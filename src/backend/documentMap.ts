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
 * ``` or ~~~ opening or closing a fenced block, up to three leading spaces.
 * Group 2 is whatever follows the run: an opener may carry a language tag, but
 * a closer may be followed only by whitespace.
 */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/**
 * ATX heading, per CommonMark: up to three leading spaces, and the text is
 * optional so a bare `#` is a heading. The space before the text is required,
 * which is what keeps an Obsidian tag like `#project` from matching.
 */
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
/** A trailing `^id` is Obsidian's block reference. Ids allow letters, digits, `-`. */
const BLOCK_REF = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;
/** ATX closing sequence, e.g. `## Title ##`, which is not part of the title. */
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/;
/** A title made only of #s is an empty heading plus its closing sequence. */
const ALL_HASHES = /^#+$/;

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
export function buildDocumentMap(
  content: string,
  frontmatter: Record<string, any> | undefined,
): DocumentMap {
  const headings: DocumentMapHeading[] = [];
  const blockRefs: string[] = [];
  /** Ancestor titles by depth. Index `n` holds the level-`n+1` heading. */
  const ancestors: string[] = [];

  let fenceMarker: string | null = null;
  let fenceLength = 0;

  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    const fence = FENCE.exec(line);
    if (fence) {
      const run = fence[1]!;
      const marker = run[0]!;
      if (fenceMarker === null) {
        fenceMarker = marker;
        fenceLength = run.length;
        continue;
      }
      // A fence closes only on the same character, at least as long as the one
      // that opened it, and with nothing but whitespace after the run. Anything
      // else — a shorter run, another character, or a trailing language tag —
      // is content inside the block.
      if (marker === fenceMarker && run.length >= fenceLength && fence[2]!.trim() === "") {
        fenceMarker = null;
        fenceLength = 0;
      }
      continue;
    }

    if (fenceMarker !== null) continue;

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const rawTitle = (heading[2] ?? "").trim();
      // `## ##` is an empty heading with a closing sequence, not a heading
      // whose text is literally "##".
      const title = ALL_HASHES.test(rawTitle) ? "" : rawTitle.replace(CLOSING_HASHES, "").trim();

      while (ancestors.length > level - 1) ancestors.pop();
      // A note that jumps H1 -> H3 leaves a gap; an empty placeholder keeps the
      // depth honest without inventing a heading that is not in the file.
      while (ancestors.length < level - 1) ancestors.push("");
      ancestors.push(title);

      headings.push({
        path: ancestors.filter((part) => part.length > 0).join("::"),
        level,
        line: index + 1,
      });
      continue;
    }

    const ref = BLOCK_REF.exec(line);
    if (ref) blockRefs.push(ref[1]!);
  }

  return { headings, blockRefs, frontmatterKeys: Object.keys(frontmatter ?? {}) };
}
