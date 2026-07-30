import type { FileSystemService } from "../../filesystem.js";
import type { VaultBackend } from "../types.js";
import type { ParsedNote, NoteWriteParams, PatchNoteParams, PatchNoteResult, DeleteNoteParams, DeleteResult, DirectoryListing, MoveNoteParams, MoveFileParams, MoveResult, BatchReadParams, BatchReadResult, UpdateFrontmatterParams, NoteInfo, TagManagementParams, TagManagementResult } from "../../types.js";
/**
 * `VaultBackend` over the local filesystem.
 *
 * An adapter, not a rewrite: every method hands its arguments to the injected
 * `FileSystemService` and returns the result unchanged. No error translation
 * either, so filesystem failures surface exactly as they did before the seam
 * existed. `BackendFailure` is produced only by backends that talk to Obsidian.
 */
export declare class FileSystemBackend implements VaultBackend {
    private readonly fileSystem;
    readonly name: "filesystem";
    constructor(fileSystem: FileSystemService);
    readNote(path: string): Promise<ParsedNote>;
    readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
    getNotesInfo(paths: string[]): Promise<NoteInfo[]>;
    writeNote(params: NoteWriteParams): Promise<void>;
    patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
    deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;
    moveNote(params: MoveNoteParams): Promise<MoveResult>;
    moveFile(params: MoveFileParams): Promise<MoveResult>;
    listDirectory(path: string): Promise<DirectoryListing>;
    /**
     * The only member without a one-to-one service method. It reproduces what the
     * `get_frontmatter` handler already did — read the note, project the
     * frontmatter — so the observable result is byte-identical to before.
     */
    getFrontmatter(path: string): Promise<Record<string, any>>;
    updateFrontmatter(params: UpdateFrontmatterParams): Promise<void>;
    manageTags(params: TagManagementParams): Promise<TagManagementResult>;
    listAllTags(): Promise<Array<{
        tag: string;
        count: number;
    }>>;
}
//# sourceMappingURL=index.d.ts.map