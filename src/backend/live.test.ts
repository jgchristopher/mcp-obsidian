import { test, expect, describe, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ObsidianLiveService, ObsidianUnavailableError, JSON_LOGIC_CONTENT_TYPE } from "./live.js";
import { RestClient } from "./rest/client.js";
import { RestConfigurationError } from "./rest/index.js";
import { startFixture } from "./testing/fixture-server.js";
import type { Fixture } from "./testing/fixture-server.js";

/**
 * The five REST-only tools, against the phase 2 fixture. Nothing here needs a
 * live Obsidian, so nothing here is environment-gated.
 */

const FILES = {
  "alpha.md": "# Alpha\n",
  "notes/gamma.md": "---\nstatus: draft\n---\n\n# Gamma\n",
};

let fixture: Fixture;
let client: RestClient;
let service: ObsidianLiveService;

function clientFor(port: number): RestClient {
  return new RestClient({
    apiKey: "live-key",
    host: "127.0.0.1",
    port,
    protocol: "http",
    verifySsl: false,
  });
}

/** A port nothing is listening on, i.e. Obsidian is closed. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => resolve((probe.address() as AddressInfo).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

beforeEach(async () => {
  fixture = await startFixture({ files: { ...FILES }, activeFile: "alpha.md" });
  client = clientFor(fixture.port);
  service = new ObsidianLiveService(client);
});

afterEach(async () => {
  client.destroy();
  await fixture.close();
});

describe("healthy Obsidian", () => {
  test("list_commands returns registered ids and names", async () => {
    expect(await service.listCommands()).toEqual([
      { id: "app:open-vault", name: "Open another vault" },
      { id: "editor:toggle-bold", name: "Toggle bold" },
    ]);
  });

  test("execute_command runs a registered command", async () => {
    expect(await service.executeCommand("app:open-vault")).toEqual({
      success: true,
      id: "app:open-vault",
    });
    expect(fixture.executedCommands).toEqual(["app:open-vault"]);
  });

  test("execute_command names an unknown id and points at list_commands", async () => {
    await expect(service.executeCommand("plugin:does-not-exist")).rejects.toThrow(
      "Unknown Obsidian command: plugin:does-not-exist. Use list_commands to see the registered ids.",
    );
    expect(fixture.executedCommands).toEqual([]);
  });

  test("execute_command rejects a blank id before sending anything", async () => {
    await expect(service.executeCommand("   ")).rejects.toThrow(
      "execute_command requires a command id",
    );
    expect(fixture.requests).toHaveLength(0);
  });

  test("get_active_file reports the focused note", async () => {
    expect(await service.getActiveFile()).toEqual({ path: "alpha.md" });
  });

  test("get_active_file says so when nothing is focused", async () => {
    await fixture.close();
    fixture = await startFixture({ files: { ...FILES } });
    client.destroy();
    client = clientFor(fixture.port);
    service = new ObsidianLiveService(client);

    await expect(service.getActiveFile()).rejects.toThrow(
      "No file is currently active in Obsidian.",
    );
  });

  test("open_file opens a nested note, percent-encoding each segment", async () => {
    expect(await service.openFile("notes/gamma.md")).toEqual({
      success: true,
      path: "notes/gamma.md",
    });
    expect(fixture.openedFiles).toEqual(["notes/gamma.md"]);
  });

  test("open_file normalizes a leading slash", async () => {
    await service.openFile("/alpha.md");

    expect(fixture.openedFiles).toEqual(["alpha.md"]);
  });

  test("open_file refuses a non-string path with a usable message", async () => {
    await expect(service.openFile(42)).rejects.toThrow(
      "open_file requires a note path relative to the vault root.",
    );
    expect(fixture.requests).toHaveLength(0);
  });

  test("execute_command refuses a non-string id with a usable message", async () => {
    await expect(service.executeCommand({ id: "app:open-vault" })).rejects.toThrow(
      "execute_command requires a command id",
    );
    expect(fixture.requests).toHaveLength(0);
  });

  test("open_file refuses a restricted path without sending a request", async () => {
    await expect(service.openFile(".obsidian/workspace.json")).rejects.toThrow(/^Access denied/);
    expect(fixture.requests).toHaveLength(0);
  });

  test("open_file refuses a traversal without sending a request", async () => {
    await expect(service.openFile("../outside.md")).rejects.toThrow(/^Path traversal not allowed/);
    expect(fixture.requests).toHaveLength(0);
  });

  test("search_vault_advanced sends the JsonLogic content type and only that", async () => {
    const query = { glob: [{ var: "path" }, "*.md"] };

    const results = await service.searchVaultAdvanced(query);

    expect(results).toEqual([
      { filename: "alpha.md", result: query },
      { filename: "notes/gamma.md", result: query },
    ]);

    const search = fixture.requests.find((entry) => entry.path === "/search/");
    expect(search?.headers["content-type"]).toBe(JSON_LOGIC_CONTENT_TYPE);
    expect(search?.headers["content-type"]).not.toContain("dataview");
    expect(search?.body).toBe(JSON.stringify(query));
  });

  test("search_vault_advanced rejects a missing query before sending anything", async () => {
    await expect(service.searchVaultAdvanced(null)).rejects.toThrow(
      "search_vault_advanced requires a JsonLogic query object.",
    );
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("Obsidian unreachable", () => {
  const calls: Array<[string, (svc: ObsidianLiveService) => Promise<unknown>]> = [
    ["list_commands", (svc) => svc.listCommands()],
    ["execute_command", (svc) => svc.executeCommand("app:open-vault")],
    ["get_active_file", (svc) => svc.getActiveFile()],
    ["open_file", (svc) => svc.openFile("alpha.md")],
    ["search_vault_advanced", (svc) => svc.searchVaultAdvanced({ var: "path" })],
  ];

  test.each(calls)("%s raises ObsidianUnavailableError against a closed port", async (tool, call) => {
    const port = await closedPort();
    const offline = clientFor(port);
    const svc = new ObsidianLiveService(offline);

    try {
      await expect(call(svc)).rejects.toThrow(ObsidianUnavailableError);
      await expect(call(svc)).rejects.toThrow(
        `'${tool}' requires a running Obsidian with the Local REST API plugin. ` +
          `Obsidian is not reachable. Start Obsidian and retry.`,
      );
    } finally {
      offline.destroy();
    }
  });

  test.each(calls)("%s raises ObsidianUnavailableError with no API key configured", async (tool, call) => {
    const svc = new ObsidianLiveService(null);

    await expect(call(svc)).rejects.toThrow(ObsidianUnavailableError);
    await expect(call(svc)).rejects.toThrow(`'${tool}' requires a running Obsidian`);
  });
});

describe("configuration failures stay distinct from unavailability", () => {
  test("a rejected key raises RestConfigurationError, not ObsidianUnavailableError", async () => {
    await fixture.close();
    fixture = await startFixture({ files: { ...FILES }, apiKey: "the-real-key" });
    client.destroy();
    client = clientFor(fixture.port);
    service = new ObsidianLiveService(client);

    await expect(service.listCommands()).rejects.toThrow(RestConfigurationError);
  });
});
