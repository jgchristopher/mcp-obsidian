import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDailyNotesConfig } from "./config.js";
import {
  PeriodicNotesUnconfiguredError,
  UnsupportedPeriodError,
  loadPeriodicNote,
  loadRecentPeriodicNotes,
  recentDailyDates,
  resolvePeriodicPath,
} from "./resolve.js";
import type { PeriodicNoteReader } from "./resolve.js";
import { FileSystemService } from "../../filesystem.js";

/** jcOS's real values, verified live against the vault. */
const JCOS_CONFIG = {
  format: "YYYY/MM/YYYY-MM-DD",
  folder: "Daily_Notes",
  template: "templates/daily.md",
};

const JULY_30_2026 = new Date(2026, 6, 30);

let vaultPath: string;

async function writeConfig(config: unknown): Promise<void> {
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    join(vaultPath, ".obsidian", "daily-notes.json"),
    JSON.stringify(config),
    "utf-8",
  );
}

async function writeNote(path: string, content: string): Promise<void> {
  const full = join(vaultPath, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf-8");
}

function reader(): PeriodicNoteReader {
  return new FileSystemService(vaultPath);
}

beforeEach(async () => {
  vaultPath = realpathSync(await mkdtemp(join(tmpdir(), "mcpvault-periodic-")));
});

afterEach(async () => {
  await rm(vaultPath, { recursive: true, force: true });
});

describe("readDailyNotesConfig", () => {
  test("returns null when the vault has no daily-notes settings", async () => {
    expect(await readDailyNotesConfig(vaultPath)).toBeNull();
  });

  test("reads folder, format, and the template the note is created from", async () => {
    await writeConfig(JCOS_CONFIG);

    expect(await readDailyNotesConfig(vaultPath)).toEqual({
      folder: "Daily_Notes",
      format: "YYYY/MM/YYYY-MM-DD",
      template: "templates/daily.md",
    });
  });

  test("reports no template when the settings file names none", async () => {
    await writeConfig({ folder: "Daily_Notes", format: "YYYY-MM-DD", template: "  " });

    expect(await readDailyNotesConfig(vaultPath)).toEqual({
      folder: "Daily_Notes",
      format: "YYYY-MM-DD",
    });
  });

  test("applies Obsidian's defaults for keys the settings file omits", async () => {
    await writeConfig({});

    expect(await readDailyNotesConfig(vaultPath)).toEqual({ folder: "", format: "YYYY-MM-DD" });
  });

  test("throws rather than reporting 'unconfigured' when the file is malformed", async () => {
    await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
    await writeFile(join(vaultPath, ".obsidian", "daily-notes.json"), "{not json", "utf-8");

    await expect(readDailyNotesConfig(vaultPath)).rejects.toThrow(
      /Malformed daily-notes settings/,
    );
  });
});

describe("resolvePeriodicPath", () => {
  test("resolves the nested jcOS layout for an injected date", async () => {
    await writeConfig(JCOS_CONFIG);

    expect(await resolvePeriodicPath(vaultPath, "daily", JULY_30_2026)).toBe(
      "Daily_Notes/2026/07/2026-07-30.md",
    );
  });

  test("derives from the config rather than duplicating it", async () => {
    // Same date, different settings: the resolved path has to follow the file.
    await writeConfig({ folder: "Journal", format: "YYYY-MM-DD" });

    expect(await resolvePeriodicPath(vaultPath, "daily", JULY_30_2026)).toBe(
      "Journal/2026-07-30.md",
    );
  });

  test("resolves to the vault root when the folder is empty", async () => {
    await writeConfig({ folder: "", format: "YYYY-MM-DD" });

    expect(await resolvePeriodicPath(vaultPath, "daily", JULY_30_2026)).toBe("2026-07-30.md");
  });

  test("normalizes a folder written with surrounding slashes", async () => {
    await writeConfig({ folder: "/Daily_Notes/", format: "YYYY-MM-DD" });

    expect(await resolvePeriodicPath(vaultPath, "daily", JULY_30_2026)).toBe(
      "Daily_Notes/2026-07-30.md",
    );
  });

  test("reports unconfigured daily notes instead of guessing a path", async () => {
    await expect(resolvePeriodicPath(vaultPath, "daily", JULY_30_2026)).rejects.toThrow(
      PeriodicNotesUnconfiguredError,
    );
  });

  for (const period of ["weekly", "monthly", "quarterly", "yearly"] as const) {
    test(`'${period}' names the missing periodic-notes plugin`, async () => {
      await writeConfig(JCOS_CONFIG);

      await expect(resolvePeriodicPath(vaultPath, period, JULY_30_2026)).rejects.toThrow(
        UnsupportedPeriodError,
      );
      await expect(resolvePeriodicPath(vaultPath, period, JULY_30_2026)).rejects.toThrow(
        /'periodic-notes' community plugin/,
      );
    });
  }
});

describe("recentDailyDates", () => {
  test("counts back from the injected date, newest first", () => {
    const dates = recentDailyDates(new Date(2026, 6, 2), 4);

    expect(dates.map((d) => [d.getFullYear(), d.getMonth(), d.getDate()])).toEqual([
      [2026, 6, 2],
      [2026, 6, 1],
      [2026, 5, 30],
      [2026, 5, 29],
    ]);
  });
});

describe("loadPeriodicNote", () => {
  test("returns the note when it exists", async () => {
    await writeConfig(JCOS_CONFIG);
    await writeNote("Daily_Notes/2026/07/2026-07-30.md", "---\nmood: fine\n---\n\n# Today\n");

    const result = await loadPeriodicNote(reader(), vaultPath, {
      period: "daily",
      date: JULY_30_2026,
    });

    expect(result).toEqual({
      period: "daily",
      path: "Daily_Notes/2026/07/2026-07-30.md",
      exists: true,
      frontmatter: { mood: "fine" },
      content: "\n# Today\n",
    });
  });

  test("returns the resolved path with exists false when the note is missing", async () => {
    await writeConfig(JCOS_CONFIG);

    expect(await loadPeriodicNote(reader(), vaultPath, { period: "daily", date: JULY_30_2026 })).toEqual(
      { period: "daily", path: "Daily_Notes/2026/07/2026-07-30.md", exists: false },
    );
  });
});

describe("loadRecentPeriodicNotes", () => {
  test("skips dates with no note instead of failing", async () => {
    await writeConfig({ folder: "Daily_Notes", format: "YYYY-MM-DD" });
    await writeNote("Daily_Notes/2026-07-30.md", "# Thursday\n");
    await writeNote("Daily_Notes/2026-07-28.md", "# Tuesday\n");

    const results = await loadRecentPeriodicNotes(reader(), vaultPath, "daily", 5, JULY_30_2026);

    expect(results.map((r) => r.path)).toEqual([
      "Daily_Notes/2026-07-30.md",
      "Daily_Notes/2026-07-28.md",
    ]);
    expect(results.every((r) => r.exists)).toBe(true);
  });

  test("returns an empty list when nothing in the window exists", async () => {
    await writeConfig(JCOS_CONFIG);

    expect(await loadRecentPeriodicNotes(reader(), vaultPath, "daily", 3, JULY_30_2026)).toEqual([]);
  });
});
