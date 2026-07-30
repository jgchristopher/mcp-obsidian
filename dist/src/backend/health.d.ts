import type { RestClient } from "./rest/client.js";
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
export declare const DEFAULT_FINGERPRINT_TTL_MS = 60000;
/** How long an unreachable mark suppresses REST attempts. */
export declare const DEFAULT_UNREACHABLE_TTL_MS = 30000;
export interface HealthOptions {
    /** How long a fingerprint check stays fresh. Default 60_000. */
    fingerprintTtlMs?: number;
    /** How long an unreachable mark suppresses REST attempts. Default 30_000. */
    unreachableTtlMs?: number;
    onWarn?: (message: string) => void;
    /** Injectable clock, so TTL expiry is testable without sleeping. */
    now?: () => number;
}
/**
 * Root-level `.md` filenames as the running Obsidian reports them.
 *
 * Rejects with a `BackendError` when the request never got an answer, which the
 * caller treats as unreachable rather than as a mismatch. Any other failure —
 * a non-2xx status, an unparseable body — is an inconclusive check.
 */
export declare function fingerprintRest(client: RestClient): Promise<string[]>;
/** Root-level `.md` filenames as the local vault directory reports them. */
export declare function fingerprintFilesystem(vaultPath: string): Promise<string[]>;
/** What `RoutingBackend` needs from health. Narrower than the class, for stubbing. */
export interface HealthGate {
    restUsable(): Promise<boolean>;
    markUnreachable(): void;
}
export declare class Health implements HealthGate {
    private readonly client;
    private readonly vaultPath;
    private readonly fingerprintTtlMs;
    private readonly unreachableTtlMs;
    private readonly onWarn;
    private readonly now;
    private unreachableSince;
    /** `-Infinity` means "no check has happened yet", which is always stale. */
    private lastCheckAt;
    private lastResult;
    private inFlight;
    private versionChecked;
    /** Warnings already emitted, so a stable fault does not repeat every TTL. */
    private readonly warned;
    constructor(client: RestClient, vaultPath: string, options?: HealthOptions);
    /**
     * True only when REST is reachable *and* the fingerprint is both fresh and
     * matching. Never rejects: an unanswerable question is answered "no".
     */
    restUsable(): Promise<boolean>;
    /**
     * Suppress REST attempts for the unreachable TTL.
     *
     * Called by the router on a transport failure and internally when a
     * fingerprint request cannot be answered at all.
     */
    markUnreachable(): void;
    /** Collapse concurrent callers onto one revalidation. */
    private revalidate;
    private record;
    private warn;
    private check;
    /**
     * Read the plugin version once and warn when it is below the tested floor.
     *
     * Never a refusal to start: BRAT moves plugin versions without warning, and
     * the endpoints this backend uses have been stable far longer than the floor.
     */
    private checkPluginVersionOnce;
}
//# sourceMappingURL=health.d.ts.map