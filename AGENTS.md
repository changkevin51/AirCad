# Project direction

New CAD functionality should be native to AirCAD. FreeCAD is no longer part of the intended project workflow; do not add FreeCAD integration or make new features depend on it. Existing legacy integration files should not be removed without an explicit request.

# Frontend verification

Run these from `web/` before handing off frontend changes:

- `npm test` — Vitest unit suite.
- `npm run build` — typecheck plus the production Vite build.
- `npm run test:ui` — Playwright browser tests. Requires `npm exec -- playwright install chromium` once per machine.

The browser tests mock `/api/tracker` and `/ws`, so no Python server or camera is needed. Review screenshots land in `web/test-results/review/` (regenerated each `test:ui` run — Playwright wipes `test-results` first).
