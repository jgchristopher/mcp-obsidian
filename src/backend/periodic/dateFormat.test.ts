import { test, expect, describe } from "vitest";
import { formatDate, UnsupportedDateTokenError } from "./dateFormat.js";

/**
 * Dates are built with `new Date(y, monthIndex, d)` — the local-time
 * constructor — never from an ISO string. `new Date("2026-07-30")` parses as
 * UTC midnight, so `getDate()` returns 29 anywhere west of Greenwich and the
 * suite would pass in CI and fail on the author's machine.
 */

const JULY_30_2026 = new Date(2026, 6, 30);

describe("formatDate", () => {
  test("substitutes the flat format", () => {
    expect(formatDate("YYYY-MM-DD", JULY_30_2026)).toBe("2026-07-30");
  });

  test("preserves slashes so a nested layout resolves to a nested path", () => {
    expect(formatDate("YYYY/MM/YYYY-MM-DD", JULY_30_2026)).toBe("2026/07/2026-07-30");
  });

  test("zero-pads a single-digit month and day", () => {
    expect(formatDate("YYYY-MM-DD", new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  test("repeats a token as many times as it appears", () => {
    expect(formatDate("DD.DD", JULY_30_2026)).toBe("30.30");
  });

  test("passes a format with no tokens through verbatim", () => {
    expect(formatDate("2026-07-30", JULY_30_2026)).toBe("2026-07-30");
    expect(formatDate("_-/.", JULY_30_2026)).toBe("_-/.");
  });

  test("treats an empty format as an empty result", () => {
    expect(formatDate("", JULY_30_2026)).toBe("");
  });

  for (const token of ["dddd", "Do", "W", "Q"]) {
    test(`rejects the unsupported token '${token}'`, () => {
      const format = `YYYY-${token}`;
      expect(() => formatDate(format, JULY_30_2026)).toThrow(UnsupportedDateTokenError);
      expect(() => formatDate(format, JULY_30_2026)).toThrow(
        `Unsupported date token '${token}' in daily-notes format '${format}'. ` +
          `Only YYYY, MM, DD, HH, mm, and ss are supported.`,
      );
    });
  }

  /**
   * Clock tokens exist for `{{time}}` in a daily-note template, which Obsidian
   * fills from the clock. The date tokens above stay the only ones a *path*
   * format needs.
   */
  test("substitutes the hour and minute", () => {
    expect(formatDate("HH:mm", new Date(2026, 6, 30, 6, 45))).toBe("06:45");
  });

  test("substitutes seconds", () => {
    expect(formatDate("HH:mm:ss", new Date(2026, 6, 30, 23, 9, 4))).toBe("23:09:04");
  });

  test("reads the hour on a 24-hour clock", () => {
    expect(formatDate("HH", new Date(2026, 6, 30, 18, 0))).toBe("18");
  });

  test("names the whole alphabetic run, not the first recognizable prefix", () => {
    // A chained-replace implementation would turn "YYYYY" into "2026Y" and
    // never complain. The scanner reads one run and rejects it.
    try {
      formatDate("YYYYY", JULY_30_2026);
      expect.unreachable("expected an UnsupportedDateTokenError");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedDateTokenError);
      expect((error as UnsupportedDateTokenError).token).toBe("YYYYY");
    }
  });
});
