import { test, expect, beforeEach, afterEach } from "vitest";
import { FileSystemBackend } from "./index.js";
import { FileSystemService } from "../../filesystem.js";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

let testVaultPath: string;
let fileSystem: FileSystemService;
let backend: FileSystemBackend;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-backend-"));
  fileSystem = new FileSystemService(testVaultPath);
  backend = new FileSystemBackend(fileSystem);
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

/** A second vault + service pair, so a mutating operation can be run twice from
 *  identical starting state: once through the adapter, once through the raw
 *  service. Deep-equal results prove the adapter adds no translation. */
async function mirror(): Promise<{ path: string; service: FileSystemService }> {
  const path = await mkdtemp(join(tmpdir(), "mcpvault-backend-mirror-"));
  return { path, service: new FileSystemService(path) };
}

test("smoke: readNote round-trips content written through the adapter", async () => {
  await backend.writeNote({ path: "smoke.md", content: "# Smoke" });
  const note = await backend.readNote("smoke.md");
  expect(note.content).toContain("# Smoke");
});

test("name identifies the backend", () => {
  expect(backend.name).toBe("filesystem");
});

// ============================================================================
// READS
// ============================================================================

test("readNote matches the service for a note with frontmatter", async () => {
  const content = "---\ntitle: Test\ntags:\n  - alpha\n---\n\n# Body\n\ntext";
  await writeFile(join(testVaultPath, "fm.md"), content);

  const viaBackend = await backend.readNote("fm.md");
  const viaService = await fileSystem.readNote("fm.md");

  expect(viaBackend).toEqual(viaService);
  expect(viaBackend.frontmatter).toEqual({ title: "Test", tags: ["alpha"] });
});

test("readNote matches the service for a note without frontmatter", async () => {
  await writeFile(join(testVaultPath, "plain.md"), "# Plain\n\nno frontmatter");

  expect(await backend.readNote("plain.md")).toEqual(await fileSystem.readNote("plain.md"));
});

test("readNote propagates the service error for a missing note", async () => {
  const serviceError = await fileSystem.readNote("missing.md").catch((e: Error) => e);
  const backendError = await backend.readNote("missing.md").catch((e: Error) => e);

  expect(backendError).toBeInstanceOf(Error);
  expect((backendError as Error).message).toBe((serviceError as Error).message);
});

test("readNote propagates the service error for a path outside the vault", async () => {
  const serviceError = await fileSystem.readNote("../escape.md").catch((e: Error) => e);
  const backendError = await backend.readNote("../escape.md").catch((e: Error) => e);

  expect(backendError).toBeInstanceOf(Error);
  expect((backendError as Error).message).toBe((serviceError as Error).message);
});

test("readMultipleNotes matches the service", async () => {
  await writeFile(join(testVaultPath, "a.md"), "---\nk: v\n---\n\nA body");
  await writeFile(join(testVaultPath, "b.md"), "B body");

  const params = { paths: ["a.md", "b.md", "gone.md"] };
  expect(await backend.readMultipleNotes(params)).toEqual(await fileSystem.readMultipleNotes(params));
});

test("getNotesInfo matches the service", async () => {
  await writeFile(join(testVaultPath, "a.md"), "---\nk: v\n---\n\nA body");
  await writeFile(join(testVaultPath, "b.md"), "B body");

  expect(await backend.getNotesInfo(["a.md", "b.md"])).toEqual(
    await fileSystem.getNotesInfo(["a.md", "b.md"])
  );
});

test("getFrontmatter returns exactly readNote's frontmatter", async () => {
  await writeFile(join(testVaultPath, "fm.md"), "---\ntitle: T\ncount: 3\n---\n\nbody");

  const fm = await backend.getFrontmatter("fm.md");
  expect(fm).toEqual((await fileSystem.readNote("fm.md")).frontmatter);
  expect(fm).toEqual({ title: "T", count: 3 });
});

test("getFrontmatter returns an empty object for a note without frontmatter", async () => {
  await writeFile(join(testVaultPath, "plain.md"), "# Plain");
  expect(await backend.getFrontmatter("plain.md")).toEqual({});
});

test("listDirectory matches the service", async () => {
  await mkdir(join(testVaultPath, "sub"), { recursive: true });
  await writeFile(join(testVaultPath, "root.md"), "root");
  await writeFile(join(testVaultPath, "sub/child.md"), "child");

  expect(await backend.listDirectory("")).toEqual(await fileSystem.listDirectory(""));
  expect(await backend.listDirectory("sub")).toEqual(await fileSystem.listDirectory("sub"));
});

test("listAllTags matches the service", async () => {
  await writeFile(join(testVaultPath, "t.md"), "---\ntags:\n  - alpha\n  - beta\n---\n\n#alpha body");

  const viaBackend = await backend.listAllTags();
  expect(viaBackend).toEqual(await fileSystem.listAllTags());
  expect(viaBackend).toEqual([
    { tag: "alpha", count: 2 },
    { tag: "beta", count: 1 },
  ]);
});

test("listAllTags returns an empty array on an empty vault", async () => {
  await expect(backend.listAllTags()).resolves.toEqual([]);
});

// ============================================================================
// WRITES
// ============================================================================

test("writeNote overwrite produces the same file bytes as the service", async () => {
  const other = await mirror();
  try {
    const params = { path: "w.md", content: "# One", frontmatter: { a: 1 } };
    await backend.writeNote(params);
    await other.service.writeNote(params);

    expect(await backend.readNote("w.md")).toEqual(await other.service.readNote("w.md"));
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("writeNote append and prepend match the service", async () => {
  const other = await mirror();
  try {
    const seed = { path: "w.md", content: "base" };
    await backend.writeNote(seed);
    await other.service.writeNote(seed);

    const append = { path: "w.md", content: "appended", mode: "append" as const };
    await backend.writeNote(append);
    await other.service.writeNote(append);

    const prepend = { path: "w.md", content: "prepended", mode: "prepend" as const };
    await backend.writeNote(prepend);
    await other.service.writeNote(prepend);

    const viaBackend = await backend.readNote("w.md");
    expect(viaBackend).toEqual(await other.service.readNote("w.md"));
    expect(viaBackend.content).toContain("prepended");
    expect(viaBackend.content).toContain("appended");
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("writeNote propagates the service error for a path outside the vault", async () => {
  const params = { path: "../escape.md", content: "nope" };
  const serviceError = await fileSystem.writeNote(params).catch((e: Error) => e);
  const backendError = await backend.writeNote(params).catch((e: Error) => e);

  expect(backendError).toBeInstanceOf(Error);
  expect((backendError as Error).message).toBe((serviceError as Error).message);
});

test("patchNote with a single match matches the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "p.md"), "alpha beta");
    await writeFile(join(other.path, "p.md"), "alpha beta");

    const params = { path: "p.md", oldString: "beta", newString: "gamma" };
    const viaBackend = await backend.patchNote(params);

    expect(viaBackend).toEqual(await other.service.patchNote(params));
    expect(viaBackend.success).toBe(true);
    expect((await backend.readNote("p.md")).content).toContain("alpha gamma");
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("patchNote with multiple matches and replaceAll false fails like the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "p.md"), "dup dup");
    await writeFile(join(other.path, "p.md"), "dup dup");

    const params = { path: "p.md", oldString: "dup", newString: "x", replaceAll: false };
    const viaBackend = await backend.patchNote(params);

    expect(viaBackend).toEqual(await other.service.patchNote(params));
    expect(viaBackend.success).toBe(false);
    expect(viaBackend.matchCount).toBe(2);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("patchNote with replaceAll true matches the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "p.md"), "dup dup");
    await writeFile(join(other.path, "p.md"), "dup dup");

    const params = { path: "p.md", oldString: "dup", newString: "x", replaceAll: true };
    const viaBackend = await backend.patchNote(params);

    expect(viaBackend).toEqual(await other.service.patchNote(params));
    expect(viaBackend.success).toBe(true);
    expect((await backend.readNote("p.md")).content).toContain("x x");
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("deleteNote with a matching confirmPath matches the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "d.md"), "gone soon");
    await writeFile(join(other.path, "d.md"), "gone soon");

    const params = { path: "d.md", confirmPath: "d.md" };
    const viaBackend = await backend.deleteNote(params);

    expect(viaBackend).toEqual(await other.service.deleteNote(params));
    expect(viaBackend.success).toBe(true);
    await expect(fileSystem.exists("d.md")).resolves.toBe(false);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("deleteNote with a mismatched confirmPath matches the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "d.md"), "stays");
    await writeFile(join(other.path, "d.md"), "stays");

    const params = { path: "d.md", confirmPath: "other.md" };
    const viaBackend = await backend.deleteNote(params);

    expect(viaBackend).toEqual(await other.service.deleteNote(params));
    expect(viaBackend.success).toBe(false);
    await expect(fileSystem.exists("d.md")).resolves.toBe(true);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("moveNote matches the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "m.md"), "moving");
    await writeFile(join(other.path, "m.md"), "moving");

    const params = { oldPath: "m.md", newPath: "moved.md" };
    const viaBackend = await backend.moveNote(params);

    expect(viaBackend).toEqual(await other.service.moveNote(params));
    expect(viaBackend.success).toBe(true);
    await expect(fileSystem.exists("moved.md")).resolves.toBe(true);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("moveNote onto an existing destination without overwrite matches the service", async () => {
  const other = await mirror();
  try {
    for (const root of [testVaultPath, other.path]) {
      await writeFile(join(root, "m.md"), "source");
      await writeFile(join(root, "taken.md"), "destination");
    }

    const params = { oldPath: "m.md", newPath: "taken.md", overwrite: false };
    const viaBackend = await backend.moveNote(params);

    expect(viaBackend).toEqual(await other.service.moveNote(params));
    expect(viaBackend.success).toBe(false);
    expect((await backend.readNote("taken.md")).content).toContain("destination");
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("moveFile matches the service, including argument order", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "f.txt"), "binary-ish");
    await writeFile(join(other.path, "f.txt"), "binary-ish");

    const params = {
      oldPath: "f.txt",
      newPath: "renamed.txt",
      confirmOldPath: "f.txt",
      confirmNewPath: "renamed.txt",
    };
    const viaBackend = await backend.moveFile(params);

    expect(viaBackend).toEqual(await other.service.moveFile(params));
    expect(viaBackend.success).toBe(true);
    await expect(fileSystem.exists("renamed.txt")).resolves.toBe(true);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("moveFile with a mismatched confirmation matches the service", async () => {
  const other = await mirror();
  try {
    await writeFile(join(testVaultPath, "f.txt"), "stays");
    await writeFile(join(other.path, "f.txt"), "stays");

    const params = {
      oldPath: "f.txt",
      newPath: "renamed.txt",
      confirmOldPath: "wrong.txt",
      confirmNewPath: "renamed.txt",
    };
    const viaBackend = await backend.moveFile(params);

    expect(viaBackend).toEqual(await other.service.moveFile(params));
    expect(viaBackend.success).toBe(false);
    await expect(fileSystem.exists("f.txt")).resolves.toBe(true);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("updateFrontmatter merging matches the service", async () => {
  const other = await mirror();
  try {
    const seed = "---\nkeep: yes\nreplace: old\n---\n\nbody";
    await writeFile(join(testVaultPath, "u.md"), seed);
    await writeFile(join(other.path, "u.md"), seed);

    const params = { path: "u.md", frontmatter: { replace: "new" }, merge: true };
    await backend.updateFrontmatter(params);
    await other.service.updateFrontmatter(params);

    const viaBackend = await backend.readNote("u.md");
    expect(viaBackend).toEqual(await other.service.readNote("u.md"));
    expect(viaBackend.frontmatter).toEqual({ keep: "yes", replace: "new" });
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("updateFrontmatter without merge matches the service", async () => {
  const other = await mirror();
  try {
    const seed = "---\nkeep: yes\n---\n\nbody";
    await writeFile(join(testVaultPath, "u.md"), seed);
    await writeFile(join(other.path, "u.md"), seed);

    const params = { path: "u.md", frontmatter: { only: "this" }, merge: false };
    await backend.updateFrontmatter(params);
    await other.service.updateFrontmatter(params);

    const viaBackend = await backend.readNote("u.md");
    expect(viaBackend).toEqual(await other.service.readNote("u.md"));
    expect(viaBackend.frontmatter).toEqual({ only: "this" });
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("manageTags add, list, and remove match the service", async () => {
  const other = await mirror();
  try {
    const seed = "---\ntags:\n  - keep\n---\n\nbody";
    await writeFile(join(testVaultPath, "tg.md"), seed);
    await writeFile(join(other.path, "tg.md"), seed);

    const add = { path: "tg.md", operation: "add" as const, tags: ["added"] };
    expect(await backend.manageTags(add)).toEqual(await other.service.manageTags(add));

    const list = { path: "tg.md", operation: "list" as const };
    const listed = await backend.manageTags(list);
    expect(listed).toEqual(await other.service.manageTags(list));
    expect(listed.tags).toContain("added");

    const remove = { path: "tg.md", operation: "remove" as const, tags: ["keep"] };
    expect(await backend.manageTags(remove)).toEqual(await other.service.manageTags(remove));
    expect((await backend.readNote("tg.md")).frontmatter.tags).toEqual(["added"]);
  } finally {
    await rm(other.path, { recursive: true });
  }
});

test("manageTags on a missing note matches the service", async () => {
  const params = { path: "nope.md", operation: "list" as const };
  const serviceError = await fileSystem.manageTags(params).catch((e: Error) => e);
  const backendError = await backend.manageTags(params).catch((e: Error) => e);

  if (serviceError instanceof Error) {
    expect(backendError).toBeInstanceOf(Error);
    expect((backendError as Error).message).toBe(serviceError.message);
  } else {
    expect(backendError).toEqual(serviceError);
  }
});
