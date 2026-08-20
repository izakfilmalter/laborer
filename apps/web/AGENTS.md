# Web App

`apps/web/` is the React 19 mission-control interface, used in the browser and inside the Electron shell.

- Keep service access behind typed Effect RPC clients and contracts from `packages/shared`; React components must not depend on server or Electron internals.
- Derive values during render when possible. Use effects only to synchronize with external systems.
- React 19 accepts `ref` as a prop; follow that convention instead of introducing `forwardRef`.
- Preserve semantic HTML, keyboard access, labels, focus behavior, and meaningful image alternatives.

## Haptics

Every haptic in the app comes from one module, `packages/ui/src/lib/haptics.ts`. Import the semantic method; never call `trigger()` with a raw preset name.

```tsx
import { haptics } from '@laborer/ui/lib/haptics'

haptics.press() // primary action committed
```

### Which haptic for which action

Method names encode intent, presets encode feel. Several intents deliberately share a preset so the texture can be retuned in one place later.

| Action                                              | Method               | Preset      |
| --------------------------------------------------- | -------------------- | ----------- |
| Primary/commit button — submit, confirm, create      | `press()`            | `medium`    |
| Secondary, outline, ghost, link button; menu item    | `tap()`              | `light`     |
| Destructive or irreversible action                   | `heavyImpact()`      | `heavy`     |
| Slider release, drag-and-drop snap into place        | `commit()`           | `medium`    |
| Switch, checkbox, radio, toggle, tab, segment        | `selection()`        | `selection` |
| Dialog, sheet, drawer opening                        | `dialogOpen()`       | `medium`    |
| Overlay closing or swiped away                       | `dismiss()`          | `soft`      |
| Accordion/collapsible opening                        | `expand()`           | `soft`      |
| Accordion/collapsible closing                        | `collapse()`         | `light`     |
| Operation succeeded, `toast.success`                 | `success()`          | `success`   |
| Attention advised, `toast.warning`, alert dialog     | `warning()`          | `warning`   |
| Operation failed, `toast.error`                      | `error()`            | `error`     |
| Agent needs attention / waiting for input            | `notification()`     | `nudge`     |
| Clipboard copy confirmed                             | `copy()`             | `rigid`     |
| Terminal/agent spawn, workspace creation             | `spawn()`            | `soft`      |
| Sidecar service crash                                | `crash()`            | `buzz`      |

### Rules

- **One gesture, one haptic.** Triggers within 50ms of each other are coalesced, so a `Button` nested in a `DialogTrigger` fires once. Declare the feedback a component deserves without checking what wraps it; the first haptic wins.
- **Outcomes outrank acknowledgements.** `success`, `warning`, `error`, `notification`, and `crash` interrupt an impact or selection pattern already playing, so an optimistic save still feels like a success rather than a plain tap.
- **Shared primitives already handle themselves.** `Button`, `Switch`, `Checkbox`, `RadioGroup`, `Toggle`, `ToggleGroup`, `Tabs`, `Slider`, `Select`, `Dialog`, `AlertDialog`, `Sheet`, `Drawer`, `Accordion`, `Collapsible`, and the menu components fire the right haptic on their own. Do not add a second one at the call site.
- **Raw `<button>` elements get a baseline `tap()`** from `installInteractiveTapFallback()` in `main.tsx`. Opt out with `data-haptic="off"`.
- **Fire on the result, not the request.** For async work, trigger `success()`/`error()` when the outcome lands, synced with the visual change.
- **Never let a haptic be the only feedback.** Desktop hardware cannot vibrate, and the pattern is silently dropped before the user's first interaction with the page.
- **Do not tick every step of a drag.** Continuous vibration is the anti-pattern; mark the moment the value lands instead (see `Slider`).
