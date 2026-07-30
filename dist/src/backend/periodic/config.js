import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
export async function readDailyNotesConfig(vaultPath) {
    const configPath = join(vaultPath, ".obsidian", "daily-notes.json");
    let raw;
    try {
        raw = await readFile(configPath, "utf-8");
    }
    catch (error) {
        const code = error.code;
        // ENOTDIR covers `.obsidian` existing as a file rather than a directory.
        if (code === "ENOENT" || code === "ENOTDIR")
            return null;
        throw new Error(`Failed to read daily-notes settings at ${configPath}: ${describe(error)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`Malformed daily-notes settings at ${configPath}: ${describe(error)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Malformed daily-notes settings at ${configPath}: expected a JSON object.`);
    }
    // Obsidian omits keys left at their default, so a present-but-partial file is
    // normal and the documented defaults apply. `template` is read by Obsidian and
    // ignored here — this project never creates a note from a template.
    const record = parsed;
    const folder = typeof record.folder === "string" ? record.folder : "";
    const format = typeof record.format === "string" && record.format.trim() !== ""
        ? record.format
        : DEFAULT_DAILY_NOTES_FORMAT;
    return { folder, format };
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
