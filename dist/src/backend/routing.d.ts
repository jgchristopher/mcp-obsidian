import type { VaultBackend } from "./types.js";
import type { DocumentMap } from "./documentMap.js";
import type { PeriodicNoteParams, PeriodicNoteResult } from "./periodic/resolve.js";
import type { HealthGate } from "./health.js";
import type { BatchReadParams, BatchReadResult, DeleteNoteParams, DeleteResult, DirectoryListing, MoveFileParams, MoveNoteParams, MoveResult, NoteInfo, NoteWriteParams, ParsedNote, PatchNoteParams, PatchNoteResult, TagManagementParams, TagManagementResult, UpdateFrontmatterParams } from "../types.js";
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
export declare const READ_OPERATIONS: ReadonlySet<string>;
export declare class RoutingBackend implements VaultBackend {
    private readonly rest;
    private readonly filesystem;
    private readonly health;
    readonly name: "rest";
    constructor(rest: VaultBackend, filesystem: VaultBackend, health: HealthGate);
    /**
     * @param operation  `VaultBackend` method name; decides read vs write.
     * @param target     What the call touches, for the unknown-state message.
     */
    private route;
    readNote(path: string): Promise<ParsedNote>;
    readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
    getNotesInfo(paths: string[]): Promise<NoteInfo[]>;
    listDirectory(path: string): Promise<DirectoryListing>;
    getFrontmatter(path: string): Promise<Record<string, any>>;
    listAllTags(): Promise<Array<{
        tag: string;
        count: number;
    }>>;
    getPeriodicNote(params: PeriodicNoteParams): Promise<PeriodicNoteResult>;
    getDocumentMap(path: string): Promise<DocumentMap>;
    writeNote(params: NoteWriteParams): Promise<void>;
    patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
    deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;
    moveNote(params: MoveNoteParams): Promise<MoveResult>;
    moveFile(params: MoveFileParams): Promise<MoveResult>;
    updateFrontmatter(params: UpdateFrontmatterParams): Promise<void>;
    manageTags(params: TagManagementParams): Promise<TagManagementResult>;
}
//# sourceMappingURL=routing.d.ts.map