import { test, expect, describe } from "vitest";
import { buildDocumentMap } from "./documentMap.js";

describe("buildDocumentMap", () => {
  test("nests heading paths three deep with :: separators", () => {
    const map = buildDocumentMap("# One\n\n## Two\n\n### Three\n", {});

    expect(map.headings).toEqual([
      { path: "One", level: 1, line: 1 },
      { path: "One::Two", level: 2, line: 3 },
      { path: "One::Two::Three", level: 3, line: 5 },
    ]);
  });

  test("pops back out when a sibling heading follows a deeper one", () => {
    const map = buildDocumentMap("# A\n## A1\n### A1a\n## A2\n# B\n", {});

    expect(map.headings.map((h) => h.path)).toEqual(["A", "A::A1", "A::A1::A1a", "A::A2", "B"]);
  });

  test("does not treat a # inside a fenced code block as a heading", () => {
    const content = ["# Real", "", "```bash", "# not a heading", "echo hi", "```", "", "## After"].join(
      "\n",
    );

    const map = buildDocumentMap(content, {});

    expect(map.headings).toEqual([
      { path: "Real", level: 1, line: 1 },
      { path: "Real::After", level: 2, line: 8 },
    ]);
  });

  test("handles tilde fences and a longer closing run", () => {
    const content = ["~~~", "# hidden", "~~~~", "# visible"].join("\n");

    expect(buildDocumentMap(content, {}).headings.map((h) => h.path)).toEqual(["visible"]);
  });

  test("does not close a backtick fence on a tilde line", () => {
    const content = ["```", "~~~", "# still hidden", "```", "# visible"].join("\n");

    expect(buildDocumentMap(content, {}).headings.map((h) => h.path)).toEqual(["visible"]);
  });

  test("collects block references without the caret", () => {
    const content = "some line ^abc123\n\nanother ^ref-2\n\nnot^inline\n";

    expect(buildDocumentMap(content, {}).blockRefs).toEqual(["abc123", "ref-2"]);
  });

  test("skips block references inside a code fence", () => {
    const content = ["```", "caret ^inside", "```", "caret ^outside"].join("\n");

    expect(buildDocumentMap(content, {}).blockRefs).toEqual(["outside"]);
  });

  test("keeps duplicate sibling heading names distinct by line", () => {
    const content = "# Log\n## Notes\n# Log\n## Notes\n";

    expect(buildDocumentMap(content, {}).headings).toEqual([
      { path: "Log", level: 1, line: 1 },
      { path: "Log::Notes", level: 2, line: 2 },
      { path: "Log", level: 1, line: 3 },
      { path: "Log::Notes", level: 2, line: 4 },
    ]);
  });

  test("skips a level gap without inventing a heading", () => {
    expect(buildDocumentMap("# One\n### Three\n", {}).headings).toEqual([
      { path: "One", level: 1, line: 1 },
      { path: "One::Three", level: 3, line: 2 },
    ]);
  });

  test("strips an ATX closing sequence from the title", () => {
    expect(buildDocumentMap("## Title ##\n", {}).headings[0]?.path).toBe("Title");
  });

  test("requires whitespace after the hashes", () => {
    expect(buildDocumentMap("#nothashtag\n", {}).headings).toEqual([]);
  });

  test("reports frontmatter keys in declaration order", () => {
    const map = buildDocumentMap("# X\n", { title: "X", tags: ["a"], created: "2026-07-30" });

    expect(map.frontmatterKeys).toEqual(["title", "tags", "created"]);
  });

  test("returns empty collections for a note with no structure", () => {
    expect(buildDocumentMap("just prose\n", {})).toEqual({
      headings: [],
      blockRefs: [],
      frontmatterKeys: [],
    });
  });

  test("treats missing frontmatter as no keys", () => {
    expect(buildDocumentMap("# X\n", undefined).frontmatterKeys).toEqual([]);
  });
  // CommonMark conformance. Upstream bitbonsai/mcpvault fixed the equivalent
  // cases in its own getNoteOutline (7549243, 7aced58); this fork's parser is a
  // separate implementation that missed the same three.

  test("recognizes an ATX heading indented up to three spaces", () => {
    const map = buildDocumentMap("  ## Indented\n", {});

    expect(map.headings).toEqual([{ path: "Indented", level: 2, line: 1 }]);
  });

  test("ignores a heading indented four or more spaces", () => {
    expect(buildDocumentMap("    # Code block\n", {}).headings).toEqual([]);
  });

  test("recognizes a heading with no text", () => {
    expect(buildDocumentMap("#\n", {}).headings).toEqual([{ path: "", level: 1, line: 1 }]);
  });

  test("treats an all-hashes heading as empty rather than literal hashes", () => {
    expect(buildDocumentMap("## ##\n", {}).headings).toEqual([{ path: "", level: 2, line: 1 }]);
  });

  test("does not close a fence on a line with trailing text after the markers", () => {
    const content = ["```", "code", "```js", "# not a heading", "```", "# Real"].join("\n");

    expect(buildDocumentMap(content, {}).headings).toEqual([{ path: "Real", level: 1, line: 6 }]);
  });
});
