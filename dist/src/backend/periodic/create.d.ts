import type { PeriodicPeriod } from "./resolve.js";
import type { NoteWriteParams, ParsedNote } from "../../types.js";
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
export declare const DAILY_NOTES_COMMAND_ID = "daily-notes";
/** Where the note came from. `existing` means nothing was written. */
export type PeriodicCreateVia = "existing" | "obsidian" | "template";
export interface CreatePeriodicNoteParams {
    period: PeriodicPeriod;
    /** Injected by the caller, never read from the clock in here. */
    date: Date;
}
export interface CreatePeriodicNoteResult {
    period: PeriodicPeriod;
    path: string;
    created: boolean;
    via: PeriodicCreateVia;
    /** Template tags left verbatim, present only on the `template` arm. */
    unrendered?: string[];
    /** Why the Obsidian arm was skipped or abandoned. */
    reason?: string;
}
/** The slice of a backend this needs, so either arm can pass itself. */
export interface PeriodicCreateBackend {
    readNote(path: string): Promise<ParsedNote>;
    writeNote(params: NoteWriteParams): Promise<void>;
}
export interface PeriodicCreateDeps {
    vaultPath: string;
    backend: PeriodicCreateBackend;
    /**
     * Runs an Obsidian command. Absent means no running Obsidian, which is the
     * normal state for a scheduled run, not an error.
     */
    runCommand?: ((commandId: string) => Promise<unknown>) | undefined;
    /** Injected so tests do not wait in real time. */
    sleep?: (ms: number) => Promise<void>;
    /** Injected clock, used only to decide whether `date` is today. */
    now?: () => Date;
}
export declare function createPeriodicNote(deps: PeriodicCreateDeps, params: CreatePeriodicNoteParams): Promise<CreatePeriodicNoteResult>;
//# sourceMappingURL=create.d.ts.map