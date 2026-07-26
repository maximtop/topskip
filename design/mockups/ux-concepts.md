# TopSkip UX Concept Set

This mockup pass replaces visual variants with divergent product concepts. Each concept changes at least two of these axes:

- popup information hierarchy
- popup interaction model
- popup/options responsibility split
- state flow across setup, active use, and error cases

## Concept 1 — Quick Status Tap

Target user: user who only wants to know whether TopSkip is on and if the current tab is covered.

Popup:
- dominant single control card
- one-line state summary
- hidden detail drawer for reliability and ranges

Options:
- remains the full control center
- focuses on setup and advanced preferences

Why it is different:
- popup becomes almost a one-action surface
- detailed status is intentionally deferred

## Concept 2 — Smart Context

Target user: user who opens the popup in mixed contexts and should see a different screen depending on state.

Popup:
- context-aware panels for: unsupported page, setup required, ready/no detections, ready/detections
- CTA changes per context

Options:
- same settings foundation, but framed as setup completion and recovery

Why it is different:
- popup is not static
- product communicates state-specific next steps instead of generic controls

## Concept 3 — Detection Timeline

Target user: user who cares about what was detected and why.

Popup:
- visual timeline becomes primary object
- ranges shown as segments with density/labels
- toggle becomes secondary but still prominent

Options:
- emphasis on detection behavior, model confidence, and explanation copy

Why it is different:
- status moves from plain text to spatial visualization
- popup is inspection-oriented rather than purely operational

## Concept 4 — Inline Model Switcher

Target user: power user who experiments with models and wants faster iteration.

Popup:
- current model selector lives directly in the popup
- compact advanced controls for quick switching and testing

Options:
- reduced to API key, custom model management, and advanced defaults

Why it is different:
- popup owns a task previously delegated to the options page
- options becomes secondary instead of required for normal use

## Concept 5 — Guided Wizard

Target user: first-time or broken-state user who needs help getting to a working setup.

Popup:
- step-based flow for enable, connect API, choose model, confirm readiness
- steady-state popup only appears after setup is complete

Options:
- reframed as editable setup summary rather than raw configuration form

Why it is different:
- setup becomes guided instead of form-first
- the same product has different first-run and steady-state UX

## Real Constraints

These concepts still need to respect:

- popup width around 320px
- accessible keyboard and screen-reader behavior
- visible route to core controls
- no change to functional requirements in the real app until a concept is selected
