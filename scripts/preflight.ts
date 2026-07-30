/**
 * Shared REST preflight for the scripts that talk to a live vault.
 *
 * Both `parity-smoke.ts` and `backend-bench.ts` are only meaningful when REST is
 * genuinely serving the vault named on the command line. Getting that wrong is
 * not a crash, it is a quiet downgrade to the filesystem — a green parity run
 * that proves nothing, or a benchmark whose two columns describe two different
 * vaults. The guard lives here so neither script can drift away from it.
 */

import { RestClient } from "../src/backend/rest/client.js";
import { resolveRestConfig } from "../src/backend/rest/config.js";
import { fingerprintRest, fingerprintFilesystem } from "../src/backend/health.js";
import { BackendError } from "../src/backend/types.js";

/** Message from an unknown throw. `(err as Error).message` is undefined for a non-Error. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function abort(tool: string, message: string): never {
  process.stderr.write(`\n  ${tool}: ${message}\n\n`);
  process.exit(1);
}

/**
 * Returns a connected `RestClient` proven to be serving `vaultPath`, or exits
 * non-zero explaining why it is not.
 */
export async function restPreflight(tool: string, vaultPath: string): Promise<RestClient> {
  let config;
  try {
    // Throws on a malformed port or protocol; returns null when the key is unset.
    config = resolveRestConfig(process.env);
  } catch (err) {
    abort(tool, `OBSIDIAN_ configuration is invalid: ${describeError(err)}`);
  }

  if (!config) {
    abort(
      tool,
      "OBSIDIAN_API_KEY is unset, so REST is disabled and this run would only\n" +
        "  exercise the filesystem. Export the key from the Local REST API plugin\n" +
        "  settings and try again.",
    );
  }

  const client = new RestClient(config);
  const endpoint = `${config.protocol}://${config.host}:${config.port}`;

  let restPrint: string[];
  try {
    restPrint = await fingerprintRest(client);
  } catch (err) {
    client.destroy();
    // A BackendError means the request never got an answer — Obsidian is down or
    // the port is wrong. Anything else means the server answered and refused,
    // which is almost always a bad key. Telling someone to start an
    // already-running Obsidian sends them down the wrong path.
    if (err instanceof BackendError) {
      abort(
        tool,
        `nothing answered at ${endpoint} (${err.message}).\n` +
          "  Start Obsidian on the vault under test, and check OBSIDIAN_PORT —\n" +
          "  this plugin's HTTPS listener is on 27123, not the documented 27124.",
      );
    }
    abort(
      tool,
      `${endpoint} answered but refused the request: ${describeError(err)}.\n` +
        "  Obsidian is reachable, so this is almost certainly a stale or wrong\n" +
        "  OBSIDIAN_API_KEY. Copy it again from the Local REST API plugin settings.",
    );
  }

  let localPrint: string[];
  try {
    localPrint = await fingerprintFilesystem(vaultPath);
  } catch (err) {
    client.destroy();
    abort(tool, `cannot read ${vaultPath}: ${describeError(err)}`);
  }

  // Two empty listings compare equal, which would wave through the exact case
  // this guard exists to catch. `Health` treats the same evidence as
  // inconclusive and disables REST, so refusing here keeps the two consistent.
  if (restPrint.length === 0 && localPrint.length === 0) {
    client.destroy();
    abort(
      tool,
      "neither the REST root nor the filesystem root has a top-level .md file,\n" +
        "  so the two vaults cannot be told apart. Add one note at the vault root\n" +
        "  and re-run — an empty fingerprint is inconclusive, not a match.",
    );
  }

  const same =
    restPrint.length === localPrint.length && restPrint.every((n, i) => n === localPrint[i]);

  if (!same) {
    client.destroy();
    abort(
      tool,
      `Obsidian is serving a different vault than ${vaultPath}.\n` +
        `  REST root:       ${restPrint.slice(0, 5).join(", ") || "(empty)"}\n` +
        `  Filesystem root: ${localPrint.slice(0, 5).join(", ") || "(empty)"}\n` +
        "  Switch Obsidian to the vault under test before running.",
    );
  }

  return client;
}
