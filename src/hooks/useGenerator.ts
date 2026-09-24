/**
 * useGenerator — runs a generator and writes the result to the workspace.
 * All writes go through the Rust IPC layer and are appended to the audit log.
 */
import { useWorkflowStore } from "@/store/workflowStore";
import { useWorkspaceStore } from "@/store/workspaceStore";
import { useAuditStore } from "@/store/auditStore";
import { readWorkspaceFile, writeWorkspaceFile } from "@/ipc/tauriCommands";
import { makeAuditEntry } from "@/utils/logger";
import {
  generateClaudeMd,
  generateAgentsMd,
  generateLangGraph,
  generateCrewAi,
} from "@/utils/generators";
import type { HookTemplate } from "@/utils/generators";

export type GenerateTarget = "claude_md" | "agents_md" | "langgraph" | "crewai" | "hook_template";

interface GenerateOptions {
  hookTemplate?: HookTemplate;
  customPath?: string;
  /** Asked before replacing an existing file whose content differs. Without it,
   *  existing files are never overwritten. */
  confirmOverwrite?: (relativePath: string) => boolean | Promise<boolean>;
}

const DEFAULT_PATHS: Record<GenerateTarget, string> = {
  claude_md:     "CLAUDE.md",
  agents_md:     "AGENTS.md",
  langgraph:     ".harness/exports/langgraph_workflow.py",
  crewai:        ".harness/exports/crewai_workflow.py",
  hook_template: ".harness/hooks/",
};

export function useGenerator() {
  const toWorkflowDef   = useWorkflowStore((s) => s.toWorkflowDef);
  const workspacePath   = useWorkspaceStore((s) => s.workspacePath);
  const addAuditEntry   = useAuditStore((s) => s.addEntry);

  async function generate(
    target: GenerateTarget,
    opts: GenerateOptions = {}
  ): Promise<{ content: string; path: string; written: boolean }> {
    const def = toWorkflowDef();

    let content: string;
    let relativePath: string;

    switch (target) {
      case "claude_md":
        content = generateClaudeMd(def);
        relativePath = opts.customPath ?? DEFAULT_PATHS.claude_md;
        break;
      case "agents_md":
        content = generateAgentsMd(def);
        relativePath = opts.customPath ?? DEFAULT_PATHS.agents_md;
        break;
      case "langgraph":
        content = generateLangGraph(def);
        relativePath = opts.customPath ?? DEFAULT_PATHS.langgraph;
        break;
      case "crewai":
        content = generateCrewAi(def);
        relativePath = opts.customPath ?? DEFAULT_PATHS.crewai;
        break;
      case "hook_template":
        if (!opts.hookTemplate) throw new Error("hookTemplate required");
        content = opts.hookTemplate.content;
        relativePath = opts.customPath ?? `${DEFAULT_PATHS.hook_template}${opts.hookTemplate.filename}`;
        break;
      default:
        throw new Error(`Unknown generate target: ${target}`);
    }

    // Write to disk if workspace is open — but never silently replace a file the
    // user may have edited (e.g. a hand-written CLAUDE.md or customized hook).
    if (!workspacePath) return { content, path: relativePath, written: false };
    const existing = await readWorkspaceFile(workspacePath, relativePath).catch(() => null);
    if (existing !== null && existing !== content) {
      const confirmed = opts.confirmOverwrite ? await opts.confirmOverwrite(relativePath) : false;
      if (!confirmed) return { content, path: relativePath, written: false };
    }
    await writeWorkspaceFile(workspacePath, relativePath, content);
    addAuditEntry(makeAuditEntry("file_write", true, {
      path: relativePath,
      details: `Generated ${target}: ${(content.length / 1024).toFixed(1)} KB`,
    }));

    return { content, path: relativePath, written: true };
  }

  return { generate, hasWorkspace: !!workspacePath };
}
