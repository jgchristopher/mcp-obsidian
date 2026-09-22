import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAILY_NOTES_COMMAND_ID, createPeriodicNote } from "./create.js";
import type { PeriodicCreateDeps } from "./create.js";
import { UnsupportedPeriodError } from "./resolve.js";
import { FileSystemService } from "../../filesystem.js";

/**
 * jcOS's real daily-notes settings, so the fixture exercises the nested folder
 * layout rather than a flat one.
 */
const JCOS_CONFIG = {
  format: "YYYY/MM/YYYY-MM-DD",
  folder: "Daily_Notes",
  template: "templates/daily.md",
};

/** The date under test is always injected — never `new Date()`. See dateFormat.test.ts. */
const JULY_30_2026 = new Date(2026, 6, 30);
const JULY_30_PATH = "Daily_Notes/2026/07/2026-07-30.md";

let vaultPath: string;

async function writeConfig(config: unknown): Promise<void> {
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(vaultPath, ".obsidian", "daily-notes.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

async function writeVaultFile(path: string, content: string): Promise<void> {
  const full = join(vaultPath, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function readVaultFile(path: string): Promise<string> {
  return readFile(join(vaultPath, path), "utf-8");
}

/** Deps with no running Obsidian: the template arm. */
function deps(overrides: Partial<PeriodicCreateDeps> = {}): PeriodicCreateDeps {
  return {
    vaultPath,
    backend: new FileSystemService(vaultPath),
    now: () => JULY_30_2026,
    sleep: async () => {},
    ...overrides,
  };
}

beforeEach(async () => {
  vaultPath = realpathSync(await mkdtemp(join(tmpdir(), "mcpvault-create-")));
  await writeConfig(JCOS_CONFIG);
  await writeVaultFile("templates/daily.md", "---\ntags:\n  - daily\n---\n\n# Email Triage\n");
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("createPeriodicNote", () => {
  test("returns the existing note and writes nothing when it already exists", async () => {
    await writeVaultFile(JULY_30_PATH, "# Written by hand\n");

    const result = await createPeriodicNote(deps(), { period: "daily", date: JULY_30_2026 });

    expect(result).toMatchObject({ path: JULY_30_PATH, created: false, via: "existing" });
    expect(await readVaultFile(JULY_30_PATH)).toBe("# Written by hand\n");
  });

  test("renders the configured template when Obsidian is not reachable", async () => {
    const result = await createPeriodicNote(deps(), { period: "daily", date: JULY_30_2026 });

    expect(result).toMatchObject({ path: JULY_30_PATH, created: true, via: "template" });
    expect(await readVaultFile(JULY_30_PATH)).toBe(
      "---\ntags:\n  - daily\n---\n\n# Email Triage\n",
    );
  });

  test("fills template tokens with the note's own date", async () => {
    await writeVaultFile("templates/daily.md", "# {{date}}\n");

    await createPeriodicNote(deps(), { period: "daily", date: JULY_30_2026 });

    expect(await readVaultFile(JULY_30_PATH)).toBe("# 2026-07-30\n");
  });

  test("reports Templater tags the template arm cannot render", async () => {
    await writeVaultFile("templates/daily.md", `WHERE x = "<% tp.date.now('YYYY-MM-DD') %>"\n`);

    const result = await createPeriodicNote(deps(), { period: "daily", date: JULY_30_2026 });

    expect(result.unrendered).toEqual(["<% tp.date.now('YYYY-MM-DD') %>"]);
  });

  test("creates an empty note when no template is configured", async () => {
    await writeConfig({ format: JCOS_CONFIG.format, folder: JCOS_CONFIG.folder });

    const result = await createPeriodicNote(deps(), { period: "daily", date: JULY_30_2026 });

    expect(result).toMatchObject({ created: true, via: "template" });
    expect(await readVaultFile(JULY_30_PATH)).toBe("");
  });

  test("lets Obsidian create the note when Obsidian is reachable", async () => {
    const commands: string[] = [];
    const runCommand = async (id: string): Promise<void> => {
      commands.push(id);
      await writeVaultFile(JULY_30_PATH, "# Written by Obsidian\n");
    };

    const result = await createPeriodicNote(deps({ runCommand }), {
      period: "daily",
      date: JULY_30_2026,
    });

    expect(commands).toEqual([DAILY_NOTES_COMMAND_ID]);
    expect(result).toMatchObject({ created: true, via: "obsidian" });
    expect(await readVaultFile(JULY_30_PATH)).toBe("# Written by Obsidian\n");
  });

  test("waits for Templater to finish rewriting the note Obsidian created", async () => {
    // Obsidian writes the raw template first; Templater rewrites it a beat
    // later. Returning between the two hands the caller a note that is about to
    // be overwritten, losing whatever the caller appended.
    const runCommand = async (): Promise<void> => {
      await writeVaultFile(JULY_30_PATH, "<% tp.date.now('YYYY-MM-DD') %>\n");
    };
    let waits = 0;
    const sleep = async (): Promise<void> => {
      waits += 1;
      if (waits === 2) await writeVaultFile(JULY_30_PATH, "2026-07-30\n");
    };

    const result = await createPeriodicNote(deps({ runCommand, sleep }), {
      period: "daily",
      date: JULY_30_2026,
    });

    expect(result).toMatchObject({ created: true, via: "obsidian" });
    expect(await readVaultFile(JULY_30_PATH)).toBe("2026-07-30\n");
  });

  test("falls back to the template when the command never produces the note", async () => {
    const runCommand = async (): Promise<void> => {};

    const result = await createPeriodicNote(deps({ runCommand }), {
      period: "daily",
      date: JULY_30_2026,
    });

    expect(result).toMatchObject({ created: true, via: "template" });
    expect(result.reason).toMatch(/did not appear/i);
    expect(await readVaultFile(JULY_30_PATH)).toBe(
      "---\ntags:\n  - daily\n---\n\n# Email Triage\n",
    );
  });

  test("falls back to the template when the command itself fails", async () => {
    const runCommand = async (): Promise<void> => {
      throw new Error("Obsidian is not reachable");
    };

    const result = await createPeriodicNote(deps({ runCommand }), {
      period: "daily",
      date: JULY_30_2026,
    });

    expect(result).toMatchObject({ created: true, via: "template" });
    expect(result.reason).toMatch(/not reachable/i);
  });

  test("uses the template for any date but today, which is all the command can make", async () => {
    const commands: string[] = [];
    const runCommand = async (id: string): Promise<void> => {
      commands.push(id);
    };

    const result = await createPeriodicNote(deps({ runCommand, now: () => new Date(2026, 6, 31) }), {
      period: "daily",
      date: JULY_30_2026,
    });

    expect(commands).toEqual([]);
    expect(result).toMatchObject({ created: true, via: "template" });
    expect(result.reason).toMatch(/today/i);
  });

  test("rejects every period but daily", async () => {
    await expect(
      createPeriodicNote(deps(), { period: "weekly", date: JULY_30_2026 }),
    ).rejects.toThrow(UnsupportedPeriodError);
  });
});
