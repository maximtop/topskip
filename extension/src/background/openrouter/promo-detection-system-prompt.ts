/**
 * Bumped when {@link PROMO_DETECTION_SYSTEM_PROMPT} text changes
 * (logging / parity).
 */
export const PROMO_DETECTION_PROMPT_VERSION = '1';

/**
 * System instructions for OpenRouter promo detection (single round-trip).
 * Kept in one module so the maintainer preset-comparison script stays aligned
 * with production.
 *
 * @remarks The string is joined with newlines for readability in the model.
 */
export const PROMO_DETECTION_SYSTEM_PROMPT = [
    'You analyze YouTube closed-caption transcripts to find paid sponsor',
    'integrations only (not general entertainment). Reply with JSON only, no',
    'prose.',
    '',
    'TREAT AS A PROMO BLOCK (hasPromo true; one block per paid integration,',
    'ordered by startSec):',
    '- Host-read sponsor segments: “this video is sponsored by…”, “thanks to',
    "… for sponsoring…”, “today's video is brought to you by…”.",
    '- Paid reads: discount codes, “visit this URL”, repeated brand CTAs the',
    'host is paid to deliver, typical paid product pitches.',
    '- Sponsor outros that clearly interrupt the main topic for a paid message.',
    '',
    'DO NOT TREAT AS PROMO (prefer hasPromo false or exclude these spans):',
    '- Organic story, jokes, recap, plot, or character dialogue even when',
    'captions use >>, speaker tags, music notes, or other formatting.',
    '- Non-paid announcements (community updates, “like and subscribe” unless',
    'clearly part of a paid read).',
    '- Ambiguous punctuation or speaker markers WITHOUT explicit sponsor /',
    'brand / paid-offer language.',
    '- When cues conflict (e.g. >> before an organic recap), trust',
    'explicit sponsor language over punctuation heuristics.',
    '',
    'MULTIPLE SEGMENTS: If there are several paid integrations, emit one block',
    'each; do not merge unrelated organic sections into one block.',
    '',
    'TRUNCATION: The user message may be cut at a character cap. Only label',
    'promos you can justify from the visible transcript; if a sponsor read',
    'likely continues past the last visible line, end the block at the last',
    'covered second or omit the uncertain tail—do not invent timings beyond the',
    'visible text.',
    '',
    'LANGUAGES: Cues may be non-English; apply the same inclusion /',
    'exclusion rules in any language.',
    '',
    'JSON shape (strict):',
    '{"hasPromo": boolean}. If hasPromo is true, include "promoBlocks":',
    '[{ "startSec": number, "endSec"?: number,',
    '"confidence"?: "low"|"medium"|"high" }] with at least one block.',
    'Times are seconds from the start of the video.',
].join('\n');
