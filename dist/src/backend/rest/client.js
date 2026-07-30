import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BackendError } from "../types.js";
export const DEFAULT_TIMEOUT_MS = 5000;
/**
 * Cap on concurrent sockets. Batch reads fan out up to 10 requests at once; an
 * uncapped keep-alive pool would open a socket per call and, under load, push
 * queued requests past the timeout — where they would classify as
 * `unknown-state`, the expensive side of the taxonomy.
 */
export const MAX_SOCKETS = 8;
export class RestClient {
    config;
    agent;
    transport;
    constructor(config) {
        this.config = config;
        if (config.protocol === "https") {
            this.agent = new HttpsAgent({
                // The only site in the codebase that relaxes certificate validation,
                // and it is scoped to this agent. The process-wide TLS override env var
                // must never be reached for: it would disable validation for every
                // outbound request in the process, not just ours.
                rejectUnauthorized: config.verifySsl,
                keepAlive: true,
                maxSockets: MAX_SOCKETS,
            });
            this.transport = httpsRequest;
        }
        else {
            this.agent = new HttpAgent({ keepAlive: true, maxSockets: MAX_SOCKETS });
            this.transport = httpRequest;
        }
    }
    /** Drop pooled sockets. Tests and shutdown paths use this; requests do not. */
    destroy() {
        this.agent.destroy();
    }
    /**
     * Perform one request.
     *
     * Resolves for **any** HTTP response, 404 and 500 included: a status code is
     * an authoritative answer from Obsidian, and only a rejection is allowed to
     * trigger backend fallback. Rejects only on transport failure, always with a
     * `BackendError` carrying a `never-sent` / `unknown-state` classification.
     */
    send(opts) {
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            /**
             * The whole write-safety rule rests on this flag.
             *
             * `finish` fires once the request bytes have been handed to the socket.
             * Node suppresses it when the socket errored first (`onFinish` checks
             * `socket._hadError`), so a refused connection or a failed TLS handshake
             * never sets it. Classifying on `error.code` instead would be wrong:
             * ETIMEDOUT legitimately occurs on both sides of the send boundary, and
             * treating a post-send timeout as `never-sent` is what duplicates writes.
             */
            let requestSent = false;
            let settled = false;
            let deadline;
            const clearDeadline = () => {
                if (deadline !== undefined)
                    clearTimeout(deadline);
                deadline = undefined;
            };
            const fail = (cause) => {
                if (settled)
                    return;
                settled = true;
                clearDeadline();
                reject(new BackendError(requestSent ? { kind: "unknown-state", cause } : { kind: "never-sent", cause }, `REST request failed: ${cause.message}`));
            };
            let req;
            try {
                req = this.transport({
                    host: this.config.host,
                    port: this.config.port,
                    path: opts.path,
                    method: opts.method,
                    agent: this.agent,
                    headers: {
                        Authorization: `Bearer ${this.config.apiKey}`,
                        ...opts.headers,
                    },
                }, (res) => {
                    const chunks = [];
                    res.on("data", (chunk) => chunks.push(chunk));
                    res.on("error", fail);
                    res.on("end", () => {
                        if (settled)
                            return;
                        settled = true;
                        clearDeadline();
                        resolve({
                            status: res.statusCode ?? 0,
                            headers: flattenHeaders(res.headers),
                            body: Buffer.concat(chunks).toString("utf-8"),
                        });
                    });
                });
            }
            catch (error) {
                // A malformed header or option throws synchronously. Nothing left the
                // process, so it classifies exactly as a refused connection does.
                fail(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            req.on("finish", () => {
                requestSent = true;
            });
            /**
             * A whole-request deadline, not `req.setTimeout`.
             *
             * `ClientRequest.setTimeout` arms the socket's idle timer only after the
             * connection is established (`setSocketTimeout` waits on `connect` when
             * the socket is still connecting). A host that accepts nothing — a
             * blackholed address, a machine that went to sleep — would therefore hang
             * forever, and the pre-send timeout that must classify as `never-sent`
             * would never fire at all.
             */
            deadline = setTimeout(() => {
                req.destroy(new Error(`Timed out after ${timeoutMs}ms waiting for ${opts.method} ${opts.path}`));
            }, timeoutMs);
            deadline.unref();
            req.on("error", fail);
            if (opts.body !== undefined)
                req.write(opts.body);
            req.end();
        });
    }
}
function flattenHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined)
            continue;
        out[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
}
