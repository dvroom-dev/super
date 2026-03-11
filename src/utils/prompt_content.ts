import path from "node:path";

export type PromptTextPart = {
  type: "text";
  text: string;
};

export type PromptImagePart = {
  type: "image";
  path: string;
};

export type PromptContentPart = PromptTextPart | PromptImagePart;
export type PromptContent = PromptContentPart[];

const IMAGE_MARKDOWN_PATTERN = /!\[[^\]]*]\(([^)]+)\)/g;
const IMAGE_HTML_PATTERN = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function isUriLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) && !isWindowsDrivePath(value);
}

function cleanImageTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const withoutBrackets =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  const withoutTitle = withoutBrackets.match(/^([^\s]+)(?:\s+["'][^"']*["'])?$/)?.[1] ?? withoutBrackets.split(/\s+/, 1)[0];
  return withoutTitle.split(/[?#]/, 1)[0] ?? "";
}

export function resolvePromptImagePath(imagePath: string, baseDir?: string): string {
  if (!imagePath) return "";
  if (path.isAbsolute(imagePath)) return path.normalize(imagePath);
  if (!baseDir) return imagePath;
  return path.resolve(baseDir, imagePath);
}

export function textPart(text: string): PromptTextPart | null {
  if (typeof text !== "string") return null;
  if (text.length === 0) return null;
  return { type: "text", text };
}

export function imagePart(imagePath: string, baseDir?: string): PromptImagePart | null {
  if (typeof imagePath !== "string") return null;
  const cleaned = cleanImageTarget(imagePath);
  if (!cleaned || isUriLike(cleaned)) return null;
  const resolved = resolvePromptImagePath(cleaned, baseDir);
  if (!resolved) return null;
  return { type: "image", path: resolved };
}

export function promptContentFromText(text: string): PromptContent {
  const part = textPart(text);
  return part ? [part] : [];
}

export function concatPromptContent(segments: Array<PromptContent | undefined>, separator = "\n"): PromptContent {
  const out: PromptContent = [];
  for (const segment of segments) {
    if (!segment || segment.length === 0) continue;
    if (out.length > 0) {
      const sep = textPart(separator);
      if (sep) out.push(sep);
    }
    for (const part of segment) out.push(part);
  }
  return out;
}

export function promptContentToText(content: PromptContent): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `<image:${part.path}>`))
    .join("");
}

export function promptContentToPlainText(content: PromptContent): string {
  return content
    .filter((part): part is PromptTextPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function promptContentToMarkdown(content: PromptContent): string {
  return content
    .map((part) => (part.type === "text" ? part.text : `![image](${part.path})`))
    .join("");
}

export function promptContentByteLength(content: PromptContent): number {
  return Buffer.byteLength(promptContentToText(content), "utf8");
}

export function dedupePromptImages(parts: PromptImagePart[]): PromptImagePart[] {
  const out: PromptImagePart[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const key = part.path.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ type: "image", path: key });
  }
  return out;
}

export function extractPromptImagePartsFromMarkdown(markdown: string, baseDir?: string): PromptImagePart[] {
  const parts: PromptImagePart[] = [];
  for (const match of markdown.matchAll(IMAGE_MARKDOWN_PATTERN)) {
    const ref = imagePart(match[1] ?? "", baseDir);
    if (ref) parts.push(ref);
  }
  for (const match of markdown.matchAll(IMAGE_HTML_PATTERN)) {
    const ref = imagePart(match[1] ?? "", baseDir);
    if (ref) parts.push(ref);
  }
  return dedupePromptImages(parts);
}
