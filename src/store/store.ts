import fs from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "../utils/hash.js";
import { defaultSupervisorHome } from "../utils/os.js";
import { newId } from "../utils/ids.js";
import type { ConversationIndex, ForkMeta, ForkSummary, SupervisorAction } from "./types.js";
import { parseChatMarkdown, lastUserMessage } from "../markdown/parse.js";
import { applyPatch, diffLines } from "./patch.js";

export type StoreOptions = {
  supervisorHome?: string;
};

export class SupervisorStore {
  private home: string;

  constructor(opts: StoreOptions = {}) {
    this.home = opts.supervisorHome ?? defaultSupervisorHome();
  }

  getSupervisorHome(): string {
    return this.home;
  }

  workspaceId(workspaceRoot: string): string {
    return sha256Hex(workspaceRoot);
  }

  private normalizeRuleList(value: any): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      const normalized = String(entry ?? "").trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  private normalizeAgentRules(forkLike: any): string[] {
    return this.normalizeRuleList(forkLike?.agentRules);
  }

  private normalizeForkMeta(rawFork: any): ForkMeta {
    const fork = { ...(rawFork ?? {}) };
    fork.agentRules = this.normalizeAgentRules(fork);
    return fork as ForkMeta;
  }

  private normalizeForkSummary(rawSummary: any): ForkSummary {
    const summary = { ...(rawSummary ?? {}) };
    summary.agentRules = this.normalizeAgentRules(summary);
    return summary as ForkSummary;
  }

  conversationIdFromPath(docPath: string): string {
    return sha256Hex(docPath);
  }

  private async ensureDir(p: string) {
    await fs.mkdir(p, { recursive: true });
  }

  private dataRoot(workspaceRoot: string): string {
    return path.join(workspaceRoot, ".ai-supervisor");
  }

  private convoDir(workspaceRoot: string, conversationId: string): string {
    return path.join(this.dataRoot(workspaceRoot), "conversations", conversationId);
  }

  private indexPath(workspaceRoot: string, conversationId: string): string {
    return path.join(this.convoDir(workspaceRoot, conversationId), "index.json");
  }

  private forkPath(workspaceRoot: string, conversationId: string, forkId: string): string {
    return path.join(this.convoDir(workspaceRoot, conversationId), "forks", `${forkId}.json`);
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify(value, null, 2);
    try {
      await fs.writeFile(tempPath, payload, "utf-8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async loadIndex(workspaceRoot: string, conversationId: string): Promise<ConversationIndex> {
    const dir = this.convoDir(workspaceRoot, conversationId);
    await this.ensureDir(path.join(dir, "forks"));
    const p = this.indexPath(workspaceRoot, conversationId);
    try {
      const raw = await fs.readFile(p, "utf-8");
      const idx = JSON.parse(raw) as ConversationIndex;
      return this.normalizeIndex(idx);
    } catch (e: any) {
      if (e?.code !== "ENOENT") {
        throw new Error(`conversation index is unreadable: ${p}: ${e?.message ?? String(e)}`);
      }
      const idx: ConversationIndex = { conversationId, headId: undefined, headIds: [], forks: [] };
      await this.writeJsonAtomic(p, idx);
      return idx;
    }
  }

  async saveIndex(workspaceRoot: string, conversationId: string, idx: ConversationIndex): Promise<void> {
    const p = this.indexPath(workspaceRoot, conversationId);
    const normalized = this.normalizeIndex(idx);
    await this.writeJsonAtomic(p, normalized);
  }

  async saveFork(workspaceRoot: string, conversationId: string, fork: ForkMeta): Promise<void> {
    const p = this.forkPath(workspaceRoot, conversationId, fork.id);
    const persist: ForkMeta = { ...fork };
    if (persist.storage === "patch") {
      delete (persist as any).documentText;
    }
    await this.writeJsonAtomic(p, persist);
  }

  private extractConversationIdFromText(text: string): string | undefined {
    return this.extractFrontmatterValue(text, "conversation_id");
  }

  private extractForkIdFromText(text: string): string | undefined {
    return this.extractFrontmatterValue(text, "fork_id");
  }

  private extractFrontmatterValue(text: string, key: string): string | undefined {
    const lines = text.split(/\r?\n/);
    if (lines[0] !== "---") return undefined;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === "---") break;
      const match = line.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)\\s*$`));
      if (match) {
        return match[1].trim().replace(/^["']|["']$/g, "");
      }
    }
    return undefined;
  }

  async conversationIdFromDocument(docPath: string, documentText: string): Promise<string> {
    const id = this.extractConversationIdFromText(documentText);
    const forkId = this.extractForkIdFromText(documentText);
    if (!forkId) {
      throw new Error("fork_id frontmatter required");
    }
    if (id) return id;
    throw new Error("conversation_id frontmatter required");
  }

  forkIdFromDocument(documentText: string): string | undefined {
    return this.extractForkIdFromText(documentText);
  }

  async conversationIdFromDocPath(workspaceRoot: string, docPath: string): Promise<string> {
    if (!docPath || docPath.startsWith("untitled:")) {
      throw new Error("conversation_id frontmatter required");
    }
    const raw = await fs.readFile(docPath, "utf-8");
    const id = this.extractConversationIdFromText(raw);
    if (!id) {
      throw new Error("conversation_id frontmatter required");
    }
    const forkId = this.extractForkIdFromText(raw);
    if (!forkId) {
      throw new Error("fork_id frontmatter required");
    }
    return id;
  }

  newConversationId(seed?: string): string {
    const base = seed ?? `${Date.now()}-${Math.random()}-${process.pid}`;
    return sha256Hex(base);
  }

  async loadFork(workspaceRoot: string, conversationId: string, forkId: string): Promise<ForkMeta> {
    const p = this.forkPath(workspaceRoot, conversationId, forkId);
    const raw = await fs.readFile(p, "utf-8");
    const fork = this.normalizeForkMeta(JSON.parse(raw));
    if (fork.storage === "snapshot") {
      return fork;
    }
    const chain: ForkMeta[] = [];
    let cursor: ForkMeta | null = fork;
    while (cursor && cursor.storage === "patch") {
      chain.push(cursor);
      if (!cursor.parentId) {
        throw new Error(`fork ${cursor.id} missing parent for patch`);
      }
      const parentRaw = await fs.readFile(this.forkPath(workspaceRoot, conversationId, cursor.parentId), "utf-8");
      cursor = this.normalizeForkMeta(JSON.parse(parentRaw));
    }
    if (!cursor || cursor.storage !== "snapshot") {
      throw new Error(`fork ${forkId} has no snapshot root`);
    }
    let text = cursor.documentText ?? "";
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const item = chain[i];
      if (item.baseHash) {
        const currentHash = sha256Hex(text);
        if (currentHash !== item.baseHash) {
          throw new Error(`fork ${item.id} base hash mismatch`);
        }
      }
      if (!item.patch) {
        throw new Error(`fork ${item.id} missing patch payload`);
      }
      text = applyPatch(text, item.patch);
      if (item.docHash) {
        const nextHash = sha256Hex(text);
        if (nextHash !== item.docHash) {
          throw new Error(`fork ${item.id} doc hash mismatch`);
        }
      }
    }
    return this.normalizeForkMeta({ ...fork, documentText: text });
  }

  // Detect whether a new submission edits history relative to the current head.
  // We use a simple, legible heuristic:
  // - If the new doc starts with the exact old doc as a prefix and ONLY appends, we treat as "linear continuation".
  // - Otherwise, it's a fork.
  isHistoryEdited(prevDoc: string, nextDoc: string): boolean {
    const prev = prevDoc.replace(/\s+$/g, "");
    const next = nextDoc.replace(/\s+$/g, "");
    if (next.startsWith(prev)) return false;
    return true;
  }

  deriveLabelFromDoc(docText: string): string {
    const parsed = parseChatMarkdown(docText);
    const lastUser = lastUserMessage(parsed);
    const base = lastUser?.content?.trim().split(/\r?\n/)[0] ?? "Conversation";
    return base.slice(0, 80);
  }

  async createFork(params: {
    workspaceRoot: string;
    conversationId: string;
    parentId?: string;
    documentText: string;
    forkId?: string;
    createdAt?: string;
    label?: string;
    forkSummary?: string;
    agentRules: string[];
    providerName?: string;
    model?: string;
    providerThreadId?: string;
    supervisorThreadId?: string;
    actions?: SupervisorAction[];
    actionSummary?: string;
    agentModel?: string;
    supervisorProviderName?: string;
    supervisorModel?: string;
  }): Promise<ForkMeta> {
    const forkId = params.forkId ?? newId("fork");
    let storage: ForkMeta["storage"] = "snapshot";
    let documentText: string | undefined = params.documentText;
    let patch: ForkMeta["patch"] = undefined;
    let baseHash: string | undefined = undefined;
    let docHash: string | undefined = sha256Hex(params.documentText ?? "");
    const label = params.label ?? this.deriveLabelFromDoc(params.documentText);
    const forkSummary = params.forkSummary ?? label;
    if (params.parentId) {
      const parent = await this.loadFork(params.workspaceRoot, params.conversationId, params.parentId);
      const baseText = parent.documentText ?? "";
      baseHash = sha256Hex(baseText);
      patch = diffLines(baseText, params.documentText ?? "");
      storage = "patch";
      documentText = undefined;
      docHash = sha256Hex(params.documentText ?? "");
    }
    const fork: ForkMeta = {
      id: forkId,
      parentId: params.parentId,
      createdAt: params.createdAt ?? new Date().toISOString(),
      label,
      forkSummary,
      storage,
      documentText,
      patch,
      baseHash,
      docHash,
      actions: params.actions,
      actionSummary: params.actionSummary,
      agentRules: this.normalizeRuleList(params.agentRules),
      providerThreadId: params.providerThreadId,
      supervisorThreadId: params.supervisorThreadId,
      providerName: params.providerName,
      supervisorProviderName: params.supervisorProviderName,
      model: params.model,
      agentModel: params.agentModel,
      supervisorModel: params.supervisorModel,
    };
    const idx = await this.loadIndex(params.workspaceRoot, params.conversationId);
    idx.forks.push(this.toSummary(fork));
    if (!idx.headIds) idx.headIds = [];
    if (params.parentId) {
      idx.headIds = idx.headIds.filter((id) => id !== params.parentId);
    }
    if (!idx.headIds.includes(fork.id)) idx.headIds.push(fork.id);
    idx.headId = fork.id;
    await this.saveFork(params.workspaceRoot, params.conversationId, fork);
    await this.saveIndex(params.workspaceRoot, params.conversationId, idx);
    return fork;
  }

  async updateFork(
    workspaceRoot: string,
    conversationId: string,
    forkId: string,
    patch: Partial<ForkMeta>
  ): Promise<ForkMeta> {
    const existing = await this.loadFork(workspaceRoot, conversationId, forkId);
    const updated: ForkMeta = { ...existing, ...patch };
    if (patch.documentText !== undefined) {
      if (updated.storage !== "snapshot") {
        throw new Error("cannot set documentText on non-snapshot fork");
      }
      updated.docHash = sha256Hex(patch.documentText ?? "");
    }
    if (patch.patch !== undefined && updated.storage === "patch") {
      if (updated.parentId) {
        const parent = await this.loadFork(workspaceRoot, conversationId, updated.parentId);
        updated.baseHash = sha256Hex(parent.documentText ?? "");
      }
      const rebuilt = applyPatch(existing.documentText ?? "", patch.patch ?? { ops: [] });
      updated.docHash = sha256Hex(rebuilt);
    }
    await this.saveFork(workspaceRoot, conversationId, updated);
    const idx = await this.loadIndex(workspaceRoot, conversationId);
    idx.forks = idx.forks.map((f) => (f.id === forkId ? this.toSummary(updated) : f));
    await this.saveIndex(workspaceRoot, conversationId, idx);
    return updated;
  }

  private toSummary(fork: ForkMeta): ForkSummary {
    return {
      id: fork.id,
      parentId: fork.parentId,
      createdAt: fork.createdAt,
      label: fork.label,
      forkSummary: fork.forkSummary,
      storage: fork.storage,
      baseHash: fork.baseHash,
      docHash: fork.docHash,
      actions: fork.actions,
      actionSummary: fork.actionSummary,
      agentRules: fork.agentRules,
      providerThreadId: fork.providerThreadId,
      supervisorThreadId: fork.supervisorThreadId,
      providerName: fork.providerName,
      supervisorProviderName: fork.supervisorProviderName,
      model: fork.model,
      agentModel: fork.agentModel,
      supervisorModel: fork.supervisorModel,
    };
  }

  private normalizeIndex(idx: ConversationIndex): ConversationIndex {
    if (!Array.isArray(idx.forks)) {
      idx.forks = [];
    }
    idx.forks = idx.forks.map((fork) => this.normalizeForkSummary(fork));
    if (!Array.isArray(idx.headIds)) {
      const allIds = idx.forks.map((f) => f.id);
      const parentIds = new Set(idx.forks.map((f) => f.parentId).filter(Boolean) as string[]);
      idx.headIds = allIds.filter((id) => !parentIds.has(id));
    }
    if (!idx.headId && idx.headIds.length > 0) {
      idx.headId = idx.headIds[0];
    }
    return idx;
  }
}
