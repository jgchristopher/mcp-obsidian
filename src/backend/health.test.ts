import { test, expect, beforeEach, afterEach, describe } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  Health,
  fingerprintFilesystem,
  fingerprintRest,
  DEFAULT_FINGERPRINT_TTL_MS,
} from "./health.js";
import { RestClient } from "./rest/client.js";
import { startFixture } from "./testing/fixture-server.js";
import type { Fixture } from "./testing/fixture-server.js";

/**
 * The guard exists for one scenario the obvious design misses: Obsidian stays
 * running, the user switches vaults, and nothing ever fails. So the clock is
 * injected and most of these tests never touch an error path.
 */

const SEED: Record<string, string> = {
  "alpha.md": "# Alpha",
  "beta.md": "# Beta",
  "notes/gamma.md": "# Gamma",
  "attachment.png": "not really a png",
};

let vaultPath: string;
let fixture: Fixture;
let client: RestClient;
let clock: number;
let warnings: string[];

async function seedVault(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcpvault-health-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf-8");
  }
  return dir;
}

function makeHealth(overrides: { fingerprintTtlMs?: number; unreachableTtlMs?: number } = {}) {
  return new Health(client, vaultPath, {
    ...overrides,
    now: () => clock,
    onWarn: (message) => warnings.push(message),
  });
}

beforeEach(async () => {
  clock = 0;
  warnings = [];
  vaultPath = await seedVault(SEED);
  fixture = await startFixture({ files: { ...SEED } });
  client = new RestClient({
    apiKey: "test-key",
    host: "127.0.0.1",
    port: fixture.port,
    protocol: "http",
    verifySsl: false,
  });
});

afterEach(async () => {
  client.destroy();
  // Tolerant: one test closes the fixture itself to make the port refuse.
  await fixture.close().catch(() => {});
  await rm(vaultPath, { recursive: true, force: true });
});

// ============================================================================
// THE FINGERPRINT ITSELF
// ============================================================================

test("both fingerprints agree on a seeded pair", async () => {
  const remote = await fingerprintRest(client);
  const local = await fingerprintFilesystem(vaultPath);

  expect(remote).toEqual(["alpha.md", "beta.md"]);
  expect(local).toEqual(remote);
});

test("the fingerprint ignores directories, nesting, and non-markdown files", async () => {
  // `notes/` exists in both sources and `attachment.png` in both, yet neither
  // contributes: the comparison is root-level .md filenames only.
  const local = await fingerprintFilesystem(vaultPath);

  expect(local).not.toContain("notes");
  expect(local).not.toContain("attachment.png");
});

test("an empty directory the plugin cannot see does not break the comparison", async () => {
  // The plugin builds /vault/ from getFiles(), so empty directories never
  // appear there. Comparing full listings would mismatch here.
  await mkdir(join(vaultPath, "Empty Folder"), { recursive: true });

  expect(await fingerprintFilesystem(vaultPath)).toEqual(await fingerprintRest(client));
});

// ============================================================================
// THE HAPPY PATH
// ============================================================================

test("a matching fingerprint makes REST usable, with no warning", async () => {
  const health = makeHealth();

  expect(await health.restUsable()).toBe(true);
  expect(warnings).toEqual([]);
});

test("a fresh check is reused instead of re-requesting", async () => {
  const health = makeHealth();
  await health.restUsable();
  const after = fixture.requests.length;

  clock += DEFAULT_FINGERPRINT_TTL_MS / 2;
  expect(await health.restUsable()).toBe(true);

  expect(fixture.requests.length).toBe(after);
});

test("concurrent callers share one revalidation", async () => {
  const health = makeHealth();

  const results = await Promise.all([
    health.restUsable(),
    health.restUsable(),
    health.restUsable(),
  ]);

  expect(results).toEqual([true, true, true]);
  expect(fixture.requests.filter((r) => r.path === "/vault/").length).toBe(1);
});

// ============================================================================
// THE SCENARIO THE GUARD EXISTS FOR
// ============================================================================

describe("mid-session vault switch with no transport failure", () => {
  test("the switch is caught once the TTL expires", async () => {
    const health = makeHealth();
    expect(await health.restUsable()).toBe(true);

    // Obsidian switched vaults. Nothing failed; the answers just changed.
    fixture.files.delete("alpha.md");
    fixture.files.set("someone-elses-note.md", "# Different vault");

    clock += DEFAULT_FINGERPRINT_TTL_MS / 2;
    expect(await health.restUsable(), "stale result is reused inside the TTL").toBe(true);

    clock += DEFAULT_FINGERPRINT_TTL_MS;
    expect(await health.restUsable()).toBe(false);
    expect(warnings.join("\n")).toMatch(/fingerprint mismatch/i);
  });

  test("the warning names both vaults", async () => {
    fixture.files.set("someone-elses-note.md", "# Different vault");
    const health = makeHealth();

    await health.restUsable();

    expect(warnings[0]).toContain(vaultPath);
    expect(warnings[0]).toContain("someone-elses-note.md");
  });

  test("a mismatch is not permanent: a matching revalidation re-enables REST", async () => {
    fixture.files.set("someone-elses-note.md", "# Different vault");
    const health = makeHealth();
    expect(await health.restUsable()).toBe(false);

    fixture.files.delete("someone-elses-note.md");

    clock += DEFAULT_FINGERPRINT_TTL_MS + 1;
    expect(await health.restUsable()).toBe(true);
  });

  test("the mismatch warning is not repeated on every revalidation", async () => {
    fixture.files.set("someone-elses-note.md", "# Different vault");
    const health = makeHealth();

    await health.restUsable();
    clock += DEFAULT_FINGERPRINT_TTL_MS + 1;
    await health.restUsable();

    expect(warnings.filter((w) => /fingerprint mismatch/i.test(w)).length).toBe(1);
  });
});

// ============================================================================
// INCONCLUSIVE
// ============================================================================

test("two empty vaults disable REST with a distinct message", async () => {
  await rm(vaultPath, { recursive: true, force: true });
  vaultPath = await seedVault({ "notes/only-nested.md": "# Nested" });
  fixture.files.clear();
  fixture.files.set("notes/only-nested.md", "# Nested");

  const health = makeHealth();

  expect(await health.restUsable()).toBe(false);
  expect(warnings.join("\n")).toMatch(/inconclusive/i);
  expect(warnings.join("\n")).not.toMatch(/mismatch/i);
});

test("an unreadable vault directory disables REST rather than assuming agreement", async () => {
  await rm(vaultPath, { recursive: true, force: true });
  const health = makeHealth();

  expect(await health.restUsable()).toBe(false);
  expect(warnings.join("\n")).toContain(vaultPath);
});

// ============================================================================
// REACHABILITY
// ============================================================================

describe("reachability", () => {
  test("a fingerprint request that cannot be answered counts as unreachable", async () => {
    await fixture.close();
    const health = makeHealth();

    expect(await health.restUsable()).toBe(false);
    // Not a mismatch: nothing was learned about which vault is on the far end.
    expect(warnings.join("\n")).not.toMatch(/mismatch/i);
  });

  test("an unreachable mark suppresses attempts for its TTL", async () => {
    const health = makeHealth({ unreachableTtlMs: 30_000 });
    expect(await health.restUsable()).toBe(true);
    const before = fixture.requests.length;

    health.markUnreachable();

    clock += 29_999;
    expect(await health.restUsable()).toBe(false);
    expect(fixture.requests.length, "no request while suppressed").toBe(before);
  });

  test("suppression expiry forces a fresh check rather than trusting the old one", async () => {
    const health = makeHealth({ unreachableTtlMs: 30_000 });
    expect(await health.restUsable()).toBe(true);
    const before = fixture.requests.length;

    health.markUnreachable();
    clock += 30_000;

    expect(await health.restUsable()).toBe(true);
    expect(fixture.requests.length).toBeGreaterThan(before);
  });

  test("recovery works: unreachable, then reachable again", async () => {
    const health = makeHealth({ unreachableTtlMs: 1_000 });
    health.markUnreachable();
    expect(await health.restUsable()).toBe(false);

    clock += 1_001;
    expect(await health.restUsable()).toBe(true);
  });
});

// ============================================================================
// PLUGIN VERSION FLOOR
// ============================================================================

test("a plugin below the floor warns once and does not disable REST", async () => {
  await fixture.close();
  fixture = await startFixture({ files: { ...SEED }, pluginVersion: "4.0.0" });
  client.destroy();
  client = new RestClient({
    apiKey: "test-key",
    host: "127.0.0.1",
    port: fixture.port,
    protocol: "http",
    verifySsl: false,
  });

  const health = makeHealth();
  expect(await health.restUsable()).toBe(true);

  clock += DEFAULT_FINGERPRINT_TTL_MS + 1;
  await health.restUsable();

  expect(warnings.filter((w) => /below the tested floor/.test(w)).length).toBe(1);
});

test("a supported plugin version is silent", async () => {
  const health = makeHealth();

  await health.restUsable();

  expect(warnings).toEqual([]);
});
