/**
 * Handler-level coverage for the backend seam.
 *
 * The pre-existing suite is a weak regression check for the rewiring in
 * `createServer`: the filesystem tests construct `FileSystemService` directly
 * and would keep passing even if a handler were wired to the wrong backend
 * method. These tests drive the real MCP handlers through an in-memory client
 * with a recording backend, so a case left pointing at `fileSystem` — or an
 * unrouted case wired to the backend by mistake — fails here.
 */
import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { createServer } from "./createServer.js";
import { FileSystemBackend } from "./backend/filesystem/index.js";
import { FileSystemService } from "./filesystem.js";
import type { VaultBackend } from "./backend/types.js";
import type {
  BatchReadParams,
  DeleteNoteParams,
  MoveFileParams,
  MoveNoteParams,
  NoteWriteParams,
  PatchNoteParams,
  TagManagementParams,
  UpdateFrontmatterParams,
} from "./types.js";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/** Records which backend methods a handler touched, then delegates for real. */
class RecordingBackend implements VaultBackend {
  readonly name = "filesystem" as const;
  readonly calls: string[] = [];

  constructor(private readonly inner: VaultBackend) {}

  private record<T>(method: string, run: () => Promise<T>): Promise<T> {
    this.calls.push(method);
    return run();
  }

  readNote(path: string) {
    return this.record("readNote", () => this.inner.readNote(path));
  }
  readMultipleNotes(params: BatchReadParams) {
    return this.record("readMultipleNotes", () => this.inner.readMultipleNotes(params));
  }
  getNotesInfo(paths: string[]) {
    return this.record("getNotesInfo", () => this.inner.getNotesInfo(paths));
  }
  writeNote(params: NoteWriteParams) {
    return this.record("writeNote", () => this.inner.writeNote(params));
  }
  patchNote(params: PatchNoteParams) {
    return this.record("patchNote", () => this.inner.patchNote(params));
  }
  deleteNote(params: DeleteNoteParams) {
    return this.record("deleteNote", () => this.inner.deleteNote(params));
  }
  moveNote(params: MoveNoteParams) {
    return this.record("moveNote", () => this.inner.moveNote(params));
  }
  moveFile(params: MoveFileParams) {
    return this.record("moveFile", () => this.inner.moveFile(params));
  }
  listDirectory(path: string) {
    return this.record("listDirectory", () => this.inner.listDirectory(path));
  }
  getFrontmatter(path: string) {
    return this.record("getFrontmatter", () => this.inner.getFrontmatter(path));
  }
  updateFrontmatter(params: UpdateFrontmatterParams) {
    return this.record("updateFrontmatter", () => this.inner.updateFrontmatter(params));
  }
  manageTags(params: TagManagementParams) {
    return this.record("manageTags", () => this.inner.manageTags(params));
  }
  listAllTags() {
    return this.record("listAllTags", () => this.inner.listAllTags());
  }
}

let testVaultPath: string;
let recorder: RecordingBackend;
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-routing-"));
  recorder = new RecordingBackend(new FileSystemBackend(new FileSystemService(testVaultPath)));

  const server = createServer(testVaultPath, { version: "1.0.0", backend: recorder });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "routing-test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  close = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  try {
    await close();
  } catch {
    // Ignore teardown errors
  }
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

function text(result: any): string {
  return result.content[0].text as string;
}

async function seed(path: string, content: string): Promise<void> {
  const fullPath = join(testVaultPath, path);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

// ============================================================================
// Every routed tool reaches the backend, and returns a well-formed response
// ============================================================================

describe("routed tools go through the backend", () => {
  test("read_note", async () => {
    await seed("r.md", "---\nk: v\n---\n\n# Body");
    const result = await client.callTool({ name: "read_note", arguments: { path: "r.md" } });

    expect(recorder.calls).toEqual(["readNote"]);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text(result));
    expect(parsed.fm).toEqual({ k: "v" });
    expect(parsed.content).toContain("# Body");
  });

  test("write_note", async () => {
    const result = await client.callTool({
      name: "write_note",
      arguments: { path: "w.md", content: "# Written" },
    });

    expect(recorder.calls).toEqual(["writeNote"]);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Successfully wrote note: w.md");
  });

  test("patch_note", async () => {
    await seed("p.md", "alpha beta");
    const result = await client.callTool({
      name: "patch_note",
      arguments: { path: "p.md", oldString: "beta", newString: "gamma" },
    });

    expect(recorder.calls).toEqual(["patchNote"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).success).toBe(true);
  });

  test("list_directory", async () => {
    await seed("sub/child.md", "child");
    const result = await client.callTool({ name: "list_directory", arguments: { path: "" } });

    expect(recorder.calls).toEqual(["listDirectory"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).dirs).toContain("sub");
  });

  test("delete_note", async () => {
    await seed("d.md", "gone");
    const result = await client.callTool({
      name: "delete_note",
      arguments: { path: "d.md", confirmPath: "d.md" },
    });

    expect(recorder.calls).toEqual(["deleteNote"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).success).toBe(true);
  });

  test("move_note", async () => {
    await seed("m.md", "moving");
    const result = await client.callTool({
      name: "move_note",
      arguments: { oldPath: "m.md", newPath: "moved.md" },
    });

    expect(recorder.calls).toEqual(["moveNote"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).newPath).toBe("moved.md");
  });

  test("move_file", async () => {
    await seed("f.txt", "bytes");
    const result = await client.callTool({
      name: "move_file",
      arguments: {
        oldPath: "f.txt",
        newPath: "renamed.txt",
        confirmOldPath: "f.txt",
        confirmNewPath: "renamed.txt",
      },
    });

    expect(recorder.calls).toEqual(["moveFile"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).newPath).toBe("renamed.txt");
  });

  test("read_multiple_notes", async () => {
    await seed("a.md", "A");
    await seed("b.md", "B");
    const result = await client.callTool({
      name: "read_multiple_notes",
      arguments: { paths: ["a.md", "b.md"] },
    });

    expect(recorder.calls).toEqual(["readMultipleNotes"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).ok).toHaveLength(2);
  });

  test("update_frontmatter", async () => {
    await seed("u.md", "---\nkeep: yes\n---\n\nbody");
    const result = await client.callTool({
      name: "update_frontmatter",
      arguments: { path: "u.md", frontmatter: { added: "now" } },
    });

    expect(recorder.calls).toEqual(["updateFrontmatter"]);
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("Successfully updated frontmatter for: u.md");
  });

  test("get_notes_info", async () => {
    await seed("i.md", "---\nk: v\n---\n\nbody");
    const result = await client.callTool({ name: "get_notes_info", arguments: { paths: ["i.md"] } });

    expect(recorder.calls).toEqual(["getNotesInfo"]);
    expect(result.isError).toBeFalsy();
    const info = JSON.parse(text(result));
    expect(info).toHaveLength(1);
    expect(info[0].path).toBe("i.md");
  });

  test("get_frontmatter uses getFrontmatter, not readNote", async () => {
    await seed("g.md", "---\ntitle: T\n---\n\nbody text");
    const result = await client.callTool({ name: "get_frontmatter", arguments: { path: "g.md" } });

    expect(recorder.calls).toEqual(["getFrontmatter"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ title: "T" });
  });

  test("manage_tags", async () => {
    await seed("t.md", "---\ntags:\n  - keep\n---\n\nbody");
    const result = await client.callTool({
      name: "manage_tags",
      arguments: { path: "t.md", operation: "add", tags: ["added"] },
    });

    expect(recorder.calls).toEqual(["manageTags"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).tags).toContain("added");
  });

  test("list_all_tags", async () => {
    await seed("t.md", "---\ntags:\n  - alpha\n---\n\nbody");
    const result = await client.callTool({ name: "list_all_tags", arguments: {} });

    expect(recorder.calls).toEqual(["listAllTags"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual([{ tag: "alpha", count: 1 }]);
  });
});

// ============================================================================
// The three unrouted tools must never consult the backend
// ============================================================================

describe("unrouted tools never consult the backend", () => {
  test("search_notes", async () => {
    await seed("s.md", "findable content");
    const result = await client.callTool({
      name: "search_notes",
      arguments: { query: "findable" },
    });

    expect(recorder.calls).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))[0].p).toBe("s.md");
  });

  test("get_vault_stats", async () => {
    await seed("s.md", "content");
    const result = await client.callTool({ name: "get_vault_stats", arguments: {} });

    expect(recorder.calls).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).notes).toBe(1);
  });

  test("wiki_link", async () => {
    await seed("Note.md", "# Note\n\nbody");
    const result = await client.callTool({ name: "wiki_link", arguments: { document: "Note" } });

    expect(recorder.calls).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as any).path).toBe("Note.md");
  });
});

// ============================================================================
// Failure paths are unchanged: rejection still happens, and still at the seam
// ============================================================================

describe("missing paths are rejected as before", () => {
  test("read_note on a missing note errors", async () => {
    const result = await client.callTool({ name: "read_note", arguments: { path: "nope.md" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Error:");
  });

  test("get_frontmatter on a missing note errors", async () => {
    const result = await client.callTool({ name: "get_frontmatter", arguments: { path: "nope.md" } });
    expect(recorder.calls).toEqual(["getFrontmatter"]);
    expect(result.isError).toBe(true);
  });

  test("patch_note on a missing note reports failure", async () => {
    const result = await client.callTool({
      name: "patch_note",
      arguments: { path: "nope.md", oldString: "a", newString: "b" },
    });
    expect(result.isError).toBe(true);
  });

  test("move_note from a missing source reports failure", async () => {
    const result = await client.callTool({
      name: "move_note",
      arguments: { oldPath: "nope.md", newPath: "somewhere.md" },
    });
    expect(result.isError).toBe(true);
  });

  test("read_multiple_notes reports the missing path in the failed list", async () => {
    await seed("a.md", "A");
    const result = await client.callTool({
      name: "read_multiple_notes",
      arguments: { paths: ["a.md", "gone.md"] },
    });
    const parsed = JSON.parse(text(result));
    expect(parsed.ok).toHaveLength(1);
    expect(parsed.err.map((e: any) => e.path)).toEqual(["gone.md"]);
  });
});

describe("paths outside the vault are rejected for every routed tool", () => {
  const escape = "../outside.md";

  const singlePathTools: Array<[string, Record<string, unknown>]> = [
    ["read_note", { path: escape }],
    ["get_frontmatter", { path: escape }],
    ["write_note", { path: escape, content: "nope" }],
    ["patch_note", { path: escape, oldString: "a", newString: "b" }],
    ["list_directory", { path: escape }],
    ["delete_note", { path: escape, confirmPath: escape }],
    ["move_note", { oldPath: escape, newPath: "inside.md" }],
    [
      "move_file",
      {
        oldPath: escape,
        newPath: "inside.txt",
        confirmOldPath: escape,
        confirmNewPath: "inside.txt",
      },
    ],
    ["update_frontmatter", { path: escape, frontmatter: { a: 1 } }],
    ["manage_tags", { path: escape, operation: "list" }],
  ];

  for (const [tool, args] of singlePathTools) {
    test(`${tool} rejects ${escape}`, async () => {
      const result = await client.callTool({ name: tool, arguments: args });
      expect(recorder.calls).toHaveLength(1);
      expect(result.isError).toBe(true);
    });
  }

  test("read_multiple_notes puts the escaping path in the failed list", async () => {
    const result = await client.callTool({
      name: "read_multiple_notes",
      arguments: { paths: [escape] },
    });
    const parsed = JSON.parse(text(result));
    expect(parsed.ok).toEqual([]);
    expect(parsed.err).toHaveLength(1);
  });

  test("get_notes_info drops the escaping path rather than returning it", async () => {
    const result = await client.callTool({
      name: "get_notes_info",
      arguments: { paths: [escape] },
    });
    expect(JSON.parse(text(result))).toEqual([]);
  });
});

// ============================================================================
// Default wiring
// ============================================================================

test("omitting the backend option still serves routed tools from the filesystem", async () => {
  const vault = await mkdtemp(join(tmpdir(), "mcpvault-routing-default-"));
  const server = createServer(vault, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const defaultClient = new Client({ name: "default-client", version: "1.0.0" });
  await Promise.all([defaultClient.connect(clientTransport), server.connect(serverTransport)]);

  try {
    await defaultClient.callTool({
      name: "write_note",
      arguments: { path: "d.md", content: "# Default" },
    });
    const result = await defaultClient.callTool({ name: "read_note", arguments: { path: "d.md" } });
    expect(JSON.parse(text(result)).content).toContain("# Default");
  } finally {
    await defaultClient.close();
    await server.close();
    await rm(vault, { recursive: true });
  }
});

test("passing backend: undefined falls through to the default", async () => {
  const vault = await mkdtemp(join(tmpdir(), "mcpvault-routing-undef-"));
  const server = createServer(vault, { version: "1.0.0", backend: undefined });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const undefClient = new Client({ name: "undef-client", version: "1.0.0" });
  await Promise.all([undefClient.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const result = await undefClient.callTool({
      name: "write_note",
      arguments: { path: "u.md", content: "# Undefined" },
    });
    expect(result.isError).toBeFalsy();
  } finally {
    await undefClient.close();
    await server.close();
    await rm(vault, { recursive: true });
  }
});
