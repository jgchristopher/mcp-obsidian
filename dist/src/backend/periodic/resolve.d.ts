import type { ParsedNote } from "../../types.js";
/**
 * Config plus a date into a vault-relative note path.
 *
 * The date is **always injected, never read from the system clock in here**. A
 * test that asserted a fixed path against `new Date()` would pass on the day it
 * was written and fail every day after. Tool handlers supply `new Date()` when
 * the caller omits a date; this module never calls it.
 */
export declare const PERIODS: readonly ["daily", "weekly", "monthly", "quarterly", "yearly"];
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
export declare class UnsupportedPeriodError extends Error {
    readonly period: string;
    constructor(period: string);
}
export declare class PeriodicNotesUnconfiguredError extends Error {
    readonly vaultPath: string;
    constructor(vaultPath: string);
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
export declare function resolvePeriodicPath(vaultPath: string, period: PeriodicPeriod, date: Date): Promise<string>;
/** Resolve several dates against one config read. */
export declare function resolvePeriodicPaths(vaultPath: string, period: PeriodicPeriod, dates: Date[]): Promise<string[]>;
/**
 * The `count` most recent daily dates ending at `from`, newest first.
 *
 * Built with the local-time `Date(y, m, d - n)` constructor, which rolls month
 * and year boundaries correctly and, unlike millisecond subtraction, does not
 * drift across a daylight-saving transition.
 */
export declare function recentDailyDates(from: Date, count: number): Date[];
/**
 * Resolve a period and read the note behind it through the caller's backend.
 *
 * Shared by both backends so the two cannot drift. A path that resolves but has
 * no note is **not** an error: callers routinely want the path in order to
 * create it, so the result reports `exists: false` and carries the path.
 * Anything other than a not-found — a transport failure, a rejected API key —
 * propagates untouched, because routing has to see those.
 */
export declare function loadPeriodicNote(reader: PeriodicNoteReader, vaultPath: string, params: PeriodicNoteParams): Promise<PeriodicNoteResult>;
/**
 * The `count` most recent periodic notes that actually exist, newest first.
 *
 * Dates with no note are skipped rather than reported, which is what makes this
 * useful for "what did I write lately" on a vault with gaps.
 */
export declare function loadRecentPeriodicNotes(reader: PeriodicNoteReader, vaultPath: string, period: PeriodicPeriod, count: number, from: Date): Promise<PeriodicNoteResult[]>;
//# sourceMappingURL=resolve.d.ts.map