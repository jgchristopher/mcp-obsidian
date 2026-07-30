#!/usr/bin/env -S npx tsx
/**
 * Prints REST and filesystem timings for three representative operations.
 *
 *   npx tsx scripts/backend-bench.ts [vaultPath]
 *
 * Informational only. Nothing asserts a threshold and no CI job runs this: the
 * repo already tuned a wall-clock assertion from 100ms to 200ms for stability
 * and then deleted the test, and CI runs a three-version Node matrix on shared
 * runners, so a timing gate would buy noise.
 *
 * Reports the median rather than a single sample, because one HTTPS round trip
 * is dominated by connection setup. The first few iterations are discarded for
 * the same reason — with keep-alive on, sample one pays for the TLS handshake
 * that every later sample reuses.
 */

import { rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { RestBackend } from "../src/backend/rest/index.js";
import { FileSystemBackend } from "../src/backend/filesystem/index.js";
import { FileSystemService } from "../src/filesystem.js";
import type { VaultBackend } from "../src/backend/types.js";
import { restPreflight, abort, describeError } from "./preflight.js";

const TOOL = "backend-bench";
const DEFAULT_VAULT = "/Users/johnchristopher/Obsidian/jcOS";
const WARMUP = 3;
const SAMPLES = 15;

const SCRATCH_DIR = "MCPVault_Parity_Smoke";
const RUN_ID = `${process.pid}-${process.hrtime.bigint().toString(36)}`;
const SCRATCH_NOTE = `${SCRATCH_DIR}/bench-${RUN_ID}.md`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

async function timeOperation(run: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < WARMUP; i += 1) await run();

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = process.hrtime.bigint();
    await run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return samples;
}

interface Row {
  operation: string;
  rest: number | null;
  fs: number | null;
  restError?: string;
  fsError?: string;
}

async function measure(
  backend: VaultBackend,
  operation: "read_note" | "write_note" | "list_directory",
): Promise<{ ms: number | null; error?: string }> {
  try {
    switch (operation) {
      case "read_note":
        return { ms: median(await timeOperation(() => backend.readNote(SCRATCH_NOTE))) };
      case "write_note":
        return {
          ms: median(
            await timeOperation(() =>
              backend.writeNote({
                path: SCRATCH_NOTE,
                content: "# bench\n\nbody\n",
                mode: "overwrite",
              }),
            ),
          ),
        };
      case "list_directory":
        return { ms: median(await timeOperation(() => backend.listDirectory(""))) };
    }
  } catch (err) {
    return { ms: null, error: describeError(err) };
  }
}

const COLUMN = 22;

function format(ms: number | null, error?: string): string {
  if (ms !== null) return `${ms.toFixed(2)} ms`;
  if (!error) return "n/a";
  // Must fit the column or the next cell runs into it and the table stops
  // being readable, which is the only thing this script produces.
  const room = COLUMN - "error: ".length - 2;
  const flat = error.replace(/\s+/g, " ").trim();
  return `error: ${flat.length > room ? `${flat.slice(0, room - 1)}…` : flat}`;
}

async function main(): Promise<void> {
  const vaultPath = process.argv[2] ?? DEFAULT_VAULT;

  // The same guard the smoke run uses. Without it, a REST arm bound to a
  // different vault would write eighteen bench notes into that vault while the
  // filesystem arm wrote to this one, and the table would compare two vaults as
  // though they were one.
  const restClient = await restPreflight(TOOL, vaultPath);

  const absolute = join(vaultPath, SCRATCH_NOTE);
  try {
    await stat(absolute);
    restClient.destroy();
    abort(TOOL, `${SCRATCH_NOTE} already exists. Refusing to overwrite it.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      restClient.destroy();
      abort(TOOL, `cannot check ${SCRATCH_NOTE}: ${describeError(err)}`);
    }
  }

  const restBackend = new RestBackend(restClient, { vaultPath });
  const fsBackend = new FileSystemBackend(new FileSystemService(vaultPath));

  process.stdout.write(`\n  Backend benchmark — ${vaultPath}\n`);
  process.stdout.write(`  median of ${SAMPLES} samples, ${WARMUP} discarded warmups\n\n`);

  const rows: Row[] = [];

  try {
    // Seed the note both arms read, through the filesystem so a broken REST
    // write does not make the read column look like a REST failure.
    await fsBackend.writeNote({
      path: SCRATCH_NOTE,
      content: "# bench\n\nbody\n",
      mode: "overwrite",
    });

    for (const operation of ["read_note", "write_note", "list_directory"] as const) {
      const rest = await measure(restBackend, operation);
      const fs = await measure(fsBackend, operation);
      const row: Row = { operation, rest: rest.ms, fs: fs.ms };
      if (rest.error !== undefined) row.restError = rest.error;
      if (fs.error !== undefined) row.fsError = fs.error;
      rows.push(row);
    }
  } finally {
    await rm(join(vaultPath, SCRATCH_NOTE), { force: true }).catch(() => {});
    // Created implicitly by the seed write; would otherwise accumulate. `rm`
    // with `recursive: false` throws EISDIR on a directory and would silently
    // never clean up.
    await rmdir(join(vaultPath, SCRATCH_DIR)).catch(() => {});
    restClient.destroy();
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  process.stdout.write(`  ${pad("operation", 18)}${pad("REST", COLUMN)}filesystem\n`);
  process.stdout.write(`  ${"-".repeat(52)}\n`);
  for (const row of rows) {
    process.stdout.write(
      `  ${pad(row.operation, 18)}${pad(format(row.rest, row.restError), COLUMN)}${format(row.fs, row.fsError)}\n`,
    );
  }

  process.stdout.write(
    "\n  Informational only. No threshold is asserted and no CI job runs this.\n\n",
  );
}

await main();
