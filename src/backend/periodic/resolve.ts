import { readDailyNotesConfig } from "./config.js";
import { formatDate } from "./dateFormat.js";
import type { ParsedNote } from "../../types.js";

/**
 * Config plus a date into a vault-relative note path.
 *
 * The date is **always injected, never read from the system clock in here**. A
 * test that asserted a fixed path against `new Date()` would pass on the day it
 * was written and fail every day after. Tool handlers supply `new Date()` when
 * the caller omits a date; this module never calls it.
 */

export const PERIODS = ["daily", "weekly", "monthly", "quarterly", "yearly"] as const;

export type PeriodicPeriod = (typeof PERIODS)[number];

export interface PeriodicNoteParams {
  period: PeriodicPeriod;
  /** Injected by the caller. Interpreted in local time. */
  date: Date;
}

export interface PeriodicNoteResult {
  period: PeriodicPeriod;
  /** Vault-relative path the period resolves to, whether or not it exists. */
  path: string;
  exists: boolean;
  frontmatter?: Record<string, any>;
  content?: string;
}

export class UnsupportedPeriodError extends Error {
  constructor(readonly period: string) {
    super(
      `Periodic notes for '${period}' require the 'periodic-notes' community plugin, ` +
        `which is not installed in this vault. Only 'daily' resolves today. ` +
        `Install and configure periodic-notes in Obsidian to enable the others.`,
    );
    this.name = "UnsupportedPeriodError";
  }
}

export class PeriodicNotesUnconfiguredError extends Error {
  constructor(readonly vaultPath: string) {
    super(
      `Daily notes are not configured for this vault: ` +
        `${vaultPath}/.obsidian/daily-notes.json does not exist. ` +
        `Enable Obsidian's core "Daily notes" plugin and set its folder and date format.`,
    );
    this.name = "PeriodicNotesUnconfiguredError";
  }
}

/** The subset of a backend `loadPeriodicNote` needs, so either arm can pass itself. */
export interface PeriodicNoteReader {
  readNote(path: string): Promise<ParsedNote>;
}

/**
 * Resolve one period to a vault-relative path.
 *
 * Only `daily` resolves. The other four throw `UnsupportedPeriodError`, which is
 * accurate for this vault and actionable. The tool schema still accepts all five
 * so the explanation is discoverable rather than a bare schema rejection.
 */
export async function resolvePeriodicPath(
  vaultPath: string,
  period: PeriodicPeriod,
  date: Date,
): Promise<string> {
  const [only] = await resolvePeriodicPaths(vaultPath, period, [date]);
  return only!;
}

/** Resolve several dates against one config read. */
export async function resolvePeriodicPaths(
  vaultPath: string,
  period: PeriodicPeriod,
  dates: Date[],
): Promise<string[]> {
  if (period !== "daily") throw new UnsupportedPeriodError(period);

  const config = await readDailyNotesConfig(vaultPath);
  if (!config) throw new PeriodicNotesUnconfiguredError(vaultPath);

  return dates.map((date) => joinVaultPath(config.folder, `${formatDate(config.format, date)}.md`));
}

/**
 * The `count` most recent daily dates ending at `from`, newest first.
 *
 * Built with the local-time `Date(y, m, d - n)` constructor, which rolls month
 * and year boundaries correctly and, unlike millisecond subtraction, does not
 * drift across a daylight-saving transition.
 */
export function recentDailyDates(from: Date, count: number): Date[] {
  const dates: Date[] = [];
  for (let back = 0; back < count; back += 1) {
    dates.push(new Date(from.getFullYear(), from.getMonth(), from.getDate() - back));
  }
  return dates;
}

/**
 * Resolve a period and read the note behind it through the caller's backend.
 *
 * Shared by both backends so the two cannot drift. A path that resolves but has
 * no note is **not** an error: callers routinely want the path in order to
 * create it, so the result reports `exists: false` and carries the path.
 * Anything other than a not-found — a transport failure, a rejected API key —
 * propagates untouched, because routing has to see those.
 */
export async function loadPeriodicNote(
  reader: PeriodicNoteReader,
  vaultPath: string,
  params: PeriodicNoteParams,
): Promise<PeriodicNoteResult> {
  const path = await resolvePeriodicPath(vaultPath, params.period, params.date);
  return readResolved(reader, params.period, path);
}

/**
 * The `count` most recent periodic notes that actually exist, newest first.
 *
 * Dates with no note are skipped rather than reported, which is what makes this
 * useful for "what did I write lately" on a vault with gaps.
 */
export async function loadRecentPeriodicNotes(
  reader: PeriodicNoteReader,
  vaultPath: string,
  period: PeriodicPeriod,
  count: number,
  from: Date,
): Promise<PeriodicNoteResult[]> {
  const paths = await resolvePeriodicPaths(vaultPath, period, recentDailyDates(from, count));

  const found: PeriodicNoteResult[] = [];
  for (const path of paths) {
    const result = await readResolved(reader, period, path);
    if (result.exists) found.push(result);
  }
  return found;
}

async function readResolved(
  reader: PeriodicNoteReader,
  period: PeriodicPeriod,
  path: string,
): Promise<PeriodicNoteResult> {
  try {
    const note = await reader.readNote(path);
    return {
      period,
      path,
      exists: true,
      frontmatter: note.frontmatter,
      content: note.content,
    };
  } catch (error) {
    // Matched on the message both backends are contractually required to
    // produce, rather than on an error class: only "the note is not there" may
    // become `exists: false`. Everything else — `BackendError`,
    // `RestConfigurationError`, a permission failure — rethrows, so routing and
    // the user still see it.
    if (error instanceof Error && error.message.startsWith("File not found:")) {
      return { period, path, exists: false };
    }
    throw error;
  }
}

/** Join a configured folder to a filename, normalized to vault-relative form. */
function joinVaultPath(folder: string, name: string): string {
  const cleanFolder = folder.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const cleanName = name.replace(/\\/g, "/").replace(/^\/+/, "");
  return cleanFolder ? `${cleanFolder}/${cleanName}` : cleanName;
}
