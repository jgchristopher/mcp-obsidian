import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reader for Obsidian's own daily-notes settings.
 *
 * This is the one place in the codebase that reads inside `.obsidian`, and it
 * does so **without** `FileSystemService` or `PathFilter`. That is deliberate:
 * `.obsidian` is a restricted segment at any depth and `.json` is not an allowed
 * extension, so serving this through the normal path would mean widening a
 * boundary that every tool-facing path shares. Instead the path is built from
 * `vaultPath` plus two string literals — no caller-supplied component reaches
 * it, so there is no traversal surface to guard — and `PathFilter` is left
 * exactly as it was.
 *
 * Read-only. Nothing in this project writes to `.obsidian`.
 */

export interface DailyNotesConfig {
  /** Vault-relative folder daily notes live in. `""` means the vault root. */
  folder: string;
  /** Obsidian date format, e.g. `YYYY/MM/YYYY-MM-DD`. */
  format: string;
}

/** What Obsidian falls back to when the setting is present but blank. */
export const DEFAULT_DAILY_NOTES_FORMAT = "YYYY-MM-DD";

export const DAILY_NOTES_CONFIG_RELATIVE_PATH = ".obsidian/daily-notes.json";

/**
 * Read `<vaultPath>/.obsidian/daily-notes.json`.
 *
 * Returns `null` when the file does not exist. Obsidian itself would default to
 * folder `""` and format `YYYY-MM-DD` in that case, but applying those defaults
 * here would resolve a plausible path that is almost certainly not the user's
 * daily note. An explicit `null` lets the caller say "daily notes are not
 * configured" instead of guessing.
 *
 * A file that exists but is unreadable or malformed throws: that is a broken
 * vault configuration, and reporting it as "unconfigured" would hide it.
 */
export async function readDailyNotesConfig(vaultPath: string): Promise<DailyNotesConfig | null> {
  const configPath = join(vaultPath, ".obsidian", "daily-notes.json");

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR covers `.obsidian` existing as a file rather than a directory.
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(
      `Failed to read daily-notes settings at ${configPath}: ${describe(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed daily-notes settings at ${configPath}: ${describe(error)}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed daily-notes settings at ${configPath}: expected a JSON object.`);
  }

  // Obsidian omits keys left at their default, so a present-but-partial file is
  // normal and the documented defaults apply. `template` is read by Obsidian and
  // ignored here — this project never creates a note from a template.
  const record = parsed as Record<string, unknown>;
  const folder = typeof record.folder === "string" ? record.folder : "";
  const format =
    typeof record.format === "string" && record.format.trim() !== ""
      ? record.format
      : DEFAULT_DAILY_NOTES_FORMAT;

  return { folder, format };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
