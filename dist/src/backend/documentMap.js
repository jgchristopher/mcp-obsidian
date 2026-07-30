/**
 * Structural outline of a note: headings, block references, frontmatter keys.
 *
 * Pure over content both backends already hold. REST gets the content from the
 * note payload it already fetched, the filesystem from the parsed note, so
 * routing this costs one mapping rather than a second request — and sharing the
 * function is what makes the two arms produce byte-identical output.
 */
/** ``` or ~~~ opening or closing a fenced block, up to three leading spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})[ \t]+(.*)$/;
/** A trailing `^id` is Obsidian's block reference. Ids allow letters, digits, `-`. */
const BLOCK_REF = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;
/** ATX closing sequence, e.g. `## Title ##`, which is not part of the title. */
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
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
export function buildDocumentMap(content, frontmatter) {
    const headings = [];
    const blockRefs = [];
    /** Ancestor titles by depth. Index `n` holds the level-`n+1` heading. */
    const ancestors = [];
    let fenceMarker = null;
    let fenceLength = 0;
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const fence = FENCE.exec(line);
        if (fence) {
            const run = fence[1];
            const marker = run[0];
            if (fenceMarker === null) {
                fenceMarker = marker;
                fenceLength = run.length;
                continue;
            }
            // A fence closes only on the same character, at least as long as the one
            // that opened it. Anything else is content inside the block.
            if (marker === fenceMarker && run.length >= fenceLength) {
                fenceMarker = null;
                fenceLength = 0;
            }
            continue;
        }
        if (fenceMarker !== null)
            continue;
        const heading = HEADING.exec(line);
        if (heading) {
            const level = heading[1].length;
            const title = heading[2].replace(CLOSING_HASHES, "").trim();
            while (ancestors.length > level - 1)
                ancestors.pop();
            // A note that jumps H1 -> H3 leaves a gap; an empty placeholder keeps the
            // depth honest without inventing a heading that is not in the file.
            while (ancestors.length < level - 1)
                ancestors.push("");
            ancestors.push(title);
            headings.push({
                path: ancestors.filter((part) => part.length > 0).join("::"),
                level,
                line: index + 1,
            });
            continue;
        }
        const ref = BLOCK_REF.exec(line);
        if (ref)
            blockRefs.push(ref[1]);
    }
    return { headings, blockRefs, frontmatterKeys: Object.keys(frontmatter ?? {}) };
}
