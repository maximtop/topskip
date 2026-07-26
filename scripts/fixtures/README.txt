Fixtures for OpenRouter preset comparison (pnpm run openrouter:compare-presets)

Files
-----
- promo-compare-110-lines.txt — synthetic timed lines (quick smoke test).
- promo-v3eXTAqGkzg-ru-from-console.log.txt — real Russian transcript rebuilt
  from tmp/logs/console-1776244778870.log (900 caption rows; DevTools export
  can drop a few malformed lines vs “total=910” in the header).
- promo-v3eXTAqGkzg-reference-blocks.json — human-annotated sponsor windows
  (start/end seconds + optional cue text) plus optional firstRunModel for
  automatic deltas when you pass --reference (see below).

Regenerate the real transcript after exporting a new service-worker log
------------------------------------------------------------------------
  pnpm run openrouter:extract-log-transcript -- PATH/TO/export.log \
    -o scripts/fixtures/promo-v3eXTAqGkzg-ru-from-console.log.txt \
    --video-id v3eXTAqGkzg --language ru

Run all presets + your reference timelines (recommended)
----------------------------------------------------------
  pnpm run openrouter:compare-presets -- \
    --fixture scripts/fixtures/promo-v3eXTAqGkzg-ru-from-console.log.txt \
    --reference scripts/fixtures/promo-v3eXTAqGkzg-reference-blocks.json \
    --out tmp/logs/openrouter-compare-presets-v3eXTAqGkzg.json

The command writes machine-readable JSON to stdout, logs per-model progress to
stderr, and can save the same JSON report directly with --out.

Stdout JSON includes:
- reference — copy of the JSON you passed (human blocks + optional first run).
- firstRunVsHuman — each human window vs firstRunModel.blocks[i] (startDeltaSec,
  endDeltaSec, iouWithHuman). Positive startDeltaSec ⇒ model started late.
- rows[].vsHuman — same metrics for every preset row that returned blocks.
- rows[].vsHumanNote — only if human and model block counts differ.
- rows[].usage / rows[].costAnalysis / rows[].pricing — token counts, reported
  request cost, estimated USD breakdown from model rates, and per-token prices.
- summary.rankedByAlignment — best overlap with human labels first.
- summary.rankedByReportedCost — cheapest successful responses first.

Human windows in reference-blocks.json (short labels)
------------------------------------------------------
  first  — ~Сбербизнес read (starts at >> “Когда я рассказываю про запуски…”).
  second — блок «Галя…» → «Плати по миру…» (уже ближе к first-run 826–945).
  third  — Selecttel / IT (близко к first-run 1583–1600).

First OpenRouter run (google/gemini-3-flash-preview) vs those humans
----------------------------------------------------------------------
  Ends were close; starts for “first” were ~26 s late (268 vs 242). Use
  firstRunVsHuman in JSON to see exact deltas; tune the prompt / model from
  startSec alignment, not only IoU.

When judging “better”
-----------------------
- Do starts sit on the first paid-read line, not on organic >> lines?
- Are separate sponsor reads split into separate blocks or merged wrongly?
- Does the model skip non-paid story?

There is no single automatic score in-repo; use vsHuman plus playback on
YouTube at the returned startSec values.
