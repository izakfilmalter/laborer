# Web App

`apps/web/` is the React 19 mission-control interface, used in the browser and inside the Electron shell.

- Keep service access behind typed Effect RPC clients and contracts from `packages/shared`; React components must not depend on server or Electron internals.
- Derive values during render when possible. Use effects only to synchronize with external systems.
- React 19 accepts `ref` as a prop; follow that convention instead of introducing `forwardRef`.
- Preserve semantic HTML, keyboard access, labels, focus behavior, and meaningful image alternatives.
