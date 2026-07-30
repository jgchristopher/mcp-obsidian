/**
 * Structural outline of a note: headings, block references, frontmatter keys.
 *
 * Pure over content both backends already hold. REST gets the content from the
 * note payload it already fetched, the filesystem from the parsed note, so
 * routing this costs one mapping rather than a second request — and sharing the
 * function is what makes the two arms produce byte-identical output.
 */
export interface DocumentMapHeading {
    /** Ancestor chain joined with `::`, e.g. `Daily::Morning`. */
    path: string;
    /** 1 through 6. */
    level: number;
    /** 1-indexed line within the note body, frontmatter excluded. */
    line: number;
}
export interface DocumentMap {
    headings: DocumentMapHeading[];
    /** Block reference ids, without the leading `^`. */
    blockRefs: string[];
    frontmatterKeys: string[];
}
/**
 * Build the map.
 *
 * Heading paths use `::` because that is the separator the Local REST API's
 * `PATCH` `Target` header expects, so the output feeds structural patching
 * directly with no re-encoding.
 *
 * Fenced code blocks are skipped. A `#` inside a fence is a shell comment, not
 * a heading, and daily notes are full of shell snippets — the same fence-aware
 * rule `patch_note` already needed.
 */
export declare function buildDocumentMap(content: string, frontmatter: Record<string, any> | undefined): DocumentMap;
//# sourceMappingURL=documentMap.d.ts.map