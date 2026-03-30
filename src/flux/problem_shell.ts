import { spawn } from "node:child_process";
import type { FluxCommandSpec } from "./types.js";

export async function runFluxProblemCommand(
  commandSpec: FluxCommandSpec,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(commandSpec.command[0]!, commandSpec.command.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`command failed (${commandSpec.command.join(" ")}): ${stderr || stdout}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(new Error(`command returned non-object JSON: ${stdout}`));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`command returned invalid JSON: ${stdout}\n${stderr}\n${String(err)}`));
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
