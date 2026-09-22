import { readDailyNotesConfig } from "./config.js";
import { resolvePeriodicPath, UnsupportedPeriodError } from "./resolve.js";
import { renderDailyTemplate } from "./template.js";
/**
 * Create today's daily note the way Obsidian would.
 *
 * Two arms, and the order matters. When Obsidian is running, its own
 * `daily-notes` command is the only thing that applies the vault's full
 * template pipeline — including community engines like Templater, whose tags
 * this process cannot evaluate. When Obsidian is not running, a scheduled run
 * still needs a note to write into, so the template is rendered here with the
 * core tokens and whatever it could not render is reported.
 *
 * Idempotent on purpose: an existing note is returned untouched. Every caller
 * is a skill that may run twice in a day, and a second run must never clobber
 * the first run's output.
 */
/** Obsidian's core "Daily notes: Open today's daily note" command. */
export const DAILY_NOTES_COMMAND_ID = "daily-notes";
/** How long to wait for Obsidian to produce, and Templater to settle, the note. */
const SETTLE_ATTEMPTS = 20;
const SETTLE_INTERVAL_MS = 500;
export async function createPeriodicNote(deps, params) {
    const { vaultPath, backend, runCommand, sleep = defaultSleep, now = () => new Date() } = deps;
    const { period, date } = params;
    if (period !== "daily")
        throw new UnsupportedPeriodError(period);
    const path = await resolvePeriodicPath(vaultPath, period, date);
    if (await exists(backend, path)) {
        return { period, path, created: false, via: "existing" };
    }
    const skipped = obsidianArmSkipReason(runCommand, date, now());
    if (!skipped) {
        const failure = await createThroughObsidian(runCommand, backend, path, sleep);
        if (!failure)
            return { period, path, created: true, via: "obsidian" };
        return createFromTemplate(deps, period, path, date, failure);
    }
    return createFromTemplate(deps, period, path, date, skipped);
}
/** Why the Obsidian arm cannot be used, or `undefined` when it can. */
function obsidianArmSkipReason(runCommand, date, today) {
    if (!runCommand)
        return "Obsidian is not reachable.";
    // The command opens *today's* note and takes no date, so any other date has
    // to be rendered here. Asking it for one would create the wrong note.
    if (!isSameDay(date, today)) {
        return "Obsidian's daily-notes command only creates today's note.";
    }
    return undefined;
}
/**
 * Run the command and wait for the note to settle.
 *
 * Returns `undefined` on success, or the reason to fall back. Settling matters
 * as much as appearing: Obsidian writes the raw template first and Templater
 * rewrites it a beat later, so returning between the two would hand the caller
 * a note that is about to be overwritten, losing whatever it appended.
 */
async function createThroughObsidian(runCommand, backend, path, sleep) {
    try {
        await runCommand(DAILY_NOTES_COMMAND_ID);
    }
    catch (error) {
        return `Obsidian's daily-notes command failed: ${describe(error)}`;
    }
    let previous;
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
        await sleep(SETTLE_INTERVAL_MS);
        const content = await readOrUndefined(backend, path);
        if (content !== undefined && content === previous)
            return undefined;
        previous = content;
    }
    if (previous !== undefined)
        return undefined;
    return (`The note did not appear within ` +
        `${(SETTLE_ATTEMPTS * SETTLE_INTERVAL_MS) / 1000}s of running Obsidian's daily-notes command.`);
}
/** Render the configured template, or write an empty note when none is set. */
async function createFromTemplate(deps, period, path, date, reason) {
    const { vaultPath, backend } = deps;
    const config = await readDailyNotesConfig(vaultPath);
    const templatePath = normalizeTemplatePath(config?.template);
    let content = "";
    let unrendered = [];
    if (templatePath) {
        const template = await backend.readNote(templatePath);
        const rendered = renderDailyTemplate(template.originalContent, {
            date,
            title: titleOf(path),
            now: deps.now?.() ?? new Date(),
        });
        content = rendered.content;
        unrendered = rendered.unrendered;
    }
    await backend.writeNote({ path, content, mode: "overwrite" });
    return { period, path, created: true, via: "template", unrendered, reason };
}
/**
 * Obsidian stores the template setting without an extension when it was typed
 * that way, and resolves it as markdown either way.
 */
function normalizeTemplatePath(template) {
    const trimmed = template?.trim();
    if (!trimmed)
        return undefined;
    return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
}
function titleOf(path) {
    return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}
function isSameDay(left, right) {
    return (left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate());
}
async function exists(backend, path) {
    return (await readOrUndefined(backend, path)) !== undefined;
}
/**
 * Read a note, treating only "not there" as absence.
 *
 * Matched on the message both backends are contractually required to produce,
 * the same way `readResolved` does in `resolve.ts`. Anything else — a denied
 * path, a transport failure — propagates, because creating a note over a
 * failure we could not classify is how a real note gets overwritten.
 */
async function readOrUndefined(backend, path) {
    try {
        return (await backend.readNote(path)).originalContent;
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith("File not found:"))
            return undefined;
        throw error;
    }
}
function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
