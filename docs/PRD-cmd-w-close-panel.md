# PRD: Cmd+W Close Panel & Focused Panel Border

## Problem Statement

The Cmd+W keyboard shortcut does not close the currently focused panel pane. Instead, Tauri intercepts it at the native window level and hides the entire window to the system tray. Users expect Cmd+W to close the thing they're looking at — the active pane — matching the mental model from browsers (close tab), IDEs (close editor tab), and terminal multiplexers (close pane).

Additionally, the active pane's visual indicator (`ring-2 ring-primary ring-inset`) is glitched — the ring does not render fully around all edges of the pane, making it unclear which pane is currently focused. Users need a reliable visual cue to know which pane Cmd+W (and other pane-scoped shortcuts) will act on.

Finally, when all panels have been closed (no panes remaining), pressing Cmd+W again should present a confirmation dialog asking whether the user wants to close the app (hide to tray), rather than silently doing nothing.

## Solution

1. **Cmd+W closes the active pane**: Register Cmd+W as a direct keyboard shortcut (not a tmux-style prefix sequence) in the web layer. When pressed, it closes the currently focused pane — identical to the existing Ctrl+B, X behavior. The Tauri native window close intercept must be updated so that Cmd+W is consumed by the web layer before reaching the native handler.

2. **Focused pane border**: Replace the glitched `ring-2 ring-primary ring-inset` with a solid `border-2 border-primary` on the active pane. The border must render reliably on all four edges regardless of pane position in the layout tree (first child, last child, nested splits). Every pane always has a focused state or not — there is always exactly one focused pane whenever at least one pane exists.

3. **Close-app confirmation dialog**: When there are no panes and the user presses Cmd+W, show an AlertDialog asking "Close Laborer?" with Cancel and Close actions. The Close action hides the window to the system tray (consistent with the existing close-to-tray behavior). The dialog uses the existing `alert-dialog.tsx` component.

## User Stories

1. As a user, I want Cmd+W to close the pane I'm focused on, so that I can quickly dismiss panes without needing a tmux-style prefix key.
2. As a user, I want to see a clear colored border around the focused pane, so that I always know which pane keyboard shortcuts will act on.
3. As a user, I want the focused-pane border to render correctly on all four edges, so that the visual indicator is not confusing or broken.
4. As a user, I want focus to automatically move to the nearest sibling pane after closing a pane, so that I always have a focused pane and can continue working without clicking.
5. As a user, I want there to always be exactly one focused pane (when panes exist), so that Cmd+W and other pane shortcuts always have a clear target.
6. As a user, I want Cmd+W to show a confirmation dialog when no panes exist, so that I don't accidentally hide the app window.
7. As a user, I want the confirmation dialog's "Close" action to hide the window to tray (not quit), so that my workspaces keep running in the background.
8. As a user, I want the confirmation dialog to have a "Cancel" option, so that I can dismiss it if I pressed Cmd+W by accident.
9. As a user, I want Cmd+W to work even when focus is inside an xterm.js terminal, so that the shortcut works universally regardless of which pane type is focused.
10. As a user, I want Cmd+W to close empty panes (panes with no terminal assigned), so that I can clean up unused panes.
11. As a user, I want the existing Ctrl+B, X shortcut to continue working alongside Cmd+W, so that both interaction styles are supported.
12. As a user, I want the border style to be consistent across all pane types (terminal, diff, empty), so that the visual indicator looks the same everywhere.
13. As a user, I want the active pane to not flicker or lose its border during layout transitions (split, close, resize), so that the focused state feels stable.

## Polishing Requirements

1. Verify the border renders correctly at all split nesting depths (1 through 5+).
2. Verify the border does not overlap or conflict with ResizableHandle drag handles.
3. Verify Cmd+W works after multiple rapid presses (closing several panes in succession).
4. Verify the close-app AlertDialog can be dismissed with Escape or clicking Cancel.
5. Verify the close-app AlertDialog does not appear when there is at least one pane.
6. Verify focus auto-transfer works when closing the only child in a nested split (tree collapse scenario).
7. Verify the border disappears when no panes exist (empty layout state).
8. Verify the drag-over drop target highlight still works correctly on empty panes alongside the new border style.
9. Verify that Cmd+W does not interfere with Cmd+W in web inspector or dev tools when they are focused.

## Implementation Decisions

### Module 1: Tauri Cmd+W interception

The Rust `on_window_event` handler currently intercepts all `CloseRequested` events (including Cmd+W) and hides the window. This must be changed so that Cmd+W is handled by the web layer for panel close, not by the native layer.

**Approach**: Register a Tauri menu accelerator or use `tauri-plugin-global-shortcut` to intercept Cmd+W before it triggers the native `CloseRequested` event. When pressed, emit a Tauri event to the webview (e.g., `"close-active-pane"`) that the React app listens for. This keeps the native close button (red dot) behavior unchanged — it still hides to tray — while Cmd+W is redirected to the web layer.

Alternative: Use `window.addEventListener("keydown")` in the web layer to catch Cmd+W (Meta+W) before it propagates to the native handler. If the web layer calls `event.preventDefault()` on the keydown, Tauri may not forward it to the native close handler. This approach is simpler but needs verification that Tauri respects `preventDefault()` on Meta+W in the webview.

The simpler approach (web-layer keydown listener with `preventDefault`) should be tried first. If Tauri still fires `CloseRequested` despite `preventDefault()`, fall back to the Rust-side approach.

### Module 2: Cmd+W keyboard shortcut registration

Register Cmd+W (Meta+W) as a direct keyboard shortcut using `@tanstack/react-hotkeys`. This is a single-key shortcut, not a tmux-style prefix sequence, so use `useHotkey` (not `useHotkeySequence`).

The handler logic:
1. Get the current `activePaneId` from context.
2. If an active pane exists, call `actions.closePane(activePaneId)`.
3. If no active pane exists (no panes in layout), open the close-app confirmation dialog.

This shortcut must also work when xterm.js has focus. The existing terminal key event handler (`attachCustomKeyEventHandler`) already intercepts Ctrl+B for prefix mode. Meta+W needs similar treatment — the terminal's custom key handler should detect Meta+W and return `false` to prevent xterm.js from consuming it, letting it bubble to the document-level hotkey handler.

### Module 3: Focus auto-transfer on pane close

When a pane is closed, the new active pane should be the nearest sibling in the same parent split. The `closePane` function in `layout-utils.ts` already handles tree manipulation. The focus transfer logic should be added to the `handleClosePane` callback in the route component:

1. Before calling `closePane()`, find the sibling leaf IDs in the parent split of the closing pane.
2. After closing, set `activePaneId` to the nearest sibling. If the closing pane was the first child, focus the next sibling. If it was the last or middle child, focus the previous sibling.
3. If no siblings exist (closing the last pane), set `activePaneId` to `null`.

A new utility function `findSiblingPaneId(root, paneId)` in `layout-utils.ts` will resolve the target pane ID before the close operation mutates the tree.

### Module 4: Focused pane border replacement

Replace the glitched `ring-2 ring-primary ring-inset` CSS classes on the active pane with `border-2 border-primary`. Non-active panes should have `border-2 border-transparent` to maintain consistent sizing (preventing layout shift when focus changes).

The change is in `LeafPaneRenderer` in `panel-manager.tsx`. The existing conditional class logic:
```
isActive ? "ring-2 ring-primary ring-inset" : ""
```
becomes:
```
isActive ? "border-2 border-primary" : "border-2 border-transparent"
```

The drag-over highlight state should similarly switch from ring to border, ensuring visual consistency.

### Module 5: Close-app confirmation AlertDialog

A new component (or inline JSX in the route component) renders an AlertDialog that is opened programmatically when Cmd+W is pressed with no panes. Uses controlled `open` state — no trigger button needed since the dialog is opened from the keyboard handler.

Dialog content:
- Title: "Close Laborer?"
- Description: "The window will be hidden to the system tray. Your workspaces will continue running."
- Actions: "Cancel" (dismisses) and "Close" (hides window to tray via `window.__TAURI_INTERNALS__` invoke or `@tauri-apps/api/window` hide)

The dialog follows the existing destructive confirmation pattern used by project removal, workspace destruction, and task removal.

### Module 6: Guaranteed active pane invariant

Ensure the invariant: "there is always exactly one focused pane when at least one pane exists." This means:

- On initial layout seed, set `activePaneId` to the first leaf pane ID.
- On pane close, auto-transfer focus (Module 3).
- On layout restore (persisted from LiveStore), validate `activePaneId` points to an existing leaf; if not, fall back to the first leaf.
- The `handleSetActivePaneId` function should not accept `null` when panes exist.

## Testing Decisions

### What makes a good test

Tests should verify external behavior from the user's perspective, not implementation details. Test the result of operations on the layout tree (what the user sees), not internal state management. Prefer testing through the pure utility functions rather than rendering full React component trees.

### Modules to test

1. **`findSiblingPaneId` utility** (layout-utils.ts): Test that closing any pane in various tree configurations returns the correct sibling ID. Test edge cases: closing first child, last child, middle child, deeply nested pane, single-leaf root. This is a pure function — easy to test in isolation.

2. **Close-pane focus transfer integration**: Test that after `closePane` + focus transfer, the `activePaneId` is set to the expected sibling. Can be tested as a unit test on the combined logic without rendering React components.

3. **Active pane invariant validation**: Test that `activePaneId` is always set to a valid leaf ID after any layout operation (seed, close, restore).

### Prior art

The existing `layout-utils.test.ts` tests `splitPane`, `closePane`, `findPaneInDirection`, `computeResize`, and `getLeafIds` with various tree configurations. The new `findSiblingPaneId` tests should follow the same pattern: construct a tree, call the function, assert the result.

## Out of Scope

- **Cmd+T to open new pane**: Not part of this PRD. Users can still split panes via Ctrl+B,H / Ctrl+B,V.
- **Tab-style pane header bar**: No per-pane close buttons or tab strips. Close is via keyboard only (Cmd+W or Ctrl+B,X) plus the existing close button in the top-level PanelHeaderBar.
- **Cmd+Shift+W to close all panes**: Not included. Close-all would be a separate feature.
- **Animated pane transitions**: Pane close/focus transitions are instant. No animation.
- **Quit confirmation (Cmd+Q)**: The existing Cmd+Q behavior (quit via Tauri default) is not changed. Only Cmd+W when no panes triggers the close-to-tray dialog.

## Further Notes

- The Tauri `CloseRequested` intercept (hide-to-tray) must remain functional for the native window close button (red dot on macOS). Only the Cmd+W keyboard path is being redirected to the web layer.
- The existing Ctrl+B, X tmux-style shortcut is not being removed. Both Cmd+W and Ctrl+B, X will close the active pane. Ctrl+B, X does not trigger the close-app dialog when no panes exist (it simply does nothing, matching its current behavior).
- The app only runs as a Tauri desktop app; browser compatibility is not a concern.
