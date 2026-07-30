import { BackendError } from "./types.js";
/**
 * Serves every routed operation from REST when REST is usable, and from the
 * filesystem otherwise — with a different fallback rule for reads than writes.
 *
 * The asymmetry is the entire point. A read served twice is free; a write
 * served twice appends the same block to a note twice. So a failure that leaves
 * the outcome unknown falls back for reads and refuses for writes.
 *
 * What never reaches this class: HTTP statuses. `RestClient` resolves on any
 * status, so 404, 400, and 500 arrive as ordinary results or translated errors.
 * A 404 is Obsidian saying the note does not exist — retrying against the
 * filesystem would be redundant at best and, against a mismatched vault,
 * actively wrong.
 */
/**
 * Operations that may be re-attempted against the filesystem after an
 * `unknown-state` failure. Everything absent from this set is treated as a
 * write, which is the conservative side: an operation added to `VaultBackend`
 * and forgotten here loses fallback rather than gaining a duplicate write.
 */
export const READ_OPERATIONS = new Set([
    "readNote",
    "readMultipleNotes",
    "getNotesInfo",
    "listDirectory",
    "getFrontmatter",
    "listAllTags",
    "getPeriodicNote",
    "getDocumentMap",
]);
export class RoutingBackend {
    rest;
    filesystem;
    health;
    name = "rest";
    constructor(rest, filesystem, health) {
        this.rest = rest;
        this.filesystem = filesystem;
        this.health = health;
    }
    /**
     * @param operation  `VaultBackend` method name; decides read vs write.
     * @param target     What the call touches, for the unknown-state message.
     */
    async route(operation, target, call) {
        if (!(await this.health.restUsable()))
            return call(this.filesystem);
        try {
            return await call(this.rest);
        }
        catch (error) {
            // Only classified transport failures participate in fallback. An
            // ordinary Error is Obsidian's authoritative answer, translated.
            if (!(error instanceof BackendError))
                throw error;
            const { failure } = error;
            if (failure.kind === "never-sent") {
                // Provably nothing was applied, so re-running is safe for anything.
                this.health.markUnreachable();
                return call(this.filesystem);
            }
            if (failure.kind === "unknown-state") {
                this.health.markUnreachable();
                if (READ_OPERATIONS.has(operation))
                    return call(this.filesystem);
                // The only user-facing safety net for the duplicate-write hazard.
                // It has to say what happened and what to check.
                throw new Error(`Write '${operation}'${target ? ` on ${target}` : ""} failed with unknown state: ` +
                    `Obsidian became unreachable after the request was sent. The change may or may ` +
                    `not have been applied. Verify the note before retrying. ` +
                    `Cause: ${failure.cause.message}`);
            }
            if (failure.kind === "unsupported") {
                // Declared before anything left the process, so nothing was applied.
                return call(this.filesystem);
            }
            throw error;
        }
    }
    // ==========================================================================
    // READS
    // ==========================================================================
    readNote(path) {
        return this.route("readNote", path, (backend) => backend.readNote(path));
    }
    readMultipleNotes(params) {
        return this.route("readMultipleNotes", params.paths.join(", "), (backend) => backend.readMultipleNotes(params));
    }
    getNotesInfo(paths) {
        return this.route("getNotesInfo", paths.join(", "), (backend) => backend.getNotesInfo(paths));
    }
    listDirectory(path) {
        return this.route("listDirectory", path, (backend) => backend.listDirectory(path));
    }
    getFrontmatter(path) {
        return this.route("getFrontmatter", path, (backend) => backend.getFrontmatter(path));
    }
    listAllTags() {
        return this.route("listAllTags", undefined, (backend) => backend.listAllTags());
    }
    getPeriodicNote(params) {
        return this.route("getPeriodicNote", params.period, (backend) => backend.getPeriodicNote(params));
    }
    getDocumentMap(path) {
        return this.route("getDocumentMap", path, (backend) => backend.getDocumentMap(path));
    }
    // ==========================================================================
    // WRITES
    // ==========================================================================
    writeNote(params) {
        return this.route("writeNote", params.path, (backend) => backend.writeNote(params));
    }
    patchNote(params) {
        return this.route("patchNote", params.path, (backend) => backend.patchNote(params));
    }
    deleteNote(params) {
        return this.route("deleteNote", params.path, (backend) => backend.deleteNote(params));
    }
    moveNote(params) {
        return this.route("moveNote", `${params.oldPath} -> ${params.newPath}`, (backend) => backend.moveNote(params));
    }
    moveFile(params) {
        return this.route("moveFile", `${params.oldPath} -> ${params.newPath}`, (backend) => backend.moveFile(params));
    }
    updateFrontmatter(params) {
        return this.route("updateFrontmatter", params.path, (backend) => backend.updateFrontmatter(params));
    }
    manageTags(params) {
        return this.route("manageTags", params.path, (backend) => backend.manageTags(params));
    }
}
