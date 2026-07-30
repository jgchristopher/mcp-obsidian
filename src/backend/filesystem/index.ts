import type { FileSystemService } from "../../filesystem.js";
import type { VaultBackend } from "../types.js";
import type {
  ParsedNote,
  NoteWriteParams,
  PatchNoteParams,
  PatchNoteResult,
  DeleteNoteParams,
  DeleteResult,
  DirectoryListing,
  MoveNoteParams,
  MoveFileParams,
  MoveResult,
  BatchReadParams,
  BatchReadResult,
  UpdateFrontmatterParams,
  NoteInfo,
  TagManagementParams,
  TagManagementResult,
} from "../../types.js";

/**
 * `VaultBackend` over the local filesystem.
 *
 * An adapter, not a rewrite: every method hands its arguments to the injected
 * `FileSystemService` and returns the result unchanged. No error translation
 * either, so filesystem failures surface exactly as they did before the seam
 * existed. `BackendFailure` is produced only by backends that talk to Obsidian.
 */
export class FileSystemBackend implements VaultBackend {
  readonly name = "filesystem" as const;

  constructor(private readonly fileSystem: FileSystemService) {}

  readNote(path: string): Promise<ParsedNote> {
    return this.fileSystem.readNote(path);
  }

  readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult> {
    return this.fileSystem.readMultipleNotes(params);
  }

  getNotesInfo(paths: string[]): Promise<NoteInfo[]> {
    return this.fileSystem.getNotesInfo(paths);
  }

  writeNote(params: NoteWriteParams): Promise<void> {
    return this.fileSystem.writeNote(params);
  }

  patchNote(params: PatchNoteParams): Promise<PatchNoteResult> {
    return this.fileSystem.patchNote(params);
  }

  deleteNote(params: DeleteNoteParams): Promise<DeleteResult> {
    return this.fileSystem.deleteNote(params);
  }

  moveNote(params: MoveNoteParams): Promise<MoveResult> {
    return this.fileSystem.moveNote(params);
  }

  moveFile(params: MoveFileParams): Promise<MoveResult> {
    return this.fileSystem.moveFile(params);
  }

  listDirectory(path: string): Promise<DirectoryListing> {
    return this.fileSystem.listDirectory(path);
  }

  /**
   * The only member without a one-to-one service method. It reproduces what the
   * `get_frontmatter` handler already did — read the note, project the
   * frontmatter — so the observable result is byte-identical to before.
   */
  async getFrontmatter(path: string): Promise<Record<string, any>> {
    const note = await this.fileSystem.readNote(path);
    return note.frontmatter;
  }

  updateFrontmatter(params: UpdateFrontmatterParams): Promise<void> {
    return this.fileSystem.updateFrontmatter(params);
  }

  manageTags(params: TagManagementParams): Promise<TagManagementResult> {
    return this.fileSystem.manageTags(params);
  }

  listAllTags(): Promise<Array<{ tag: string; count: number }>> {
    return this.fileSystem.listAllTags();
  }
}
