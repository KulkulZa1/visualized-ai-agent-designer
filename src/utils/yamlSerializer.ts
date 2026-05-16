import { parse, stringify } from "yaml";
import type { WorkflowDef } from "@/types/workflow";

export function serializeWorkflow(def: WorkflowDef): string {
  return stringify(def, { lineWidth: 0, defaultKeyType: "PLAIN" });
}

export function deserializeWorkflow(yaml: string): WorkflowDef {
  return parse(yaml) as WorkflowDef;
}
