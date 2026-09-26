/**
 * useWorkflowExecution — runs the canvas workflow in the app.
 *
 * The run itself is the shared engine (src/engine/runWorkflow.ts). This hook
 * gives it the canvas and the settings, and a host that writes the run into the
 * stores, asks the user to approve commands and saves context snapshots.
 */

import { useWorkflowStore } from "@/store/workflowStore";
import { useExecutionStore } from "@/store/executionStore";
import { useAuditStore } from "@/store/auditStore";
import { useWorkspaceStore, refreshWorkspaceFiles } from "@/store/workspaceStore";
import { useCommandConsentStore } from "@/store/commandConsentStore";
import { invoke } from "@/ipc/tauriCommands";
import { buildContextSnapshot } from "@/services/context-builder/contextSnapshot";
import { createSnapshot } from "@/services/context-builder/snapshotService";
import type { Artifact } from "@/types/inspection";
import type { WorkflowRunConfig } from "@/types/workflowRunConfig";
import { runWorkflow, type RunHost } from "@/engine/runWorkflow";
import { writeRunRecord } from "@/engine/runRecord";

// Set synchronously when a run starts so a second Run click during the async
// provider preflight (before isRunning flips) is rejected too.
let runInFlight = false;

export function useWorkflowExecution() {
  const nodes             = useWorkflowStore((s) => s.nodes);
  const edges             = useWorkflowStore((s) => s.edges);
  const meta              = useWorkflowStore((s) => s.meta);
  const executionSettings = useWorkflowStore((s) => s.executionSettings);
  const updateNodeData    = useWorkflowStore((s) => s.updateNodeData);
  const filePath          = useWorkflowStore((s) => s.filePath);
  const workspacePath     = useWorkspaceStore((s) => s.workspacePath);
  const {
    currentRun, apiKey, openaiApiKey, ollamaApiKey,
    customApiUrl, customApiKey, customApiModel,
    llmProvider, ollamaBaseUrl, ollamaModel,
    startRun, updateAgent, finishRun, cancelRun, isRunning, continueOnError,
  } = useExecutionStore();
  const addEntry = useAuditStore((s) => s.addEntry);

  async function executeWorkflow(
    config: WorkflowRunConfig = {
      userInput: "", contextFilePaths: [], thinkDepthOverride: null, providerOverride: null,
    },
    onError?: (msg: string) => void,
  ) {
    const reportError = (msg: string) => { if (onError) onError(msg); else alert(msg); };
    if (runInFlight || useExecutionStore.getState().isRunning) {
      reportError("A workflow run is already in progress. A stopped run first finishes its in-flight agent calls.");
      return;
    }
    runInFlight = true;
    // Run status is written onto the nodes; keep it out of the undo history.
    const history = useWorkflowStore.temporal.getState();
    history.pause();
    try {
      const outcome = await runWorkflow({
        graph: { nodes, edges, meta, executionSettings },
        config,
        provider: {
          llmProvider, apiKey, openaiApiKey, ollamaApiKey, ollamaBaseUrl, ollamaModel,
          customApiUrl, customApiKey, customApiModel,
        },
        workspacePath,
        continueOnError,
        // The record names the workflow file relative to the workspace, as harness run does.
        workflowFile: {
          path: filePath && workspacePath && filePath.startsWith(`${workspacePath}/`)
            ? filePath.slice(workspacePath.length + 1) : filePath,
          hash: null,
        },
      }, appHost());
      if (!outcome.started) reportError(outcome.error);
      // Agents may have created files: show them in the file tree.
      else await refreshWorkspaceFiles();
    } finally {
      history.resume();
      runInFlight = false;
    }
  }

  /** Writes the run into the stores, asks the user to approve commands, saves snapshots. */
  function appHost(): RunHost {
    let runId = "";
    // Stop or a newer run ends this run; its late events never reach a newer run.
    const isCurrent = () => useExecutionStore.getState().currentRun?.id === runId;
    return {
      invoke,
      events: {
        onRunStarted: (id, workflowName) => { runId = id; startRun(workflowName, id); },
        onAgentUpdate: (nodeId, partial) => { if (isCurrent()) updateAgent(nodeId, partial); },
        onNodeStatus: (nodeId, status, tokens) => updateNodeData(nodeId, tokens ? { status, tokens } : { status }),
        onAudit: addEntry,
        onFileChange: (path, before, after, agent) => {
          if (isCurrent()) useExecutionStore.getState().recordFileChange(path, before, after, agent);
        },
        onRunFinished: (status) => {
          // A command still waiting for approval must not run once the run is over.
          useCommandConsentStore.getState().denyRun(runId);
          // Stop has already marked the run cancelled.
          if (status !== "cancelled" && isCurrent()) finishRun(status);
        },
      },
      askCommand: (request) => useCommandConsentStore.getState().request(request),
      isCancelled: () => {
        const run = useExecutionStore.getState().currentRun;
        return !run || run.id !== runId || run.status === "cancelled";
      },
      snapshot: ({ runId: id, nodeId, status, output, error }) => {
        const node = nodes.find((n) => n.id === nodeId);
        if (!node) return;
        const now = new Date().toISOString();
        // The node's real output, as a live artifact for the Inspector.
        const artifacts: Artifact[] = status === "completed" ? [{
          id: `artifact-${nodeId}-${Date.now()}`, title: `${node.data.name} output`, type: "markdown",
          sourceNodeId: nodeId, content: output, status: "live", createdAt: now, updatedAt: now,
          version: 1, previewMode: "rendered",
        }] : [];
        createSnapshot(
          buildContextSnapshot({ node, nodes, edges,
            agentRun: { agentId: nodeId, agentName: node.data.name, status: status === "completed" ? "done" : "error", output },
            artifacts }),
          { workspacePath, workflowId: meta.name, runId: id, snapshotStatus: status,
            ...(error === undefined ? {} : { metadata: { error } }) },
        ).catch(console.error);
      },
      // With a workspace open, every run is saved to .harness/runs/<id>/run.json.
      saveRun: workspacePath ? (record) => writeRunRecord(invoke, workspacePath, record) : undefined,
    };
  }

  return { executeWorkflow, currentRun, isRunning, cancelRun };
}
