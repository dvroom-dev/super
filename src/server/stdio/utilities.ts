import type { UtilityStatus } from "../../supervisor/compile.js";
import type { ServerState } from "./types.js";
import { findCommand } from "./workspace.js";

export async function detectUtilities(): Promise<UtilityStatus[]> {
  const specs: { name: string; commands: string[] }[] = [
    { name: "ripgrep", commands: ["rg"] },
    { name: "ast-grep", commands: ["sg", "ast-grep"] },
    { name: "fd", commands: ["fd", "fdfind"] },
    { name: "fzf", commands: ["fzf"] },
    { name: "jq", commands: ["jq"] },
    { name: "yq", commands: ["yq"] },
    { name: "bat", commands: ["bat", "batcat"] },
    { name: "eza", commands: ["eza"] },
    { name: "delta", commands: ["delta"] },
    { name: "gh", commands: ["gh"] },
    { name: "ripgrep-all", commands: ["rga"] },
  ];
  const out: UtilityStatus[] = [];
  for (const spec of specs) {
    let foundCmd: string | undefined;
    let foundPath: string | undefined;
    for (const cmd of spec.commands) {
      const full = await findCommand(cmd);
      if (full) {
        foundCmd = cmd;
        foundPath = full;
        break;
      }
    }
    out.push({
      name: spec.name,
      command: foundCmd ?? spec.commands[0],
      available: Boolean(foundCmd),
      path: foundPath,
    });
  }
  return out;
}

export async function getUtilities(state: ServerState): Promise<UtilityStatus[]> {
  if (state.utilities) return state.utilities;
  const utils = await detectUtilities();
  state.utilities = utils;
  return utils;
}
