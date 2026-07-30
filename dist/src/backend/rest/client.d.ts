import type { RestConfig } from "./config.js";
/**
 * HTTP transport for the Local REST API.
 *
 * Built on `node:https` rather than the global `fetch`. `fetch` ignores an
 * `https.Agent`, so there is no way to scope relaxed certificate validation to
 * this one client through it, and the alternative (an undici `dispatcher`)
 * means a new runtime dependency in a package whose entire dependency list is
 * four entries.
 */
export interface RestResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}
export interface SendOptions {
    /** Any verb, including the WebDAV-style "MOVE". `node:http` does not validate verbs. */
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}
export declare const DEFAULT_TIMEOUT_MS = 5000;
/**
 * Cap on concurrent sockets. Batch reads fan out up to 10 requests at once; an
 * uncapped keep-alive pool would open a socket per call and, under load, push
 * queued requests past the timeout — where they would classify as
 * `unknown-state`, the expensive side of the taxonomy.
 */
export declare const MAX_SOCKETS = 8;
export declare class RestClient {
    private readonly config;
    private readonly agent;
    private readonly transport;
    constructor(config: RestConfig);
    /** Drop pooled sockets. Tests and shutdown paths use this; requests do not. */
    destroy(): void;
    /**
     * Perform one request.
     *
     * Resolves for **any** HTTP response, 404 and 500 included: a status code is
     * an authoritative answer from Obsidian, and only a rejection is allowed to
     * trigger backend fallback. Rejects only on transport failure, always with a
     * `BackendError` carrying a `never-sent` / `unknown-state` classification.
     */
    send(opts: SendOptions): Promise<RestResponse>;
}
//# sourceMappingURL=client.d.ts.map