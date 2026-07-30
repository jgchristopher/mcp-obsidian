import type { ParsedNote, NoteWriteParams, PatchNoteParams, PatchNoteResult, DeleteNoteParams, DeleteResult, DirectoryListing, MoveNoteParams, MoveFileParams, MoveResult, BatchReadParams, BatchReadResult, UpdateFrontmatterParams, NoteInfo, TagManagementParams, TagManagementResult } from "../types.js";
import type { DocumentMap } from "./documentMap.js";
import type { PeriodicNoteParams, PeriodicNoteResult } from "./periodic/resolve.js";
export type { PeriodicNoteParams, PeriodicNoteResult, PeriodicPeriod } from "./periodic/resolve.js";
/**
 * How a backend failed, classified by what the routing policy needs to decide:
 * whether falling back to another backend is safe for the operation at hand.
 */
export type BackendFailure = 
/** Request provably never reached Obsidian. Safe to fall back for any operation. */
{
    kind: "never-sent";
    cause: Error;
}
/** Request may have been received and applied. Reads may fall back; writes must not. */
 | {
    kind: "unknown-state";
    cause: Error;
}
/** This backend cannot serve this operation at all. */
 | {
    kind: "unsupported";
    operation: string;
};
export declare class BackendError extends Error {
    readonly failure: BackendFailure;
    constructor(failure: BackendFailure, message: string);
}
/**
 * The vault operations that can be served by more than one backend.
 *
 * Deliberately excludes `search_notes`, `get_vault_stats`, and `wiki_link`:
 * those stay wired straight to their services, so no backend has to prove
 * anything about them.
 *
 * Return types mirror `FileSystemService` exactly. The filesystem behavior is
 * the contract every other backend has to match, so any backend-specific shape
 * here would be a shape the filesystem arm could not satisfy without changing
 * observable behavior.
 */
export interface VaultBackend {
    readonly name: "filesystem" | "rest";
    readNote(path: string): Promise<ParsedNote>;
    readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
    getNotesInfo(paths: string[]): Promise<NoteInfo[]>;
    writeNote(params: NoteWriteParams): Promise<void>;
    patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
    deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;
    moveNote(params: MoveNoteParams): Promise<MoveResult>;
    moveFile(params: MoveFileParams): Promise<MoveResult>;
    listDirectory(path: string): Promise<DirectoryListing>;
    getFrontmatter(path: string): Promise<Record<string, any>>;
    updateFrontmatter(params: UpdateFrontmatterParams): Promise<void>;
    manageTags(params: TagManagementParams): Promise<TagManagementResult>;
    listAllTags(): Promise<Array<{
        tag: string;
        count: number;
    }>>;
    /**
     * Resolve a period to a vault-relative path and read it.
     *
     * Routed because the read is a read: whichever backend is serving `readNote`
     * should serve this too. The path itself is always derived from Obsidian's own
     * `.obsidian/daily-notes.json` on local disk, on both arms — the plugin's
     * `/periodic/` endpoints cover only what the absent `periodic-notes` plugin
     * would provide, and a second source of truth is how the two drift apart.
     */
    getPeriodicNote(params: PeriodicNoteParams): Promise<PeriodicNoteResult>;
    /** Headings, block references, and frontmatter keys for one note. */
    getDocumentMap(path: string): Promise<DocumentMap>;
}
//# sourceMappingURL=types.d.ts.map