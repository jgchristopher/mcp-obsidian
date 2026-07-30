/**
 * The retirement checklist for `obsidian-jcos`, the Python `mcp-obsidian`
 * server this package replaces.
 *
 * One table, two consumers. `parity.test.ts` asserts every `mcpvault` target is
 * genuinely registered, which catches a rename at build time and keeps catching
 * it forever. `scripts/parity-smoke.ts` calls each counterpart against the live
 * vault, which catches the case where a tool is registered and mapped but does
 * not actually work. Neither check subsumes the other: the mapping test would
 * pass on a server where every handler throws, and the smoke run cannot run in
 * CI because it needs a real Obsidian.
 *
 * Both consumers read this array so the mechanical check and the live check can
 * never drift apart.
 */

export interface ParityMapping {
  /** `obsidian-jcos` tool name. */
  python: string;
  /** MCPVault tool name that replaces it. */
  mcpvault: string;
  /** How the call differs, when it does. Absent means a straight swap. */
  note?: string;
}

/**
 * Thirteen rows naming **eleven** distinct targets — `list_directory` and
 * `write_note` each answer two Python tools. Anything asserting a distinct-name
 * count against `length` will be wrong by two.
 *
 * The three `note` fields are what make "parity" an honest claim rather than a
 * name match. Where the call shape genuinely differs, it is recorded here
 * instead of being discovered after the old server is gone.
 */
export const PARITY_MAPPINGS: readonly ParityMapping[] = [
  { python: "obsidian_list_files_in_vault", mcpvault: "list_directory", note: 'path: "" for vault root' },
  { python: "obsidian_list_files_in_dir", mcpvault: "list_directory" },
  { python: "obsidian_get_file_contents", mcpvault: "read_note" },
  { python: "obsidian_batch_get_file_contents", mcpvault: "read_multiple_notes" },
  { python: "obsidian_simple_search", mcpvault: "search_notes" },
  {
    python: "obsidian_complex_search",
    mcpvault: "search_vault_advanced",
    note: "JsonLogic only; Dataview absent in this vault",
  },
  { python: "obsidian_patch_content", mcpvault: "patch_note" },
  { python: "obsidian_append_content", mcpvault: "write_note", note: 'mode: "append"' },
  { python: "obsidian_put_content", mcpvault: "write_note", note: 'mode: "overwrite"' },
  { python: "obsidian_delete_file", mcpvault: "delete_note", note: "requires confirmPath" },
  { python: "obsidian_get_periodic_note", mcpvault: "get_periodic_note", note: "daily only" },
  { python: "obsidian_get_recent_periodic_notes", mcpvault: "get_recent_periodic_notes" },
  {
    python: "obsidian_get_recent_changes",
    mcpvault: "get_recent_changes",
    note: "filesystem-native; the Python version needs Dataview and returns 400 here",
  },
] as const;

/**
 * Targets that are served by the filesystem no matter what, because
 * `createServer` wires them to a service rather than to `VaultBackend`.
 *
 * The smoke run uses this to label which path answered each call. Without it, a
 * clean "13 PASS" reads as thirteen REST round trips when three of them never
 * touch the network — which is how a REST outage hides behind a green run.
 */
export const FILESYSTEM_ONLY_TARGETS: ReadonlySet<string> = new Set([
  "search_notes",
  "get_recent_changes",
  "get_recent_periodic_notes",
]);

/** Distinct MCPVault tools referenced by the table. Eleven, not thirteen. */
export function uniqueTargets(): string[] {
  return [...new Set(PARITY_MAPPINGS.map((m) => m.mcpvault))].sort();
}
