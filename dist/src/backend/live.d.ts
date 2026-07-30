import { PathFilter } from "../pathfilter.js";
import type { RestClient } from "./rest/client.js";
/**
 * The capabilities that exist only inside a running Obsidian.
 *
 * Registered commands, the active file, opening a note in the UI, and
 * Obsidian's own query index have **no filesystem equivalent**, so none of them
 * belongs on `VaultBackend`. Routing them through `RoutingBackend` would land in
 * its `unsupported` branch, which falls back to the filesystem — where there is
 * nothing to fall back to. The tool would appear to succeed while doing
 * nothing. Failing closed with `ObsidianUnavailableError` is the correct
 * outcome, so these five live outside the seam entirely.
 *
 * The tools stay registered even with `OBSIDIAN_API_KEY` unset. A named error
 * explaining what to start is more discoverable than a tool that silently
 * vanishes from `ListTools`.
 */
export declare class ObsidianUnavailableError extends Error {
    readonly tool: string;
    constructor(tool: string, cause?: unknown);
}
/**
 * The only content type ever sent to `POST /search/`.
 *
 * Dataview DQL is out of scope: verified live, the DQL content type returns
 * `400 errorCode 40012` because the Dataview plugin is not installed in the
 * target vault. Offering it would advertise a capability that always fails.
 */
export declare const JSON_LOGIC_CONTENT_TYPE = "application/vnd.olrapi.jsonlogic+json";
export interface ObsidianCommand {
    id: string;
    name: string;
}
export interface ObsidianLiveOptions {
    pathFilter?: PathFilter;
}
export declare class ObsidianLiveService {
    private readonly client;
    private readonly pathFilter;
    /**
     * @param client `null` when `resolveRestConfig()` found no API key. Every call
     *               then raises `ObsidianUnavailableError`, which is the same
     *               outcome as a closed Obsidian and says the same thing.
     */
    constructor(client: RestClient | null, options?: ObsidianLiveOptions);
    /** Every command Obsidian has registered, its own plus every plugin's. */
    listCommands(): Promise<ObsidianCommand[]>;
    /**
     * Run one registered command.
     *
     * The widest blast radius in the project: the id space covers every installed
     * plugin, and Obsidian applies whatever the command does with no confirmation
     * and no undo hook. The tool description says so plainly.
     */
    executeCommand(id: unknown): Promise<{
        success: boolean;
        id: string;
    }>;
    /** The note Obsidian currently has focused. */
    getActiveFile(): Promise<{
        path: string;
    }>;
    /** Open a note in the Obsidian UI. */
    openFile(inputPath: unknown): Promise<{
        success: boolean;
        path: string;
    }>;
    /**
     * Query Obsidian's own index with a JsonLogic expression.
     *
     * One content type, always. See `JSON_LOGIC_CONTENT_TYPE`.
     */
    searchVaultAdvanced(query: unknown): Promise<unknown[]>;
    /**
     * A missing client and a transport failure collapse to the same error on
     * purpose: from the caller's side both mean "Obsidian is not answering".
     * An HTTP status is still an authoritative answer and is left to the caller.
     */
    private send;
    private static assertOk;
    private static parse;
    private static detail;
    /**
     * The same guard every other path-taking tool applies. `open_file` reaches
     * Obsidian rather than the disk, but a tool that could open `.obsidian/*` in
     * the UI would still be a hole in a boundary this project keeps closed
     * everywhere else.
     */
    private prepare;
}
//# sourceMappingURL=live.d.ts.map