import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { FrontmatterHandler } from "../../frontmatter.js";
import { PathFilter } from "../../pathfilter.js";
import { generateObsidianUri } from "../../uri.js";
import { BackendError } from "../types.js";
import { buildDocumentMap } from "../documentMap.js";
import { loadPeriodicNote } from "../periodic/resolve.js";
import { RestClient } from "./client.js";
import { pluginVersionWarning } from "./config.js";
/**
 * `VaultBackend` over the Obsidian Local REST API.
 *
 * Two rules shape every method here.
 *
 * First, results must be indistinguishable from `FileSystemBackend`'s. Phase
 * 3's contract suite runs the same assertions against both, so any divergence
 * in a returned shape, an error message, or the bytes left in the vault is a
 * test failure there. That is why path normalization, `PathFilter` guards, and
 * frontmatter serialization all reuse the same code the filesystem path uses,
 * and why several operations are read-modify-write rather than a single exotic
 * endpoint (see the notes on `patchNote` and `updateFrontmatter`).
 *
 * Second, only transport failures may reject with a `BackendError`. Any HTTP
 * status is an authoritative answer from Obsidian and gets translated into the
 * same error or result the filesystem produces for that condition.
 */
/** A setup mistake, not a runtime fault: the key is wrong or missing. */
export class RestConfigurationError extends Error {
    constructor(status) {
        super(`Obsidian Local REST API rejected the request with HTTP ${status}. ` +
            `Check that OBSIDIAN_API_KEY matches the key shown in Obsidian's ` +
            `"Local REST API" plugin settings.`);
        this.name = "RestConfigurationError";
    }
}
const NOTE_JSON = "application/vnd.olrapi.note+json";
/** Percent-encode a vault path segment by segment, leaving separators intact. */
function encodeVaultPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
}
export class RestBackend {
    client;
    name = "rest";
    vaultPath;
    pathFilter;
    frontmatter;
    constructor(client, options) {
        this.client = client;
        // `realpathSync`, not just `resolve`: FileSystemService canonicalizes its
        // vault path in the constructor, so on macOS a `/var/folders/...` temp
        // vault becomes `/private/var/folders/...`. Skipping it makes every
        // `obsidianUri` differ from the filesystem backend's, and makes absolute
        // input paths fail to have their vault prefix stripped.
        const resolved = resolvePath(options.vaultPath);
        try {
            this.vaultPath = realpathSync(resolved);
        }
        catch {
            // Vault path does not exist or is inaccessible; lexical resolution stands.
            this.vaultPath = resolved;
        }
        this.pathFilter = options.pathFilter ?? new PathFilter();
        this.frontmatter = options.frontmatterHandler ?? new FrontmatterHandler();
    }
    // ==========================================================================
    // PATHS
    // ==========================================================================
    /**
     * Mirror of `FileSystemService.normalizePath`. Duplicated rather than shared
     * because hoisting it would mean editing `filesystem.ts`, which this phase
     * deliberately leaves untouched; phase 3 is the place to extract it once both
     * callers exist in the tree.
     */
    normalizePath(inputPath) {
        if (!inputPath)
            return "";
        let p = inputPath.trim();
        if (p.startsWith("~/") || p === "~") {
            p = p.replace("~", homedir());
        }
        const normalized = p.replace(/\\/g, "/");
        const vaultPrefix = this.vaultPath.replace(/\\/g, "/");
        if (normalized.startsWith(`${vaultPrefix}/`)) {
            p = normalized.slice(vaultPrefix.length + 1);
        }
        else if (normalized === vaultPrefix) {
            p = "";
        }
        else if (p.startsWith("/")) {
            p = p.slice(1);
        }
        return p;
    }
    /**
     * Stand-in for `FileSystemService.resolvePath`'s traversal guard, message
     * included. The plugin enforces its own vault boundary, but relying on that
     * would make the two backends disagree about what a traversal attempt looks
     * like — and it takes the normalized path, because that is what the
     * filesystem has in hand by the time it resolves.
     *
     * Every call site below sits exactly where `FileSystemService` calls
     * `resolvePath`. The ordering matters: some operations report a traversal by
     * throwing and others fold it into a result object, depending on whether the
     * filesystem happens to resolve before or inside its `try`.
     */
    assertInsideVault(normalizedPath) {
        let depth = 0;
        for (const segment of normalizedPath.split("/")) {
            if (segment === "" || segment === ".")
                continue;
            depth += segment === ".." ? -1 : 1;
            if (depth < 0) {
                throw new Error(`Path traversal not allowed: ${normalizedPath}. Paths must be within the vault directory.`);
            }
        }
    }
    /** Normalize, reject traversal, and return the vault-relative path. */
    prepare(inputPath) {
        const normalized = this.normalizePath(inputPath);
        this.assertInsideVault(normalized);
        return normalized;
    }
    accessDenied(path) {
        return `Access denied: ${path}. This path is restricted (system files like .obsidian, .git, and dotfiles are not accessible).`;
    }
    // ==========================================================================
    // TRANSPORT
    // ==========================================================================
    async request(opts) {
        const res = await this.client.send(opts);
        if (res.status === 401 || res.status === 403) {
            throw new RestConfigurationError(res.status);
        }
        return res;
    }
    /**
     * Errors that must never be folded into a `{ success: false }` result.
     *
     * `BackendError` is how phase 3 decides whether falling back is safe, and a
     * misconfigured key is a startup problem the user has to see. Swallowing
     * either into a message string would silently disable both mechanisms.
     */
    rethrowIfTransport(error) {
        if (error instanceof BackendError || error instanceof RestConfigurationError)
            throw error;
    }
    static detail(res) {
        try {
            const parsed = JSON.parse(res.body);
            if (parsed.message)
                return parsed.message;
        }
        catch {
            // Not the plugin's JSON error envelope; fall through to the raw body.
        }
        return res.body.trim() || `HTTP ${res.status}`;
    }
    /** Fetch a note as the plugin's JSON representation, or throw as the filesystem would. */
    async fetchNote(path) {
        const res = await this.request({
            method: "GET",
            path: `/vault/${encodeVaultPath(path)}`,
            headers: { Accept: NOTE_JSON },
        });
        if (res.status === 404) {
            throw new Error(`File not found: ${path}. Use list_directory to see available files, or check the path spelling.`);
        }
        if (res.status === 405) {
            throw new Error(`Cannot read directory as file: ${path}. Use list_directory tool instead.`);
        }
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Failed to read file: ${path} - ${RestBackend.detail(res)}`);
        }
        return JSON.parse(res.body);
    }
    /** Write a whole file. Every write path funnels through here. */
    async putFile(path, content) {
        const res = await this.request({
            method: "PUT",
            path: `/vault/${encodeVaultPath(path)}`,
            headers: { "Content-Type": "text/markdown" },
            body: content,
        });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Failed to write file: ${path} - ${RestBackend.detail(res)}`);
        }
    }
    /**
     * Read the plugin version from `GET /` and return a warning when it is below
     * the floor. The field is `versions.self`; `manifest.version` is accepted as
     * a fallback in case a future release renames it.
     */
    async checkPluginVersion() {
        const res = await this.request({ method: "GET", path: "/" });
        if (res.status < 200 || res.status >= 300)
            return { version: null, warning: null };
        let version = null;
        try {
            const parsed = JSON.parse(res.body);
            version = parsed.versions?.self ?? parsed.manifest?.version ?? null;
        }
        catch {
            return { version: null, warning: null };
        }
        return { version, warning: pluginVersionWarning(version) };
    }
    // ==========================================================================
    // READS
    // ==========================================================================
    async readNote(inputPath) {
        const path = this.prepare(inputPath);
        if (!this.pathFilter.isAllowed(path)) {
            throw new Error(this.accessDenied(path));
        }
        const note = await this.fetchNote(path);
        // The plugin returns the whole file in `content`, frontmatter block
        // included, so the same parser the filesystem uses produces the same
        // `ParsedNote` — including `matter` and `originalContent`, which the JSON
        // payload does not carry on its own.
        return this.frontmatter.parse(note.content);
    }
    async getFrontmatter(inputPath) {
        const note = await this.readNote(inputPath);
        return note.frontmatter;
    }
    /**
     * Resolution reads `.obsidian/daily-notes.json` off the local disk even on
     * this arm. The plugin's `/periodic/` endpoints only answer for periods the
     * absent `periodic-notes` plugin would provide, and taking the setting from a
     * second source would be exactly the drift `get_periodic_note` exists to
     * avoid. The *read* still routes: it goes through this backend's `readNote`.
     */
    getPeriodicNote(params) {
        return loadPeriodicNote(this, this.vaultPath, params);
    }
    /**
     * Built from the note payload this backend already fetches, so routing the
     * map costs one mapping rather than a second request.
     */
    async getDocumentMap(inputPath) {
        const note = await this.readNote(inputPath);
        return buildDocumentMap(note.content, note.frontmatter);
    }
    async readMultipleNotes(params) {
        const { paths, includeContent = true, includeFrontmatter = true } = params;
        if (paths.length > 10) {
            throw new Error("Maximum 10 files per batch read request");
        }
        const results = await Promise.allSettled(paths.map(async (rawPath) => {
            const path = this.normalizePath(rawPath);
            if (!this.pathFilter.isAllowed(path)) {
                throw new Error(this.accessDenied(path));
            }
            // `readNote` applies the traversal guard, which is where the filesystem
            // applies it too — inside the settled promise, so it lands in `failed`.
            const note = await this.readNote(path);
            const result = {
                path,
                obsidianUri: generateObsidianUri(this.vaultPath, path),
            };
            if (includeFrontmatter)
                result.frontmatter = note.frontmatter;
            if (includeContent)
                result.content = note.content;
            return result;
        }));
        const successful = [];
        const failed = [];
        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                successful.push(result.value);
            }
            else {
                failed.push({
                    path: paths[index] || "",
                    error: result.reason instanceof Error ? result.reason.message : "Unknown error",
                });
            }
        });
        return { successful, failed };
    }
    async getNotesInfo(paths) {
        const results = await Promise.allSettled(paths.map(async (rawPath) => {
            const path = this.normalizePath(rawPath);
            if (!this.pathFilter.isAllowed(path)) {
                throw new Error(this.accessDenied(path));
            }
            this.assertInsideVault(path);
            // One request covers size, mtime, and the frontmatter check: the note
            // payload carries `stat` alongside the content.
            const note = await this.fetchNote(path);
            return {
                path,
                size: note.stat.size,
                modified: note.stat.mtime,
                hasFrontmatter: note.content.slice(0, 100).startsWith("---\n"),
                obsidianUri: generateObsidianUri(this.vaultPath, path),
            };
        }));
        return results
            .filter((result) => result.status === "fulfilled")
            .map((result) => result.value);
    }
    async listDirectory(inputPath = "") {
        const path = inputPath === "." ? "" : this.prepare(inputPath);
        const dir = path.replace(/\/+$/, "");
        const encoded = dir ? `${encodeVaultPath(dir)}/` : "";
        const res = await this.request({ method: "GET", path: `/vault/${encoded}` });
        if (res.status === 404) {
            throw new Error(`Directory not found: ${inputPath}. Use list_directory with no path or '/' to see root folders.`);
        }
        if (res.status === 405) {
            throw new Error(`Not a directory: ${inputPath}. This path points to a file, not a folder. Use read_note to read files.`);
        }
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Failed to list directory: ${inputPath} - ${RestBackend.detail(res)}`);
        }
        const payload = JSON.parse(res.body);
        const files = [];
        const directories = [];
        for (const entry of payload.files ?? []) {
            const isDirectory = entry.endsWith("/");
            const name = isDirectory ? entry.slice(0, -1) : entry;
            const entryPath = dir ? `${dir}/${name}` : name;
            if (!this.pathFilter.isAllowedForListing(entryPath))
                continue;
            (isDirectory ? directories : files).push(name);
        }
        return { files: files.sort(), directories: directories.sort() };
    }
    async listAllTags() {
        const res = await this.request({ method: "GET", path: "/tags/" });
        if (res.status < 200 || res.status >= 300) {
            throw new Error(`Failed to list tags - ${RestBackend.detail(res)}`);
        }
        /**
         * The counts come from Obsidian's own index rather than a vault walk, which
         * is the single-call win that justifies routing this tool at all. They are
         * not identical to the filesystem's: the plugin counts files per tag and
         * credits every parent of a hierarchical tag, while the walk counts raw
         * occurrences. Same shape, same ordering, different arithmetic — an
         * accepted difference, not a bug to paper over.
         */
        const payload = JSON.parse(res.body);
        const counts = new Map();
        for (const entry of payload.tags ?? []) {
            if (!entry.name)
                continue;
            // Lowercase and re-aggregate to match the filesystem walk, which
            // normalizes case before counting.
            const tag = entry.name.toLowerCase();
            counts.set(tag, (counts.get(tag) ?? 0) + (entry.count ?? 0));
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }
    // ==========================================================================
    // WRITES
    // ==========================================================================
    async writeNote(params) {
        const { content, frontmatter, mode = "overwrite" } = params;
        const path = this.prepare(params.path);
        if (!this.pathFilter.isAllowed(path)) {
            throw new Error(this.accessDenied(path));
        }
        if (content === undefined || content === null) {
            throw new Error(`Content is required for writing a note: ${path}. The content parameter must be a string.`);
        }
        if (frontmatter) {
            const validation = this.frontmatter.validate(frontmatter);
            if (!validation.isValid) {
                throw new Error(`Invalid frontmatter: ${validation.errors.join(", ")}`);
            }
        }
        const fresh = () => frontmatter ? this.frontmatter.stringify(frontmatter, content) : content;
        if (mode === "overwrite") {
            await this.putFile(path, fresh());
            return;
        }
        /**
         * `append` has a REST equivalent (`POST /vault/{path}`) and `prepend` has
         * none, but neither is used: the filesystem backend merges frontmatter and
         * splices the *body*, and `POST` appends to the raw file. Read-then-PUT
         * with the shared `FrontmatterHandler` is the only way both backends leave
         * identical bytes behind. The cost is that neither mode is atomic here; a
         * concurrent edit inside the read-write window is lost.
         */
        let existing;
        try {
            existing = await this.readNote(path);
        }
        catch (error) {
            this.rethrowIfTransport(error);
            // The note does not exist yet, so append and prepend degrade to a write.
        }
        if (!existing) {
            await this.putFile(path, fresh());
            return;
        }
        const mergedContent = mode === "append" ? existing.content + content : content + existing.content;
        const finalContent = existing.matter && existing.matter.trim() !== ""
            ? this.frontmatter.preserveStringify(existing.matter, frontmatter || {}, mergedContent)
            : this.frontmatter.stringify(frontmatter ? { ...existing.frontmatter, ...frontmatter } : existing.frontmatter, mergedContent);
        await this.putFile(path, finalContent);
    }
    /**
     * Find-and-replace over the whole file.
     *
     * `PATCH /vault/{path}` cannot express this: it targets a heading, block, or
     * frontmatter field, and has no notion of an occurrence count or of failing
     * when a string matches twice. Those are exactly the semantics `patch_note`
     * promises, so this is read-modify-write against the same endpoints the rest
     * of the backend uses.
     */
    async patchNote(params) {
        const { oldString, newString, replaceAll = false } = params;
        // No traversal check here: the filesystem only resolves inside its `try`,
        // via `readNote`, so a traversal attempt comes back as a failed result
        // rather than a thrown error.
        const path = this.normalizePath(params.path);
        if (!this.pathFilter.isAllowed(path)) {
            return { success: false, path, message: this.accessDenied(path) };
        }
        if (!oldString || oldString.trim() === "") {
            return { success: false, path, message: "oldString cannot be empty" };
        }
        if (newString === undefined || newString === null) {
            return { success: false, path, message: "newString is required" };
        }
        if (oldString === newString) {
            return { success: false, path, message: "oldString and newString must be different" };
        }
        try {
            const note = await this.readNote(path);
            const fullContent = note.originalContent;
            const occurrences = fullContent.split(oldString).length - 1;
            if (occurrences === 0) {
                return {
                    success: false,
                    path,
                    message: `String not found in note: "${oldString.substring(0, 50)}${oldString.length > 50 ? "..." : ""}"`,
                    matchCount: 0,
                };
            }
            if (!replaceAll && occurrences > 1) {
                return {
                    success: false,
                    path,
                    message: `Found ${occurrences} occurrences of the string. Use replaceAll=true to replace all occurrences, or provide a more specific string to match exactly one occurrence.`,
                    matchCount: occurrences,
                };
            }
            // A replacer function, so `$&`, `$'` and friends in newString are
            // inserted literally rather than expanded.
            const updatedContent = replaceAll
                ? fullContent.split(oldString).join(newString)
                : fullContent.replace(oldString, () => newString);
            await this.putFile(path, updatedContent);
            return {
                success: true,
                path,
                message: `Successfully replaced ${replaceAll ? occurrences : 1} occurrence${occurrences > 1 ? "s" : ""}`,
                matchCount: occurrences,
            };
        }
        catch (error) {
            this.rethrowIfTransport(error);
            return {
                success: false,
                path,
                message: `Failed to patch note: ${error instanceof Error ? error.message : "Unknown error"}`,
            };
        }
    }
    async deleteNote(params) {
        const { trashMode = "none" } = params;
        const path = this.normalizePath(params.path);
        const confirmPath = this.normalizePath(params.confirmPath);
        // The confirmation check runs before the filesystem resolves anything, so a
        // mismatched pair is cancelled even when the path would also be rejected.
        if (path !== confirmPath) {
            return {
                success: false,
                path,
                message: "Deletion cancelled: confirmation path does not match. For safety, both 'path' and 'confirmPath' must be identical.",
            };
        }
        this.assertInsideVault(path);
        if (!this.pathFilter.isAllowed(path)) {
            return { success: false, path, message: this.accessDenied(path) };
        }
        if (trashMode !== "none") {
            // The plugin deletes outright; there is no trash-aware endpoint. Rather
            // than silently ignoring the caller's recovery request, declare the
            // operation unsupported so routing hands it to the filesystem.
            throw new BackendError({ kind: "unsupported", operation: `deleteNote(trashMode: ${trashMode})` }, `The Local REST API cannot delete to ${trashMode} trash.`);
        }
        const res = await this.request({
            method: "DELETE",
            path: `/vault/${encodeVaultPath(path)}`,
        });
        if (res.status === 404) {
            return {
                success: false,
                path,
                message: `File not found: ${path}. Use list_directory to see available files.`,
            };
        }
        if (res.status === 405) {
            return { success: false, path, message: `Cannot delete: ${path} is not a file` };
        }
        if (res.status < 200 || res.status >= 300) {
            return {
                success: false,
                path,
                message: `Failed to delete file: ${path} - ${RestBackend.detail(res)}`,
            };
        }
        return {
            success: true,
            path,
            message: `Successfully deleted note: ${path}. This action cannot be undone.`,
        };
    }
    async moveNote(params) {
        const { overwrite = false } = params;
        const oldPath = this.normalizePath(params.oldPath);
        const newPath = this.normalizePath(params.newPath);
        for (const candidate of [oldPath, newPath]) {
            if (!this.pathFilter.isAllowed(candidate)) {
                return { success: false, oldPath, newPath, message: this.accessDenied(candidate) };
            }
        }
        this.assertInsideVault(oldPath);
        this.assertInsideVault(newPath);
        return this.move(oldPath, newPath, overwrite, "note");
    }
    async moveFile(params) {
        const { overwrite = false } = params;
        const oldPath = this.normalizePath(params.oldPath);
        const newPath = this.normalizePath(params.newPath);
        const confirmOldPath = this.normalizePath(params.confirmOldPath);
        const confirmNewPath = this.normalizePath(params.confirmNewPath);
        if (oldPath !== confirmOldPath || newPath !== confirmNewPath) {
            return {
                success: false,
                oldPath,
                newPath,
                message: "Move cancelled: confirmation paths do not match. For safety, oldPath must equal confirmOldPath and newPath must equal confirmNewPath.",
            };
        }
        for (const candidate of [oldPath, newPath]) {
            if (!this.pathFilter.isAllowedForListing(candidate)) {
                return { success: false, oldPath, newPath, message: this.accessDenied(candidate) };
            }
        }
        this.assertInsideVault(oldPath);
        this.assertInsideVault(newPath);
        return this.move(oldPath, newPath, overwrite, "file");
    }
    /**
     * `MOVE /vault/{path}` with a `Destination` header. This is the one operation
     * REST does strictly better than the filesystem: the plugin preserves file
     * history and rewrites inbound links, which a rename cannot.
     *
     * The path and the header are percent-encoded separately — the OpenAPI
     * document calls that out explicitly for both.
     */
    async move(oldPath, newPath, overwrite, kind) {
        try {
            const res = await this.request({
                method: "MOVE",
                path: `/vault/${encodeVaultPath(oldPath)}`,
                headers: {
                    Destination: encodeVaultPath(newPath),
                    "Allow-Overwrite": overwrite ? "true" : "false",
                },
            });
            if (res.status === 404) {
                return {
                    success: false,
                    oldPath,
                    newPath,
                    message: `Source file not found: ${oldPath}. Use list_directory to see available files.`,
                };
            }
            if (res.status === 409) {
                return {
                    success: false,
                    oldPath,
                    newPath,
                    message: `Target file already exists: ${newPath}. Use overwrite=true to replace it.`,
                };
            }
            if (res.status === 405) {
                return {
                    success: false,
                    oldPath,
                    newPath,
                    message: kind === "file"
                        ? `Source path is a directory: ${oldPath}. move_file currently supports files only.`
                        : `Failed to move note: ${RestBackend.detail(res)}`,
                };
            }
            if (res.status < 200 || res.status >= 300) {
                return {
                    success: false,
                    oldPath,
                    newPath,
                    message: `Failed to move ${kind}: ${RestBackend.detail(res)}`,
                };
            }
            return {
                success: true,
                oldPath,
                newPath,
                message: `Successfully moved ${kind} from ${oldPath} to ${newPath}`,
            };
        }
        catch (error) {
            this.rethrowIfTransport(error);
            return {
                success: false,
                oldPath,
                newPath,
                message: `Failed to move ${kind}: ${error instanceof Error ? error.message : "Unknown error"}`,
            };
        }
    }
    /**
     * `PATCH` with `Target-Type: frontmatter` sets one field per request and
     * cannot remove a field, so `merge: false` and multi-key updates are
     * inexpressible — and a multi-request update is not atomic either. Read,
     * merge with the shared handler, write back.
     */
    async updateFrontmatter(params) {
        const { frontmatter, merge = true } = params;
        // Access is checked before the path resolves, matching the filesystem: a
        // restricted path reports "access denied" even when it also traverses.
        const path = this.normalizePath(params.path);
        if (!this.pathFilter.isAllowed(path)) {
            throw new Error(this.accessDenied(path));
        }
        const note = await this.readNote(path);
        const newFrontmatter = merge ? { ...note.frontmatter, ...frontmatter } : frontmatter;
        const validation = this.frontmatter.validate(newFrontmatter);
        if (!validation.isValid) {
            throw new Error(`Invalid frontmatter: ${validation.errors.join(", ")}`);
        }
        if (merge && note.matter && note.matter.trim() !== "") {
            // Preserve raw formatting for fields the caller did not touch.
            await this.putFile(path, this.frontmatter.preserveStringify(note.matter, frontmatter, note.content));
            return;
        }
        await this.writeNote({ path, content: note.content, frontmatter: newFrontmatter });
    }
    /**
     * `GET /tags/` reports vault-wide counts but there is no per-note tag write
     * endpoint, so tag edits are read-modify-write through the note itself —
     * which is what the filesystem backend does too.
     */
    async manageTags(params) {
        const { operation, tags = [] } = params;
        // Traversal surfaces through `readNote` inside the try below, as a message
        // rather than a throw — again matching where the filesystem resolves.
        const path = this.normalizePath(params.path);
        if (!this.pathFilter.isAllowed(path)) {
            return {
                path,
                operation,
                tags: [],
                success: false,
                message: this.accessDenied(path),
            };
        }
        try {
            const note = await this.readNote(path);
            let currentTags = [];
            if (note.frontmatter.tags) {
                if (Array.isArray(note.frontmatter.tags)) {
                    currentTags = note.frontmatter.tags;
                }
                else if (typeof note.frontmatter.tags === "string") {
                    currentTags = [note.frontmatter.tags];
                }
            }
            const inlineTags = (note.content.match(/#[a-zA-Z0-9_-]+/g) ?? []).map((tag) => tag.slice(1));
            currentTags = [...new Set([...currentTags, ...inlineTags])];
            if (operation === "list") {
                return { path, operation, tags: currentTags, success: true };
            }
            let newTags = [...currentTags];
            if (operation === "add") {
                for (const tag of tags) {
                    if (!newTags.includes(tag))
                        newTags.push(tag);
                }
            }
            else if (operation === "remove") {
                newTags = newTags.filter((tag) => !tags.includes(tag));
            }
            const tagUpdates = { tags: newTags.length > 0 ? newTags : undefined };
            let updatedContent;
            if (note.matter && note.matter.trim() !== "") {
                updatedContent = this.frontmatter.preserveStringify(note.matter, tagUpdates, note.content);
            }
            else {
                const updatedFrontmatter = { ...note.frontmatter };
                if (newTags.length > 0) {
                    updatedFrontmatter.tags = newTags;
                }
                else {
                    delete updatedFrontmatter.tags;
                }
                updatedContent = this.frontmatter.stringify(updatedFrontmatter, note.content);
            }
            await this.putFile(path, updatedContent);
            return {
                path,
                operation,
                tags: newTags,
                success: true,
                message: `Successfully ${operation === "add" ? "added" : "removed"} tags`,
            };
        }
        catch (error) {
            this.rethrowIfTransport(error);
            return {
                path,
                operation,
                tags: [],
                success: false,
                message: error instanceof Error ? error.message : "Unknown error",
            };
        }
    }
}
