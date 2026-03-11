import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

type ResolveWorkspacePathOptions = {
  allowMissing?: boolean;
};

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const rel = path.relative(rootPath, candidatePath);
  if (!rel) return true;
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function resolveExistingAncestorRealpath(targetPath: string): Promise<{ realpath: string; missingSegments: string[] }> {
  const missingSegments: string[] = [];
  let cursor = targetPath;
  while (true) {
    try {
      return {
        realpath: await fsPromises.realpath(cursor),
        missingSegments,
      };
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function resolveExistingAncestorRealpathSync(targetPath: string): { realpath: string; missingSegments: string[] } {
  const missingSegments: string[] = [];
  let cursor = targetPath;
  while (true) {
    try {
      return {
        realpath: fs.realpathSync(cursor),
        missingSegments,
      };
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveRealpathLike(targetPath: string, options: ResolveWorkspacePathOptions = {}): Promise<string> {
  const absoluteTargetPath = path.resolve(targetPath);
  if (!options.allowMissing) return await fsPromises.realpath(absoluteTargetPath);
  const { realpath, missingSegments } = await resolveExistingAncestorRealpath(absoluteTargetPath);
  return missingSegments.length ? path.join(realpath, ...missingSegments) : realpath;
}

export function resolveRealpathLikeSync(targetPath: string, options: ResolveWorkspacePathOptions = {}): string {
  const absoluteTargetPath = path.resolve(targetPath);
  if (!options.allowMissing) return fs.realpathSync(absoluteTargetPath);
  const { realpath, missingSegments } = resolveExistingAncestorRealpathSync(absoluteTargetPath);
  return missingSegments.length ? path.join(realpath, ...missingSegments) : realpath;
}

export async function resolveWorkspacePath(
  workspaceRoot: string,
  candidatePath: string,
  options: ResolveWorkspacePathOptions = {},
): Promise<string> {
  const rootRealpath = await fsPromises.realpath(path.resolve(workspaceRoot));
  const absoluteCandidatePath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspaceRoot, candidatePath);
  const resolvedCandidatePath = await resolveRealpathLike(absoluteCandidatePath, options);
  if (!isPathInside(rootRealpath, resolvedCandidatePath)) {
    throw new Error(`Path escapes workspace root: ${candidatePath}`);
  }
  return resolvedCandidatePath;
}

export function resolveWorkspacePathSync(
  workspaceRoot: string,
  candidatePath: string,
  options: ResolveWorkspacePathOptions = {},
): string {
  const rootRealpath = fs.realpathSync(path.resolve(workspaceRoot));
  const absoluteCandidatePath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(workspaceRoot, candidatePath);
  const resolvedCandidatePath = resolveRealpathLikeSync(absoluteCandidatePath, options);
  if (!isPathInside(rootRealpath, resolvedCandidatePath)) {
    throw new Error(`Path escapes workspace root: ${candidatePath}`);
  }
  return resolvedCandidatePath;
}

export function isWorkspacePath(workspaceRoot: string, candidatePath: string, options: ResolveWorkspacePathOptions = {}): boolean {
  try {
    resolveWorkspacePathSync(workspaceRoot, candidatePath, options);
    return true;
  } catch {
    return false;
  }
}
