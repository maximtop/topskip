/**
 * Restricts permanent diagnostics to identifiers and bounded scalar metadata.
 */
export type ServerAnalysisLogFields = Readonly<
    Record<string, string | number | boolean | null | undefined>
>;
