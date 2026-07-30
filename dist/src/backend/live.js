import { PathFilter } from "../pathfilter.js";
import { BackendError } from "./types.js";
import { RestConfigurationError } from "./rest/index.js";
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
export class ObsidianUnavailableError extends Error {
    tool;
    constructor(tool, cause) {
        super(`'${tool}' requires a running Obsidian with the Local REST API plugin. ` +
            `Obsidian is not reachable. Start Obsidian and retry.`, cause === undefined ? undefined : { cause });
        this.tool = tool;
        this.name = "ObsidianUnavailableError";
    }
}
/**
 * The only content type ever sent to `POST /search/`.
 *
 * Dataview DQL is out of scope: verified live, the DQL content type returns
 * `400 errorCode 40012` because the Dataview plugin is not installed in the
 * target vault. Offering it would advertise a capability that always fails.
 */
export const JSON_LOGIC_CONTENT_TYPE = "application/vnd.olrapi.jsonlogic+json";
const NOTE_JSON = "application/vnd.olrapi.note+json";
/** Percent-encode a vault path segment by segment, leaving separators intact. */
function encodeVaultPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}
export class ObsidianLiveService {
    client;
    pathFilter;
    /**
     * @param client `null` when `resolveRestConfig()` found no API key. Every call
     *               then raises `ObsidianUnavailableError`, which is the same
     *               outcome as a closed Obsidian and says the same thing.
     */
    constructor(client, options = {}) {
        this.client = client;
        this.pathFilter = options.pathFilter ?? new PathFilter();
    }
    /** Every command Obsidian has registered, its own plus every plugin's. */
    async listCommands() {
        const res = await this.send("list_commands", { method: "GET", path: "/commands/" });
        ObsidianLiveService.assertOk("list_commands", res, "list commands");
        const payload = ObsidianLiveService.parse("list_commands", res);
        const commands = Array.isArray(payload.commands) ? payload.commands : [];
        return commands
            .filter((entry) => {
            return typeof entry === "object" && entry !== null && typeof entry.id === "string";
        })
            .map((entry) => ({
            id: entry.id,
            name: typeof entry.name === "string" ? entry.name : entry.id,
        }));
    }
    /**
     * Run one registered command.
     *
     * The widest blast radius in the project: the id space covers every installed
     * plugin, and Obsidian applies whatever the command does with no confirmation
     * and no undo hook. The tool description says so plainly.
     */
    async executeCommand(id) {
        const trimmed = typeof id === "string" ? id.trim() : "";
        if (trimmed === "") {
            throw new Error("execute_command requires a command id. Use list_commands to see them.");
        }
        const res = await this.send("execute_command", {
            method: "POST",
            path: `/commands/${encodeURIComponent(trimmed)}/`,
        });
        if (res.status === 404) {
            throw new Error(`Unknown Obsidian command: ${trimmed}. Use list_commands to see the registered ids.`);
        }
        ObsidianLiveService.assertOk("execute_command", res, `execute command ${trimmed}`);
        return { success: true, id: trimmed };
    }
    /** The note Obsidian currently has focused. */
    async getActiveFile() {
        const res = await this.send("get_active_file", {
            method: "GET",
            path: "/active/",
            headers: { Accept: NOTE_JSON },
        });
        if (res.status === 404) {
            throw new Error("No file is currently active in Obsidian.");
        }
        ObsidianLiveService.assertOk("get_active_file", res, "read the active file");
        const payload = ObsidianLiveService.parse("get_active_file", res);
        if (typeof payload.path !== "string") {
            throw new Error("Obsidian reported an active file with no path.");
        }
        return { path: payload.path };
    }
    /** Open a note in the Obsidian UI. */
    async openFile(inputPath) {
        const path = this.prepare(inputPath);
        const res = await this.send("open_file", {
            method: "POST",
            path: `/open/${encodeVaultPath(path)}`,
        });
        ObsidianLiveService.assertOk("open_file", res, `open ${path}`);
        return { success: true, path };
    }
    /**
     * Query Obsidian's own index with a JsonLogic expression.
     *
     * One content type, always. See `JSON_LOGIC_CONTENT_TYPE`.
     */
    async searchVaultAdvanced(query) {
        if (query === undefined || query === null) {
            throw new Error("search_vault_advanced requires a JsonLogic query object.");
        }
        const res = await this.send("search_vault_advanced", {
            method: "POST",
            path: "/search/",
            headers: { "Content-Type": JSON_LOGIC_CONTENT_TYPE },
            body: JSON.stringify(query),
        });
        ObsidianLiveService.assertOk("search_vault_advanced", res, "run the advanced search");
        const payload = ObsidianLiveService.parse("search_vault_advanced", res);
        return Array.isArray(payload) ? payload : [payload];
    }
    // ==========================================================================
    // TRANSPORT
    // ==========================================================================
    /**
     * A missing client and a transport failure collapse to the same error on
     * purpose: from the caller's side both mean "Obsidian is not answering".
     * An HTTP status is still an authoritative answer and is left to the caller.
     */
    async send(tool, opts) {
        if (!this.client)
            throw new ObsidianUnavailableError(tool);
        let res;
        try {
            res = await this.client.send(opts);
        }
        catch (error) {
            if (error instanceof BackendError)
                throw new ObsidianUnavailableError(tool, error);
            throw error;
        }
        if (res.status === 401 || res.status === 403)
            throw new RestConfigurationError(res.status);
        return res;
    }
    static assertOk(tool, res, what) {
        if (res.status >= 200 && res.status < 300)
            return;
        throw new Error(`${tool} failed to ${what}: ${ObsidianLiveService.detail(res)}`);
    }
    static parse(tool, res) {
        try {
            return JSON.parse(res.body);
        }
        catch {
            throw new Error(`${tool} received a response that is not JSON: ${res.body.slice(0, 200)}`);
        }
    }
    static detail(res) {
        try {
            const parsed = JSON.parse(res.body);
            if (parsed.message)
                return `${parsed.message} (HTTP ${res.status})`;
        }
        catch {
            // Not the plugin's JSON error envelope; fall through to the raw body.
        }
        return res.body.trim() || `HTTP ${res.status}`;
    }
    /**
     * The same guard every other path-taking tool applies. `open_file` reaches
     * Obsidian rather than the disk, but a tool that could open `.obsidian/*` in
     * the UI would still be a hole in a boundary this project keeps closed
     * everywhere else.
     */
    prepare(inputPath) {
        if (typeof inputPath !== "string" || inputPath.trim() === "") {
            throw new Error("open_file requires a note path relative to the vault root.");
        }
        const path = inputPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
        let depth = 0;
        for (const segment of path.split("/")) {
            if (segment === "" || segment === ".")
                continue;
            depth += segment === ".." ? -1 : 1;
            if (depth < 0) {
                throw new Error(`Path traversal not allowed: ${path}. Paths must be within the vault directory.`);
            }
        }
        if (!this.pathFilter.isAllowed(path)) {
            throw new Error(`Access denied: ${path}. This path is restricted (system files like .obsidian, .git, and dotfiles are not accessible).`);
        }
        return path;
    }
}
