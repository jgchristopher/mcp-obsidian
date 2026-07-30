import { buildDocumentMap } from "../documentMap.js";
import { loadPeriodicNote } from "../periodic/resolve.js";
/**
 * `VaultBackend` over the local filesystem.
 *
 * An adapter, not a rewrite: every method hands its arguments to the injected
 * `FileSystemService` and returns the result unchanged. No error translation
 * either, so filesystem failures surface exactly as they did before the seam
 * existed. `BackendFailure` is produced only by backends that talk to Obsidian.
 */
export class FileSystemBackend {
    fileSystem;
    name = "filesystem";
    constructor(fileSystem) {
        this.fileSystem = fileSystem;
    }
    readNote(path) {
        return this.fileSystem.readNote(path);
    }
    readMultipleNotes(params) {
        return this.fileSystem.readMultipleNotes(params);
    }
    getNotesInfo(paths) {
        return this.fileSystem.getNotesInfo(paths);
    }
    writeNote(params) {
        return this.fileSystem.writeNote(params);
    }
    patchNote(params) {
        return this.fileSystem.patchNote(params);
    }
    deleteNote(params) {
        return this.fileSystem.deleteNote(params);
    }
    moveNote(params) {
        return this.fileSystem.moveNote(params);
    }
    moveFile(params) {
        return this.fileSystem.moveFile(params);
    }
    listDirectory(path) {
        return this.fileSystem.listDirectory(path);
    }
    /**
     * The only member without a one-to-one service method. It reproduces what the
     * `get_frontmatter` handler already did — read the note, project the
     * frontmatter — so the observable result is byte-identical to before.
     */
    async getFrontmatter(path) {
        const note = await this.fileSystem.readNote(path);
        return note.frontmatter;
    }
    updateFrontmatter(params) {
        return this.fileSystem.updateFrontmatter(params);
    }
    manageTags(params) {
        return this.fileSystem.manageTags(params);
    }
    listAllTags() {
        return this.fileSystem.listAllTags();
    }
    /**
     * Both new members delegate to the same shared functions the REST arm calls,
     * over content this backend already has. Sharing the implementation is what
     * makes the contract suite's "identical output" assertion true by
     * construction rather than by two parallel implementations agreeing today.
     */
    getPeriodicNote(params) {
        return loadPeriodicNote(this, this.fileSystem.vaultRoot, params);
    }
    async getDocumentMap(path) {
        const note = await this.fileSystem.readNote(path);
        return buildDocumentMap(note.content, note.frontmatter);
    }
}
