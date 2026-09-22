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
    /**
     * Vault-relative template a new daily note starts from, when one is set.
     * Absent when the setting is missing or blank, which is Obsidian's own "no
     * template, start empty".
     */
    template?: string;
}
/** What Obsidian falls back to when the setting is present but blank. */
export declare const DEFAULT_DAILY_NOTES_FORMAT = "YYYY-MM-DD";
export declare const DAILY_NOTES_CONFIG_RELATIVE_PATH = ".obsidian/daily-notes.json";
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
export declare function readDailyNotesConfig(vaultPath: string): Promise<DailyNotesConfig | null>;
//# sourceMappingURL=config.d.ts.map