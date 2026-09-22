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
export declare function renderDailyTemplate(template: string, params: DailyTemplateParams): DailyTemplateResult;
//# sourceMappingURL=template.d.ts.map