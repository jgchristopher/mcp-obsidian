import { createServer } from "node:http";
import { FrontmatterHandler } from "../../frontmatter.js";
const DEFAULT_COMMANDS = [
    { id: "app:open-vault", name: "Open another vault" },
    { id: "editor:toggle-bold", name: "Toggle bold" },
];
const JSON_LOGIC = "application/vnd.olrapi.jsonlogic+json";
const frontmatter = new FrontmatterHandler();
const NOTE_JSON = "application/vnd.olrapi.note+json";
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
    });
}
function flattenHeaders(req) {
    const out = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined)
            continue;
        out[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return out;
}
function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
}
function sendError(res, status, message) {
    sendJson(res, status, { errorCode: status * 100 + 1, message });
}
/** Decode a percent-encoded vault path one segment at a time. */
function decodeVaultPath(raw) {
    return raw
        .split("/")
        .map((segment) => decodeURIComponent(segment))
        .join("/");
}
/** True when an injector target matches the request URL, encoded or decoded. */
function targets(target, url) {
    if (target === undefined)
        return false;
    if (target === url)
        return true;
    try {
        return decodeURIComponent(url) === target;
    }
    catch {
        return false;
    }
}
function tagsOf(content) {
    const parsed = frontmatter.parse(content);
    const fromFrontmatter = Array.isArray(parsed.frontmatter.tags)
        ? parsed.frontmatter.tags.filter((tag) => typeof tag === "string")
        : typeof parsed.frontmatter.tags === "string"
            ? [parsed.frontmatter.tags]
            : [];
    const inline = (parsed.content.match(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g) ?? []).map((match) => match.trim().slice(1));
    const all = [...fromFrontmatter, ...inline].map((tag) => tag.replace(/^#/, "")).filter(Boolean);
    return [...new Set(all)];
}
/**
 * Directory listing in the plugin's shape: names relative to the directory,
 * with a trailing slash on directories. Built from the file set, so empty
 * directories do not appear — the same quirk the real plugin has, because it
 * lists `app.vault.getFiles()`.
 */
function listDirectory(files, dir) {
    const prefix = dir ? `${dir}/` : "";
    const entries = new Set();
    let matched = false;
    for (const path of files.keys()) {
        if (!path.startsWith(prefix))
            continue;
        matched = true;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf("/");
        entries.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`);
    }
    if (!matched && dir !== "")
        return null;
    return [...entries].sort();
}
/** True when the path names a directory, i.e. some file lives beneath it. */
function isDirectoryPath(files, path) {
    const prefix = `${path}/`;
    for (const key of files.keys())
        if (key.startsWith(prefix))
            return true;
    return false;
}
function noteJson(path, content) {
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
function applyPatch(content, operation, targetType, target, payload) {
    if (targetType === "frontmatter") {
        const parsed = frontmatter.parse(content);
        if (!(target in parsed.frontmatter))
            return null;
        return frontmatter.preserveStringify(parsed.matter ?? "", { [target]: payload }, parsed.content);
    }
    if (targetType !== "heading")
        return null;
    const lines = content.split("\n");
    const headingIndex = lines.findIndex((line) => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, "").trim() === target);
    if (headingIndex === -1)
        return null;
    let end = headingIndex + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end] ?? ""))
        end += 1;
    const before = lines.slice(0, headingIndex + 1);
    const section = lines.slice(headingIndex + 1, end);
    const after = lines.slice(end);
    const replacement = operation === "prepend"
        ? [payload, ...section]
        : operation === "replace"
            ? [payload]
            : [...section, payload];
    return [...before, ...replacement, ...after].join("\n");
}
export function startFixture(opts = {}) {
    const files = new Map(Object.entries(opts.files ?? {}));
    const requests = [];
    const commands = opts.commands ?? DEFAULT_COMMANDS;
    const executedCommands = [];
    const openedFiles = [];
    let failWith = opts.failWith;
    const server = createServer((req, res) => {
        void handle(req, res);
    });
    async function handle(req, res) {
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
            const counts = new Map();
            for (const content of files.values()) {
                const seen = new Set();
                for (const tag of tagsOf(content)) {
                    // Hierarchical tags credit every parent prefix, as Obsidian's sidebar does.
                    const segments = tag.split("/");
                    for (let i = 1; i <= segments.length; i += 1)
                        seen.add(segments.slice(0, i).join("/"));
                }
                for (const tag of seen)
                    counts.set(tag, (counts.get(tag) ?? 0) + 1);
            }
            const tags = [...counts.entries()]
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
            sendJson(res, 200, { tags });
            return;
        }
        if (handleLive(req, res, method, url, body))
            return;
        if (!url.startsWith("/vault/")) {
            sendError(res, 404, `No route for ${method} ${url}`);
            return;
        }
        const rawPath = url.slice("/vault/".length);
        let path;
        try {
            path = decodeVaultPath(rawPath);
        }
        catch {
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
    /**
     * The four endpoints behind `ObsidianLiveService`. Returns true when the
     * request was handled here, so the vault routes below stay untouched.
     */
    function handleLive(req, res, method, url, body) {
        if (url === "/commands/" && method === "GET") {
            sendJson(res, 200, { commands });
            return true;
        }
        if (url.startsWith("/commands/") && method === "POST") {
            let id;
            try {
                id = decodeURIComponent(url.slice("/commands/".length).replace(/\/$/, ""));
            }
            catch {
                sendError(res, 400, "Malformed percent-encoding in command id.");
                return true;
            }
            if (!commands.some((command) => command.id === id)) {
                sendError(res, 404, `Command not found: ${id}`);
                return true;
            }
            executedCommands.push(id);
            res.writeHead(204);
            res.end();
            return true;
        }
        if (url === "/active/" && method === "GET") {
            const active = opts.activeFile;
            if (active === undefined) {
                sendError(res, 404, "File does not exist.");
                return true;
            }
            sendJson(res, 200, noteJson(active, files.get(active) ?? ""));
            return true;
        }
        if (url.startsWith("/open/") && method === "POST") {
            try {
                openedFiles.push(decodeVaultPath(url.slice("/open/".length)));
            }
            catch {
                sendError(res, 400, "Malformed percent-encoding in path.");
                return true;
            }
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("");
            return true;
        }
        if (url === "/search/" && method === "POST") {
            const contentType = String(req.headers["content-type"] ?? "");
            if (!contentType.includes(JSON_LOGIC)) {
                // What the real plugin answers for a Dataview DQL query with the
                // Dataview plugin absent, which is the situation in the target vault.
                sendJson(res, 400, {
                    errorCode: 40012,
                    message: "Invalid Content-Type; Dataview is not enabled in this vault.",
                });
                return true;
            }
            // Not a JsonLogic engine: the fixture proves the verb, headers, and body
            // round-trip. Evaluating the expression would be reimplementing the plugin.
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                sendError(res, 400, "Malformed JsonLogic body.");
                return true;
            }
            sendJson(res, 200, [...files.keys()].sort().map((filename) => ({ filename, result: parsed })));
            return true;
        }
        return false;
    }
    function handleFile(req, res, method, path, body) {
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
                let target;
                try {
                    target = decodeURIComponent(rawTarget);
                }
                catch {
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
                let destination;
                try {
                    destination = decodeVaultPath(rawDestination);
                }
                catch {
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
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        // Port 0: the OS picks a free ephemeral port, so parallel test files
        // never collide.
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({
                port: address.port,
                requests,
                files,
                executedCommands,
                openedFiles,
                close: () => new Promise((done, fail) => {
                    // Keep-alive sockets outlive close(); drop them so the promise settles.
                    server.closeAllConnections();
                    server.close((err) => (err ? fail(err) : done()));
                }),
            });
        });
    });
}
