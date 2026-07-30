import { describe, test, expect, afterAll } from "vitest";
import { RestBackend } from "./index.js";
import { RestClient } from "./client.js";
import { resolveRestConfig, MIN_PLUGIN_VERSION } from "./config.js";

/**
 * Optional smoke against a real Obsidian.
 *
 * The whole file is skipped unless `OBSIDIAN_API_KEY` is set, which is the
 * repo's first conditional-skip idiom — see AGENTS.md. It exists to catch
 * fixture drift when the plugin updates (BRAT moves versions without warning),
 * never as a substitute for the fixture-backed suite: phase 3's contract
 * criterion requires zero skipped tests in the contract arms, so nothing that
 * proves backend equivalence may live behind this guard.
 *
 * Strictly read-only. These run against a real vault.
 *
 *   OBSIDIAN_API_KEY=… npm test -- src/backend/rest/live
 */

const config = resolveRestConfig();
const client = config ? new RestClient(config) : null;

afterAll(() => {
  client?.destroy();
});

describe.skipIf(!config)("live Local REST API", () => {
  const backend = new RestBackend(client!, {
    vaultPath: process.env.OBSIDIAN_VAULT_PATH ?? process.cwd(),
  });

  test("the plugin reports a version at or above the floor", async () => {
    const { version, warning } = await backend.checkPluginVersion();

    expect(version).toBeTruthy();
    if (warning) {
      // Not a failure: the floor is a warning, not a refusal to start. Surface
      // it so the drift is visible in test output.
      console.warn(`${warning} (floor ${MIN_PLUGIN_VERSION})`);
    }
  });

  test("the vault root lists at least one markdown file", async () => {
    const listing = await backend.listDirectory("");

    expect(listing.files.some((name) => name.endsWith(".md"))).toBe(true);
  });

  test("a root note reads back with parsed frontmatter and content", async () => {
    const listing = await backend.listDirectory("");
    const first = listing.files.find((name) => name.endsWith(".md"));
    expect(first).toBeDefined();

    const note = await backend.readNote(first!);

    expect(typeof note.content).toBe("string");
    expect(note.originalContent.length).toBeGreaterThan(0);
    expect(note.frontmatter).toBeTypeOf("object");
  });

  test("the tag index answers in one call", async () => {
    const tags = await backend.listAllTags();

    expect(Array.isArray(tags)).toBe(true);
    for (const entry of tags) {
      expect(entry.count).toBeGreaterThan(0);
    }
  });
});
