/**
 * Date substitution for Obsidian's daily-notes format string.
 *
 * Deliberately tiny: `YYYY`, `MM`, `DD` for dates, plus `HH`, `mm`, `ss` for
 * the clock. Weekly and longer periods need the `periodic-notes` community
 * plugin, which is not installed in the target vault, so `dddd`, `Do`, `W`, and
 * `Q` would be code no in-scope goal exercises. An unrecognized token is
 * therefore an error, not a pass-through: a silently wrong token resolves a
 * plausible-looking path to the wrong note.
 *
 * The clock tokens exist for `{{time}}` in a daily-note template, which is the
 * one place a *time* is substituted. A path format needs only the date three.
 */
export class UnsupportedDateTokenError extends Error {
    token;
    format;
    constructor(token, format) {
        super(`Unsupported date token '${token}' in daily-notes format '${format}'. ` +
            `Only YYYY, MM, DD, HH, mm, and ss are supported.`);
        this.token = token;
        this.format = format;
        this.name = "UnsupportedDateTokenError";
    }
}
const ALPHABETIC = /[A-Za-z]/;
/**
 * Substitute the supported tokens in `format` using `date`.
 *
 * A **single-pass scan**, not a chain of `String.replace` calls. Sequential
 * replacement is order-dependent — replacing `MM` before `YYYY` mangles any
 * format where one token's output can contain another's text — and it silently
 * accepts tokens it does not understand. The scanner consumes each alphabetic
 * run as one token and rejects the ones it cannot resolve.
 *
 * Everything non-alphabetic is a literal, separators included. That is what
 * makes the nested `YYYY/MM/YYYY-MM-DD` layout resolve to a nested path.
 *
 * Date components are read in **local time**. A daily note belongs to the day
 * the user is having, not to the day UTC is having, so callers must build test
 * dates with `new Date(y, m, d)` rather than an ISO string (which parses as
 * UTC midnight and lands on the previous day west of Greenwich).
 */
export function formatDate(format, date) {
    let out = "";
    let index = 0;
    while (index < format.length) {
        const char = format[index];
        if (!ALPHABETIC.test(char)) {
            out += char;
            index += 1;
            continue;
        }
        let end = index;
        while (end < format.length && ALPHABETIC.test(format[end]))
            end += 1;
        out += substitute(format.slice(index, end), format, date);
        index = end;
    }
    return out;
}
function substitute(token, format, date) {
    switch (token) {
        case "YYYY":
            return String(date.getFullYear()).padStart(4, "0");
        case "MM":
            return String(date.getMonth() + 1).padStart(2, "0");
        case "DD":
            return String(date.getDate()).padStart(2, "0");
        case "HH":
            return String(date.getHours()).padStart(2, "0");
        case "mm":
            return String(date.getMinutes()).padStart(2, "0");
        case "ss":
            return String(date.getSeconds()).padStart(2, "0");
        default:
            throw new UnsupportedDateTokenError(token, format);
    }
}
