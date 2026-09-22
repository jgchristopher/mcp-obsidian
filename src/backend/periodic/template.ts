import { formatDate } from "./dateFormat.js";

/**
 * Obsidian's core template substitution, for the arm that creates a daily note
 * with Obsidian closed.
 *
 * Scope is exactly what the core Templates plugin fills in: `{{date}}`,
 * `{{time}}`, `{{title}}`, each with an optional `:FORMAT`. Community template
 * engines are **not** emulated. Templater's `<% %>` tags run arbitrary
 * JavaScript inside a live Obsidian, so guessing at them here would produce a
 * note that quietly disagrees with the one Obsidian would have written. They
 * are left verbatim and reported instead, which lets the caller say which lines
 * did not render rather than pretending the note is complete.
 */

/** Core tokens, with optional `:FORMAT`. Case-insensitive, inner spaces allowed. */
const CORE_TOKEN = /\{\{\s*(date|time|title)\s*(?::([^}]*?))?\s*\}\}/gi;

/** A Templater tag, matched non-greedily so two on one line stay separate. */
const TEMPLATER_TAG = /<%[\s\S]*?%>/g;

const DEFAULT_DATE_FORMAT = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT = "HH:mm";

export interface DailyTemplateParams {
  /** The date the note is *for*, which is what `{{date}}` means. */
  date: Date;
  /** The note's title, which for a daily note is its filename without `.md`. */
  title: string;
  /** Wall clock for `{{time}}`. Defaults to `date`, so callers can pin it. */
  now?: Date;
}

export interface DailyTemplateResult {
  content: string;
  /** Distinct template tags left verbatim, in the order they first appear. */
  unrendered: string[];
}

/** Substitute the core tokens in `template`, reporting what was left alone. */
export function renderDailyTemplate(
  template: string,
  params: DailyTemplateParams,
): DailyTemplateResult {
  const { date, title, now = date } = params;

  const content = template.replace(CORE_TOKEN, (_match, rawToken: string, rawFormat?: string) => {
    const token = rawToken.toLowerCase();
    if (token === "title") return title;

    const format = rawFormat?.trim();
    if (token === "date") return formatDate(format || DEFAULT_DATE_FORMAT, date);
    return formatDate(format || DEFAULT_TIME_FORMAT, now);
  });

  return { content, unrendered: [...new Set(content.match(TEMPLATER_TAG) ?? [])] };
}
