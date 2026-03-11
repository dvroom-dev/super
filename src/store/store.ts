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
    const direct = this.normalizeRuleList(forkLike?.agentRules);
    if (direct.length) return direct;
    const legacyImpl = this.normalizeRuleList(forkLike?.implRules);
    const legacyValidation = this.normalizeRuleList(forkLike?.validationRules);
    return this.normalizeRuleList([...legacyImpl, ...legacyValidation]);
  }

  private normalizeForkMeta(rawFork: any): ForkMeta {
    const fork = { ...(rawFork ?? {}) };
    fork.agentRules = this.normalizeAgentRules(fork);
    delete fork.implRules;
    delete fork.validationRules;
    return fork as ForkMeta;
  }

  private normalizeForkSummary(rawSummary: any): ForkSummary {
    const summary = { ...(rawSummary ?? {}) };
    summary.agentRules = this.normalizeAgentRules(summary);
    delete summary.implRules;
    delete summary.validationRules;
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

  private legacyConvoDir(workspaceRoot: string, conversationId: string): string {
    return path.join(this.home, "workspaces", this.workspaceId(workspaceRoot), "conversations", conversationId);
  }

  private indexPath(workspaceRoot: string, conversationId: string): string {
    return path.join(this.convoDir(workspaceRoot, conversationId), "index.json");
  }

  private forkPath(workspaceRoot: string, conversationId: string, forkId: string): string {
    return path.join(this.convoDir(workspaceRoot, conversationId), "forks", `${forkId}.json`);
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
      const migrated = await this.migrateLegacyConversation(workspaceRoot, conversationId);
      if (migrated) return migrated;
      const idx: ConversationIndex = { conversationId, headId: undefined, headIds: [], forks: [] };
      await fs.writeFile(p, JSON.stringify(idx, null, 2), "utf-8");
      return idx;
    }
  }

  async saveIndex(workspaceRoot: string, conversationId: string, idx: ConversationIndex): Promise<void> {
    const p = this.indexPath(workspaceRoot, conversationId);
    const normalized = this.normalizeIndex(idx);
    await fs.writeFile(p, JSON.stringify(normalized, null, 2), "utf-8");
  }

  async saveFork(workspaceRoot: string, conversationId: string, fork: ForkMeta): Promise<void> {
    const p = this.forkPath(workspaceRoot, conversationId, fork.id);
    const persist: ForkMeta = { ...fork };
    if (persist.storage === "patch") {
      delete (persist as any).documentText;
    }
    await fs.writeFile(p, JSON.stringify(persist, null, 2), "utf-8");
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
      model: fork.model,
      agentModel: fork.agentModel,
      supervisorModel: fork.supervisorModel,
    };
  }

  private async migrateLegacyConversation(workspaceRoot: string, conversationId: string): Promise<ConversationIndex | null> {
    const legacyDir = this.legacyConvoDir(workspaceRoot, conversationId);
    const legacyIndexPath = path.join(legacyDir, "index.json");
    let legacyRaw = "";
    try {
      legacyRaw = await fs.readFile(legacyIndexPath, "utf-8");
    } catch {
      return null;
    }
    const legacyIndex = JSON.parse(legacyRaw) as any;
    const legacyForksDir = path.join(legacyDir, "forks");
    const forkMap = new Map<string, any>();
    if (Array.isArray(legacyIndex?.forks)) {
      for (const f of legacyIndex.forks) {
        if (f && f.id) forkMap.set(String(f.id), f);
      }
    }
    try {
      const files = await fs.readdir(legacyForksDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(legacyForksDir, file), "utf-8");
        const data = JSON.parse(raw) as any;
        if (data && data.id) forkMap.set(String(data.id), data);
      }
    } catch {
      // ignore
    }

    const remaining = new Map(forkMap);
    const processed = new Set<string>();
    let safety = 0;
    while (remaining.size > 0 && safety < remaining.size * 4) {
      safety += 1;
      let progressed = false;
      for (const [id, fork] of remaining) {
        const parentId = fork.parentId ? String(fork.parentId) : undefined;
        if (parentId && !processed.has(parentId)) continue;
        const docText = typeof fork.documentText === "string" ? fork.documentText : "";
        await this.createFork({
          workspaceRoot,
          conversationId,
          parentId,
          documentText: docText,
          forkId: String(id),
          createdAt: fork.createdAt,
          label: fork.label,
          forkSummary: fork.forkSummary,
          agentRules: this.normalizeAgentRules(fork),
          providerThreadId: fork.providerThreadId,
          supervisorThreadId: fork.supervisorThreadId,
          providerName: fork.providerName,
          model: fork.model,
          agentModel: fork.agentModel,
          supervisorModel: fork.supervisorModel,
          actions: fork.actions,
          actionSummary: fork.actionSummary,
        });
        processed.add(id);
        remaining.delete(id);
        progressed = true;
      }
      if (!progressed) break;
    }

    const idx = await this.loadIndex(workspaceRoot, conversationId);
    const allIds = idx.forks.map((f) => f.id);
    const parentIds = new Set(idx.forks.map((f) => f.parentId).filter(Boolean) as string[]);
    const heads = allIds.filter((id) => !parentIds.has(id));
    idx.headIds = heads;
    if (legacyIndex?.headId && allIds.includes(legacyIndex.headId)) {
      idx.headId = legacyIndex.headId;
    } else {
      idx.headId = heads[0];
    }
    await this.saveIndex(workspaceRoot, conversationId, idx);
    return idx;
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
