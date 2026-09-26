import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { temporal } from "zundo";
import { addEdge, applyNodeChanges, applyEdgeChanges } from "@xyflow/react";
import type { NodeChange, EdgeChange, Connection } from "@xyflow/react";
import type { AgentNode, WorkflowDef, WorkflowMeta, ExecutionSettings } from "@/types/workflow";
import type { Edge } from "@xyflow/react";
import { AgentRole, ToolPermission } from "@/types/agent";
import { defToGraph } from "@/engine/workflowGraph";

type WorkflowEdgeKind = NonNullable<WorkflowDef["connections"][number]["edgeKind"]>;
type WorkflowEdgeData = { label?: string; edgeKind?: WorkflowEdgeKind };

function isWorkflowEdgeKind(value: unknown): value is WorkflowEdgeKind {
  return value === "dataflow" || value === "memory" || value === "feedback" || value === "control";
}

function getEdgeData(edge: Edge): WorkflowEdgeData {
  return (edge.data as WorkflowEdgeData | undefined) ?? {};
}

function getEdgeLabel(edge: Edge): string | undefined {
  const dataLabel = getEdgeData(edge).label;
  if (typeof dataLabel === "string") return dataLabel;
  return typeof edge.label === "string" ? edge.label : undefined;
}

function getEdgeKind(edge: Edge): WorkflowEdgeKind {
  const dataKind = getEdgeData(edge).edgeKind;
  if (isWorkflowEdgeKind(dataKind)) return dataKind;
  return isWorkflowEdgeKind(edge.type) ? edge.type : "dataflow";
}

/** React Flow also reports measuring and selecting nodes and edges, which change
 *  nothing that is saved: only the other changes make the workflow unsaved. */
function changesSavedState(changes: Array<NodeChange<AgentNode> | EdgeChange>): boolean {
  return changes.some((change) => change.type !== "dimensions" && change.type !== "select");
}

const DEFAULT_META: WorkflowMeta = {
  name: "Untitled Workflow",
  version: "1.0.0",
  description: "",
  projectRoot: "",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const DEFAULT_SETTINGS: ExecutionSettings = {
  maxParallel: 4,
  timeoutSeconds: 300,
  retryOnFailure: false,
  maxRetries: 0,
};

interface WorkflowStoreState {
  nodes: AgentNode[];
  edges: Edge[];
  meta: WorkflowMeta;
  executionSettings: ExecutionSettings;
  isDirty: boolean;
  filePath: string | null;
}

interface WorkflowStoreActions {
  onNodesChange: (changes: NodeChange<AgentNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (node: AgentNode) => void;
  removeNode: (nodeId: string) => void;
  duplicateNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<AgentNode["data"]>) => void;
  /** Set model on all nodes, optionally filtered by role. Returns the count changed. */
  bulkSetModel: (model: string, roleFilter?: AgentRole) => number;
  updateEdgeLabel: (edgeId: string, label: string) => void;
  updateMeta: (meta: Partial<WorkflowMeta>) => void;
  updateExecutionSettings: (settings: Partial<ExecutionSettings>) => void;
  loadWorkflow: (def: WorkflowDef) => void;
  markClean: (filePath: string) => void;
  reset: () => void;
  toWorkflowDef: () => WorkflowDef;
}

const initialState: WorkflowStoreState = {
  nodes: [],
  edges: [],
  meta: DEFAULT_META,
  executionSettings: DEFAULT_SETTINGS,
  isDirty: false,
  filePath: null,
};

export const useWorkflowStore = create<WorkflowStoreState & WorkflowStoreActions>()(
  temporal(
    immer((set, get) => ({
      ...initialState,

      onNodesChange: (changes) =>
        set((state) => {
          state.nodes = applyNodeChanges(changes, state.nodes) as AgentNode[];
          if (changesSavedState(changes)) state.isDirty = true;
        }),

      onEdgesChange: (changes) =>
        set((state) => {
          state.edges = applyEdgeChanges(changes, state.edges);
          if (changesSavedState(changes)) state.isDirty = true;
        }),

      onConnect: (connection) =>
        set((state) => {
          state.edges = addEdge({
            ...connection,
            type: "dataflow",
            data: { edgeKind: "dataflow" },
          }, state.edges);
          state.isDirty = true;
        }),

      addNode: (node) =>
        set((state) => {
          state.nodes.push(node);
          state.isDirty = true;
        }),

      removeNode: (nodeId) =>
        set((state) => {
          state.nodes = state.nodes.filter((n) => n.id !== nodeId);
          state.edges = state.edges.filter(
            (e) => e.source !== nodeId && e.target !== nodeId
          );
          state.isDirty = true;
        }),

      duplicateNode: (nodeId) =>
        set((state) => {
          const source = state.nodes.find((n) => n.id === nodeId);
          if (!source) return;
          const newId = nextNodeId();
          const newNode: AgentNode = {
            ...source,
            id: newId,
            position: { x: source.position.x + 40, y: source.position.y + 40 },
            data: {
              ...source.data,
              name: `${source.data.name} (copy)`,
              status: "idle",
              tokens: { used: 0, budget: source.data.tokens.budget },
            },
            selected: false,
          };
          state.nodes.push(newNode);
          state.isDirty = true;
        }),

      updateNodeData: (nodeId, data) =>
        set((state) => {
          const node = state.nodes.find((n) => n.id === nodeId);
          if (!node) return;
          Object.assign(node.data, data);
          state.isDirty = true;
        }),

      bulkSetModel: (model, roleFilter) => {
        const targets = get().nodes.filter(
          (n) => !roleFilter || n.data.role === roleFilter
        );
        set((state) => {
          state.nodes.forEach((node) => {
            if (!roleFilter || node.data.role === roleFilter) {
              node.data.model = model;
            }
          });
          state.isDirty = true;
        });
        return targets.length;
      },

      updateEdgeLabel: (edgeId, label) =>
        set((state) => {
          const edge = state.edges.find((e) => e.id === edgeId);
          if (edge) {
            edge.label = label;
            edge.data = { ...getEdgeData(edge), label };
            state.isDirty = true;
          }
        }),

      updateMeta: (meta) =>
        set((state) => {
          Object.assign(state.meta, meta);
          state.isDirty = true;
        }),

      updateExecutionSettings: (settings) =>
        set((state) => {
          Object.assign(state.executionSettings, settings);
          state.isDirty = true;
        }),

      loadWorkflow: (def) => {
        const graph = defToGraph(def);
        set((state) => {
          state.meta = graph.meta;
          state.executionSettings = graph.executionSettings;
          state.edges = graph.edges;
          state.nodes = graph.nodes;
          state.isDirty = false;
          state.filePath = null;
        });
        // A loaded workflow starts a fresh history: undoing past the load would put the
        // previous graph under this workflow's name and file path.
        useWorkflowStore.temporal.getState().clear();
      },

      markClean: (filePath) =>
        set((state) => {
          state.isDirty = false;
          state.filePath = filePath;
          state.meta.updatedAt = new Date().toISOString();
        }),

      reset: () => {
        set(() => ({
          ...initialState,
          meta: { ...DEFAULT_META, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        }));
        useWorkflowStore.temporal.getState().clear();
      },

      toWorkflowDef: () => {
        const { nodes, edges, meta, executionSettings } = get();
        // Saved agents are identified by list position ("agent-<i>"), which is how
        // loadWorkflow and the generators resolve them. Canvas node IDs are not stable
        // across save/load, so connections and positions must be remapped.
        const savedId = new Map(nodes.map((n, i) => [n.id, `agent-${i}`]));
        return {
          meta,
          // "stopped" is display-only: the workflow file schema does not accept it.
          agents: nodes.map((n) => n.data.status === "stopped" ? { ...n.data, status: "idle" as const } : n.data),
          connections: edges
            .filter((e) => savedId.has(e.source) && savedId.has(e.target))
            .map((e) => ({
              id: e.id,
              sourceAgentId: savedId.get(e.source)!,
              targetAgentId: savedId.get(e.target)!,
              label: getEdgeLabel(e),
              edgeKind: getEdgeKind(e) !== "dataflow" ? getEdgeKind(e) : undefined,
            })),
          executionSettings,
          nodePositions: Object.fromEntries(nodes.map((n, i) => [`agent-${i}`, n.position])),
        };
      },
    })),
    {
      limit: 50,
      partialize: (state) => ({ nodes: state.nodes, edges: state.edges }),
      // Writes that leave the graph untouched (markClean, meta edits) are not undo steps.
      equality: (past, current) => past.nodes === current.nodes && past.edges === current.edges,
    }
  )
);

let _nodeCounter = 0;

export function makeDefaultAgentNode(
  id: string,
  role: AgentRole,
  position: { x: number; y: number }
): AgentNode {
  const defaultTools: Partial<Record<AgentRole, ToolPermission[]>> = {
    [AgentRole.Worker]:     [ToolPermission.ReadFile, ToolPermission.FsRead],
    [AgentRole.ToolCaller]: [ToolPermission.ReadFile, ToolPermission.Bash, ToolPermission.WebSearch],
    [AgentRole.Hook]:       [ToolPermission.FsRead, ToolPermission.WriteFile],
    [AgentRole.Memory]:     [ToolPermission.FsAppend, ToolPermission.FsRead],
  };

  const defaultBudgets: Partial<Record<AgentRole, number>> = {
    [AgentRole.Orchestrator]: 32000,
    [AgentRole.Worker]:       40000,
    [AgentRole.Critic]:       24000,
    [AgentRole.Aggregator]:   48000,
    [AgentRole.Memory]:       16000,
    [AgentRole.Gateway]:       8000,
    [AgentRole.Hook]:             0,
    [AgentRole.ToolCaller]:   20000,
  };

  const labelMap: Record<AgentRole, string> = {
    [AgentRole.Orchestrator]: "Orchestrator",
    [AgentRole.Gateway]:      "Router",
    [AgentRole.Worker]:       "Worker",
    [AgentRole.Critic]:       "Critic",
    [AgentRole.Memory]:       "Memory",
    [AgentRole.Hook]:         "Hook",
    [AgentRole.Aggregator]:   "Aggregator",
    [AgentRole.ToolCaller]:   "Tool Caller",
  };

  return {
    id,
    type: "agent",
    position,
    data: {
      name: labelMap[role],
      role,
      model: role === AgentRole.Hook || role === AgentRole.Memory ? "" : "claude-sonnet-4.6",
      temperature: 0.7,
      maxTokens: 4096,
      maxSteps: 20,
      timeoutSeconds: 300,
      promptSource: { type: "inline", content: "" },
      tools: defaultTools[role] ?? [],
      memoryRead: [],
      memoryWrite: [],
      tokens: { used: 0, budget: defaultBudgets[role] ?? 16000 },
      status: "idle",
    },
  };
}

export function nextNodeId(): string {
  return `node-${Date.now()}-${++_nodeCounter}`;
}
