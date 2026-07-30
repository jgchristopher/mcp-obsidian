import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { VaultBackend } from "./backend/types.js";
import { FrontmatterHandler } from "./frontmatter.js";
import { PathFilter } from "./pathfilter.js";
export interface CreateServerOptions {
    name?: string;
    version?: string;
    pathFilter?: PathFilter;
    frontmatterHandler?: FrontmatterHandler;
    /**
     * Serves the routed tools. Defaults to a `FileSystemBackend` over the same
     * `FileSystemService` the unrouted tools use, so omitting it keeps today's
     * behavior exactly. Phase 3 injects a router here.
     *
     * Explicitly `| undefined` because `exactOptionalPropertyTypes` is on and a
     * caller passing `backend: undefined` must land on the default, not a type
     * error.
     */
    backend?: VaultBackend | undefined;
    /**
     * Where runtime warnings go — fingerprint mismatches and the plugin version
     * floor. Defaults to `console.error`, i.e. **stderr**. Never write these to
     * stdout: on stdio transport that stream carries the MCP protocol, and a
     * stray line corrupts the session.
     */
    onWarn?: ((message: string) => void) | undefined;
    /** Environment the REST config is read from. Injected by tests. */
    env?: NodeJS.ProcessEnv | undefined;
}
export declare function createServer(vaultPath: string, options?: CreateServerOptions): Server;
//# sourceMappingURL=createServer.d.ts.map