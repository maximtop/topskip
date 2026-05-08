import {
    summarize,
    type BaseIssue,
    type BaseSchema,
    type BaseSchemaAsync,
    type ValiError,
} from 'valibot';

type ValiSchema =
    | BaseSchema<unknown, unknown, BaseIssue<unknown>>
    | BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>;

/**
 * Pretty-prints validation issues from a {@link ValiError}.
 *
 * @param valiError Valibot parse/validation error.
 * @returns Human-readable summary of issues.
 */
export function extractMessageFromValiError<TSchema extends ValiSchema>(
    valiError: ValiError<TSchema>,
): string {
    return summarize(valiError.issues);
}
