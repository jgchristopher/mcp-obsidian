/**
 * In-process stand-in for the Obsidian Local REST API.
 *
 * Exists because CI runs on ubuntu with no Obsidian installed, and the repo has
 * no HTTP mocking library. Without it the REST arm of the backend contract
 * suite cannot execute at all.
 *
 * Deliberately a test double, not a reimplementation: it serves only the
 * endpoints `RestBackend` calls, plus the three failure injectors a real server
 * will not produce on demand. Response shapes are taken from the plugin's own
 * OpenAPI document (v4.1.7).
 *
 * Plain `node:http`, not `https`. Tests set `protocol: "http"` in the config,
 * which exercises the same client code path minus TLS. TLS scoping is covered
 * by the grep criterion and the live smoke test, not by minting certificates
 * in unit tests.
 *
 * Never import this from a production path.
 */
export interface FixtureRequestRecord {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
}
export interface FixtureOptions {
    /** Seeded vault contents, path -> file body. */
    files?: Record<string, string>;
    /** Force a status for the next request to a matching path. Fires once, then clears. */
    failWith?: {
        path: string;
        status: number;
    };
    /** Simulate a socket death after the request is received but before a reply. */
    killSocketOn?: string;
    /** Accept the request and never respond, to exercise post-send timeouts. */
    hangOn?: string;
    /** When set, every request except `GET /` must carry `Authorization: Bearer <key>`. */
    apiKey?: string;
    /** Reported as `versions.self` by `GET /`. Defaults to the current floor. */
    pluginVersion?: string;
    /** Registered commands served by `GET /commands/`. */
    commands?: Array<{
        id: string;
        name: string;
    }>;
    /** Vault path reported by `GET /active/`. Absent means no active file (404). */
    activeFile?: string;
}
export interface Fixture {
    port: number;
    close(): Promise<void>;
    /** Every request the fixture received, in order. */
    requests: FixtureRequestRecord[];
    /** Live view of the seeded vault, so tests can assert resulting state. */
    files: Map<string, string>;
    /** Command ids `POST /commands/{id}/` accepted, in order. */
    executedCommands: string[];
    /** Paths `POST /open/{path}` accepted, in order. */
    openedFiles: string[];
}
export declare function startFixture(opts?: FixtureOptions): Promise<Fixture>;
//# sourceMappingURL=fixture-server.d.ts.map