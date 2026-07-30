import { test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../createServer.js";
import { PARITY_MAPPINGS, FILESYSTEM_ONLY_TARGETS, uniqueTargets } from "./parity.js";

let testVaultPath: string;

beforeEach(async () => {
  testVaultPath = await mkdtemp(join(tmpdir(), "mcpvault-test-"));
});

afterEach(async () => {
  try {
    await rm(testVaultPath, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
});

/**
 * The registered tool names, read from the server rather than from a list kept
 * alongside it. A table compared against a hardcoded copy of itself would keep
 * agreeing while the tools were renamed out from under it.
 */
async function registeredToolNames(): Promise<Set<string>> {
  const server = createServer(testVaultPath, { version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.listTools();
    return new Set(result.tools.map((t) => t.name));
  } finally {
    await client.close();
    await server.close();
  }
}

test("every obsidian-jcos tool maps to a registered MCPVault tool", async () => {
  const registered = await registeredToolNames();

  const missing = PARITY_MAPPINGS.filter((m) => !registered.has(m.mcpvault)).map(
    (m) => `${m.python} -> ${m.mcpvault}`,
  );

  expect(missing).toEqual([]);
});

test("the table covers all 13 Python tools", () => {
  expect(PARITY_MAPPINGS).toHaveLength(13);

  // Every Python tool is named once. A duplicated row would silently shrink
  // coverage while the length assertion still passed.
  const pythonNames = PARITY_MAPPINGS.map((m) => m.python);
  expect(new Set(pythonNames).size).toBe(13);
});

test("13 rows collapse to 11 distinct targets", () => {
  // list_directory and write_note each answer two Python tools. Asserting 13
  // distinct names here is the mistake this test exists to prevent.
  expect(uniqueTargets()).toHaveLength(11);
});

test("membership check has teeth", async () => {
  const registered = await registeredToolNames();

  // Proves the assertion above can fail. Without this, a bug that made
  // `registered` universally truthy would let every mapping pass.
  expect(registered.has("obsidian_tool_that_does_not_exist")).toBe(false);
  expect(registered.has("read_note")).toBe(true);
});

test("filesystem-only targets are real mapping targets", () => {
  // Guards against a typo in the label set silently mislabelling nothing.
  const targets = new Set(uniqueTargets());
  for (const name of FILESYSTEM_ONLY_TARGETS) {
    expect(targets).toContain(name);
  }
});
