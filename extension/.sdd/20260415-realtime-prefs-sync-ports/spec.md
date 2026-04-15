# Feature Specification: Real-time Preference Sync Between Popup and Options via Long-lived Connections

**Created**: 2026-04-15
**Status**: Validated
**Model**: claude-opus-4.6
**Input**: When I switch "enable promo skip" on the popup, I want this setting to be synchronized automatically on the options page, and vice versa; when I switch on the options page, I want it to update on the popup page. This can be implemented via long-lived connections.

## Assumptions

- **"Enable promo skip" maps to two linked toggles**: The popup has an
  "Enable promo skip" master switch (`UserPreferences.enabled`), and the
  options page has an "Enable LLM promo detection" checkbox
  (`OpenRouterConfig.enabled`). Today these are already kept in sync by the
  background (`SET_PREFS` propagates to `OpenRouterStorage`, `SET_OPENROUTER_CONFIG`
  propagates to `PrefsSyncStorage`), but neither the popup nor the options page
  receives a push notification when the *other* page changes the value; the
  popup would need to be re-opened, and the options page would need a manual
  Reload. This feature closes that gap with live push updates.

- **Long-lived connections (`browser.runtime.connect` / `Port`)**: The user
  explicitly requested this mechanism. Ports are well-suited here because both
  the popup and the options page are extension pages with a clear open/close
  lifecycle; the background can detect disconnection automatically instead of
  maintaining stale listeners. This replaces (or supplements) the current
  one-shot `PREFS_UPDATED` broadcast-to-all-tabs pattern for extension pages.

- **Scope limited to the `enabled` preference**: The only preference that
  exists today on both surfaces is the enabled/disabled toggle. OpenRouter
  config fields (API key, model) are options-page-only and do not need
  real-time sync to the popup. If additional shared preferences are added
  later, the same port channel can carry them.

- **Content-script broadcast unchanged**: The existing
  `PrefsBroadcast.sendUpdatedToAllTabs` (one-shot `tabs.sendMessage`) for
  content scripts remains as-is. Content scripts are injected into web pages
  and cannot use `runtime.connect` reliably for this purpose; the port-based
  sync targets only extension pages (popup + options).

- **Popup lifecycle**: The popup is destroyed each time it is closed, so it
  will connect on open and disconnect on close naturally. The options page
  persists as a tab and will connect on mount and disconnect on unmount /
  navigation away.

## User Scenarios & Testing

### User Story 1 - Popup toggle pushes to open options page (Priority: P1)

The user has both the popup and the options page open. They toggle "Enable
promo skip" OFF in the popup. Without refreshing or clicking Reload, the
"Enable LLM promo detection" checkbox on the options page unchecks itself
automatically. Toggling it back ON in the popup re-checks the options
checkbox.

**Why this priority**: This is the most common direction of change -- the
popup is the primary quick-access surface, and users expect settings pages
to reflect the current state without manual refresh.

**Independent Test**: Open the options page in a tab, open the popup, toggle
the switch. Observe the options page checkbox updates within ~1 second
without any user interaction on that page.

**Acceptance Scenarios**:

1. **Given** the options page is open and shows "Enable LLM promo detection"
   checked, **When** the user opens the popup and toggles "Enable promo skip"
   OFF, **Then** the options page checkbox unchecks automatically without
   page reload.

2. **Given** the options page is open and shows the checkbox unchecked,
   **When** the user toggles "Enable promo skip" ON in the popup, **Then**
   the options page checkbox checks itself automatically.

3. **Given** the options page is not open, **When** the user toggles the
   popup switch, **Then** no errors occur (the background simply has no
   options-page port connected).

---

### User Story 2 - Options page toggle pushes to open popup (Priority: P1)

The user has the popup open and the options page open in a tab. They toggle
"Enable LLM promo detection" on the options page (by checking/unchecking
and clicking Save, per the current UX). The popup's "Enable promo skip"
switch updates to match without the user closing and re-opening the popup.

**Why this priority**: Equal to P1 because the user's description
explicitly states "vice versa." The popup is short-lived but must
reflect current state while it is visible.

**Independent Test**: Open the popup, open the options page, change the
checkbox, click Save. Observe the popup switch updates within ~1 second.

**Acceptance Scenarios**:

1. **Given** the popup is open showing "Enable promo skip" ON, **When** the
   user unchecks "Enable LLM promo detection" on the options page and saves,
   **Then** the popup switch flips to OFF automatically.

2. **Given** the popup is open showing the switch OFF, **When** the user
   checks the options checkbox and saves, **Then** the popup switch flips
   to ON automatically.

3. **Given** the popup is closed, **When** the user saves a change on the
   options page, **Then** no errors occur (the background has no popup port
   connected).

---

### User Story 3 - Graceful port lifecycle (Priority: P2)

Ports connect when extension pages open and disconnect when they close.
The background handles connection and disconnection without errors,
memory leaks, or orphaned listeners.

**Why this priority**: Robustness requirement; not directly user-visible
but critical for extension stability (especially since the popup opens
and closes frequently).

**Independent Test**: Open and close the popup 20 times rapidly; verify
no errors in the background service-worker console and no memory growth
from accumulated port references.

**Acceptance Scenarios**:

1. **Given** no extension pages are open, **When** the popup opens,
   **Then** the background registers exactly one popup port.

2. **Given** a popup port is connected, **When** the popup closes,
   **Then** the background removes the port reference and the
   `onDisconnect` handler fires without error.

3. **Given** the service worker has been idle and restarts (MV3
   lifecycle), **When** the popup or options page opens, **Then** the
   port connection succeeds after the worker wakes.

---

### Edge Cases

- What happens when the service worker is inactive and a page tries to
  connect? The `runtime.connect` call wakes the service worker; this is
  standard MV3 behavior. The `onConnect` listener must be registered
  synchronously in the top-level service-worker scope.
- What happens if two options tabs are open? Both should receive the update
  (the background maintains a set of connected ports, not a single reference).
- What if `postMessage` is called on a disconnected port? The call is a
  no-op per the WebExtensions spec; the background should still remove
  stale ports via `onDisconnect`.
- What if the popup and options page both change the toggle simultaneously?
  Last-write-wins at the storage layer (existing behavior); the subsequent
  broadcast via ports will converge both UIs to the stored value.

## Requirements

### Functional Requirements

- **FR-001**: The background service worker MUST listen for
  `browser.runtime.onConnect` and accept port connections identified by a
  well-known port name (e.g. `"topskip:prefs"`).

- **FR-002**: The background MUST maintain a collection of connected ports
  and remove them on `port.onDisconnect`.

- **FR-003**: When a preference change is saved (via `SET_PREFS` or
  `SET_OPENROUTER_CONFIG`), the background MUST post the updated
  `UserPreferences` to all currently connected ports.

- **FR-004**: The popup MUST open a port on mount, listen for incoming
  preference messages, and update the MobX `PreferencesStore` accordingly.

- **FR-005**: The popup MUST disconnect the port on unmount (or rely on
  automatic disconnection when the popup DOM is destroyed).

- **FR-006**: The options page MUST open a port on mount, listen for
  incoming preference messages, and update its local `enabled` React state
  accordingly.

- **FR-007**: The options page MUST disconnect the port on unmount.

- **FR-008**: The port message format MUST be typed and distinguishable
  (e.g. `{ type: "PREFS_UPDATED", prefs: UserPreferences }`), reusing the
  existing `TOPSKIP_MESSAGE.PREFS_UPDATED` discriminator where practical.

- **FR-009**: The existing content-script broadcast via
  `PrefsBroadcast.sendUpdatedToAllTabs` MUST remain unchanged; port-based
  sync is an addition, not a replacement, for content-script notification.

- **FR-010**: The feature MUST NOT introduce new extension permissions
  beyond what is already declared in the manifest.

### Key Entities

- **PrefsPort**: A long-lived `browser.runtime.Port` connection between an
  extension page (popup or options) and the background service worker.
  Identified by a fixed port name. Carries preference-update messages from
  the background to connected pages.

- **UserPreferences**: Existing entity (`{ enabled: boolean }`). The
  payload transmitted over the port when preferences change.

## Success Criteria

### Measurable Outcomes

- **SC-001**: When the enabled toggle is changed on one surface (popup or
  options), the other surface reflects the new value within 500 ms, without
  any manual refresh or re-open action by the user.

- **SC-002**: Opening and closing the popup 50 times in succession produces
  zero errors in the service-worker console and zero orphaned port
  references in the background's port collection.

- **SC-003**: The existing unit tests for `PreferencesStore`, `skip-logic`,
  and `page-guards` continue to pass without modification (no regressions).

- **SC-004**: No new permissions are added to `src/manifest.json`.

- **SC-005**: Content-script preference broadcasts (`PrefsBroadcast`) are
  unaffected; toggling the switch still causes active YouTube tabs to
  register/unregister the content script as before.
