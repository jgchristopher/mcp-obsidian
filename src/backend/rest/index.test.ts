import { test, expect, beforeEach, afterEach } from "vitest";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RestBackend, RestConfigurationError } from "./index.js";
import { RestClient } from "./client.js";
import { BackendError } from "../types.js";
import { generateObsidianUri } from "../../uri.js";
import { startFixture } from "../testing/fixture-server.js";
import type { Fixture, FixtureOptions } from "../testing/fixture-server.js";

/**
 * Every routed operation against the fixture: one happy path plus the failure
 * status the real plugin returns for it.
 */

const VAULT = "/tmp/mcpvault-rest-test-vault";

const SEED: Record<string, string> = {
  "alpha.md": "---\ntitle: Alpha\ntags:\n  - one\n---\n\n# Alpha\n\nbody text",
  "beta.md": "# Beta\n\nplain body",
  "notes/gamma.md": "---\nstatus: draft\n---\n\n# Gamma",
  "résumé.md": "# CV\n\naccented path",
};

let fixture: Fixture;
let client: RestClient;
let backend: RestBackend;

async function boot(opts: FixtureOptions = {}): Promise<void> {
  fixture = await startFixture({ files: { ...SEED }, ...opts });
  client = new RestClient({
    apiKey: "test-key",
    host: "127.0.0.1",
    port: fixture.port,
    protocol: "http",
    verifySsl: false,
  });
  backend = new RestBackend(client, { vaultPath: VAULT });
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  client.destroy();
  await fixture.close();
});

/** Re-seed the fixture with a fresh failure injector without losing the client. */
async function reboot(opts: FixtureOptions): Promise<void> {
  client.destroy();
  await fixture.close();
  await boot(opts);
}

// ============================================================================
// SMOKE
// ============================================================================

test("smoke: readNote returns the seeded note", async () => {
  const note = await backend.readNote("alpha.md");

  expect(note.content).toContain("# Alpha");
  expect(note.frontmatter).toEqual({ title: "Alpha", tags: ["one"] });
});

test("name identifies the backend", () => {
  expect(backend.name).toBe("rest");
});

// ============================================================================
// readNote
// ============================================================================

test("readNote reconstructs the full ParsedNote from one request", async () => {
  const note = await backend.readNote("alpha.md");

  expect(note.originalContent).toBe(SEED["alpha.md"]);
  expect(note.matter?.trim()).toContain("title: Alpha");
  expect(note.content.trim()).toBe("# Alpha\n\nbody text");
  expect(fixture.requests).toHaveLength(1);
  expect(fixture.requests[0]?.headers["accept"]).toBe("application/vnd.olrapi.note+json");
});

test("readNote on a missing note fails the way the filesystem does", async () => {
  await expect(backend.readNote("nope.md")).rejects.toThrow(/^File not found: nope\.md\./);
});

test("readNote percent-encodes a non-ASCII path", async () => {
  const note = await backend.readNote("résumé.md");

  expect(note.content).toContain("accented path");
  expect(fixture.requests[0]?.path).toBe(`/vault/${encodeURIComponent("résumé.md")}`);
});

test("readNote normalizes a leading slash and an absolute vault path", async () => {
  await expect(backend.readNote("/alpha.md")).resolves.toBeDefined();
  await expect(backend.readNote(`${VAULT}/alpha.md`)).resolves.toBeDefined();
});

test("the vault path is canonicalized, as FileSystemService's constructor does", async () => {
  // FileSystemService runs realpathSync on its vault path. Skipping that here
  // makes every obsidianUri differ from the filesystem backend's, and stops an
  // absolute input path from having its vault prefix stripped. Exercised
  // through a symlink so it fails on any platform, not just the macOS
  // /var -> /private/var case that first exposed it.
  const parent = await mkdtemp(join(tmpdir(), "mcpvault-rest-canon-"));
  const real = join(parent, "vault");
  const link = join(parent, "link");
  await mkdir(real);
  await symlink(real, link, "dir");

  try {
    const viaLink = new RestBackend(client, { vaultPath: link });

    const batch = await viaLink.readMultipleNotes({ paths: ["alpha.md"] });
    expect(batch.successful[0]?.obsidianUri).toBe(
      generateObsidianUri(realpathSync(real), "alpha.md"),
    );

    // The canonical prefix is the one that gets stripped from an absolute path.
    await expect(viaLink.readNote(`${realpathSync(real)}/alpha.md`)).resolves.toBeDefined();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("readNote refuses a restricted path before touching the network", async () => {
  await expect(backend.readNote(".obsidian/config.md")).rejects.toThrow(/^Access denied/);
  expect(fixture.requests).toHaveLength(0);
});

test("readNote refuses a traversal attempt", async () => {
  await expect(backend.readNote("../outside.md")).rejects.toThrow(/^Path traversal not allowed/);
  expect(fixture.requests).toHaveLength(0);
});

test("readNote surfaces a 500 as a read failure, not a transport failure", async () => {
  await reboot({ failWith: { path: "/vault/alpha.md", status: 500 } });

  const error = await backend.readNote("alpha.md").catch((e: unknown) => e);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(BackendError);
  expect((error as Error).message).toMatch(/^Failed to read file: alpha\.md/);
});

// ============================================================================
// getFrontmatter
// ============================================================================

test("getFrontmatter projects the frontmatter from the note payload", async () => {
  await expect(backend.getFrontmatter("notes/gamma.md")).resolves.toEqual({ status: "draft" });
  expect(fixture.requests).toHaveLength(1);
});

test("getFrontmatter of a note without frontmatter is an empty object", async () => {
  await expect(backend.getFrontmatter("beta.md")).resolves.toEqual({});
});

// ============================================================================
// readMultipleNotes
// ============================================================================

test("readMultipleNotes collects partial failures", async () => {
  const result = await backend.readMultipleNotes({
    paths: ["alpha.md", "missing.md", "beta.md"],
  });

  expect(result.successful.map((s) => s.path)).toEqual(["alpha.md", "beta.md"]);
  expect(result.failed).toEqual([
    { path: "missing.md", error: expect.stringMatching(/^File not found: missing\.md\./) },
  ]);
});

test("readMultipleNotes honours the include flags and emits obsidian uris", async () => {
  const result = await backend.readMultipleNotes({
    paths: ["alpha.md"],
    includeContent: false,
    includeFrontmatter: true,
  });

  expect(result.successful[0]).toEqual({
    path: "alpha.md",
    frontmatter: { title: "Alpha", tags: ["one"] },
    obsidianUri: generateObsidianUri(VAULT, "alpha.md"),
  });
});

test("readMultipleNotes rejects more than ten paths", async () => {
  const paths = Array.from({ length: 11 }, (_, i) => `n${i}.md`);

  await expect(backend.readMultipleNotes({ paths })).rejects.toThrow(
    "Maximum 10 files per batch read request",
  );
});

// ============================================================================
// getNotesInfo
// ============================================================================

test("getNotesInfo projects stat from the note payload and drops failures", async () => {
  const info = await backend.getNotesInfo(["alpha.md", "missing.md", "beta.md"]);

  expect(info.map((i) => i.path)).toEqual(["alpha.md", "beta.md"]);
  expect(info[0]?.size).toBe(Buffer.byteLength(SEED["alpha.md"]!, "utf-8"));
  expect(info[0]?.hasFrontmatter).toBe(true);
  expect(info[1]?.hasFrontmatter).toBe(false);
  expect(info[0]?.modified).toBeTypeOf("number");
});

// ============================================================================
// listDirectory
// ============================================================================

test("listDirectory splits files from directories at the vault root", async () => {
  await expect(backend.listDirectory("")).resolves.toEqual({
    files: ["alpha.md", "beta.md", "résumé.md"],
    directories: ["notes"],
  });
});

test("listDirectory descends into a subdirectory", async () => {
  await expect(backend.listDirectory("notes")).resolves.toEqual({
    files: ["gamma.md"],
    directories: [],
  });
  expect(fixture.requests[0]?.path).toBe("/vault/notes/");
});

test("listDirectory treats '.' as the vault root", async () => {
  await expect(backend.listDirectory(".")).resolves.toMatchObject({ directories: ["notes"] });
  expect(fixture.requests[0]?.path).toBe("/vault/");
});

test("listDirectory hides restricted entries", async () => {
  await reboot({ files: { "a.md": "x", ".obsidian/app.json": "{}", "node_modules/p.md": "x" } });

  await expect(backend.listDirectory("")).resolves.toEqual({
    files: ["a.md"],
    directories: [],
  });
});

test("listDirectory on a missing directory fails the way the filesystem does", async () => {
  await expect(backend.listDirectory("nope")).rejects.toThrow(/^Directory not found: nope\./);
});

// ============================================================================
// writeNote
// ============================================================================

test("writeNote overwrites through a single PUT", async () => {
  await backend.writeNote({ path: "new.md", content: "# New" });

  expect(fixture.files.get("new.md")).toBe("# New");
  expect(fixture.requests.map((r) => r.method)).toEqual(["PUT"]);
});

test("writeNote creates a nested path that does not exist yet", async () => {
  await backend.writeNote({ path: "deep/nested/dir/new.md", content: "# Deep" });

  expect(fixture.files.get("deep/nested/dir/new.md")).toBe("# Deep");
});

test("writeNote serializes frontmatter with the shared handler", async () => {
  await backend.writeNote({
    path: "fm.md",
    content: "# Body",
    frontmatter: { title: "T", tags: ["a"] },
  });

  const written = fixture.files.get("fm.md") ?? "";
  expect(written.startsWith("---\n")).toBe(true);
  expect(written).toContain("title: T");
  expect(written).toContain("# Body");
});

test("writeNote append splices the body and leaves frontmatter intact", async () => {
  await backend.writeNote({ path: "alpha.md", content: "\n\nappended", mode: "append" });

  const written = fixture.files.get("alpha.md") ?? "";
  expect(written).toContain("title: Alpha");
  expect(written.trimEnd().endsWith("appended")).toBe(true);
  expect(written.indexOf("body text")).toBeLessThan(written.indexOf("appended"));
});

test("writeNote prepend puts content ahead of the body, still after frontmatter", async () => {
  await backend.writeNote({ path: "alpha.md", content: "lead\n", mode: "prepend" });

  const written = fixture.files.get("alpha.md") ?? "";
  expect(written.indexOf("lead")).toBeGreaterThan(written.indexOf("title: Alpha"));
  expect(written.indexOf("lead")).toBeLessThan(written.indexOf("# Alpha"));
});

test("writeNote append to a missing note degrades to a plain write", async () => {
  await backend.writeNote({ path: "fresh.md", content: "# Fresh", mode: "append" });

  expect(fixture.files.get("fresh.md")).toBe("# Fresh");
});

test("writeNote rejects missing content, restricted paths, and invalid frontmatter", async () => {
  await expect(
    backend.writeNote({ path: "a.md", content: undefined as unknown as string }),
  ).rejects.toThrow(/^Content is required/);

  await expect(backend.writeNote({ path: ".git/x.md", content: "x" })).rejects.toThrow(
    /^Access denied/,
  );

  await expect(
    backend.writeNote({ path: "a.md", content: "x", frontmatter: { bad: () => 1 } }),
  ).rejects.toThrow(/^Invalid frontmatter/);
});

test("writeNote surfaces a write failure status", async () => {
  await reboot({ failWith: { path: "/vault/new.md", status: 400 } });

  await expect(backend.writeNote({ path: "new.md", content: "x" })).rejects.toThrow(
    /^Failed to write file: new\.md/,
  );
});

// ============================================================================
// patchNote
// ============================================================================

test("patchNote replaces a single occurrence and reports the count", async () => {
  const result = await backend.patchNote({
    path: "beta.md",
    oldString: "plain body",
    newString: "patched body",
  });

  expect(result).toEqual({
    success: true,
    path: "beta.md",
    message: "Successfully replaced 1 occurrence",
    matchCount: 1,
  });
  expect(fixture.files.get("beta.md")).toBe("# Beta\n\npatched body");
});

test("patchNote refuses an ambiguous match unless replaceAll is set", async () => {
  await reboot({ files: { "dup.md": "x x x" } });

  const refused = await backend.patchNote({ path: "dup.md", oldString: "x", newString: "y" });
  expect(refused).toMatchObject({ success: false, matchCount: 3 });
  expect(fixture.files.get("dup.md")).toBe("x x x");

  const applied = await backend.patchNote({
    path: "dup.md",
    oldString: "x",
    newString: "y",
    replaceAll: true,
  });
  expect(applied).toMatchObject({ success: true, matchCount: 3 });
  expect(fixture.files.get("dup.md")).toBe("y y y");
});

test("patchNote reports a string that is not present", async () => {
  const result = await backend.patchNote({
    path: "beta.md",
    oldString: "absent",
    newString: "z",
  });

  expect(result).toMatchObject({ success: false, matchCount: 0 });
  expect(result.message).toMatch(/^String not found in note/);
});

test("patchNote validates its arguments before any request", async () => {
  await expect(
    backend.patchNote({ path: "beta.md", oldString: "  ", newString: "z" }),
  ).resolves.toMatchObject({ message: "oldString cannot be empty" });
  await expect(
    backend.patchNote({ path: "beta.md", oldString: "a", newString: "a" }),
  ).resolves.toMatchObject({ message: "oldString and newString must be different" });
  expect(fixture.requests).toHaveLength(0);
});

test("patchNote inserts the replacement literally, without $-pattern expansion", async () => {
  await reboot({ files: { "d.md": "before TOKEN after" } });

  await backend.patchNote({ path: "d.md", oldString: "TOKEN", newString: "$& $` cost" });

  expect(fixture.files.get("d.md")).toBe("before $& $` cost after");
});

test("patchNote on a missing note reports the failure rather than throwing", async () => {
  const result = await backend.patchNote({
    path: "nope.md",
    oldString: "a",
    newString: "b",
  });

  expect(result.success).toBe(false);
  expect(result.message).toMatch(/^Failed to patch note: File not found/);
});

// ============================================================================
// deleteNote
// ============================================================================

test("deleteNote removes the note", async () => {
  const result = await backend.deleteNote({ path: "beta.md", confirmPath: "beta.md" });

  expect(result.success).toBe(true);
  expect(fixture.files.has("beta.md")).toBe(false);
  expect(fixture.requests[0]?.method).toBe("DELETE");
});

test("deleteNote requires a matching confirmation path", async () => {
  const result = await backend.deleteNote({ path: "beta.md", confirmPath: "alpha.md" });

  expect(result.success).toBe(false);
  expect(result.message).toMatch(/^Deletion cancelled/);
  expect(fixture.requests).toHaveLength(0);
});

test("deleteNote reports a missing file", async () => {
  const result = await backend.deleteNote({ path: "nope.md", confirmPath: "nope.md" });

  expect(result).toMatchObject({ success: false });
  expect(result.message).toMatch(/^File not found: nope\.md\./);
});

test("deleteNote declares trash modes unsupported so routing can fall back", async () => {
  const error = await backend
    .deleteNote({ path: "beta.md", confirmPath: "beta.md", trashMode: "system" })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(BackendError);
  expect((error as BackendError).failure).toMatchObject({ kind: "unsupported" });
  expect(fixture.files.has("beta.md")).toBe(true);
});

// ============================================================================
// moveNote / moveFile
// ============================================================================

test("moveNote sends MOVE with a Destination header", async () => {
  const result = await backend.moveNote({ oldPath: "beta.md", newPath: "archive/beta.md" });

  expect(result).toEqual({
    success: true,
    oldPath: "beta.md",
    newPath: "archive/beta.md",
    message: "Successfully moved note from beta.md to archive/beta.md",
  });
  expect(fixture.requests[0]?.method).toBe("MOVE");
  expect(fixture.requests[0]?.headers["destination"]).toBe("archive/beta.md");
  expect(fixture.files.get("archive/beta.md")).toBe(SEED["beta.md"]);
});

test("moveNote percent-encodes the Destination header separately from the path", async () => {
  await backend.moveNote({ oldPath: "résumé.md", newPath: "archive/résumé bis.md" });

  expect(fixture.requests[0]?.path).toBe(`/vault/${encodeURIComponent("résumé.md")}`);
  expect(fixture.requests[0]?.headers["destination"]).toBe(
    `archive/${encodeURIComponent("résumé bis.md")}`,
  );
  expect(fixture.files.has("archive/résumé bis.md")).toBe(true);
});

test("moveNote onto an existing destination is refused unless overwrite is set", async () => {
  const refused = await backend.moveNote({ oldPath: "beta.md", newPath: "alpha.md" });
  expect(refused.success).toBe(false);
  expect(refused.message).toMatch(/^Target file already exists: alpha\.md\./);
  expect(fixture.files.get("alpha.md")).toBe(SEED["alpha.md"]);

  const forced = await backend.moveNote({
    oldPath: "beta.md",
    newPath: "alpha.md",
    overwrite: true,
  });
  expect(forced.success).toBe(true);
  expect(fixture.files.get("alpha.md")).toBe(SEED["beta.md"]);
});

test("moveNote reports a missing source", async () => {
  const result = await backend.moveNote({ oldPath: "nope.md", newPath: "b.md" });

  expect(result.success).toBe(false);
  expect(result.message).toMatch(/^Source file not found: nope\.md\./);
});

test("moveFile requires both confirmation paths to match", async () => {
  const result = await backend.moveFile({
    oldPath: "beta.md",
    newPath: "archive/beta.md",
    confirmOldPath: "beta.md",
    confirmNewPath: "wrong.md",
  });

  expect(result.success).toBe(false);
  expect(result.message).toMatch(/^Move cancelled/);
  expect(fixture.requests).toHaveLength(0);
});

test("moveFile moves a non-note file that read_note would refuse", async () => {
  await reboot({ files: { "img.png": "binary-ish" } });

  const result = await backend.moveFile({
    oldPath: "img.png",
    newPath: "assets/img.png",
    confirmOldPath: "img.png",
    confirmNewPath: "assets/img.png",
  });

  expect(result.success).toBe(true);
  expect(result.message).toBe("Successfully moved file from img.png to assets/img.png");
  expect(fixture.files.get("assets/img.png")).toBe("binary-ish");
});

// ============================================================================
// updateFrontmatter
// ============================================================================

test("updateFrontmatter merges by default and preserves untouched fields", async () => {
  await backend.updateFrontmatter({ path: "alpha.md", frontmatter: { status: "final" } });

  const written = fixture.files.get("alpha.md") ?? "";
  expect(written).toContain("title: Alpha");
  expect(written).toContain("status: final");
  expect(written).toContain("# Alpha");
});

test("updateFrontmatter with merge off replaces the block entirely", async () => {
  await backend.updateFrontmatter({
    path: "alpha.md",
    frontmatter: { only: "this" },
    merge: false,
  });

  const written = fixture.files.get("alpha.md") ?? "";
  expect(written).toContain("only: this");
  expect(written).not.toContain("title: Alpha");
});

test("updateFrontmatter adds a block to a note that had none", async () => {
  await backend.updateFrontmatter({ path: "beta.md", frontmatter: { added: true } });

  const written = fixture.files.get("beta.md") ?? "";
  expect(written.startsWith("---\n")).toBe(true);
  expect(written).toContain("added: true");
});

test("updateFrontmatter refuses invalid frontmatter before writing", async () => {
  await expect(
    backend.updateFrontmatter({ path: "alpha.md", frontmatter: { bad: Symbol("x") } }),
  ).rejects.toThrow(/^Invalid frontmatter/);
  expect(fixture.files.get("alpha.md")).toBe(SEED["alpha.md"]);
});

// ============================================================================
// manageTags
// ============================================================================

test("manageTags lists frontmatter and inline tags together", async () => {
  await reboot({ files: { "t.md": "---\ntags:\n  - one\n---\n\nbody #two" } });

  await expect(backend.manageTags({ path: "t.md", operation: "list" })).resolves.toEqual({
    path: "t.md",
    operation: "list",
    tags: ["one", "two"],
    success: true,
  });
});

test("manageTags adds a tag and writes it back", async () => {
  const result = await backend.manageTags({
    path: "alpha.md",
    operation: "add",
    tags: ["two"],
  });

  expect(result.success).toBe(true);
  expect(result.tags).toEqual(["one", "two"]);
  expect(fixture.files.get("alpha.md")).toContain("two");
});

test("manageTags removes a tag", async () => {
  const result = await backend.manageTags({
    path: "alpha.md",
    operation: "remove",
    tags: ["one"],
  });

  expect(result.success).toBe(true);
  expect(result.tags).toEqual([]);
  expect(fixture.files.get("alpha.md")).not.toContain("- one");
});

test("manageTags on a missing note reports the failure rather than throwing", async () => {
  const result = await backend.manageTags({ path: "nope.md", operation: "list" });

  expect(result.success).toBe(false);
  expect(result.message).toMatch(/^File not found: nope\.md\./);
});

// ============================================================================
// listAllTags
// ============================================================================

test("listAllTags maps the plugin's tag index to the filesystem's shape", async () => {
  await reboot({
    files: {
      "a.md": "---\ntags:\n  - project\n---\n\n#work",
      "b.md": "#project text",
    },
  });

  await expect(backend.listAllTags()).resolves.toEqual([
    { tag: "project", count: 2 },
    { tag: "work", count: 1 },
  ]);
  expect(fixture.requests[0]?.path).toBe("/tags/");
});

test("listAllTags folds case the way the filesystem walk does", async () => {
  await reboot({ files: { "a.md": "#Work", "b.md": "#work" } });

  await expect(backend.listAllTags()).resolves.toEqual([{ tag: "work", count: 2 }]);
});

// ============================================================================
// PATH GUARD ORDERING
//
// FileSystemService resolves paths at different points in different methods:
// sometimes before its try block (so a traversal throws) and sometimes inside
// it (so a traversal becomes a failed result). Phase 3's contract suite runs
// identical assertions against both backends, so the ordering has to match, not
// just the outcome.
// ============================================================================

test("the traversal message names the normalized path, as the filesystem's does", async () => {
  await expect(backend.readNote("/../outside.md")).rejects.toThrow(
    "Path traversal not allowed: ../outside.md. Paths must be within the vault directory.",
  );
});

test("readNote and writeNote throw on traversal", async () => {
  await expect(backend.readNote("../out.md")).rejects.toThrow(/^Path traversal not allowed/);
  await expect(backend.writeNote({ path: "../out.md", content: "x" })).rejects.toThrow(
    /^Path traversal not allowed/,
  );
  expect(fixture.requests).toHaveLength(0);
});

test("patchNote and manageTags report traversal as a failed result", async () => {
  await expect(
    backend.patchNote({ path: "../out.md", oldString: "a", newString: "b" }),
  ).resolves.toMatchObject({
    success: false,
    message: expect.stringMatching(/^Failed to patch note: Path traversal not allowed/),
  });

  await expect(backend.manageTags({ path: "../out.md", operation: "list" })).resolves.toMatchObject(
    { success: false, message: expect.stringMatching(/^Path traversal not allowed/) },
  );
});

test("deleteNote checks the confirmation pair before rejecting the path", async () => {
  const result = await backend.deleteNote({ path: "../a.md", confirmPath: "../b.md" });

  expect(result.message).toMatch(/^Deletion cancelled/);
});

test("deleteNote throws on traversal once the confirmation pair matches", async () => {
  await expect(
    backend.deleteNote({ path: "../a.md", confirmPath: "../a.md" }),
  ).rejects.toThrow(/^Path traversal not allowed/);
});

test("a restricted path reports access denied even when it also traverses", async () => {
  // The filesystem checks PathFilter before resolving in these methods, so the
  // restriction wins over the traversal.
  await expect(
    backend.updateFrontmatter({ path: ".obsidian/../../x.md", frontmatter: {} }),
  ).rejects.toThrow(/^Access denied/);
  await expect(
    backend.manageTags({ path: ".obsidian/../../x.md", operation: "list" }),
  ).resolves.toMatchObject({ message: expect.stringMatching(/^Access denied/) });
});

test("moveNote checks access before rejecting a traversing path", async () => {
  await expect(
    backend.moveNote({ oldPath: ".obsidian/x.md", newPath: "../out.md" }),
  ).resolves.toMatchObject({ message: expect.stringMatching(/^Access denied/) });

  await expect(backend.moveNote({ oldPath: "beta.md", newPath: "../out.md" })).rejects.toThrow(
    /^Path traversal not allowed/,
  );
});

test("moveFile checks the confirmation pair before rejecting a traversing path", async () => {
  await expect(
    backend.moveFile({
      oldPath: "../a.md",
      newPath: "b.md",
      confirmOldPath: "mismatch.md",
      confirmNewPath: "b.md",
    }),
  ).resolves.toMatchObject({ message: expect.stringMatching(/^Move cancelled/) });
});

test("readMultipleNotes folds a traversing path into failed rather than throwing", async () => {
  const result = await backend.readMultipleNotes({ paths: ["alpha.md", "../out.md"] });

  expect(result.successful.map((s) => s.path)).toEqual(["alpha.md"]);
  expect(result.failed[0]?.error).toMatch(/^Path traversal not allowed/);
});

test("getNotesInfo silently drops a traversing path", async () => {
  const info = await backend.getNotesInfo(["alpha.md", "../out.md"]);

  expect(info.map((i) => i.path)).toEqual(["alpha.md"]);
});

// ============================================================================
// DIRECTORY VERSUS FILE
// ============================================================================

test("readNote on a directory says so instead of reporting a missing file", async () => {
  await expect(backend.readNote("notes")).rejects.toThrow(
    "Cannot read directory as file: notes. Use list_directory tool instead.",
  );
});

test("listDirectory on a file says so instead of reporting a missing directory", async () => {
  await expect(backend.listDirectory("alpha.md")).rejects.toThrow(/^Not a directory: alpha\.md\./);
});

test("deleteNote on a directory reports that it is not a file", async () => {
  const result = await backend.deleteNote({ path: "notes", confirmPath: "notes" });

  expect(result).toMatchObject({ success: false, message: "Cannot delete: notes is not a file" });
});

test("moveFile on a directory reports a file-only limitation", async () => {
  const result = await backend.moveFile({
    oldPath: "notes",
    newPath: "archive",
    confirmOldPath: "notes",
    confirmNewPath: "archive",
  });

  expect(result.message).toBe(
    "Source path is a directory: notes. move_file currently supports files only.",
  );
});

// ============================================================================
// CONFIGURATION AND VERSION
// ============================================================================

test("a 401 becomes a named configuration error mentioning the api key", async () => {
  await reboot({ apiKey: "a-different-key" });

  await expect(backend.readNote("alpha.md")).rejects.toBeInstanceOf(RestConfigurationError);
  await expect(backend.readNote("alpha.md")).rejects.toThrow(/OBSIDIAN_API_KEY/);
});

test("a configuration error escapes result-returning operations instead of being swallowed", async () => {
  await reboot({ apiKey: "a-different-key" });

  // patchNote and manageTags fold ordinary errors into a message string. A
  // setup mistake must not disappear that way.
  await expect(
    backend.patchNote({ path: "alpha.md", oldString: "a", newString: "b" }),
  ).rejects.toBeInstanceOf(RestConfigurationError);
  await expect(backend.manageTags({ path: "alpha.md", operation: "list" })).rejects.toBeInstanceOf(
    RestConfigurationError,
  );
});

test("a transport failure escapes result-returning operations as a BackendError", async () => {
  await reboot({ killSocketOn: "/vault/alpha.md" });

  // Routing needs the classification. Folding it into `{ success: false }`
  // would silently remove the filesystem fallback.
  await expect(
    backend.patchNote({ path: "alpha.md", oldString: "a", newString: "b" }),
  ).rejects.toBeInstanceOf(BackendError);
});

test("checkPluginVersion reads versions.self and warns below the floor", async () => {
  await expect(backend.checkPluginVersion()).resolves.toEqual({
    version: "4.1.7",
    warning: null,
  });

  await reboot({ pluginVersion: "4.0.0" });
  const below = await backend.checkPluginVersion();

  expect(below.version).toBe("4.0.0");
  expect(below.warning).toContain("4.1.7");
});
