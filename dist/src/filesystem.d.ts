import { FrontmatterHandler } from './frontmatter.js';
import { PathFilter } from './pathfilter.js';
import type { ParsedNote, DirectoryListing, NoteWriteParams, DeleteNoteParams, DeleteResult, MoveNoteParams, MoveFileParams, MoveResult, BatchReadParams, BatchReadResult, UpdateFrontmatterParams, NoteInfo, TagManagementParams, TagManagementResult, PatchNoteParams, PatchNoteResult, VaultStats } from './types.js';
/**
 * Map a filesystem write failure to a clear, accurate Error.
 *
 * Classifies by the Node error `code`, NOT by message substring. The old
 * substring matching (`message.includes('space')`) mislabeled any error whose
 * message merely contained "space" as a disk-full error, producing false
 * "No space left on device" reports (#109). Errors we threw ourselves with a
 * meaningful message (no `code`) pass through unchanged.
 */
export declare function classifyWriteError(error: unknown, path: string): Error;
/** `get_recent_changes` defaults, mirroring the Python tool's parameters. */
export declare const RECENT_CHANGES_DEFAULT_LIMIT = 10;
export declare const RECENT_CHANGES_MAX_LIMIT = 100;
export declare const RECENT_CHANGES_DEFAULT_DAYS = 90;
/** Whole number within [min, max], falling back to `fallback` when unusable. */
export declare function clamp(raw: unknown, fallback: number, min: number, max: number): number;
export declare class FileSystemService {
    private vaultPath;
    private frontmatterHandler;
    private pathFilter;
    constructor(vaultPath: string, pathFilter?: PathFilter, frontmatterHandler?: FrontmatterHandler);
    /**
     * The canonical (realpath'd) vault root.
     *
     * Read-only, and exposed only because the periodic-note resolver has to read
     * `.obsidian/daily-notes.json` outside this service — see
     * `src/backend/periodic/config.ts` for why that read bypasses `PathFilter`.
     */
    get vaultRoot(): string;
    /**
     * Normalize an incoming path to be vault-relative. Strips leading slashes
     * and the vault path prefix when a caller accidentally passes an absolute path
     * (e.g. "/Users/me/vault/wiki/note.md" instead of "wiki/note.md").
     */
    private normalizePath;
    private resolvePath;
    readNote(path: string): Promise<ParsedNote>;
    writeNote(params: NoteWriteParams): Promise<void>;
    patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
    listDirectory(path?: string): Promise<DirectoryListing>;
    exists(path: string): Promise<boolean>;
    isDirectory(path: string): Promise<boolean>;
    deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;
    moveNote(params: MoveNoteParams): Promise<MoveResult>;
    moveFile(params: MoveFileParams): Promise<MoveResult>;
    readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
    updateFrontmatter(params: UpdateFrontmatterParams): Promise<void>;
    getNotesInfo(paths: string[]): Promise<NoteInfo[]>;
    manageTags(params: TagManagementParams): Promise<TagManagementResult>;
    getVaultPath(): string;
    /**
     * Resolve an Obsidian wiki link name to its vault-relative paths.
     * Scans the vault for exact filename matches (name + .md).
     *
     * A name containing `/` is path-qualified (Obsidian emits these when a
     * basename is ambiguous, e.g. [[folder/Note]]): it must match the full
     * vault-relative path instead of just the basename.
     *
     * Returns all matches sorted root-first (by path depth ascending), with
     * alphabetical tiebreak at equal depth. Empty array on zero matches.
     * The caller decides how to handle zero/single/multi — this function does
     * not throw on lookup outcomes.
     *
     * Throws only on caller misuse (empty name).
     */
    findPathForWikiLink(wikiLinkName: string): Promise<string[]>;
    /**
     * One vault walk, shared by `getVaultStats` and `getRecentChanges`.
     *
     * Extracted rather than copied: a second traversal with its own
     * `PathFilter` calls would drift from this one, and two tools reporting
     * different answers about the same vault is worse than either being slow.
     *
     * `recentLimit` bounds the retained list as the walk proceeds, so a large
     * vault never materializes an array of every file just to keep the top ten.
     */
    private scanVault;
    getVaultStats(recentCount?: number): Promise<VaultStats>;
    /**
     * Files modified within the last `days`, newest first.
     *
     * Filesystem-native, never routed. The Python server implements the same tool
     * as a Dataview DQL query, and Dataview is not installed in the target vault,
     * so `obsidian_get_recent_changes` returns HTTP 400 there today. A vault walk
     * needs no plugin and keeps working with Obsidian closed.
     *
     * `limit` is capped hard: the caller is a language model, and an unbounded
     * list of a large vault's files is an oversized response, not a useful answer.
     */
    getRecentChanges(options?: {
        limit?: number;
        days?: number;
    }): Promise<Array<{
        path: string;
        modified: number;
    }>>;
    listAllTags(): Promise<Array<{
        tag: string;
        count: number;
    }>>;
}
//# sourceMappingURL=filesystem.d.ts.map