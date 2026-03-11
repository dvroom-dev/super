import os from "node:os";
import path from "node:path";

export function defaultSupervisorHome(): string {
  // Keep supervisor state OUT of the project directory.
  // Use a dedicated home under the user's home directory.
  return path.join(os.homedir(), ".ai-supervisor-studio");
}
