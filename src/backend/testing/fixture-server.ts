import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FrontmatterHandler } from "../../frontmatter.js";

/**
 * In-process stand-in for the Obsidian Local REST API.
 *
 * Exists because CI runs on ubuntu with no Obsidian installed, and the repo has
 * no HTTP mocking library. Without it the REST arm of the backend contract
 * suite cannot execute at all.
 *
 * Deliberately a test double, not a reimplementation: it serves only the
 * endpoints `RestBackend` calls, plus the three failure injectors a real server
 * will not produce on demand. Response shapes are taken from the plugin's own
 * OpenAPI document (v4.1.7).
 *
 * Plain `node:http`, not `https`. Tests set `protocol: "http"` in the config,
 * which exercises the same client code path minus TLS. TLS scoping is covered
 * by the grep criterion and the live smoke test, not by minting certificates
 * in unit tests.
 *
 * Never import this from a production path.
 */

export interface FixtureRequestRecord {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface FixtureOptions {
  /** Seeded vault contents, path -> file body. */
  files?: Record<string, string>;
  /** Force a status for the next request to a matching path. Fires once, then clears. */
  failWith?: { path: string; status: number };
  /** Simulate a socket death after the request is received but before a reply. */
  killSocketOn?: string;
  /** Accept the request and never respond, to exercise post-send timeouts. */
  hangOn?: string;
  /** When set, every request except `GET /` must carry `Authorization: Bearer <key>`. */
  apiKey?: string;
  /** Reported as `versions.self` by `GET /`. Defaults to the current floor. */
  pluginVersion?: string;
}

export interface Fixture {
  port: number;
  close(): Promise<void>;
  /** Every request the fixture received, in order. */
  requests: FixtureRequestRecord[];
  /** Live view of the seeded vault, so tests can assert resulting state. */
  files: Map<string, string>;
}

const frontmatter = new FrontmatterHandler();

const NOTE_JSON = "application/vnd.olrapi.note+json";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { errorCode: status * 100 + 1, message });
}

/** Decode a percent-encoded vault path one segment at a time. */
function decodeVaultPath(raw: string): string {
  return raw
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
}

/** True when an injector target matches the request URL, encoded or decoded. */
function targets(target: string | undefined, url: string): boolean {
  if (target === undefined) return false;
  if (target === url) return true;
  try {
    return decodeURIComponent(url) === target;
  } catch {
    return false;
  }
}

function tagsOf(content: string): string[] {
  const parsed = frontmatter.parse(content);
  const fromFrontmatter = Array.isArray(parsed.frontmatter.tags)
    ? parsed.frontmatter.tags.filter((tag: unknown): tag is string => typeof tag === "string")
    : typeof parsed.frontmatter.tags === "string"
      ? [parsed.frontmatter.tags]
      : [];
  const inline = (parsed.content.match(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g) ?? []).map((match) =>
    match.trim().slice(1),
  );
  const all = [...fromFrontmatter, ...inline].map((tag) => tag.replace(/^#/, "")).filter(Boolean);
  return [...new Set(all)];
}

/**
 * Directory listing in the plugin's shape: names relative to the directory,
 * with a trailing slash on directories. Built from the file set, so empty
 * directories do not appear — the same quirk the real plugin has, because it
 * lists `app.vault.getFiles()`.
 */
function listDirectory(files: Map<string, string>, dir: string): string[] | null {
  const prefix = dir ? `${dir}/` : "";
  const entries = new Set<string>();
  let matched = false;

  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    matched = true;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    entries.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
  }

  if (!matched && dir !== "") return null;
  return [...entries].sort();
}

/** True when the path names a directory, i.e. some file lives beneath it. */
function isDirectoryPath(files: Map<string, string>, path: string): boolean {
  const prefix = `${path}/`;
  for (const key of files.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

function noteJson(path: string, content: string): Record<string, unknown> {
  const parsed = frontmatter.parse(content);
  return {
    tags: tagsOf(content),
    frontmatter: parsed.frontmatter,
    stat: {
      ctime: 1_700_000_000_000,
      mtime: 1_700_000_000_000 + content.length,
      size: Buffer.byteLength(content, "utf-8"),
    },
    path,
    // The plugin returns `cachedRead(file)` here, i.e. the whole file including
    // its frontmatter block — not the body alone.
    content,
    links: [],
    backlinks: [],
  };
}

/** Minimal heading/frontmatter PATCH, enough to prove the verb round-trips. */
function applyPatch(
  content: string,
  operation: string,
  targetType: string,
  target: string,
  payload: string,
): string | null {
  if (targetType === "frontmatter") {
    const parsed = frontmatter.parse(content);
    if (!(target in parsed.frontmatter)) return null;
    return frontmatter.preserveStringify(parsed.matter ?? "", { [target]: payload }, parsed.content);
  }

  if (targetType !== "heading") return null;

  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === target);
  if (headingIndex === -1) return null;

  let end = headingIndex + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end] ?? "")) end += 1;

  const before = lines.slice(0, headingIndex + 1);
  const section = lines.slice(headingIndex + 1, end);
  const after = lines.slice(end);

  const replacement =
    operation === "prepend"
      ? [payload, ...section]
      : operation === "replace"
        ? [payload]
        : [...section, payload];

  return [...before, ...replacement, ...after].join("\n");
}

export function startFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const requests: FixtureRequestRecord[] = [];
  let failWith = opts.failWith;

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    const body = await readBody(req);

    requests.push({ method, path: url, headers: flattenHeaders(req), body });

    if (targets(opts.hangOn, url)) {
      // Deliberately never respond. The client's timeout must fire, and because
      // the request was already flushed the failure is `unknown-state`.
      return;
    }

    if (targets(opts.killSocketOn, url)) {
      req.socket.destroy();
      return;
    }

    if (failWith && targets(failWith.path, url)) {
      const status = failWith.status;
      failWith = undefined;
      sendError(res, status, `Injected failure with status ${status}`);
      return;
    }

    if (url === "/" && method === "GET") {
      sendJson(res, 200, {
        status: "OK",
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "1.4.0", self: opts.pluginVersion ?? "4.1.7" },
      });
      return;
    }

    if (opts.apiKey !== undefined && req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      sendError(res, 401, "Authorization required.");
      return;
    }

    if (url === "/tags/" && method === "GET") {
      const counts = new Map<string, number>();
      for (const content of files.values()) {
        const seen = new Set<string>();
        for (const tag of tagsOf(content)) {
          // Hierarchical tags credit every parent prefix, as Obsidian's sidebar does.
          const segments = tag.split("/");
          for (let i = 1; i <= segments.length; i += 1) seen.add(segments.slice(0, i).join("/"));
        }
        for (const tag of seen) counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
      const tags = [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      sendJson(res, 200, { tags });
      return;
    }

    if (!url.startsWith("/vault/")) {
      sendError(res, 404, `No route for ${method} ${url}`);
      return;
    }

    const rawPath = url.slice("/vault/".length);
    let path: string;
    try {
      path = decodeVaultPath(rawPath);
    } catch {
      sendError(res, 400, "Malformed percent-encoding in path.");
      return;
    }

    // A trailing slash (or an empty remainder) means a directory listing.
    if (path === "" || path.endsWith("/")) {
      if (method !== "GET") {
        sendError(res, 405, "This request method is valid only for files.");
        return;
      }
      const dir = path.replace(/\/$/, "");
      const entries = listDirectory(files, dir);
      if (entries === null) {
        if (files.has(dir)) {
          sendError(res, 405, "This path references a file, not a directory.");
          return;
        }
        sendError(res, 404, `Directory does not exist: ${dir}`);
        return;
      }
      sendJson(res, 200, { files: entries });
      return;
    }

    handleFile(req, res, method, path, body);
  }

  function handleFile(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
    body: string,
  ): void {
    const exists = files.has(path);

    // The plugin answers 405 when a file-only verb is aimed at a directory.
    // Modeled here because the two backends must agree on "you pointed at a
    // folder", not just on "that is not a file".
    if (!exists && isDirectoryPath(files, path)) {
      sendError(res, 405, "This request method is valid only for files.");
      return;
    }

    switch (method) {
      case "GET": {
        if (!exists) {
          sendError(res, 404, `File does not exist: ${path}`);
          return;
        }
        const content = files.get(path) ?? "";
        if ((req.headers.accept ?? "").includes(NOTE_JSON)) {
          sendJson(res, 200, noteJson(path, content));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/markdown" });
        res.end(content);
        return;
      }

      case "PUT": {
        files.set(path, body);
        res.writeHead(204);
        res.end();
        return;
      }

      case "POST": {
        files.set(path, (files.get(path) ?? "") + body);
        res.writeHead(204);
        res.end();
        return;
      }

      case "PATCH": {
        if (!exists) {
          sendError(res, 404, `File does not exist: ${path}`);
          return;
        }
        const operation = String(req.headers["operation"] ?? "append");
        const targetType = String(req.headers["target-type"] ?? "");
        const rawTarget = String(req.headers["target"] ?? "");
        let target: string;
        try {
          target = decodeURIComponent(rawTarget);
        } catch {
          sendError(res, 400, "Malformed percent-encoding in Target header.");
          return;
        }
        const patched = applyPatch(files.get(path) ?? "", operation, targetType, target, body);
        if (patched === null) {
          sendError(res, 400, `Target not found: ${targetType} "${target}"`);
          return;
        }
        files.set(path, patched);
        res.writeHead(200, { "Content-Type": "text/markdown" });
        res.end(patched);
        return;
      }

      case "DELETE": {
        if (!exists) {
          sendError(res, 404, `File does not exist: ${path}`);
          return;
        }
        files.delete(path);
        res.writeHead(204);
        res.end();
        return;
      }

      case "MOVE": {
        const rawDestination = req.headers["destination"];
        if (typeof rawDestination !== "string" || rawDestination === "") {
          sendError(res, 400, "Missing Destination header.");
          return;
        }
        if (rawDestination.startsWith("/")) {
          sendError(res, 400, "Destination must not escape the vault root.");
          return;
        }
        let destination: string;
        try {
          destination = decodeVaultPath(rawDestination);
        } catch {
          sendError(res, 400, "Malformed percent-encoding in Destination header.");
          return;
        }
        if (!exists) {
          sendError(res, 404, `File does not exist: ${path}`);
          return;
        }
        const allowOverwrite = String(req.headers["allow-overwrite"] ?? "false") === "true";
        if (files.has(destination) && !allowOverwrite) {
          sendError(res, 409, `Destination already exists: ${destination}`);
          return;
        }
        files.set(destination, files.get(path) ?? "");
        files.delete(path);
        res.writeHead(204, { "Content-Location": rawDestination });
        res.end();
        return;
      }

      default: {
        sendError(res, 405, `Method not allowed: ${method}`);
        return;
      }
    }
  }

  return new Promise<Fixture>((resolve, reject) => {
    server.once("error", reject);
    // Port 0: the OS picks a free ephemeral port, so parallel test files
    // never collide.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        requests,
        files,
        close: () =>
          new Promise<void>((done, fail) => {
            // Keep-alive sockets outlive close(); drop them so the promise settles.
            server.closeAllConnections();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
