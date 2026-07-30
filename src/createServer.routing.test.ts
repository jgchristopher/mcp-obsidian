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
import type { PeriodicNoteParams, VaultBackend } from "./backend/types.js";
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
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "fs/promises";
import { startFixture } from "./backend/testing/fixture-server.js";
import type { Fixture } from "./backend/testing/fixture-server.js";
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
  getPeriodicNote(params: PeriodicNoteParams) {
    return this.record("getPeriodicNote", () => this.inner.getPeriodicNote(params));
  }
  getDocumentMap(path: string) {
    return this.record("getDocumentMap", () => this.inner.getDocumentMap(path));
  }
}

let testVaultPath: string;
let recorder: RecordingBackend;
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-routing-"));
  recorder = new RecordingBackend(new FileSystemBackend(new FileSystemService(testVaultPath)));

  // `env: {}` keeps these hermetic: without it, a developer with
  // OBSIDIAN_API_KEY exported would get a real REST client behind the
  // REST-only tools and the "no Obsidian" expectations below would not hold.
  const server = createServer(testVaultPath, { version: "1.0.0", backend: recorder, env: {} });
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

  test("get_periodic_note", async () => {
    await seed(".obsidian/daily-notes.json", JSON.stringify({ folder: "D", format: "YYYY-MM-DD" }));
    await seed("D/2026-07-30.md", "# Thursday");
    const result = await client.callTool({
      name: "get_periodic_note",
      arguments: { period: "daily", date: "2026-07-30" },
    });

    expect(recorder.calls).toEqual(["getPeriodicNote"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({
      period: "daily",
      path: "D/2026-07-30.md",
      exists: true,
    });
  });

  test("get_periodic_note defaults to today without a date argument", async () => {
    await seed(".obsidian/daily-notes.json", JSON.stringify({ folder: "D", format: "YYYY-MM-DD" }));
    const result = await client.callTool({ name: "get_periodic_note", arguments: {} });

    expect(recorder.calls).toEqual(["getPeriodicNote"]);
    const now = new Date();
    const expected = `D/${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}.md`;
    expect(JSON.parse(text(result)).path).toBe(expected);
  });

  test("get_periodic_note rejects a malformed date before touching the backend", async () => {
    const result = await client.callTool({
      name: "get_periodic_note",
      arguments: { date: "30/07/2026" },
    });

    expect(recorder.calls).toEqual([]);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Use YYYY-MM-DD");
  });

  test("get_document_map", async () => {
    await seed("map.md", "---\nk: v\n---\n\n# Top\n\n## Under\n\nline ^ref1\n");
    const result = await client.callTool({
      name: "get_document_map",
      arguments: { path: "map.md" },
    });

    expect(recorder.calls).toEqual(["getDocumentMap"]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({
      headings: [
        { path: "Top", level: 1, line: 2 },
        { path: "Top::Under", level: 2, line: 4 },
      ],
      blockRefs: ["ref1"],
      frontmatterKeys: ["k"],
    });
  });
});

// ============================================================================
// The unrouted tools must never consult the backend
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

  test("get_recent_changes stays filesystem-native and honors limit and days", async () => {
    await seed("recent.md", "fresh");
    await seed("stale.md", "old");
    const staleTime = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    await utimes(join(testVaultPath, "stale.md"), staleTime, staleTime);

    const windowed = await client.callTool({ name: "get_recent_changes", arguments: {} });
    expect(recorder.calls).toEqual([]);
    expect(JSON.parse(text(windowed)).map((entry: any) => entry.path)).toEqual(["recent.md"]);

    const widened = await client.callTool({
      name: "get_recent_changes",
      arguments: { days: 365 },
    });
    expect(JSON.parse(text(widened)).map((entry: any) => entry.path).sort()).toEqual([
      "recent.md",
      "stale.md",
    ]);

    const capped = await client.callTool({
      name: "get_recent_changes",
      arguments: { days: 365, limit: 1 },
    });
    expect(JSON.parse(text(capped))).toHaveLength(1);
  });

  test("get_recent_changes falls back to its defaults for unusable numbers", async () => {
    await seed("recent.md", "fresh");

    // NaN survives Math.min/Math.max, and a NaN bound silently returns nothing.
    const garbage = await client.callTool({
      name: "get_recent_changes",
      arguments: { limit: "lots", days: "forever" },
    });

    expect(garbage.isError).toBeFalsy();
    expect(JSON.parse(text(garbage)).map((entry: any) => entry.path)).toEqual(["recent.md"]);
  });

  test("get_recent_changes caps limit at 100", async () => {
    await seed("only.md", "one");

    const result = await client.callTool({
      name: "get_recent_changes",
      arguments: { limit: 100_000 },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toHaveLength(1);
  });

  test("get_recent_periodic_notes stays filesystem-native and skips missing dates", async () => {
    await seed(".obsidian/daily-notes.json", JSON.stringify({ folder: "D", format: "YYYY-MM-DD" }));
    const today = new Date();
    const stamp = (back: number): string => {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
      return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    };
    await seed(`D/${stamp(0)}.md`, "# Today");
    await seed(`D/${stamp(2)}.md`, "# Two days ago");

    const result = await client.callTool({
      name: "get_recent_periodic_notes",
      arguments: { limit: 5 },
    });

    expect(recorder.calls).toEqual([]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).map((entry: any) => entry.path)).toEqual([
      `D/${stamp(0)}.md`,
      `D/${stamp(2)}.md`,
    ]);
  });

  test("get_recent_periodic_notes can drop content", async () => {
    await seed(".obsidian/daily-notes.json", JSON.stringify({ folder: "D", format: "YYYY-MM-DD" }));
    const today = new Date();
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await seed(`D/${stamp}.md`, "# Today");

    const result = await client.callTool({
      name: "get_recent_periodic_notes",
      arguments: { includeContent: false },
    });

    const [first] = JSON.parse(text(result));
    expect(first).toEqual({ period: "daily", path: `D/${stamp}.md`, exists: true, frontmatter: {} });
  });
});

// ============================================================================
// The five REST-only tools fail closed rather than degrading to the filesystem
// ============================================================================

describe("REST-only tools with no Obsidian", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["list_commands", {}],
    ["execute_command", { commandId: "app:open-vault" }],
    ["get_active_file", {}],
    ["open_file", { path: "any.md" }],
    ["search_vault_advanced", { query: { var: "path" } }],
  ];

  test.each(calls)("%s reports that Obsidian is not reachable", async (name, args) => {
    const result = await client.callTool({ name, arguments: args });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain(`'${name}' requires a running Obsidian`);
    // Nothing quietly fell back to the filesystem behind the error.
    expect(recorder.calls).toEqual([]);
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
  // `env: {}` pins this to the no-REST path: the point is the default backend,
  // not whatever OBSIDIAN_API_KEY the developer's shell happens to carry.
  const server = createServer(vault, { version: "1.0.0", env: {} });
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
  const server = createServer(vault, { version: "1.0.0", backend: undefined, env: {} });
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

// ============================================================================
// REST wiring
// ============================================================================

/**
 * `createServer` builds the router only when `resolveRestConfig()` finds a key.
 * These drive the real MCP handlers against the in-process fixture, so the
 * whole chain — config, client, RestBackend, Health, RoutingBackend — is under
 * test, not just its parts.
 */
describe("REST wiring", () => {
  let vault: string;
  let fixture: Fixture;
  let warnings: string[];
  let restClient: Client;
  let teardown: () => Promise<void>;

  async function boot(files: Record<string, string>, env: NodeJS.ProcessEnv): Promise<void> {
    vault = await mkdtemp(join(tmpdir(), "mcpvault-rest-wiring-"));
    for (const [path, content] of Object.entries(files)) {
      const full = join(vault, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    warnings = [];
    const server = createServer(vault, {
      version: "1.0.0",
      env,
      onWarn: (message) => warnings.push(message),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    restClient = new Client({ name: "rest-wiring-client", version: "1.0.0" });
    await Promise.all([restClient.connect(clientTransport), server.connect(serverTransport)]);
    teardown = async () => {
      await restClient.close();
      await server.close();
    };
  }

  function envFor(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return {
      OBSIDIAN_API_KEY: "wiring-key",
      OBSIDIAN_HOST: "127.0.0.1",
      OBSIDIAN_PORT: String(fixture.port),
      OBSIDIAN_PROTOCOL: "http",
      ...overrides,
    };
  }

  afterEach(async () => {
    try {
      await teardown();
    } catch {
      // Ignore teardown errors
    }
    await fixture.close().catch(() => {});
    await rm(vault, { recursive: true, force: true });
  });

  test("with OBSIDIAN_API_KEY unset, nothing reaches the Local REST API", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    await boot({ "root.md": "# Root" }, {});

    const result = await restClient.callTool({
      name: "write_note",
      arguments: { path: "root.md", content: "# Written by filesystem" },
    });

    expect(result.isError).toBeFalsy();
    expect(fixture.requests, "no request should have been made at all").toEqual([]);
    expect(await readFile(join(vault, "root.md"), "utf-8")).toBe("# Written by filesystem");
  });

  test("with a matching vault, writes are served by the Local REST API", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({
      name: "write_note",
      arguments: { path: "root.md", content: "# Written by REST" },
    });

    expect(result.isError).toBeFalsy();
    expect(fixture.files.get("root.md")).toBe("# Written by REST");
    // The filesystem copy is untouched: REST served it, nothing double-applied.
    expect(await readFile(join(vault, "root.md"), "utf-8")).toBe("# Root");
    expect(warnings).toEqual([]);
  });

  test("a vault fingerprint mismatch keeps writes on the filesystem and warns", async () => {
    fixture = await startFixture({ files: { "someone-elses-vault.md": "# Elsewhere" } });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({
      name: "write_note",
      arguments: { path: "root.md", content: "# Written by filesystem" },
    });

    expect(result.isError).toBeFalsy();
    expect(await readFile(join(vault, "root.md"), "utf-8")).toBe("# Written by filesystem");
    expect(fixture.files.has("root.md"), "the wrong vault must not be written").toBe(false);
    expect(warnings.join("\n")).toMatch(/fingerprint mismatch/i);
  });

  test("an unreachable Obsidian falls back without an error", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    const port = fixture.port;
    await fixture.close();
    await boot({ "root.md": "# Root" }, envFor({ OBSIDIAN_PORT: String(port) }));

    const result = await restClient.callTool({ name: "read_note", arguments: { path: "root.md" } });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result)).content).toContain("# Root");
  });

  // The five REST-only tools share the client the backend uses, but not the
  // seam. These prove the env-to-handler wiring, not the service itself —
  // src/backend/live.test.ts covers the behavior.

  test("list_commands reaches the Local REST API", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({ name: "list_commands", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))[0].id).toBe("app:open-vault");
  });

  test("execute_command reaches the Local REST API", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({
      name: "execute_command",
      arguments: { commandId: "app:open-vault" },
    });

    expect(result.isError).toBeFalsy();
    expect(fixture.executedCommands).toEqual(["app:open-vault"]);
  });

  test("get_active_file reaches the Local REST API", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" }, activeFile: "root.md" });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({ name: "get_active_file", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ path: "root.md" });
  });

  test("open_file reaches the Local REST API", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({
      name: "open_file",
      arguments: { path: "root.md" },
    });

    expect(result.isError).toBeFalsy();
    expect(fixture.openedFiles).toEqual(["root.md"]);
  });

  test("search_vault_advanced reaches the Local REST API as JsonLogic", async () => {
    fixture = await startFixture({ files: { "root.md": "# Root" } });
    await boot({ "root.md": "# Root" }, envFor());

    const result = await restClient.callTool({
      name: "search_vault_advanced",
      arguments: { query: { var: "path" } },
    });

    expect(result.isError).toBeFalsy();
    const search = fixture.requests.find((entry) => entry.path === "/search/");
    expect(search?.headers["content-type"]).toBe("application/vnd.olrapi.jsonlogic+json");
  });
});
