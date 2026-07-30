#!/usr/bin/env -S npx tsx
/**
 * Live parity smoke: calls every MCPVault counterpart of an `obsidian-jcos`
 * tool against the real vault and reports a pass/fail table.
 *
 * The exit code is the contract, not the printed text. Exits 0 only when all
 * thirteen mappings pass. Screen-scraping for the word PASS is a human read;
 * success criterion 9 needs a mechanical result.
 *
 *   npx tsx scripts/parity-smoke.ts [vaultPath]
 *
 * Refuses to run unless REST is reachable *and* serving the vault under test. A
 * smoke run that silently exercised only the filesystem would prove nothing
 * about the server being retired.
 */

import { rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/createServer.js";
import { PARITY_MAPPINGS, FILESYSTEM_ONLY_TARGETS } from "../src/backend/parity.js";
import { restPreflight, describeError } from "./preflight.js";
import { fingerprintRest, fingerprintFilesystem } from "../src/backend/health.js";

const TOOL = "parity-smoke";
const DEFAULT_VAULT = "/Users/johnchristopher/Obsidian/jcOS";

/**
 * Everything the run writes lives under one folder and is removed on the way
 * out.
 *
 * The name carries the pid and a timestamp, and the run refuses to start if the
 * path already exists. A fixed name would let one aborted run leave a note that
 * the next run silently overwrites and then permanently deletes — the spec says
 * no check touches an existing note, and this is what enforces it rather than
 * assuming it.
 *
 * No leading dot and a `.md` extension, so the path clears `PathFilter`; a
 * dotted path would be rejected before any backend saw it and the failure would
 * look like a REST problem.
 */
const SCRATCH_DIR = "MCPVault_Parity_Smoke";
const RUN_ID = `${process.pid}-${process.hrtime.bigint().toString(36)}`;

/** Written, patched, appended, overwritten, and finally deleted by the checks. */
const SCRATCH_NOTE = `${SCRATCH_DIR}/smoke-${RUN_ID}.md`;

/**
 * A second note that no check deletes, removed only in teardown.
 *
 * The cross-arm checks assert that a REST-written note is visible to a
 * filesystem read. One of them, `get_recent_changes`, is row 13 while
 * `obsidian_delete_file` is row 10, so pointing it at `SCRATCH_NOTE` would
 * assert the presence of a note the run had already deleted three checks
 * earlier. `search_notes` (row 5) is not forced by ordering but uses the same
 * note so both cross-arm checks assert against one subject.
 */
const PERSIST_NOTE = `${SCRATCH_DIR}/persist-${RUN_ID}.md`;

/** A token that cannot occur anywhere else, so search checks can assert a hit. */
const SEARCH_TOKEN = `paritysmoke${RUN_ID.replace(/[^a-z0-9]/gi, "")}`;

const SEED_CONTENT = `# Parity smoke\n\n${SEARCH_TOKEN}\n\nseed line\n`;

interface CheckResult {
  ok: boolean;
  detail: string;
}

type Check = (client: Client) => Promise<CheckResult>;

interface CallOutcome {
  ok: boolean;
  body: unknown;
  text: string;
}

/**
 * Unwraps an MCP tool result.
 *
 * `createServer` catches every handler throw and returns `{isError: true}`
 * rather than rejecting, and several tools additionally report failure as
 * `success: false` inside a resolved, non-error response. Treating a resolved
 * promise as a pass would report thirteen greens against a server whose every
 * handler was broken, so both layers are checked here.
 *
 * Note that this is still not sufficient on its own: `read_multiple_notes`
 * reports per-path failures in an `err` array with no `success` key at all, so
 * its check inspects the body directly.
 */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.map((c) => c.text ?? "").join("") ?? "";

  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not every tool returns JSON; the raw text is the body in that case.
  }

  if (result.isError === true) return { ok: false, body, text };

  if (body !== null && typeof body === "object" && "success" in body) {
    if ((body as { success?: unknown }).success === false) return { ok: false, body, text };
  }

  return { ok: true, body, text };
}

function truncate(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Retries a cross-arm check for a short window.
 *
 * Two checks assert that a note written through REST is visible to a
 * filesystem read. That is the most valuable assertion in the run — it proves
 * both arms are looking at one vault — but it depends on Obsidian having
 * flushed the write to disk. Failing on the first attempt would turn a
 * sub-second lag into a spurious "not at parity" verdict; waiting forever would
 * hide a real desync. Two seconds is long enough for a local write and short
 * enough that a genuine failure still fails.
 */
async function poll(attempt: () => Promise<CheckResult>): Promise<CheckResult> {
  const deadline = Date.now() + 2000;
  let last = await attempt();
  while (!last.ok && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await attempt();
  }
  return last;
}

/** Note body as the read tools report it, whatever field they used. */
function contentOf(outcome: CallOutcome): string {
  const body = asRecord(outcome.body);
  if (body && typeof body["content"] === "string") return body["content"];
  return outcome.text;
}

/**
 * One check per Python tool.
 *
 * The scratch note is seeded in `setup()` before any check runs. Driving the
 * loop from `PARITY_MAPPINGS` means checks execute in *table* order, and in the
 * table `obsidian_put_content` sits at row 9 — behind four checks that read the
 * note. Relying on the write check to create it would fail those four on every
 * clean run and read as "MCPVault is not at parity".
 */
const CHECKS: Record<string, Check> = {
  obsidian_list_files_in_vault: async (client) => {
    const r = await call(client, "list_directory", { path: "" });
    return { ok: r.ok, detail: r.ok ? "listed vault root" : truncate(r.text) };
  },

  obsidian_list_files_in_dir: async (client) => {
    const r = await call(client, "list_directory", { path: SCRATCH_DIR });
    return { ok: r.ok, detail: r.ok ? `listed ${SCRATCH_DIR}` : truncate(r.text) };
  },

  obsidian_get_file_contents: async (client) => {
    const r = await call(client, "read_note", { path: SCRATCH_NOTE });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    return contentOf(r).includes(SEARCH_TOKEN)
      ? { ok: true, detail: "read scratch note" }
      : { ok: false, detail: "read succeeded but content did not match what was written" };
  },

  obsidian_batch_get_file_contents: async (client) => {
    const r = await call(client, "read_multiple_notes", {
      paths: [SCRATCH_NOTE],
      includeContent: true,
    });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };

    // This handler reports per-path failures in `err` and never sets `success`
    // or `isError`, so a missing note resolves as a clean response with an empty
    // `ok` array. Without inspecting the body this check can never fail.
    const body = asRecord(r.body);
    const okList = Array.isArray(body?.["ok"]) ? (body["ok"] as unknown[]) : [];
    const errList = Array.isArray(body?.["err"]) ? (body["err"] as unknown[]) : [];

    if (errList.length > 0) {
      return { ok: false, detail: `err: ${truncate(JSON.stringify(errList))}` };
    }
    if (okList.length !== 1) {
      return { ok: false, detail: `expected 1 note, got ${okList.length}` };
    }
    return { ok: true, detail: "batch read 1 note, 0 errors" };
  },

  // Cross-arm: search_notes always reads the filesystem, but the scratch note
  // was written through REST. Passing proves both arms see one vault.
  obsidian_simple_search: (client) =>
    poll(async () => {
      const r = await call(client, "search_notes", { query: SEARCH_TOKEN, limit: 5 });
      if (!r.ok) return { ok: false, detail: truncate(r.text) };
      // A search returning nothing is a passing call and a failing check: the
      // token is unique to the scratch note, so zero hits means the walk did
      // not see a note that provably exists.
      return r.text.includes(PERSIST_NOTE)
        ? { ok: true, detail: "found the REST-written note from the filesystem arm" }
        : { ok: false, detail: "unique token returned no hits after 2s" };
    }),

  obsidian_complex_search: async (client) => {
    // `query` is declared `type: "object"` and is posted verbatim under the
    // JsonLogic content type. A bare string is either rejected by the plugin or
    // matches everything, and neither outcome tests JsonLogic.
    const r = await call(client, "search_vault_advanced", {
      query: { glob: [`${SCRATCH_DIR}/*.md`, { var: "path" }] },
    });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    return r.text.includes(SCRATCH_NOTE)
      ? { ok: true, detail: "JsonLogic glob matched the scratch note" }
      : { ok: false, detail: `JsonLogic returned no match: ${truncate(r.text, 60)}` };
  },

  obsidian_patch_content: async (client) => {
    const r = await call(client, "patch_note", {
      path: SCRATCH_NOTE,
      oldString: "seed line",
      newString: "patched line",
    });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    const back = await call(client, "read_note", { path: SCRATCH_NOTE });
    return contentOf(back).includes("patched line")
      ? { ok: true, detail: "patch visible on read-back" }
      : { ok: false, detail: "patch reported success but is not visible" };
  },

  obsidian_append_content: async (client) => {
    const r = await call(client, "write_note", {
      path: SCRATCH_NOTE,
      content: "appended line\n",
      mode: "append",
    });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    const back = await call(client, "read_note", { path: SCRATCH_NOTE });
    return contentOf(back).includes("appended line")
      ? { ok: true, detail: "append visible on read-back" }
      : { ok: false, detail: "append not visible on read-back" };
  },

  obsidian_put_content: async (client) => {
    const marker = `overwritten-${RUN_ID}`;
    const r = await call(client, "write_note", {
      path: SCRATCH_NOTE,
      content: `# Parity smoke\n\n${marker}\n`,
      mode: "overwrite",
    });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    const back = await call(client, "read_note", { path: SCRATCH_NOTE });
    const seen = contentOf(back);
    return seen.includes(marker) && !seen.includes("appended line")
      ? { ok: true, detail: "overwrite replaced prior content" }
      : { ok: false, detail: "overwrite did not replace prior content" };
  },

  obsidian_delete_file: async (client) => {
    // confirmPath must be byte-identical to path. trashMode is stated rather
    // than defaulted; the note is unique to this run and was verified absent
    // before it started, so a permanent delete cannot destroy anything else.
    const r = await call(client, "delete_note", {
      path: SCRATCH_NOTE,
      confirmPath: SCRATCH_NOTE,
      trashMode: "none",
    });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    const back = await call(client, "read_note", { path: SCRATCH_NOTE });
    return back.ok
      ? { ok: false, detail: "delete reported success but the note still reads" }
      : { ok: true, detail: "scratch note deleted" };
  },

  obsidian_get_periodic_note: async (client) => {
    const r = await call(client, "get_periodic_note", { period: "daily" });
    if (!r.ok) return { ok: false, detail: truncate(r.text) };
    // A resolved path whose note has not been created yet is a correct answer,
    // not a failure. Requiring the file to exist would fail the run on any day
    // the daily note had not been touched.
    const exists = asRecord(r.body)?.["exists"];
    return {
      ok: true,
      detail: exists === false ? "resolved (note not yet created)" : "resolved today's daily note",
    };
  },

  obsidian_get_recent_periodic_notes: async (client) => {
    const r = await call(client, "get_recent_periodic_notes", { period: "daily", limit: 3 });
    return { ok: r.ok, detail: r.ok ? "listed recent dailies" : truncate(r.text) };
  },

  // Cross-arm, same reasoning as obsidian_simple_search.
  obsidian_get_recent_changes: (client) =>
    poll(async () => {
      const r = await call(client, "get_recent_changes", { limit: 20, days: 30 });
      if (!r.ok) return { ok: false, detail: truncate(r.text) };
      // The scratch note was written seconds ago, so it must appear in a 30-day
      // window. A response that omits it means the scan is not seeing new writes.
      return r.text.includes(PERSIST_NOTE)
        ? { ok: true, detail: "recent changes include the REST-written note" }
        : { ok: false, detail: "scratch note missing from recent changes after 2s" };
    }),
};

/** Seeds the note every read check depends on. */
async function setup(client: Client, vaultPath: string): Promise<void> {
  for (const path of [SCRATCH_NOTE, PERSIST_NOTE]) {
    let exists = true;
    try {
      await stat(join(vaultPath, path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      exists = false;
    }
    // Throwing rather than aborting: `process.exit` skips `finally`, and by the
    // time the second path is checked the first note may already be seeded.
    if (exists) throw new Error(`${path} already exists. Refusing to overwrite it.`);
  }

  // Both go through the client, so both are REST writes when REST is serving.
  // A filesystem seed would make the cross-arm checks prove nothing.
  for (const path of [SCRATCH_NOTE, PERSIST_NOTE]) {
    const seeded = await call(client, "write_note", {
      path,
      content: SEED_CONTENT,
      mode: "overwrite",
    });
    if (!seeded.ok) {
      throw new Error(`could not create ${path}: ${truncate(seeded.text)}`);
    }
  }
}

/**
 * Removes both notes and the folder, whether or not the delete check ran.
 *
 * Tries the client first so Obsidian learns the note is gone through the same
 * path that created it; a raw unlink would leave its in-memory index holding a
 * file that no longer exists. The filesystem removal is the backstop for the
 * case where REST has already degraded, and is what actually clears the folder.
 */
async function teardown(vaultPath: string, client?: Client): Promise<void> {
  for (const path of [SCRATCH_NOTE, PERSIST_NOTE]) {
    if (client) {
      await call(client, "delete_note", {
        path,
        confirmPath: path,
        trashMode: "none",
      }).catch(() => {
        // Already deleted by a check, or REST is gone; the unlink below covers it.
      });
    }
    await rm(join(vaultPath, path), { force: true }).catch(() => {});
  }
  // Created implicitly by the seed writes; would otherwise accumulate as an
  // empty directory in the vault after every run. `rm` with `recursive: false`
  // throws EISDIR on a directory and would silently never clean up; `rmdir`
  // removes an empty directory and fails ENOTEMPTY if anything unexpected is
  // inside, which is the safer signal.
  await rmdir(join(vaultPath, SCRATCH_DIR)).catch(() => {});
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2] ?? DEFAULT_VAULT;

  process.stdout.write(`\n  Parity smoke against ${vaultPath}\n`);

  const restClient = await restPreflight(TOOL, vaultPath);
  process.stdout.write("  REST reachable and serving this vault.\n\n");

  const warnings: string[] = [];
  let passed = 0;
  const failures: string[] = [];

  // Everything from here is inside the try so a throw during construction or
  // connect still reaches the teardown that destroys the REST clients.
  let client: Client | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  try {
    server = createServer(vaultPath, {
      version: "1.0.0",
      onWarn: (m: string) => warnings.push(m),
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "parity-smoke", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await setup(client, vaultPath);

    for (const mapping of PARITY_MAPPINGS) {
      const check = CHECKS[mapping.python];
      const route = FILESYSTEM_ONLY_TARGETS.has(mapping.mcpvault) ? "fs " : "rest";

      if (!check) {
        failures.push(mapping.python);
        process.stdout.write(`  FAIL [${route}] ${mapping.python} -> no check defined\n`);
        continue;
      }

      let result: CheckResult;
      try {
        result = await check(client);
      } catch (err) {
        result = { ok: false, detail: truncate(describeError(err)) };
      }

      const note = mapping.note ? ` (${mapping.note})` : "";
      const verdict = result.ok ? "PASS" : "FAIL";
      if (result.ok) passed += 1;
      else failures.push(mapping.python);

      process.stdout.write(
        `  ${verdict} [${route}] ${mapping.python} -> ${mapping.mcpvault}${note}: ${result.detail}\n`,
      );
    }
  } finally {
    await teardown(vaultPath, client);
    if (client) await client.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    // restClient is destroyed after the post-loop fingerprint recheck below,
    // which still needs it.
  }

  process.stdout.write(`\n  ${passed}/${PARITY_MAPPINGS.length} passed\n`);

  // Warnings are not all equal. A fingerprint warning means REST stopped
  // serving this vault and results are suspect; the plugin version floor is
  // documented as warn-and-continue, and failing the gate on it would block a
  // cutover for a condition the README says to ignore.
  const degraded = warnings.filter((w) => w.startsWith("Vault fingerprint"));
  const informational = warnings.filter((w) => !w.startsWith("Vault fingerprint"));

  if (informational.length > 0) {
    process.stdout.write("\n  Notes:\n");
    for (const w of informational) process.stdout.write(`    - ${w}\n`);
  }

  // `Health` deliberately does NOT warn when the fingerprint request fails with
  // a BackendError — a refused connection is a reachability fact, not evidence
  // about which vault is on the other end. So quitting Obsidian mid-run leaves
  // the warnings array empty. Re-checking here is what actually closes the
  // window between preflight and the last assertion.
  let stillServing = true;
  let recheckDetail = "";
  try {
    const restPrint = await fingerprintRest(restClient);
    const localPrint = await fingerprintFilesystem(vaultPath);
    stillServing =
      (restPrint.length > 0 || localPrint.length > 0) &&
      restPrint.length === localPrint.length &&
      restPrint.every((n, i) => n === localPrint[i]);
    if (!stillServing) recheckDetail = "the vault fingerprint no longer matches";
  } catch (err) {
    stillServing = false;
    recheckDetail = `REST is no longer answering (${describeError(err)})`;
  } finally {
    restClient.destroy();
  }

  if (degraded.length > 0 || !stillServing) {
    for (const w of degraded) process.stderr.write(`\n  ${w}\n`);
    process.stderr.write(
      `\n  Refusing to report success: ${recheckDetail || "REST degraded mid-run"}, so some\n` +
        "  checks may have been served by the filesystem.\n\n",
    );
    process.exit(1);
  }

  if (failures.length > 0) {
    process.stderr.write(`\n  Failed: ${failures.join(", ")}\n\n`);
    process.exit(1);
  }

  process.stdout.write("\n  All mappings verified against the live vault.\n\n");
  // `createServer` builds its own RestClient whose keep-alive sockets this
  // script cannot reach, so a passing run can hang without an explicit exit.
  // Setting exitCode and letting the write drain first keeps piped output
  // intact; the unref'd timer is the backstop if the socket pool holds on.
  process.exitCode = 0;
  setTimeout(() => process.exit(0), 100).unref();
}

// A throw anywhere above skips the post-loop recheck that owns restClient's
// teardown, so exit explicitly rather than risk hanging on keep-alive sockets.
await main().catch((err) => {
  process.stderr.write(`\n  ${TOOL}: ${describeError(err)}\n\n`);
  process.exit(1);
});
