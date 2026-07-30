import { FrontmatterHandler } from "../../frontmatter.js";
import { PathFilter } from "../../pathfilter.js";
import type { VaultBackend } from "../types.js";
import type { DocumentMap } from "../documentMap.js";
import type { PeriodicNoteParams, PeriodicNoteResult } from "../periodic/resolve.js";
import { RestClient } from "./client.js";
import type { BatchReadParams, BatchReadResult, DeleteNoteParams, DeleteResult, DirectoryListing, MoveFileParams, MoveNoteParams, MoveResult, NoteInfo, NoteWriteParams, ParsedNote, PatchNoteParams, PatchNoteResult, TagManagementParams, TagManagementResult, UpdateFrontmatterParams } from "../../types.js";
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
export declare class RestConfigurationError extends Error {
    constructor(status: number);
}
export interface RestBackendOptions {
    /**
     * Absolute vault root. Needed for two things the REST API cannot supply:
     * `obsidianUri` values, and normalizing an absolute path a caller passed by
     * mistake back to a vault-relative one.
     */
    vaultPath: string;
    pathFilter?: PathFilter;
    frontmatterHandler?: FrontmatterHandler;
}
export declare class RestBackend implements VaultBackend {
    private readonly client;
    readonly name: "rest";
    private readonly vaultPath;
    private readonly pathFilter;
    private readonly frontmatter;
    constructor(client: RestClient, options: RestBackendOptions);
    /**
     * Mirror of `FileSystemService.normalizePath`. Duplicated rather than shared
     * because hoisting it would mean editing `filesystem.ts`, which this phase
     * deliberately leaves untouched; phase 3 is the place to extract it once both
     * callers exist in the tree.
     */
    private normalizePath;
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
    private assertInsideVault;
    /** Normalize, reject traversal, and return the vault-relative path. */
    private prepare;
    private accessDenied;
    private request;
    /**
     * Errors that must never be folded into a `{ success: false }` result.
     *
     * `BackendError` is how phase 3 decides whether falling back is safe, and a
     * misconfigured key is a startup problem the user has to see. Swallowing
     * either into a message string would silently disable both mechanisms.
     */
    private rethrowIfTransport;
    private static detail;
    /** Fetch a note as the plugin's JSON representation, or throw as the filesystem would. */
    private fetchNote;
    /** Write a whole file. Every write path funnels through here. */
    private putFile;
    /**
     * Read the plugin version from `GET /` and return a warning when it is below
     * the floor. The field is `versions.self`; `manifest.version` is accepted as
     * a fallback in case a future release renames it.
     */
    checkPluginVersion(): Promise<{
        version: string | null;
        warning: string | null;
    }>;
    readNote(inputPath: string): Promise<ParsedNote>;
    getFrontmatter(inputPath: string): Promise<Record<string, any>>;
    /**
     * Resolution reads `.obsidian/daily-notes.json` off the local disk even on
     * this arm. The plugin's `/periodic/` endpoints only answer for periods the
     * absent `periodic-notes` plugin would provide, and taking the setting from a
     * second source would be exactly the drift `get_periodic_note` exists to
     * avoid. The *read* still routes: it goes through this backend's `readNote`.
     */
    getPeriodicNote(params: PeriodicNoteParams): Promise<PeriodicNoteResult>;
    /**
     * Built from the note payload this backend already fetches, so routing the
     * map costs one mapping rather than a second request.
     */
    getDocumentMap(inputPath: string): Promise<DocumentMap>;
    readMultipleNotes(params: BatchReadParams): Promise<BatchReadResult>;
    getNotesInfo(paths: string[]): Promise<NoteInfo[]>;
    listDirectory(inputPath?: string): Promise<DirectoryListing>;
    listAllTags(): Promise<Array<{
        tag: string;
        count: number;
    }>>;
    writeNote(params: NoteWriteParams): Promise<void>;
    /**
     * Find-and-replace over the whole file.
     *
     * `PATCH /vault/{path}` cannot express this: it targets a heading, block, or
     * frontmatter field, and has no notion of an occurrence count or of failing
     * when a string matches twice. Those are exactly the semantics `patch_note`
     * promises, so this is read-modify-write against the same endpoints the rest
     * of the backend uses.
     */
    patchNote(params: PatchNoteParams): Promise<PatchNoteResult>;
    deleteNote(params: DeleteNoteParams): Promise<DeleteResult>;
    moveNote(params: MoveNoteParams): Promise<MoveResult>;
    moveFile(params: MoveFileParams): Promise<MoveResult>;
    /**
     * `MOVE /vault/{path}` with a `Destination` header. This is the one operation
     * REST does strictly better than the filesystem: the plugin preserves file
     * history and rewrites inbound links, which a rename cannot.
     *
     * The path and the header are percent-encoded separately — the OpenAPI
     * document calls that out explicitly for both.
     */
    private move;
    /**
     * `PATCH` with `Target-Type: frontmatter` sets one field per request and
     * cannot remove a field, so `merge: false` and multi-key updates are
     * inexpressible — and a multi-request update is not atomic either. Read,
     * merge with the shared handler, write back.
     */
    updateFrontmatter(params: UpdateFrontmatterParams): Promise<void>;
    /**
     * `GET /tags/` reports vault-wide counts but there is no per-note tag write
     * endpoint, so tag edits are read-modify-write through the note itself —
     * which is what the filesystem backend does too.
     */
    manageTags(params: TagManagementParams): Promise<TagManagementResult>;
}
//# sourceMappingURL=index.d.ts.map