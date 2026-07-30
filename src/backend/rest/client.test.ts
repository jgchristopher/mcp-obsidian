import { test, expect, afterEach } from "vitest";
import { RestClient, DEFAULT_TIMEOUT_MS, MAX_SOCKETS } from "./client.js";
import { BackendError } from "../types.js";
import { startFixture } from "../testing/fixture-server.js";
import type { Fixture, FixtureOptions } from "../testing/fixture-server.js";
import type { RestConfig } from "./config.js";

/**
 * The classifier is the most consequential code in this phase: phase 3's
 * write-safety rule is only as correct as the never-sent / unknown-state
 * decision made here. Every failure shape gets its own test.
 */

let fixture: Fixture | undefined;
let client: RestClient | undefined;

afterEach(async () => {
  client?.destroy();
  client = undefined;
  await fixture?.close();
  fixture = undefined;
});

function configFor(port: number, overrides: Partial<RestConfig> = {}): RestConfig {
  return {
    apiKey: "test-key",
    host: "127.0.0.1",
    port,
    protocol: "http",
    verifySsl: false,
    ...overrides,
  };
}

async function withFixture(opts?: FixtureOptions): Promise<{ f: Fixture; c: RestClient }> {
  fixture = await startFixture(opts);
  client = new RestClient(configFor(fixture.port));
  return { f: fixture, c: client };
}

/** A port nothing is listening on: bind one, then let it go. */
async function closedPort(): Promise<number> {
  const temporary = await startFixture();
  const { port } = temporary;
  await temporary.close();
  return port;
}

async function failureOf(promise: Promise<unknown>): Promise<BackendError["failure"]> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BackendError);
    return (error as BackendError).failure;
  }
  throw new Error("expected the request to reject, but it resolved");
}

// ============================================================================
// HAPPY PATH
// ============================================================================

test("smoke: a 200 round-trips status, headers, and body", async () => {
  const { c } = await withFixture({ files: { "a.md": "# A" } });

  const res = await c.send({ method: "GET", path: "/vault/a.md" });

  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/markdown");
  expect(res.body).toBe("# A");
});

test("every request carries the bearer auth header", async () => {
  const { f, c } = await withFixture({ files: { "a.md": "x" }, apiKey: "test-key" });

  const res = await c.send({ method: "GET", path: "/vault/a.md" });

  expect(res.status).toBe(200);
  expect(f.requests[0]?.headers["authorization"]).toBe("Bearer test-key");
});

test("caller-supplied headers are merged with the auth header", async () => {
  const { f, c } = await withFixture({ files: { "a.md": "x" } });

  await c.send({
    method: "GET",
    path: "/vault/a.md",
    headers: { Accept: "application/vnd.olrapi.note+json" },
  });

  expect(f.requests[0]?.headers["accept"]).toBe("application/vnd.olrapi.note+json");
  expect(f.requests[0]?.headers["authorization"]).toBe("Bearer test-key");
});

test("a request body is written to the wire", async () => {
  const { f, c } = await withFixture();

  const res = await c.send({ method: "PUT", path: "/vault/a.md", body: "hello" });

  expect(res.status).toBe(204);
  expect(f.requests[0]?.body).toBe("hello");
  expect(f.files.get("a.md")).toBe("hello");
});

test("the WebDAV MOVE verb passes through unchanged", async () => {
  const { f, c } = await withFixture({ files: { "a.md": "x" } });

  const res = await c.send({
    method: "MOVE",
    path: "/vault/a.md",
    headers: { Destination: "archive/a.md" },
  });

  expect(res.status).toBe(204);
  expect(f.requests[0]?.method).toBe("MOVE");
  expect(f.requests[0]?.headers["destination"]).toBe("archive/a.md");
});

// ============================================================================
// HTTP STATUSES ARE ANSWERS, NOT FAILURES
// ============================================================================

test.each([400, 401, 403, 404, 409, 500])("a %i response resolves rather than rejects", async (status) => {
  const { c } = await withFixture({
    files: { "a.md": "x" },
    failWith: { path: "/vault/a.md", status },
  });

  const res = await c.send({ method: "GET", path: "/vault/a.md" });

  expect(res.status).toBe(status);
});

test("a 404 for a genuinely missing note also resolves", async () => {
  const { c } = await withFixture();

  await expect(c.send({ method: "GET", path: "/vault/missing.md" })).resolves.toMatchObject({
    status: 404,
  });
});

// ============================================================================
// CLASSIFICATION: NEVER SENT
// ============================================================================

test("a refused connection classifies as never-sent", async () => {
  const port = await closedPort();
  client = new RestClient(configFor(port));

  const failure = await failureOf(client.send({ method: "GET", path: "/vault/a.md" }));

  expect(failure.kind).toBe("never-sent");
  expect(failure).toMatchObject({ cause: expect.objectContaining({ code: "ECONNREFUSED" }) });
});

test("a refused connection on a write also classifies as never-sent", async () => {
  // The write case is the one that matters: never-sent is the only
  // classification that lets phase 3 retry a write on the filesystem.
  const port = await closedPort();
  client = new RestClient(configFor(port));

  const failure = await failureOf(
    client.send({ method: "PUT", path: "/vault/a.md", body: "content" }),
  );

  expect(failure.kind).toBe("never-sent");
});

test("a DNS failure classifies as never-sent", async () => {
  // .invalid is reserved by RFC 2606 and can never resolve.
  client = new RestClient(configFor(80, { host: "obsidian.invalid" }));

  const failure = await failureOf(
    client.send({ method: "GET", path: "/vault/a.md", timeoutMs: 4000 }),
  );

  expect(failure.kind).toBe("never-sent");
}, 10_000);

test("a timeout before the request is flushed classifies as never-sent", async () => {
  // 192.0.2.0/24 is TEST-NET-1: routable-looking and guaranteed to go nowhere,
  // so the connection never completes and no bytes ever leave.
  client = new RestClient(configFor(27123, { host: "192.0.2.1" }));

  const failure = await failureOf(
    client.send({ method: "PUT", path: "/vault/a.md", body: "content", timeoutMs: 250 }),
  );

  expect(failure.kind).toBe("never-sent");
}, 10_000);

// ============================================================================
// CLASSIFICATION: UNKNOWN STATE
// ============================================================================

test("a socket destroyed after the request was sent classifies as unknown-state", async () => {
  const { f, c } = await withFixture({ files: { "a.md": "x" }, killSocketOn: "/vault/a.md" });

  const failure = await failureOf(c.send({ method: "GET", path: "/vault/a.md" }));

  expect(failure.kind).toBe("unknown-state");
  // The server did receive it — which is precisely why falling back is unsafe.
  expect(f.requests).toHaveLength(1);
});

test("a write whose socket dies mid-flight classifies as unknown-state", async () => {
  const { f, c } = await withFixture({ hangOn: "/never", killSocketOn: "/vault/a.md" });

  const failure = await failureOf(
    c.send({ method: "PUT", path: "/vault/a.md", body: "content" }),
  );

  expect(failure.kind).toBe("unknown-state");
  expect(f.requests[0]?.body).toBe("content");
});

test("no response within the timeout, after send, classifies as unknown-state", async () => {
  const { f, c } = await withFixture({ files: { "a.md": "x" }, hangOn: "/vault/a.md" });

  const failure = await failureOf(
    c.send({ method: "GET", path: "/vault/a.md", timeoutMs: 200 }),
  );

  expect(failure.kind).toBe("unknown-state");
  expect(failure.kind === "unknown-state" && failure.cause.message).toMatch(/Timed out after 200ms/);
  expect(f.requests).toHaveLength(1);
});

test("the two timeout sides are told apart by the finish flag, not the error code", async () => {
  // Both of these are timeouts. Only the post-send one may block a write
  // fallback, and no error code distinguishes them.
  const hung = await startFixture({ hangOn: "/vault/a.md" });
  fixture = hung;
  const postSend = new RestClient(configFor(hung.port));
  const preSend = new RestClient(configFor(27123, { host: "192.0.2.1" }));

  try {
    const after = await failureOf(
      postSend.send({ method: "PUT", path: "/vault/a.md", body: "x", timeoutMs: 200 }),
    );
    const before = await failureOf(
      preSend.send({ method: "PUT", path: "/vault/a.md", body: "x", timeoutMs: 250 }),
    );

    expect(after.kind).toBe("unknown-state");
    expect(before.kind).toBe("never-sent");
  } finally {
    postSend.destroy();
    preSend.destroy();
  }
}, 10_000);

// ============================================================================
// ERROR SHAPE
// ============================================================================

test("transport failures always reject with a BackendError that keeps the cause", async () => {
  const port = await closedPort();
  client = new RestClient(configFor(port));

  await expect(client.send({ method: "GET", path: "/vault/a.md" })).rejects.toBeInstanceOf(
    BackendError,
  );
  await expect(client.send({ method: "GET", path: "/vault/a.md" })).rejects.toThrow(
    /REST request failed/,
  );
});

// ============================================================================
// AGENT SCOPING
// ============================================================================

test("constructing an https client never touches process-wide TLS settings", () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  client = new RestClient(configFor(27123, { protocol: "https", verifySsl: false }));

  expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
});

test("the socket cap is set, so batch reads cannot exhaust the pool", () => {
  expect(MAX_SOCKETS).toBe(8);
});

test("the default timeout is the documented five seconds", () => {
  expect(DEFAULT_TIMEOUT_MS).toBe(5000);
});
