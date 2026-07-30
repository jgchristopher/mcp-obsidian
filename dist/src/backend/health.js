import { readdir } from "node:fs/promises";
import { BackendError } from "./types.js";
import { pluginVersionWarning } from "./rest/config.js";
/**
 * "Should REST serve the next call?"
 *
 * Two independent reasons to say no, kept in one object because every routed
 * call asks the question once:
 *
 * 1. **Reachability** — Obsidian is closed, so the connection is refused. A
 *    boolean plus a timestamp is the whole mechanism. Loopback refusals are
 *    immediate, so there is nothing for a half-open circuit breaker to protect.
 * 2. **Vault identity** — the plugin binds to whichever vault Obsidian has open,
 *    while this server binds to its `vaultPath` argument. Nothing connects the
 *    two, and the plugin exposes no vault identity, so the only available check
 *    is comparing what both sides say the vault contains.
 *
 * Revalidation is **time-based, never failure-triggered**. Obsidian is normally
 * open on the target machine, so a check that only re-ran after a connection
 * failure would run once at startup and never again — and someone switching
 * vaults inside a running Obsidian would move the REST target while every check
 * stayed green.
 */
/** How long a passing (or failing) fingerprint check stays fresh. */
export const DEFAULT_FINGERPRINT_TTL_MS = 60_000;
/** How long an unreachable mark suppresses REST attempts. */
export const DEFAULT_UNREACHABLE_TTL_MS = 30_000;
/**
 * Reduce a set of names to the fingerprint: root-level `.md` filenames, sorted.
 *
 * Narrow on purpose. The plugin builds `/vault/` from `app.vault.getFiles()`, so
 * it omits empty directories, while a filesystem listing reports them; and
 * `PathFilter` drops dotfiles and restricted directories that the plugin may or
 * may not report. Comparing full listings would mismatch on a correctly
 * configured machine and permanently disable REST — a silent downgrade with no
 * symptom other than "REST never seems to help". Root-level `.md` filenames are
 * the largest set both sources report identically.
 */
function reduceToFingerprint(names) {
    const out = [];
    for (const name of names) {
        // A trailing slash marks a directory in the plugin's listing shape.
        if (name.endsWith("/"))
            continue;
        // Nested paths never appear in a root listing; ignore them if they do.
        if (name.includes("/"))
            continue;
        // Dotfiles are filtered inconsistently between the two sources.
        if (name.startsWith("."))
            continue;
        if (!name.toLowerCase().endsWith(".md"))
            continue;
        out.push(name);
    }
    return out.sort();
}
/**
 * Root-level `.md` filenames as the running Obsidian reports them.
 *
 * Rejects with a `BackendError` when the request never got an answer, which the
 * caller treats as unreachable rather than as a mismatch. Any other failure —
 * a non-2xx status, an unparseable body — is an inconclusive check.
 */
export async function fingerprintRest(client) {
    const res = await client.send({ method: "GET", path: "/vault/" });
    if (res.status < 200 || res.status >= 300) {
        throw new Error(`GET /vault/ answered HTTP ${res.status}`);
    }
    const payload = JSON.parse(res.body);
    const files = Array.isArray(payload.files) ? payload.files : [];
    return reduceToFingerprint(files.filter((name) => typeof name === "string"));
}
/** Root-level `.md` filenames as the local vault directory reports them. */
export async function fingerprintFilesystem(vaultPath) {
    const entries = await readdir(vaultPath, { withFileTypes: true });
    return reduceToFingerprint(entries.filter((entry) => !entry.isDirectory()).map((e) => e.name));
}
export class Health {
    client;
    vaultPath;
    fingerprintTtlMs;
    unreachableTtlMs;
    onWarn;
    now;
    unreachableSince = null;
    /** `-Infinity` means "no check has happened yet", which is always stale. */
    lastCheckAt = Number.NEGATIVE_INFINITY;
    lastResult = false;
    inFlight = null;
    versionChecked = false;
    /** Warnings already emitted, so a stable fault does not repeat every TTL. */
    warned = new Set();
    constructor(client, vaultPath, options = {}) {
        this.client = client;
        this.vaultPath = vaultPath;
        this.fingerprintTtlMs = options.fingerprintTtlMs ?? DEFAULT_FINGERPRINT_TTL_MS;
        this.unreachableTtlMs = options.unreachableTtlMs ?? DEFAULT_UNREACHABLE_TTL_MS;
        this.onWarn = options.onWarn ?? (() => { });
        this.now = options.now ?? Date.now;
    }
    /**
     * True only when REST is reachable *and* the fingerprint is both fresh and
     * matching. Never rejects: an unanswerable question is answered "no".
     */
    async restUsable() {
        const now = this.now();
        if (this.unreachableSince !== null) {
            if (now - this.unreachableSince < this.unreachableTtlMs)
                return false;
            // Suppression expired. Clear it and force a fresh check rather than
            // trusting whatever the last fingerprint said.
            this.unreachableSince = null;
            this.lastCheckAt = Number.NEGATIVE_INFINITY;
        }
        if (now - this.lastCheckAt < this.fingerprintTtlMs)
            return this.lastResult;
        return this.revalidate();
    }
    /**
     * Suppress REST attempts for the unreachable TTL.
     *
     * Called by the router on a transport failure and internally when a
     * fingerprint request cannot be answered at all.
     */
    markUnreachable() {
        this.unreachableSince = this.now();
        this.lastResult = false;
    }
    /** Collapse concurrent callers onto one revalidation. */
    revalidate() {
        if (this.inFlight)
            return this.inFlight;
        this.inFlight = (async () => {
            try {
                return await this.check();
            }
            finally {
                this.inFlight = null;
            }
        })();
        return this.inFlight;
    }
    record(result) {
        this.lastCheckAt = this.now();
        this.lastResult = result;
        return result;
    }
    warn(message) {
        if (this.warned.has(message))
            return;
        this.warned.add(message);
        this.onWarn(message);
    }
    async check() {
        let remote;
        try {
            remote = await fingerprintRest(this.client);
        }
        catch (error) {
            // A fingerprint request that cannot be answered is a reachability
            // problem, not evidence about which vault is on the other end.
            this.markUnreachable();
            if (!(error instanceof BackendError)) {
                this.warn(`Vault fingerprint check could not read the Obsidian vault listing: ${describe(error)}. ` +
                    `Serving from the filesystem until the next retry.`);
            }
            return false;
        }
        let local;
        try {
            local = await fingerprintFilesystem(this.vaultPath);
        }
        catch (error) {
            this.warn(`Vault fingerprint check could not read ${this.vaultPath}: ${describe(error)}. ` +
                `The Obsidian Local REST API will not be used.`);
            return this.record(false);
        }
        await this.checkPluginVersionOnce();
        // No evidence either way is not agreement. Failing safe here costs a
        // filesystem-only session on an empty vault; failing open costs writes
        // landing in whichever vault Obsidian happens to hold.
        if (remote.length === 0 && local.length === 0) {
            this.warn(`Vault fingerprint is inconclusive: neither the Obsidian Local REST API nor ` +
                `${this.vaultPath} reports any root-level .md file, so there is no evidence the two ` +
                `are the same vault. The Local REST API will not be used. Add a note at the vault ` +
                `root, or unset OBSIDIAN_API_KEY to silence this.`);
            return this.record(false);
        }
        if (remote.length !== local.length || remote.some((name, i) => name !== local[i])) {
            this.warn(`Vault fingerprint mismatch: Obsidian's Local REST API is serving a different vault ` +
                `than ${this.vaultPath}. REST reports [${preview(remote)}] at the vault root while the ` +
                `filesystem reports [${preview(local)}]. Falling back to the filesystem; switch ` +
                `Obsidian back to this vault to re-enable REST.`);
            return this.record(false);
        }
        // A recovered vault should be able to warn again if it switches away.
        this.warned.clear();
        return this.record(true);
    }
    /**
     * Read the plugin version once and warn when it is below the tested floor.
     *
     * Never a refusal to start: BRAT moves plugin versions without warning, and
     * the endpoints this backend uses have been stable far longer than the floor.
     */
    async checkPluginVersionOnce() {
        if (this.versionChecked)
            return;
        try {
            const res = await this.client.send({ method: "GET", path: "/" });
            if (res.status < 200 || res.status >= 300)
                return;
            const parsed = JSON.parse(res.body);
            const version = parsed.versions?.self ?? parsed.manifest?.version ?? null;
            const warning = pluginVersionWarning(version);
            if (warning)
                this.warn(warning);
        }
        catch {
            // The version is a nice-to-have. A failure here says nothing about vault
            // identity, and the next call re-checks it.
            return;
        }
        this.versionChecked = true;
    }
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** First few names, so a warning stays readable on a large vault. */
function preview(names) {
    const head = names.slice(0, 5).join(", ");
    return names.length > 5 ? `${head}, +${names.length - 5} more` : head || "nothing";
}
