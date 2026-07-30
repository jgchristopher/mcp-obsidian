import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { FileSystemBackend } from "./filesystem/index.js";
import { RestBackend } from "./rest/index.js";
import { seedBoth } from "./testing/seed.js";
import type { SeededVault, VaultState } from "./testing/seed.js";
import type { VaultBackend } from "./types.js";
import { generateObsidianUri } from "../uri.js";

/**
 * One set of behavioral assertions, executed against every backend.
 *
 * The REST arm targets the in-process fixture, never a live Obsidian, so
 * **nothing here is environment-gated**. A suite that skipped the REST arm
 * would exit 0 while proving nothing, which is exactly the failure this file
 * exists to prevent. There must be no `skipIf` in this file.
 *
 * What is deliberately not asserted: timing, request counts, and anything else
 * that legitimately differs between a local read and an HTTP round trip.
 */

const SEED: Record<string, string> = {
  "alpha.md": "---\ntitle: Alpha\ntags:\n  - one\n---\n\n# Alpha\n\nbody text\n",
  "beta.md": "# Beta\n\nplain body\n",
  "twice.md": "repeat\nrepeat\n",
  "notes/gamma.md": "---\nstatus: draft\n---\n\n# Gamma\n",
  "notes/delta.md": "# Delta\n\n#tagged content\n",
};

interface Arm {
  name: string;
  make(env: SeededVault): VaultBackend;
  state(env: SeededVault): VaultState;
}

const BACKENDS: Arm[] = [
  {
    name: "filesystem",
    make: (env) => new FileSystemBackend(env.fileSystem),
    state: (env) => env.filesystemState,
  },
  {
    name: "rest",
    make: (env) => new RestBackend(env.client, { vaultPath: env.vaultPath }),
    state: (env) => env.restState,
  },
];

for (const arm of BACKENDS) {
  describe(`backend contract: ${arm.name}`, () => {
    let env: SeededVault;
    let backend: VaultBackend;
    let state: VaultState;

    beforeEach(async () => {
      env = await seedBoth(SEED);
      backend = arm.make(env);
      state = arm.state(env);
    });

    afterEach(async () => {
      await env.cleanup();
    });

    // ========================================================================
    // readNote
    // ========================================================================

    test("readNote returns parsed frontmatter and body", async () => {
      const note = await backend.readNote("alpha.md");

      expect(note.frontmatter).toEqual({ title: "Alpha", tags: ["one"] });
      expect(note.content).toBe("\n# Alpha\n\nbody text\n");
      expect(note.originalContent).toBe(SEED["alpha.md"]);
    });

    test("readNote on a note without frontmatter returns an empty object", async () => {
      const note = await backend.readNote("beta.md");

      expect(note.frontmatter).toEqual({});
      expect(note.content).toBe("# Beta\n\nplain body\n");
    });

    test("readNote rejects a missing note", async () => {
      await expect(backend.readNote("missing.md")).rejects.toThrow(
        "File not found: missing.md. Use list_directory to see available files, or check the path spelling.",
      );
    });

    test("readNote rejects a directory", async () => {
      await expect(backend.readNote("notes")).rejects.toThrow(
        "Cannot read directory as file: notes. Use list_directory tool instead.",
      );
    });

    test("readNote rejects a restricted path", async () => {
      await expect(backend.readNote(".obsidian/workspace.md")).rejects.toThrow(/^Access denied/);
    });

    // ========================================================================
    // readMultipleNotes
    // ========================================================================

    test("readMultipleNotes splits successes from failures", async () => {
      const result = await backend.readMultipleNotes({ paths: ["alpha.md", "missing.md"] });

      expect(result.successful).toEqual([
        {
          path: "alpha.md",
          obsidianUri: generateObsidianUri(env.vaultPath, "alpha.md"),
          frontmatter: { title: "Alpha", tags: ["one"] },
          content: "\n# Alpha\n\nbody text\n",
        },
      ]);
      expect(result.failed).toEqual([
        {
          path: "missing.md",
          error:
            "File not found: missing.md. Use list_directory to see available files, or check the path spelling.",
        },
      ]);
    });

    test("readMultipleNotes honors includeContent and includeFrontmatter", async () => {
      const result = await backend.readMultipleNotes({
        paths: ["alpha.md"],
        includeContent: false,
        includeFrontmatter: false,
      });

      expect(result.successful).toEqual([
        { path: "alpha.md", obsidianUri: generateObsidianUri(env.vaultPath, "alpha.md") },
      ]);
    });

    test("readMultipleNotes refuses more than ten paths", async () => {
      const paths = Array.from({ length: 11 }, (_, i) => `note-${i}.md`);

      await expect(backend.readMultipleNotes({ paths })).rejects.toThrow(
        "Maximum 10 files per batch read request",
      );
    });

    // ========================================================================
    // getNotesInfo
    // ========================================================================

    test("getNotesInfo reports metadata and drops unreadable paths", async () => {
      const info = await backend.getNotesInfo(["alpha.md", "beta.md", "missing.md"]);

      // `modified` is a real mtime on one arm and a fixture-supplied stat on the
      // other, so only its type is contractual.
      expect(info.map(({ modified, ...rest }) => rest)).toEqual([
        {
          path: "alpha.md",
          size: Buffer.byteLength(SEED["alpha.md"]!),
          hasFrontmatter: true,
          obsidianUri: generateObsidianUri(env.vaultPath, "alpha.md"),
        },
        {
          path: "beta.md",
          size: Buffer.byteLength(SEED["beta.md"]!),
          hasFrontmatter: false,
          obsidianUri: generateObsidianUri(env.vaultPath, "beta.md"),
        },
      ]);
      expect(info.every((entry) => typeof entry.modified === "number")).toBe(true);
    });

    // ========================================================================
    // listDirectory
    // ========================================================================

    test("listDirectory lists the vault root", async () => {
      const listing = await backend.listDirectory("");

      expect(listing).toEqual({
        files: ["alpha.md", "beta.md", "twice.md"],
        directories: ["notes"],
      });
    });

    test("listDirectory lists a subdirectory", async () => {
      const listing = await backend.listDirectory("notes");

      expect(listing).toEqual({ files: ["delta.md", "gamma.md"], directories: [] });
    });

    test("listDirectory rejects a missing directory", async () => {
      await expect(backend.listDirectory("nope")).rejects.toThrow(
        "Directory not found: nope. Use list_directory with no path or '/' to see root folders.",
      );
    });

    // ========================================================================
    // getFrontmatter
    // ========================================================================

    test("getFrontmatter projects just the frontmatter", async () => {
      expect(await backend.getFrontmatter("notes/gamma.md")).toEqual({ status: "draft" });
      expect(await backend.getFrontmatter("beta.md")).toEqual({});
    });

    // ========================================================================
    // listAllTags
    // ========================================================================

    test("listAllTags reports every tag in the vault", async () => {
      const tags = await backend.listAllTags();

      expect(tags).toEqual([
        { tag: "one", count: 1 },
        { tag: "tagged", count: 1 },
      ]);
    });

    // ========================================================================
    // writeNote
    // ========================================================================

    test("writeNote creates a note at a nested path that does not exist yet", async () => {
      await backend.writeNote({ path: "new/deep/note.md", content: "# Fresh\n" });

      expect(await state.read("new/deep/note.md")).toBe("# Fresh\n");
    });

    test("writeNote overwrites by default", async () => {
      await backend.writeNote({ path: "beta.md", content: "replaced\n" });

      expect(await state.read("beta.md")).toBe("replaced\n");
    });

    test("writeNote serializes supplied frontmatter", async () => {
      await backend.writeNote({
        path: "fm.md",
        content: "# Body\n",
        frontmatter: { title: "Written" },
      });

      const note = await backend.readNote("fm.md");
      expect(note.frontmatter).toEqual({ title: "Written" });
      expect(note.content).toBe("# Body\n");
    });

    test("writeNote append adds to the end and preserves frontmatter", async () => {
      await backend.writeNote({ path: "alpha.md", content: "appended\n", mode: "append" });

      const note = await backend.readNote("alpha.md");
      expect(note.frontmatter).toEqual({ title: "Alpha", tags: ["one"] });
      expect(note.content).toBe("\n# Alpha\n\nbody text\nappended\n");
    });

    test("writeNote prepend adds to the front and preserves frontmatter", async () => {
      await backend.writeNote({ path: "alpha.md", content: "prepended\n", mode: "prepend" });

      const note = await backend.readNote("alpha.md");
      expect(note.frontmatter).toEqual({ title: "Alpha", tags: ["one"] });
      expect(note.content).toBe("prepended\n\n# Alpha\n\nbody text\n");
    });

    test("writeNote append on a missing note degrades to a create", async () => {
      await backend.writeNote({ path: "brand-new.md", content: "first\n", mode: "append" });

      expect(await state.read("brand-new.md")).toBe("first\n");
    });

    test("writeNote rejects a restricted path", async () => {
      await expect(
        backend.writeNote({ path: ".obsidian/hack.md", content: "x" }),
      ).rejects.toThrow(/^Access denied/);
      expect(await state.exists(".obsidian/hack.md")).toBe(false);
    });

    // ========================================================================
    // patchNote
    // ========================================================================

    test("patchNote replaces a single occurrence", async () => {
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
      expect(await state.read("beta.md")).toBe("# Beta\n\npatched body\n");
    });

    test("patchNote refuses an ambiguous match", async () => {
      const result = await backend.patchNote({
        path: "twice.md",
        oldString: "repeat",
        newString: "once",
      });

      expect(result.success).toBe(false);
      expect(result.matchCount).toBe(2);
      expect(result.message).toContain("Use replaceAll=true");
      expect(await state.read("twice.md")).toBe(SEED["twice.md"]);
    });

    test("patchNote replaceAll rewrites every occurrence", async () => {
      const result = await backend.patchNote({
        path: "twice.md",
        oldString: "repeat",
        newString: "once",
        replaceAll: true,
      });

      expect(result.success).toBe(true);
      expect(await state.read("twice.md")).toBe("once\nonce\n");
    });

    test("patchNote reports a string that is not present", async () => {
      const result = await backend.patchNote({
        path: "beta.md",
        oldString: "absent",
        newString: "x",
      });

      expect(result.success).toBe(false);
      expect(result.matchCount).toBe(0);
      expect(result.message).toContain("String not found in note");
    });

    // ========================================================================
    // deleteNote
    // ========================================================================

    test("deleteNote removes a confirmed note", async () => {
      const result = await backend.deleteNote({ path: "beta.md", confirmPath: "beta.md" });

      expect(result.success).toBe(true);
      expect(await state.exists("beta.md")).toBe(false);
    });

    test("deleteNote cancels on a confirmation mismatch and leaves the note alone", async () => {
      const result = await backend.deleteNote({ path: "beta.md", confirmPath: "alpha.md" });

      expect(result).toEqual({
        success: false,
        path: "beta.md",
        message:
          "Deletion cancelled: confirmation path does not match. For safety, both 'path' and 'confirmPath' must be identical.",
      });
      expect(await state.exists("beta.md")).toBe(true);
    });

    test("deleteNote reports a missing note", async () => {
      const result = await backend.deleteNote({ path: "missing.md", confirmPath: "missing.md" });

      expect(result.success).toBe(false);
      expect(result.message).toContain("File not found: missing.md");
    });

    // ========================================================================
    // moveNote
    // ========================================================================

    test("moveNote renames a note", async () => {
      const result = await backend.moveNote({ oldPath: "beta.md", newPath: "notes/beta.md" });

      expect(result.success).toBe(true);
      expect(await state.exists("beta.md")).toBe(false);
      expect(await state.read("notes/beta.md")).toBe(SEED["beta.md"]);
    });

    test("moveNote refuses to clobber an existing destination", async () => {
      const result = await backend.moveNote({ oldPath: "beta.md", newPath: "alpha.md" });

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        "Target file already exists: alpha.md. Use overwrite=true to replace it.",
      );
      expect(await state.read("alpha.md")).toBe(SEED["alpha.md"]);
    });

    test("moveNote overwrites when asked", async () => {
      const result = await backend.moveNote({
        oldPath: "beta.md",
        newPath: "alpha.md",
        overwrite: true,
      });

      expect(result.success).toBe(true);
      expect(await state.read("alpha.md")).toBe(SEED["beta.md"]);
    });

    test("moveNote reports a missing source", async () => {
      const result = await backend.moveNote({ oldPath: "missing.md", newPath: "moved.md" });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Source file not found: missing.md");
    });

    // ========================================================================
    // moveFile
    // ========================================================================

    test("moveFile moves a confirmed file", async () => {
      const result = await backend.moveFile({
        oldPath: "beta.md",
        newPath: "notes/moved.md",
        confirmOldPath: "beta.md",
        confirmNewPath: "notes/moved.md",
      });

      expect(result.success).toBe(true);
      expect(await state.read("notes/moved.md")).toBe(SEED["beta.md"]);
    });

    test("moveFile cancels on a confirmation mismatch", async () => {
      const result = await backend.moveFile({
        oldPath: "beta.md",
        newPath: "notes/moved.md",
        confirmOldPath: "beta.md",
        confirmNewPath: "notes/typo.md",
      });

      expect(result).toEqual({
        success: false,
        oldPath: "beta.md",
        newPath: "notes/moved.md",
        message:
          "Move cancelled: confirmation paths do not match. For safety, oldPath must equal confirmOldPath and newPath must equal confirmNewPath.",
      });
      expect(await state.exists("beta.md")).toBe(true);
    });

    // ========================================================================
    // updateFrontmatter
    // ========================================================================

    test("updateFrontmatter merges by default and leaves the body untouched", async () => {
      await backend.updateFrontmatter({ path: "alpha.md", frontmatter: { status: "final" } });

      const note = await backend.readNote("alpha.md");
      expect(note.frontmatter).toEqual({ title: "Alpha", tags: ["one"], status: "final" });
      expect(note.content).toBe("\n# Alpha\n\nbody text\n");
    });

    test("updateFrontmatter with merge false replaces the block", async () => {
      await backend.updateFrontmatter({
        path: "alpha.md",
        frontmatter: { only: "this" },
        merge: false,
      });

      expect(await backend.getFrontmatter("alpha.md")).toEqual({ only: "this" });
    });

    test("updateFrontmatter rejects a restricted path", async () => {
      await expect(
        backend.updateFrontmatter({ path: ".git/config.md", frontmatter: { a: 1 } }),
      ).rejects.toThrow(/^Access denied/);
    });

    // ========================================================================
    // manageTags
    // ========================================================================

    test("manageTags lists frontmatter and inline tags together", async () => {
      const result = await backend.manageTags({ path: "notes/delta.md", operation: "list" });

      expect(result).toEqual({
        path: "notes/delta.md",
        operation: "list",
        tags: ["tagged"],
        success: true,
      });
    });

    test("manageTags adds a tag to the frontmatter", async () => {
      const result = await backend.manageTags({
        path: "notes/gamma.md",
        operation: "add",
        tags: ["added"],
      });

      expect(result.success).toBe(true);
      expect(result.tags).toEqual(["added"]);
      expect(await backend.getFrontmatter("notes/gamma.md")).toEqual({
        status: "draft",
        tags: ["added"],
      });
    });

    test("manageTags removes a tag", async () => {
      const result = await backend.manageTags({
        path: "alpha.md",
        operation: "remove",
        tags: ["one"],
      });

      expect(result.success).toBe(true);
      expect(result.tags).toEqual([]);
      expect(await backend.getFrontmatter("alpha.md")).toEqual({ title: "Alpha" });
    });

    test("manageTags reports a restricted path without throwing", async () => {
      const result = await backend.manageTags({ path: ".git/secret.md", operation: "list" });

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/^Access denied/);
    });
  });
}
