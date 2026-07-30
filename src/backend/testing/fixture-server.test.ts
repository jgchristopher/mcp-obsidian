import { test, expect, afterEach } from "vitest";
import { request } from "node:http";
import { startFixture } from "./fixture-server.js";
import type { Fixture, FixtureOptions } from "./fixture-server.js";

/**
 * Self-test for the fixture. Driven with raw `node:http` rather than
 * `RestClient`, so a bug in one is never masked by a bug in the other.
 */

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function start(opts?: FixtureOptions): Promise<Fixture> {
  fixture = await startFixture(opts);
  return fixture;
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string; timeoutMs?: number } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      },
    );
    if (opts.timeoutMs !== undefined) {
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error("client timeout")));
    }
    req.on("error", reject);
    req.end(opts.body);
  });
}

// ============================================================================
// SEEDED CONTENT
// ============================================================================

test("GET /vault/ lists seeded root entries", async () => {
  const { port } = await start({ files: { "a.md": "# A", "b.md": "# B" } });

  const res = await raw(port, "GET", "/vault/");

  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ files: ["a.md", "b.md"] });
});

test("GET /vault/ marks nested directories with a trailing slash", async () => {
  const { port } = await start({ files: { "a.md": "# A", "sub/c.md": "# C" } });

  const res = await raw(port, "GET", "/vault/");

  expect(JSON.parse(res.body).files).toEqual(["a.md", "sub/"]);
});

test("GET on a nested directory lists only its own entries", async () => {
  const { port } = await start({ files: { "a.md": "# A", "sub/c.md": "# C" } });

  const res = await raw(port, "GET", "/vault/sub/");

  expect(JSON.parse(res.body)).toEqual({ files: ["c.md"] });
});

test("GET on a missing directory is 404", async () => {
  const { port } = await start({ files: { "a.md": "# A" } });

  const res = await raw(port, "GET", "/vault/nope/");

  expect(res.status).toBe(404);
});

test("GET a note as markdown returns the raw file", async () => {
  const { port } = await start({ files: { "a.md": "---\ntitle: A\n---\n\n# A" } });

  const res = await raw(port, "GET", "/vault/a.md");

  expect(res.status).toBe(200);
  expect(res.body).toBe("---\ntitle: A\n---\n\n# A");
});

test("GET a note with the olrapi accept header returns parsed metadata", async () => {
  const content = "---\ntitle: A\ntags:\n  - alpha\n---\n\n# A\n\n#beta text";
  const { port } = await start({ files: { "a.md": content } });

  const res = await raw(port, "GET", "/vault/a.md", {
    headers: { Accept: "application/vnd.olrapi.note+json" },
  });
  const json = JSON.parse(res.body);

  expect(json.path).toBe("a.md");
  // The plugin returns the whole file here, frontmatter block included.
  expect(json.content).toBe(content);
  expect(json.frontmatter).toEqual({ title: "A", tags: ["alpha"] });
  expect(json.tags).toEqual(["alpha", "beta"]);
  expect(json.stat.size).toBe(Buffer.byteLength(content, "utf-8"));
});

test("GET a missing note is 404", async () => {
  const { port } = await start();

  const res = await raw(port, "GET", "/vault/missing.md");

  expect(res.status).toBe(404);
});

test("percent-encoded non-ASCII paths resolve to the decoded file", async () => {
  const { port } = await start({ files: { "résumé.md": "# CV" } });

  const res = await raw(port, "GET", `/vault/${encodeURIComponent("résumé.md")}`);

  expect(res.status).toBe(200);
  expect(res.body).toBe("# CV");
});

// ============================================================================
// WRITES
// ============================================================================

test("PUT replaces file content and returns 204", async () => {
  const f = await start({ files: { "a.md": "old" } });

  const res = await raw(f.port, "PUT", "/vault/a.md", { body: "new" });

  expect(res.status).toBe(204);
  expect(f.files.get("a.md")).toBe("new");
});

test("PUT creates a nested file that did not exist", async () => {
  const f = await start();

  const res = await raw(f.port, "PUT", "/vault/deep/nested/a.md", { body: "hi" });

  expect(res.status).toBe(204);
  expect(f.files.get("deep/nested/a.md")).toBe("hi");
});

test("POST appends to the end of the file", async () => {
  const f = await start({ files: { "a.md": "one" } });

  const res = await raw(f.port, "POST", "/vault/a.md", { body: "-two" });

  expect(res.status).toBe(204);
  expect(f.files.get("a.md")).toBe("one-two");
});

test("DELETE removes the file, and a second DELETE is 404", async () => {
  const f = await start({ files: { "a.md": "x" } });

  expect((await raw(f.port, "DELETE", "/vault/a.md")).status).toBe(204);
  expect(f.files.has("a.md")).toBe(false);
  expect((await raw(f.port, "DELETE", "/vault/a.md")).status).toBe(404);
});

test("PATCH appends beneath a heading", async () => {
  const f = await start({ files: { "a.md": "# One\nbody\n\n# Two\nother" } });

  const res = await raw(f.port, "PATCH", "/vault/a.md", {
    headers: { Operation: "append", "Target-Type": "heading", Target: "One" },
    body: "added",
  });

  expect(res.status).toBe(200);
  expect(f.files.get("a.md")).toBe("# One\nbody\n\nadded\n# Two\nother");
});

test("PATCH targeting an absent heading is 400", async () => {
  const f = await start({ files: { "a.md": "# One\nbody" } });

  const res = await raw(f.port, "PATCH", "/vault/a.md", {
    headers: { Operation: "append", "Target-Type": "heading", Target: "Nope" },
    body: "added",
  });

  expect(res.status).toBe(400);
  expect(f.files.get("a.md")).toBe("# One\nbody");
});

// ============================================================================
// MOVE
// ============================================================================

test("MOVE relocates the file and reports the new location", async () => {
  const f = await start({ files: { "a.md": "x" } });

  const res = await raw(f.port, "MOVE", "/vault/a.md", {
    headers: { Destination: "archive/a.md" },
  });

  expect(res.status).toBe(204);
  expect(res.headers["content-location"]).toBe("archive/a.md");
  expect(f.files.has("a.md")).toBe(false);
  expect(f.files.get("archive/a.md")).toBe("x");
});

test("MOVE onto an existing destination is 409 unless overwrite is allowed", async () => {
  const f = await start({ files: { "a.md": "x", "b.md": "y" } });

  const blocked = await raw(f.port, "MOVE", "/vault/a.md", {
    headers: { Destination: "b.md" },
  });
  expect(blocked.status).toBe(409);
  expect(f.files.get("b.md")).toBe("y");

  const allowed = await raw(f.port, "MOVE", "/vault/a.md", {
    headers: { Destination: "b.md", "Allow-Overwrite": "true" },
  });
  expect(allowed.status).toBe(204);
  expect(f.files.get("b.md")).toBe("x");
});

test("MOVE of a missing source is 404, and a missing Destination header is 400", async () => {
  const f = await start({ files: { "a.md": "x" } });

  expect(
    (await raw(f.port, "MOVE", "/vault/missing.md", { headers: { Destination: "b.md" } })).status,
  ).toBe(404);
  expect((await raw(f.port, "MOVE", "/vault/a.md")).status).toBe(400);
});

test("MOVE percent-decodes the Destination header", async () => {
  const f = await start({ files: { "a.md": "x" } });

  await raw(f.port, "MOVE", "/vault/a.md", {
    headers: { Destination: encodeURIComponent("résumé.md") },
  });

  expect(f.files.get("résumé.md")).toBe("x");
});

// ============================================================================
// SYSTEM ENDPOINTS
// ============================================================================

test("GET / reports the plugin version and needs no auth", async () => {
  const { port } = await start({ apiKey: "secret", pluginVersion: "4.0.0" });

  const res = await raw(port, "GET", "/");

  expect(res.status).toBe(200);
  expect(JSON.parse(res.body).versions.self).toBe("4.0.0");
});

test("a wrong api key is rejected with 401 on vault routes", async () => {
  const { port } = await start({ apiKey: "secret", files: { "a.md": "x" } });

  const wrong = await raw(port, "GET", "/vault/a.md", { headers: { Authorization: "Bearer nope" } });
  expect(wrong.status).toBe(401);

  const right = await raw(port, "GET", "/vault/a.md", {
    headers: { Authorization: "Bearer secret" },
  });
  expect(right.status).toBe(200);
});

test("GET /tags/ counts tags across files and credits parent prefixes", async () => {
  const { port } = await start({
    files: {
      "a.md": "---\ntags:\n  - work/tasks\n---\n\n#project",
      "b.md": "#project text",
    },
  });

  const res = await raw(port, "GET", "/tags/");

  expect(JSON.parse(res.body).tags).toEqual([
    { name: "project", count: 2 },
    { name: "work", count: 1 },
    { name: "work/tasks", count: 1 },
  ]);
});

// ============================================================================
// REQUEST RECORDING
// ============================================================================

test("every request is recorded with verb, path, headers, and body", async () => {
  const f = await start({ files: { "a.md": "x" } });

  await raw(f.port, "MOVE", "/vault/a.md", { headers: { Destination: "b.md" } });
  await raw(f.port, "PUT", "/vault/b.md", { body: "content" });

  expect(f.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    "MOVE /vault/a.md",
    "PUT /vault/b.md",
  ]);
  expect(f.requests[0]?.headers["destination"]).toBe("b.md");
  expect(f.requests[1]?.body).toBe("content");
});

// ============================================================================
// FAILURE INJECTORS
// ============================================================================

test("failWith forces the given status once, then normal service resumes", async () => {
  const f = await start({
    files: { "a.md": "x" },
    failWith: { path: "/vault/a.md", status: 500 },
  });

  expect((await raw(f.port, "GET", "/vault/a.md")).status).toBe(500);
  expect((await raw(f.port, "GET", "/vault/a.md")).status).toBe(200);
});

test("failWith ignores paths it was not aimed at", async () => {
  const f = await start({
    files: { "a.md": "x", "b.md": "y" },
    failWith: { path: "/vault/a.md", status: 500 },
  });

  expect((await raw(f.port, "GET", "/vault/b.md")).status).toBe(200);
});

test("killSocketOn destroys the connection, surfacing a socket error client-side", async () => {
  const f = await start({ files: { "a.md": "x" }, killSocketOn: "/vault/a.md" });

  await expect(raw(f.port, "GET", "/vault/a.md")).rejects.toThrow();
  // The request still reached the server before the socket died — this is
  // exactly the shape that must classify as `unknown-state`.
  expect(f.requests).toHaveLength(1);
});

test("hangOn accepts the request and never replies", async () => {
  const f = await start({ files: { "a.md": "x" }, hangOn: "/vault/a.md" });

  await expect(raw(f.port, "GET", "/vault/a.md", { timeoutMs: 200 })).rejects.toThrow(
    "client timeout",
  );
  expect(f.requests).toHaveLength(1);
});
