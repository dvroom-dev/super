import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SupervisorStore } from "./store.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("SupervisorStore", () => {
  let tempDir: string;
  let store: SupervisorStore;
  let workspaceRoot: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    store = new SupervisorStore({ supervisorHome: tempDir });
    workspaceRoot = path.join(tempDir, "workspace");
    await fs.mkdir(workspaceRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    it("uses provided supervisorHome", () => {
      expect(store.getSupervisorHome()).toBe(tempDir);
    });

    it("uses default home when not provided", () => {
      const defaultStore = new SupervisorStore();
      expect(defaultStore.getSupervisorHome()).toContain(".ai-supervisor-studio");
    });
  });

  describe("workspaceId", () => {
    it("generates consistent hash for same path", () => {
      const id1 = store.workspaceId("/path/to/workspace");
      const id2 = store.workspaceId("/path/to/workspace");
      expect(id1).toBe(id2);
    });

    it("generates different hash for different paths", () => {
      const id1 = store.workspaceId("/path/one");
      const id2 = store.workspaceId("/path/two");
      expect(id1).not.toBe(id2);
    });

    it("returns 64-char hex string", () => {
      const id = store.workspaceId("/any/path");
      expect(id).toHaveLength(64);
      expect(id).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("conversationIdFromPath", () => {
    it("generates consistent hash for same doc path", () => {
      const id1 = store.conversationIdFromPath("/doc/path.md");
      const id2 = store.conversationIdFromPath("/doc/path.md");
      expect(id1).toBe(id2);
    });

    it("generates different hash for different doc paths", () => {
      const id1 = store.conversationIdFromPath("/doc/one.md");
      const id2 = store.conversationIdFromPath("/doc/two.md");
      expect(id1).not.toBe(id2);
    });
  });

  describe("isHistoryEdited", () => {
    it("returns false when next doc extends prev doc", () => {
      const prev = "Some content";
      const next = "Some content\nMore content";
      expect(store.isHistoryEdited(prev, next)).toBe(false);
    });

    it("returns true when next doc modifies prev doc", () => {
      const prev = "Some content";
      const next = "Different content";
      expect(store.isHistoryEdited(prev, next)).toBe(true);
    });

    it("handles trailing whitespace", () => {
      const prev = "Content   \n\n";
      const next = "Content\nMore";
      expect(store.isHistoryEdited(prev, next)).toBe(false);
    });

    it("returns true when content is removed", () => {
      const prev = "Long content here";
      const next = "Long";
      expect(store.isHistoryEdited(prev, next)).toBe(true);
    });

    it("returns false for identical docs", () => {
      const doc = "Same content";
      expect(store.isHistoryEdited(doc, doc)).toBe(false);
    });
  });

  describe("deriveLabelFromDoc", () => {
    it("extracts label from last user message", () => {
      const doc = `\`\`\`chat role=user
First message
\`\`\`

\`\`\`chat role=assistant
Response
\`\`\`

\`\`\`chat role=user
This is the label text
\`\`\``;
      const label = store.deriveLabelFromDoc(doc);
      expect(label).toBe("This is the label text");
    });

    it("truncates long labels to 80 chars", () => {
      const longMessage = "A".repeat(100);
      const doc = `\`\`\`chat role=user\n${longMessage}\n\`\`\``;
      const label = store.deriveLabelFromDoc(doc);
      expect(label).toHaveLength(80);
    });

    it("uses first line of multiline message", () => {
      const doc = `\`\`\`chat role=user
First line
Second line
Third line
\`\`\``;
      const label = store.deriveLabelFromDoc(doc);
      expect(label).toBe("First line");
    });

    it("returns 'Conversation' when no user message", () => {
      const doc = `\`\`\`chat role=assistant
Only assistant
\`\`\``;
      const label = store.deriveLabelFromDoc(doc);
      expect(label).toBe("Conversation");
    });

    it("returns 'Conversation' for empty doc", () => {
      const label = store.deriveLabelFromDoc("");
      expect(label).toBe("Conversation");
    });
  });

  describe("loadIndex", () => {
    it("creates new index if none exists", async () => {
      const idx = await store.loadIndex(workspaceRoot, "conv123");
      expect(idx.conversationId).toBe("conv123");
      expect(idx.headId).toBeUndefined();
      expect(idx.headIds).toEqual([]);
      expect(idx.forks).toEqual([]);
    });

    it("creates necessary directories", async () => {
      await store.loadIndex(workspaceRoot, "conv123");
      const dir = path.join(workspaceRoot, ".ai-supervisor", "conversations", "conv123", "forks");
      const stat = await fs.stat(dir);
      expect(stat.isDirectory()).toBe(true);
    });

    it("loads existing index", async () => {
      // Create first, then load
      const idx1 = await store.loadIndex(workspaceRoot, "conv123");
      idx1.headId = "fork_1";
      idx1.headIds = ["fork_1"];
      await store.saveIndex(workspaceRoot, "conv123", idx1);

      const idx2 = await store.loadIndex(workspaceRoot, "conv123");
      expect(idx2.headId).toBe("fork_1");
      expect(idx2.headIds).toEqual(["fork_1"]);
    });

    it("fails loudly on malformed index data", async () => {
      const indexPath = path.join(workspaceRoot, ".ai-supervisor", "conversations", "conv123", "index.json");
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(indexPath, "{not-json", "utf8");

      await expect(store.loadIndex(workspaceRoot, "conv123")).rejects.toThrow("conversation index is unreadable");
    });
  });

  describe("saveIndex and loadIndex roundtrip", () => {
    it("persists and retrieves index", async () => {
      const idx = await store.loadIndex(workspaceRoot, "conv123");
      idx.headId = "head_id";
      idx.headIds = ["head_id"];
      idx.forks = [
        {
          id: "fork_1",
          createdAt: "2024-01-01T00:00:00Z",
          label: "Test fork",
          storage: "snapshot",
          docHash: "hash",
          baseHash: undefined,
          agentRules: ["rule1", "check1"],
        },
      ];
      await store.saveIndex(workspaceRoot, "conv123", idx);

      const loaded = await store.loadIndex(workspaceRoot, "conv123");
      expect(loaded.headId).toBe("head_id");
      expect(loaded.headIds).toEqual(["head_id"]);
      expect(loaded.forks).toHaveLength(1);
      expect(loaded.forks[0].label).toBe("Test fork");
    });
  });

  describe("createFork", () => {
    it("creates fork with correct structure", async () => {
      const fork = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nTest message\n```",
        agentRules: ["rule1", "check1"],
        providerName: "codex",
        model: "gpt-4",
      });

      expect(fork.id).toMatch(/^fork_/);
      expect(fork.label).toBe("Test message");
      expect(fork.documentText).toContain("Test message");
      expect(fork.storage).toBe("snapshot");
      expect(fork.agentRules).toEqual(["rule1", "check1"]);
      expect(fork.providerName).toBe("codex");
      expect(fork.model).toBe("gpt-4");
      expect(fork.createdAt).toBeDefined();
    });

    it("sets parentId when provided", async () => {
      const parent = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nParent fork\n```",
        agentRules: [],
      });

      const fork = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        parentId: parent.id,
        documentText: "```chat role=user\nChild fork\n```",
        agentRules: [],
      });

      expect(fork.parentId).toBe(parent.id);
    });

    it("updates index headId", async () => {
      const fork = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nTest\n```",
        agentRules: [],
      });

      const idx = await store.loadIndex(workspaceRoot, "conv123");
      expect(idx.headId).toBe(fork.id);
    });

    it("adds fork to index forks array", async () => {
      await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nFork 1\n```",
        agentRules: [],
      });

      await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nFork 2\n```",
        agentRules: [],
      });

      const idx = await store.loadIndex(workspaceRoot, "conv123");
      expect(idx.forks).toHaveLength(2);
    });

    it("saves fork to file", async () => {
      const fork = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nTest\n```",
        agentRules: [],
      });

      const loaded = await store.loadFork(workspaceRoot, "conv123", fork.id);
      expect(loaded.id).toBe(fork.id);
      expect(loaded.label).toBe(fork.label);
    });

    it("stores child forks as patches", async () => {
      const parent = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nParent\n```",
        agentRules: [],
      });

      const childText = "```chat role=user\nParent\n```\n\n```chat role=assistant\nReply\n```";
      const child = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        parentId: parent.id,
        documentText: childText,
        agentRules: [],
      });

      expect(child.storage).toBe("patch");
      expect(child.documentText).toBeUndefined();
      expect(child.patch).toBeDefined();

      const loaded = await store.loadFork(workspaceRoot, "conv123", child.id);
      expect(loaded.documentText).toBe(childText);
    });

    it("updates headIds when branching", async () => {
      const root = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nRoot\n```",
        agentRules: [],
      });

      const a = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        parentId: root.id,
        documentText: "```chat role=user\nRoot\n```\n\n```chat role=assistant\nA\n```",
        agentRules: [],
      });

      const b = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        parentId: root.id,
        documentText: "```chat role=user\nRoot\n```\n\n```chat role=assistant\nB\n```",
        agentRules: [],
      });

      const idx = await store.loadIndex(workspaceRoot, "conv123");
      expect(idx.headIds).toEqual(expect.arrayContaining([a.id, b.id]));
      expect(idx.headIds).not.toContain(root.id);
    });
  });

  describe("loadFork", () => {
    it("loads saved fork", async () => {
      const created = await store.createFork({
        workspaceRoot,
        conversationId: "conv123",
        documentText: "```chat role=user\nTest content\n```",
        agentRules: ["rule", "check"],
        providerThreadId: "thread_123",
      });

      const loaded = await store.loadFork(workspaceRoot, "conv123", created.id);
      expect(loaded.documentText).toBe(created.documentText);
      expect(loaded.providerThreadId).toBe("thread_123");
    });

    it("throws when fork does not exist", async () => {
      await store.loadIndex(workspaceRoot, "conv123"); // Ensure dirs exist
      await expect(store.loadFork(workspaceRoot, "conv123", "nonexistent")).rejects.toThrow();
    });
  });
});
