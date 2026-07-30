/**
 * Environment-driven configuration for the Local REST API backend.
 *
 * Variable names mirror the Python `mcp-obsidian` server exactly, so migrating
 * an existing MCP client entry is copy-paste.
 */
/**
 * Lowest plugin version this backend is known to work against.
 *
 * BRAT is in play on the target vault, so plugin versions move without warning.
 * A lower version is a warning, never a refusal to start — the endpoints this
 * backend uses have been stable for far longer than the floor.
 */
export const MIN_PLUGIN_VERSION = "4.1.7";
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
export const DEFAULT_PORT = 27123;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PROTOCOL = "https";
/** Env values accepted as booleans. Anything else throws rather than defaulting. */
const TRUE_VALUES = new Set(["true", "1", "yes"]);
const FALSE_VALUES = new Set(["false", "0", "no"]);
function parseBoolean(name, raw, fallback) {
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const value = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(value))
        return true;
    if (FALSE_VALUES.has(value))
        return false;
    throw new Error(`Invalid ${name}: "${raw}". Expected one of true, false, 1, 0, yes, no.`);
}
function parsePort(raw) {
    if (raw === undefined || raw.trim() === "")
        return DEFAULT_PORT;
    const value = Number(raw.trim());
    // A typo should stop the server, not silently disable REST: a bad port that
    // fell back to the default would look identical to a working configuration
    // right up until every request went to the wrong place.
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`Invalid OBSIDIAN_PORT: "${raw}". Expected an integer between 1 and 65535.`);
    }
    return value;
}
function parseProtocol(raw) {
    if (raw === undefined || raw.trim() === "")
        return DEFAULT_PROTOCOL;
    const value = raw.trim().toLowerCase();
    if (value === "http" || value === "https")
        return value;
    throw new Error(`Invalid OBSIDIAN_PROTOCOL: "${raw}". Expected "http" or "https".`);
}
/**
 * Resolve the REST configuration from the environment.
 *
 * Returns `null` when `OBSIDIAN_API_KEY` is unset or blank, which disables REST
 * entirely and leaves behavior identical to a build with no REST code at all.
 * Every other malformed value throws, because a silent downgrade to filesystem
 * mode is indistinguishable from success.
 */
export function resolveRestConfig(env = process.env) {
    const apiKey = env.OBSIDIAN_API_KEY?.trim();
    if (!apiKey)
        return null;
    return {
        apiKey,
        host: env.OBSIDIAN_HOST?.trim() || DEFAULT_HOST,
        port: parsePort(env.OBSIDIAN_PORT),
        protocol: parseProtocol(env.OBSIDIAN_PROTOCOL),
        // The plugin ships a self-signed certificate, so verification is off by
        // default. Scoped to this backend's agent only — see RestClient.
        verifySsl: parseBoolean("OBSIDIAN_VERIFY_SSL", env.OBSIDIAN_VERIFY_SSL, false),
    };
}
/** Numeric comparison of dotted version strings, ignoring any pre-release suffix. */
function compareVersions(a, b) {
    const parts = (v) => v
        .trim()
        .replace(/^v/, "")
        .split(/[-+]/)[0]
        .split(".")
        .map((n) => Number.parseInt(n, 10) || 0);
    const left = parts(a);
    const right = parts(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0)
            return diff < 0 ? -1 : 1;
    }
    return 0;
}
/**
 * Is the reported plugin version at or above the floor?
 *
 * An unparseable or missing version counts as supported: refusing to run
 * because a version string looked odd would be a worse failure than running
 * against a plugin that is probably fine.
 */
export function isPluginVersionSupported(version) {
    if (!version || !/\d/.test(version))
        return true;
    return compareVersions(version, MIN_PLUGIN_VERSION) >= 0;
}
/** Warning text for a below-floor plugin, or `null` when nothing is wrong. */
export function pluginVersionWarning(version) {
    if (isPluginVersionSupported(version))
        return null;
    return (`Obsidian Local REST API plugin version ${version} is below the tested floor ` +
        `${MIN_PLUGIN_VERSION}. Continuing anyway; upgrade the plugin if REST operations misbehave.`);
}
