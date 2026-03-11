import path from "node:path";

export function superDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "super");
}

export function statePath(workspaceRoot: string): string {
  return path.join(superDir(workspaceRoot), "state.json");
}

export function eventsPath(workspaceRoot: string): string {
  return path.join(superDir(workspaceRoot), "events.jsonl");
}

export function exportsDir(workspaceRoot: string): string {
  return path.join(superDir(workspaceRoot), "exports");
}

export function exportSessionPath(workspaceRoot: string): string {
  return path.join(exportsDir(workspaceRoot), "session.md");
}
