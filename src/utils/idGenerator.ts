let counter = 0;

export function generateNodeId(prefix = "node"): string {
  return `${prefix}-${Date.now()}-${++counter}`;
}
