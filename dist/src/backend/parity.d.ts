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
export declare const PARITY_MAPPINGS: readonly ParityMapping[];
/**
 * Targets that are served by the filesystem no matter what, because
 * `createServer` wires them to a service rather than to `VaultBackend`.
 *
 * The smoke run uses this to label which path answered each call. Without it, a
 * clean "13 PASS" reads as thirteen REST round trips when three of them never
 * touch the network — which is how a REST outage hides behind a green run.
 */
export declare const FILESYSTEM_ONLY_TARGETS: ReadonlySet<string>;
/** Distinct MCPVault tools referenced by the table. Eleven, not thirteen. */
export declare function uniqueTargets(): string[];
//# sourceMappingURL=parity.d.ts.map