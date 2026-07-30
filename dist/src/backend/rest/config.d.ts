/**
 * Environment-driven configuration for the Local REST API backend.
 *
 * Variable names mirror the Python `mcp-obsidian` server exactly, so migrating
 * an existing MCP client entry is copy-paste.
 */
export interface RestConfig {
    apiKey: string;
    host: string;
    port: number;
    protocol: "http" | "https";
    verifySsl: boolean;
}
/**
 * Lowest plugin version this backend is known to work against.
 *
 * BRAT is in play on the target vault, so plugin versions move without warning.
 * A lower version is a warning, never a refusal to start — the endpoints this
 * backend uses have been stable for far longer than the floor.
 */
export declare const MIN_PLUGIN_VERSION = "4.1.7";
/**
 * The port default is 27123, not the 27124 most documentation implies.
 *
 * The plugin's OpenAPI document lists 27124 as the HTTPS port and 27123 as the
 * insecure one, but those are only the shipped defaults; the actual ports come
 * from the vault's plugin settings. On the target vault HTTPS listens on 27123
 * and the insecure server is disabled outright, so defaulting to 27124 would
 * fail every connection and silently pin the server to permanent filesystem
 * fallback — a failure with no symptom other than "REST never seems to help".
 */
export declare const DEFAULT_PORT = 27123;
export declare const DEFAULT_HOST = "127.0.0.1";
export declare const DEFAULT_PROTOCOL: "https";
/**
 * Resolve the REST configuration from the environment.
 *
 * Returns `null` when `OBSIDIAN_API_KEY` is unset or blank, which disables REST
 * entirely and leaves behavior identical to a build with no REST code at all.
 * Every other malformed value throws, because a silent downgrade to filesystem
 * mode is indistinguishable from success.
 */
export declare function resolveRestConfig(env?: NodeJS.ProcessEnv): RestConfig | null;
/**
 * Is the reported plugin version at or above the floor?
 *
 * An unparseable or missing version counts as supported: refusing to run
 * because a version string looked odd would be a worse failure than running
 * against a plugin that is probably fine.
 */
export declare function isPluginVersionSupported(version: string | undefined | null): boolean;
/** Warning text for a below-floor plugin, or `null` when nothing is wrong. */
export declare function pluginVersionWarning(version: string | undefined | null): string | null;
//# sourceMappingURL=config.d.ts.map