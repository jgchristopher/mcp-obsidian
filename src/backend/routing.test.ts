import { test, expect, beforeEach, describe } from "vitest";
import { RoutingBackend, READ_OPERATIONS } from "./routing.js";
import { BackendError } from "./types.js";
import type { BackendFailure, VaultBackend } from "./types.js";
import type { HealthGate } from "./health.js";

/**
 * The fallback policy is pure decision logic over failure kinds, so it is
 * tested against stubs: no network, no filesystem, every branch reachable on
 * demand. The stakes are why — an `unknown-state` write that falls back is a
 * silently duplicated `append` in a real note.
 */

/**
 * Rejects every call with the configured failure, or resolves with a marker
 * naming the backend that served it — which is how each test tells the two
 * arms apart.
 */
class StubBackend implements VaultBackend {
  readonly calls: string[] = [];
  failure: BackendFailure | null = null;
  /** Thrown instead of a `BackendError` when set, to prove passthrough. */
  raw: Error | null = null;

  constructor(readonly name: "filesystem" | "rest") {}

  private async run<T>(method: string, value: T): Promise<T> {
    this.calls.push(method);
    if (this.raw) throw this.raw;
    if (this.failure) {
      throw new BackendError(this.failure, `stub failure: ${this.failure.kind}`);
    }
    return value;
  }

  readNote(path: string): any {
    return this.run("readNote", { source: this.name, path });
  }
  readMultipleNotes(): any {
    return this.run("readMultipleNotes", { successful: [{ source: this.name }], failed: [] });
  }
  getNotesInfo(): any {
    return this.run("getNotesInfo", [{ source: this.name }]);
  }
  listDirectory(): any {
    return this.run("listDirectory", { files: [this.name], directories: [] });
  }
  getFrontmatter(): any {
    return this.run("getFrontmatter", { source: this.name });
  }
  listAllTags(): any {
    return this.run("listAllTags", [{ tag: this.name, count: 1 }]);
  }
  writeNote(): any {
    return this.run("writeNote", undefined);
  }
  patchNote(): any {
    return this.run("patchNote", { success: true, path: "x", message: this.name });
  }
  deleteNote(): any {
    return this.run("deleteNote", { success: true, path: "x", message: this.name });
  }
  moveNote(): any {
    return this.run("moveNote", { success: true, oldPath: "a", newPath: "b", message: this.name });
  }
  moveFile(): any {
    return this.run("moveFile", { success: true, oldPath: "a", newPath: "b", message: this.name });
  }
  updateFrontmatter(): any {
    return this.run("updateFrontmatter", undefined);
  }
  manageTags(): any {
    return this.run("manageTags", { path: "x", operation: "list", tags: [], success: true });
  }
  getPeriodicNote(): any {
    return this.run("getPeriodicNote", {
      period: "daily",
      path: `${this.name}.md`,
      exists: true,
    });
  }
  getDocumentMap(): any {
    return this.run("getDocumentMap", {
      headings: [{ path: this.name, level: 1, line: 1 }],
      blockRefs: [],
      frontmatterKeys: [],
    });
  }
}

class StubHealth implements HealthGate {
  usable = true;
  unreachableMarks = 0;

  async restUsable(): Promise<boolean> {
    return this.usable;
  }
  markUnreachable(): void {
    this.unreachableMarks += 1;
  }
}

let rest: StubBackend;
let filesystem: StubBackend;
let health: StubHealth;
let routing: RoutingBackend;

beforeEach(() => {
  rest = new StubBackend("rest");
  filesystem = new StubBackend("filesystem");
  health = new StubHealth();
  routing = new RoutingBackend(rest, filesystem, health);
});

const WRITE_PARAMS = {
  path: "note.md",
  content: "body",
} as const;

// ============================================================================
// SMOKE
// ============================================================================

test("smoke: a never-sent failure on readNote reaches the filesystem", async () => {
  rest.failure = { kind: "never-sent", cause: new Error("ECONNREFUSED") };

  const note = await routing.readNote("note.md");

  expect(filesystem.calls).toEqual(["readNote"]);
  expect((note as any).source).toBe("filesystem");
});

// ============================================================================
// HAPPY PATH AND THE HEALTH GATE
// ============================================================================

test("REST serves the call when health says it is usable", async () => {
  const note = await routing.readNote("note.md");

  expect(rest.calls).toEqual(["readNote"]);
  expect(filesystem.calls).toEqual([]);
  expect((note as any).source).toBe("rest");
});

test("an unusable REST is never attempted", async () => {
  health.usable = false;

  await routing.writeNote({ ...WRITE_PARAMS });

  expect(rest.calls).toEqual([]);
  expect(filesystem.calls).toEqual(["writeNote"]);
});

test("the router reports itself as the rest backend", () => {
  expect(routing.name).toBe("rest");
});

// ============================================================================
// THE FAILURE MATRIX
// ============================================================================

describe("never-sent", () => {
  beforeEach(() => {
    rest.failure = { kind: "never-sent", cause: new Error("connect ECONNREFUSED") };
  });

  test("a read falls back", async () => {
    const note = await routing.readNote("note.md");

    expect((note as any).source).toBe("filesystem");
    expect(health.unreachableMarks).toBe(1);
  });

  test("a write falls back, because nothing was applied", async () => {
    await routing.writeNote({ ...WRITE_PARAMS });

    expect(filesystem.calls).toEqual(["writeNote"]);
    expect(health.unreachableMarks).toBe(1);
  });
});

describe("unknown-state", () => {
  beforeEach(() => {
    rest.failure = { kind: "unknown-state", cause: new Error("socket hang up") };
  });

  test("a read falls back and returns the filesystem result", async () => {
    const note = await routing.readNote("note.md");

    expect(filesystem.calls).toEqual(["readNote"]);
    expect((note as any).source).toBe("filesystem");
    expect(health.unreachableMarks).toBe(1);
  });

  test("a write throws and the filesystem is never called", async () => {
    await expect(routing.writeNote({ ...WRITE_PARAMS })).rejects.toThrow(/unknown state/);

    expect(filesystem.calls).toEqual([]);
    expect(health.unreachableMarks).toBe(1);
  });

  test("the write error names the operation, the note, and the cause", async () => {
    await expect(routing.writeNote({ ...WRITE_PARAMS })).rejects.toThrow(
      /Write 'writeNote' on note\.md .*socket hang up/s,
    );
  });

  test("every write operation refuses to fall back", async () => {
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["writeNote", () => routing.writeNote({ ...WRITE_PARAMS })],
      [
        "patchNote",
        () => routing.patchNote({ path: "note.md", oldString: "a", newString: "b" }),
      ],
      ["deleteNote", () => routing.deleteNote({ path: "note.md", confirmPath: "note.md" })],
      ["moveNote", () => routing.moveNote({ oldPath: "a.md", newPath: "b.md" })],
      [
        "moveFile",
        () =>
          routing.moveFile({
            oldPath: "a.md",
            newPath: "b.md",
            confirmOldPath: "a.md",
            confirmNewPath: "b.md",
          }),
      ],
      [
        "updateFrontmatter",
        () => routing.updateFrontmatter({ path: "note.md", frontmatter: { a: 1 } }),
      ],
      ["manageTags", () => routing.manageTags({ path: "note.md", operation: "add", tags: ["x"] })],
    ];

    for (const [name, call] of writes) {
      await expect(call(), `${name} must not fall back`).rejects.toThrow(
        new RegExp(`Write '${name}'`),
      );
    }

    expect(filesystem.calls).toEqual([]);
  });

  test("every read operation falls back", async () => {
    await routing.readNote("note.md");
    await routing.readMultipleNotes({ paths: ["note.md"] });
    await routing.getNotesInfo(["note.md"]);
    await routing.listDirectory("");
    await routing.getFrontmatter("note.md");
    await routing.listAllTags();
    await routing.getPeriodicNote({ period: "daily", date: new Date(2026, 6, 30) });
    await routing.getDocumentMap("note.md");

    expect(filesystem.calls).toEqual([
      "readNote",
      "readMultipleNotes",
      "getNotesInfo",
      "listDirectory",
      "getFrontmatter",
      "listAllTags",
      "getPeriodicNote",
      "getDocumentMap",
    ]);
  });
});

describe("unsupported", () => {
  beforeEach(() => {
    rest.failure = { kind: "unsupported", operation: "deleteNote(trashMode: system)" };
  });

  test("a read falls back", async () => {
    const note = await routing.readNote("note.md");

    expect((note as any).source).toBe("filesystem");
  });

  test("a write falls back, since the backend refused before sending anything", async () => {
    const result = await routing.deleteNote({
      path: "note.md",
      confirmPath: "note.md",
      trashMode: "system",
    });

    expect(filesystem.calls).toEqual(["deleteNote"]);
    expect(result.message).toBe("filesystem");
  });

  test("an unsupported operation does not mark REST unreachable", async () => {
    await routing.readNote("note.md");

    expect(health.unreachableMarks).toBe(0);
  });
});

// ============================================================================
// WHAT MUST NOT TRIGGER FALLBACK
// ============================================================================

test("a plain Error propagates untouched, with no filesystem retry", async () => {
  // This is what a 404 or a 500 looks like by the time it leaves RestBackend:
  // an authoritative answer from Obsidian, already translated.
  rest.raw = new Error("File not found: note.md. Use list_directory to see available files.");

  await expect(routing.readNote("note.md")).rejects.toThrow("File not found: note.md");
  expect(filesystem.calls).toEqual([]);
  expect(health.unreachableMarks).toBe(0);
});

test("a 500-shaped error on a write neither falls back nor is rewritten", async () => {
  rest.raw = new Error("Failed to write file: note.md - HTTP 500");

  await expect(routing.writeNote({ ...WRITE_PARAMS })).rejects.toThrow(
    "Failed to write file: note.md - HTTP 500",
  );
  expect(filesystem.calls).toEqual([]);
});

// ============================================================================
// THE READ SET ITSELF
// ============================================================================

test("every VaultBackend member is classified, and writes are the default", () => {
  const members = [
    "readNote",
    "readMultipleNotes",
    "getNotesInfo",
    "writeNote",
    "patchNote",
    "deleteNote",
    "moveNote",
    "moveFile",
    "listDirectory",
    "getFrontmatter",
    "updateFrontmatter",
    "manageTags",
    "listAllTags",
    "getPeriodicNote",
    "getDocumentMap",
  ];

  // Guards against a member being added to the interface and silently skipped
  // here: the router must implement every one of them.
  for (const member of members) {
    expect(typeof (routing as any)[member], member).toBe("function");
  }

  expect([...READ_OPERATIONS].every((op) => members.includes(op))).toBe(true);
  expect(READ_OPERATIONS.has("writeNote")).toBe(false);
  expect(READ_OPERATIONS.has("patchNote")).toBe(false);
});
