import { test, expect, describe } from "vitest";
import { renderDailyTemplate } from "./template.js";

const JULY_30_2026 = new Date(2026, 6, 30);
const TITLE = "2026-07-30";

/** The jcOS template's real Dataview line, which Templater owns. */
const TEMPLATER_LINE = `WHERE contains(file.path, "<% tp.date.now('YYYY-MM-DD') %>")`;

describe("renderDailyTemplate", () => {
  test("substitutes {{date}} with the note's date", () => {
    const result = renderDailyTemplate("# {{date}}", { date: JULY_30_2026, title: TITLE });

    expect(result.content).toBe("# 2026-07-30");
  });

  test("substitutes {{date:FORMAT}} with the requested format", () => {
    const result = renderDailyTemplate("{{date:YYYY/MM/DD}}", { date: JULY_30_2026, title: TITLE });

    expect(result.content).toBe("2026/07/30");
  });

  test("substitutes {{title}} with the note title", () => {
    const result = renderDailyTemplate("# {{title}}", { date: JULY_30_2026, title: TITLE });

    expect(result.content).toBe("# 2026-07-30");
  });

  test("substitutes {{time}} from the clock rather than the note's date", () => {
    const result = renderDailyTemplate("{{time}}", {
      date: JULY_30_2026,
      title: TITLE,
      now: new Date(2026, 6, 31, 6, 45),
    });

    expect(result.content).toBe("06:45");
  });

  test("accepts inner spaces and any case in a token", () => {
    const result = renderDailyTemplate("{{ DATE }}", { date: JULY_30_2026, title: TITLE });

    expect(result.content).toBe("2026-07-30");
  });

  test("leaves a template without tokens byte for byte", () => {
    const template = "---\ntags:\n  - daily\n---\n\n# Daily Log\n";

    const result = renderDailyTemplate(template, { date: JULY_30_2026, title: TITLE });

    expect(result.content).toBe(template);
  });

  test("leaves Templater tags in place, because only Obsidian can run them", () => {
    const result = renderDailyTemplate(TEMPLATER_LINE, { date: JULY_30_2026, title: TITLE });

    expect(result.content).toBe(TEMPLATER_LINE);
  });

  test("reports each distinct Templater tag it could not render", () => {
    const template = `${TEMPLATER_LINE}\n${TEMPLATER_LINE}\n<% tp.file.title %>`;

    const result = renderDailyTemplate(template, { date: JULY_30_2026, title: TITLE });

    expect(result.unrendered).toEqual([
      "<% tp.date.now('YYYY-MM-DD') %>",
      "<% tp.file.title %>",
    ]);
  });

  test("reports nothing unrendered for a template without Templater tags", () => {
    const result = renderDailyTemplate("# {{date}}", { date: JULY_30_2026, title: TITLE });

    expect(result.unrendered).toEqual([]);
  });
});
