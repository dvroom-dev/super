import fs from "node:fs/promises";
import path from "node:path";
import { toolDefinitionsMarkdown } from "../tools/definitions.js";
import {
  imagePart,
  promptContentToMarkdown,
  promptContentToPlainText,
  textPart,
  type PromptContent,
} from "../utils/prompt_content.js";
import {
  renderSupervisorMessageTemplatesByTriggerMarkdown,
  type SupervisorMessageTemplateGroupMap,
} from "./run_config_supervisor.js";
import type {
  RunConfig,
  RunConfigPart,
  RunConfigSystemMessage,
  RunConfigUserMessage,
  RenderedRunConfigMessage,
  RenderedRunConfigUserMessage,
} from "./run_config.js";
import type { RunConfigTools } from "./run_config_tools.js";

export type RenderScopeRoots = {
  configBaseDir?: string;
  agentBaseDir?: string;
  supervisorBaseDir?: string;
};

type FilesPartEntry = {
  sourcePath: string;
  displayPath: string;
  resolvedPath: string;
  fromGlob: boolean;
};

function resolveReferencedPath(baseDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
}

function reportFilesPartError(message: string): void {
  process.stderr.write(`run:config files part: ${message}\n`);
}

function isGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
}

function toDisplayPath(baseDir: string, resolvedPath: string): string {
  const relative = path.relative(baseDir, resolvedPath).split(path.sep).join("/");
  if (!relative || relative === ".") return "./";
  if (relative.startsWith(".") || relative.startsWith("..")) return relative;
  return `./${relative}`;
}

async function readReferencedFile(baseDir: string, filePath: string): Promise<string> {
  const resolved = resolveReferencedPath(baseDir, filePath);
  try {
    return await fs.readFile(resolved, "utf8");
  } catch (err: any) {
    throw new Error(`failed to read referenced file '${filePath}' (${resolved}): ${err?.message ?? String(err)}`);
  }
}

async function readResolvedFile(filePathLabel: string, resolvedPath: string): Promise<string> {
  try {
    return await fs.readFile(resolvedPath, "utf8");
  } catch (err: any) {
    throw new Error(`failed to read referenced file '${filePathLabel}' (${resolvedPath}): ${err?.message ?? String(err)}`);
  }
}

async function readReferencedFileTailBytes(baseDir: string, filePath: string, maxBytes: number): Promise<string> {
  const resolved = resolveReferencedPath(baseDir, filePath);
  if (maxBytes <= 0) return "";
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(resolved, "r");
    const stat = await handle.stat();
    const fileSize = Number(stat.size ?? 0);
    if (fileSize <= maxBytes) {
      return await handle.readFile({ encoding: "utf8" });
    }
    const start = fileSize - maxBytes;
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (err: any) {
    throw new Error(`failed to read referenced file '${filePath}' (${resolved}): ${err?.message ?? String(err)}`);
  } finally {
    if (handle) await handle.close();
  }
}

async function readResolvedFileTailBytes(filePathLabel: string, resolvedPath: string, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return "";
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(resolvedPath, "r");
    const stat = await handle.stat();
    const fileSize = Number(stat.size ?? 0);
    if (fileSize <= maxBytes) {
      return await handle.readFile({ encoding: "utf8" });
    }
    const start = fileSize - maxBytes;
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (err: any) {
    throw new Error(`failed to read referenced file '${filePathLabel}' (${resolvedPath}): ${err?.message ?? String(err)}`);
  } finally {
    if (handle) await handle.close();
  }
}

function resolveScopeBaseDir(scope: "config_file" | "agent_file" | "supervisor_file", args: {
  configBaseDir: string;
  roots?: RenderScopeRoots;
}): string {
  if (scope === "config_file") return args.roots?.configBaseDir ?? args.configBaseDir;
  if (scope === "agent_file") {
    if (!args.roots?.agentBaseDir) {
      throw new Error("agent_file references require render options with agentBaseDir");
    }
    return args.roots.agentBaseDir;
  }
  if (!args.roots?.supervisorBaseDir) {
    throw new Error("supervisor_file references require render options with supervisorBaseDir");
  }
  return args.roots.supervisorBaseDir;
}

async function readReferencedFileForScope(args: {
  scope: "config_file" | "agent_file" | "supervisor_file";
  filePath: string;
  configBaseDir: string;
  maxBytes?: number;
  roots?: RenderScopeRoots;
}): Promise<string> {
  const baseDir = resolveScopeBaseDir(args.scope, {
    configBaseDir: args.configBaseDir,
    roots: args.roots,
  });
  if (args.maxBytes != null) {
    return readReferencedFileTailBytes(baseDir, args.filePath, args.maxBytes);
  }
  return readReferencedFile(baseDir, args.filePath);
}

async function resolveFilesPartEntries(args: {
  filePaths: string[];
  scope: "config_file" | "agent_file" | "supervisor_file";
  configBaseDir: string;
  roots?: RenderScopeRoots;
}): Promise<FilesPartEntry[]> {
  const baseDir = resolveScopeBaseDir(args.scope, {
    configBaseDir: args.configBaseDir,
    roots: args.roots,
  });
  const entries: FilesPartEntry[] = [];
  const seenResolved = new Set<string>();
  for (const sourcePath of args.filePaths) {
    if (isGlobPattern(sourcePath)) {
      const iterator = path.isAbsolute(sourcePath)
        ? fs.glob(sourcePath)
        : fs.glob(sourcePath, { cwd: baseDir });
      const matches: string[] = [];
      for await (const matchPath of iterator) {
        const resolvedPath = path.isAbsolute(matchPath) ? path.resolve(matchPath) : path.resolve(baseDir, matchPath);
        let stat: any;
        try {
          stat = await fs.stat(resolvedPath);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        matches.push(resolvedPath);
      }
      matches.sort((a, b) => a.localeCompare(b));
      if (matches.length === 0) {
        reportFilesPartError(`glob matched no files: '${sourcePath}'`);
        continue;
      }
      for (const resolvedPath of matches) {
        if (seenResolved.has(resolvedPath)) continue;
        seenResolved.add(resolvedPath);
        entries.push({
          sourcePath,
          displayPath: toDisplayPath(baseDir, resolvedPath),
          resolvedPath,
          fromGlob: true,
        });
      }
      continue;
    }
    const resolvedPath = resolveReferencedPath(baseDir, sourcePath);
    if (seenResolved.has(resolvedPath)) continue;
    seenResolved.add(resolvedPath);
    entries.push({
      sourcePath,
      displayPath: sourcePath,
      resolvedPath,
      fromGlob: false,
    });
  }
  return entries;
}

async function resolveReferencedImagePath(baseDir: string, filePath: string): Promise<string> {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(baseDir, filePath);
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new Error("not a regular file");
    }
    return resolved;
  } catch (err: any) {
    throw new Error(`failed to read referenced image '${filePath}' (${resolved}): ${err?.message ?? String(err)}`);
  }
}

async function renderTemplate(
  template: string,
  baseDir: string,
  tools?: RunConfigTools,
  messageTemplateGroups?: SupervisorMessageTemplateGroupMap,
  roots?: RenderScopeRoots,
): Promise<string> {
  const pattern = /\{\{\s*([a-zA-Z_]+)(?::([^}]+))?\s*\}\}/g;
  let out = "";
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    const idx = match.index ?? 0;
    out += template.slice(lastIndex, idx);
    const key = (match[1] ?? "").trim().toLowerCase();
    const arg = (match[2] ?? "").trim();
    if (key === "tools" || key === "tool_definitions" || key === "tool-definitions") {
      out += toolDefinitionsMarkdown(tools);
    } else if (key === "message_templates" || key === "message-templates") {
      out += renderSupervisorMessageTemplatesByTriggerMarkdown(messageTemplateGroups);
    } else if (key === "file" || key === "config_file") {
      if (!arg) throw new Error("template token {{file:...}} requires a path");
      out += await readReferencedFileForScope({
        scope: "config_file",
        filePath: arg,
        configBaseDir: baseDir,
        roots,
      });
    } else if (key === "agent_file") {
      if (!arg) throw new Error("template token {{agent_file:...}} requires a path");
      out += await readReferencedFileForScope({
        scope: "agent_file",
        filePath: arg,
        configBaseDir: baseDir,
        roots,
      });
    } else if (key === "supervisor_file") {
      if (!arg) throw new Error("template token {{supervisor_file:...}} requires a path");
      out += await readReferencedFileForScope({
        scope: "supervisor_file",
        filePath: arg,
        configBaseDir: baseDir,
        roots,
      });
    } else {
      throw new Error(`unsupported template token '${match[0]}'`);
    }
    lastIndex = idx + match[0].length;
  }
  out += template.slice(lastIndex);
  return out;
}

async function renderParts(
  parts: RunConfigPart[],
  tools?: RunConfigTools,
  messageTemplateGroups?: SupervisorMessageTemplateGroupMap,
  roots?: RenderScopeRoots,
  promptParts?: Record<string, RunConfigPart[]>,
  seenPromptParts: string[] = [],
): Promise<PromptContent> {
  const sections: PromptContent = [];
  let first = true;
  const appendSection = (next: PromptContent) => {
    if (!next.length) return;
    if (!first) {
      const separator = textPart("\n\n");
      if (separator) sections.push(separator);
    }
    sections.push(...next);
    first = false;
  };
  for (const part of parts) {
    if (part.kind === "literal") {
      const entry = textPart(part.value);
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "file") {
      const entry = textPart(await readReferencedFileForScope({
        scope: "config_file",
        filePath: part.value,
        configBaseDir: part.baseDir,
        roots,
      }));
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "config_file") {
      const entry = textPart(await readReferencedFileForScope({
        scope: "config_file",
        filePath: part.value,
        configBaseDir: part.baseDir,
        roots,
      }));
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "agent_file") {
      const entry = textPart(await readReferencedFileForScope({
        scope: "agent_file",
        filePath: part.value,
        configBaseDir: part.baseDir,
        roots,
      }));
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "supervisor_file") {
      const entry = textPart(await readReferencedFileForScope({
        scope: "supervisor_file",
        filePath: part.value,
        configBaseDir: part.baseDir,
        roots,
      }));
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "prompt_part") {
      const referencedParts = promptParts?.[part.value];
      if (!referencedParts) {
        throw new Error(`unknown prompt_part '${part.value}'`);
      }
      if (seenPromptParts.includes(part.value)) {
        throw new Error(`prompt_part cycle detected: ${[...seenPromptParts, part.value].join(" -> ")}`);
      }
      appendSection(
        await renderParts(
          referencedParts,
          tools,
          messageTemplateGroups,
          roots,
          promptParts,
          [...seenPromptParts, part.value],
        ),
      );
      continue;
    }
    if (part.kind === "files") {
      const blocks: string[] = [];
      const entries = await resolveFilesPartEntries({
        filePaths: part.value,
        scope: part.scope,
        configBaseDir: part.baseDir,
        roots,
      });
      for (const entry of entries) {
        try {
          const body = part.maxBytesPerFile != null
            ? await readResolvedFileTailBytes(entry.displayPath, entry.resolvedPath, part.maxBytesPerFile)
            : await readResolvedFile(entry.displayPath, entry.resolvedPath);
          blocks.push(`==> ${entry.displayPath} <==\n${body}`);
        } catch (err: any) {
          const message = err?.message ?? String(err);
          if (part.strictFileExistence && !entry.fromGlob) {
            throw new Error(message);
          }
          reportFilesPartError(`${message}; skipping`);
        }
      }
      const entry = textPart(blocks.join("\n"));
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "builtin") {
      const entry = textPart(
        part.value === "message_templates"
          ? renderSupervisorMessageTemplatesByTriggerMarkdown(messageTemplateGroups)
          : toolDefinitionsMarkdown(tools),
      );
      if (entry) appendSection([entry]);
      continue;
    }
    if (part.kind === "image") {
      const imagePath = await resolveReferencedImagePath(part.baseDir, part.value);
      const entry = imagePart(imagePath);
      if (!entry) {
        throw new Error(`invalid image path '${part.value}'`);
      }
      appendSection([entry]);
      continue;
    }
    const entry = textPart(await renderTemplate(part.value, part.baseDir, tools, messageTemplateGroups, roots));
    if (entry) appendSection([entry]);
  }
  return sections;
}

export async function renderSystemMessage(
  message?: RunConfigSystemMessage,
  tools?: RunConfigTools,
  messageTemplateGroups?: SupervisorMessageTemplateGroupMap,
  roots?: RenderScopeRoots,
  promptParts?: Record<string, RunConfigPart[]>,
): Promise<RenderedRunConfigMessage | undefined> {
  if (!message) return undefined;
  const content = await renderParts(message.parts, tools, messageTemplateGroups, roots, promptParts);
  const images = content
    .filter((part): part is { type: "image"; path: string } => part.type === "image")
    .map((part) => part.path);
  return { operation: message.operation, text: promptContentToPlainText(content), images, content };
}

export async function renderUserMessage(
  message?: RunConfigUserMessage,
  tools?: RunConfigTools,
  roots?: RenderScopeRoots,
  promptParts?: Record<string, RunConfigPart[]>,
): Promise<RenderedRunConfigUserMessage | undefined> {
  if (!message) return undefined;
  const content = await renderParts(message.parts, tools, undefined, roots, promptParts);
  return { operation: message.operation, text: promptContentToMarkdown(content), content };
}

export async function renderOutputSchema(file: RunConfig["outputSchemaFile"]): Promise<any | undefined> {
  if (!file) return undefined;
  const raw = await readReferencedFile(file.baseDir, file.value);
  try {
    return JSON.parse(raw);
  } catch (err: any) {
    throw new Error(
      `${file.sourcePath}: failed to parse output_schema_file '${file.value}' as JSON: ${err?.message ?? String(err)}`,
    );
  }
}
