import { loadRunConfigForDirectory, renderRunConfig, type RenderedRunConfig } from "../../../supervisor/run_config.js";

export async function refreshRenderedRunConfigForModeFork(args: {
  workspaceRoot: string;
  runConfigPath?: string;
  configBaseDir: string;
  agentBaseDir: string;
  supervisorBaseDir: string;
}): Promise<RenderedRunConfig | null> {
  const runConfig = await loadRunConfigForDirectory(args.workspaceRoot, {
    explicitConfigPath: args.runConfigPath,
  });
  return await renderRunConfig(runConfig, {
    configBaseDir: args.configBaseDir,
    agentBaseDir: args.agentBaseDir,
    supervisorBaseDir: args.supervisorBaseDir,
  });
}
