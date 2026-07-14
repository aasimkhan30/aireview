# Repository Review

Reviewed: 2026-07-14  
Commit: `acb8c3e`

The scaffold is directionally sound, but feature work should pause for a short foundation pass. TypeScript and packaging checks pass, yet there are concurrency, performance, verification, reusable webview infrastructure, state-management, and distribution issues worth fixing now.

## Prioritized findings

| #   | Finding and correction                                                                                                                                                                                                                                                                                                                   | Category                   | Impact                 | Effort | Fix risk | Confidence | Evidence                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------- | ------ | -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Completed 2026-07-14.** `npm run check` now enforces formatting, linting, unit tests, typechecking, a production build, a VS Code 1.125 Extension Host smoke test, and package enumeration. GitHub Actions runs the same gate under Xvfb.                                                                                              | Tests / DX                 | High                   | M      | Low      | High       | [`package.json`](package.json), [`webviewProtocol.test.ts`](src/common/webviewProtocol.test.ts), [`index.cjs`](test/integration/index.cjs), [`ci.yml`](.github/workflows/ci.yml)                                                                                                                     |
| 2   | **Completed 2026-07-14.** Shared `WebviewSession` infrastructure now owns HTML/CSP, resources, JSON-RPC, visibility, and disposal through a surface-neutral contract. `WebviewViewHost` contains only current view-specific registration and reveal behavior; a future panel host can reuse sessions without panel code being added now. | Architecture / DX          | High                   | M      | Medium   | High       | [`webviewSession.ts`](src/webviewHost/webviewSession.ts), [`webviewSurface.ts`](src/webviewHost/webviewSurface.ts), [`webviewViewHost.ts`](src/webviewHost/webviewViewHost.ts)                                                                                                                       |
| 3   | **Completed 2026-07-14.** Review state is host-authoritative and revisioned. Persistence starts with a clean versioned schema and serialized mutations; the browser rejects stale envelopes and persists only its draft with `getState`/`setState`.                                                                                      | Correctness / Architecture | High                   | M      | Medium   | High       | [`reviewStore.ts`](src/review/reviewStore.ts), [`reviewPanelStateService.ts`](src/review/reviewPanelStateService.ts), [`webviewProtocol.ts`](src/common/webviewProtocol.ts), [`App.tsx`](src/webview/reviewPanel/App.tsx)                                                                            |
| 4   | Add a short debounce for high-frequency selection invalidations and cache stable command/branch metadata. The state coordinator now single-flights refreshes, discards computations invalidated while running, and publishes monotonic revisions, but sustained cursor movement can still cause repeated Git and command queries.        | Performance                | Medium                 | S      | Low      | High       | [`reviewPanelStateService.ts`](src/review/reviewPanelStateService.ts)                                                                                                                                                                                                                                |
| 5   | Add verified third-party license notices to the packaged extension. Eleven copied Microsoft files reference a missing root license, while the bundled dependencies' notices are also absent from the five packaged files.                                                                                                                | Distribution / Compliance  | High before publishing | S      | Low      | High       | [`services.ts:1`](src/util/common/services.ts#L1), [`package.json:8`](package.json#L8), [`.vscodeignore:11`](.vscodeignore#L11). Microsoft's MIT license requires its notice to accompany substantial copies: [official VS Code license](https://github.com/microsoft/vscode/blob/main/LICENSE.txt). |
| 6   | **Completed 2026-07-14.** The minimum supported VS Code API, `@types/vscode`, and Extension Host smoke-test target are aligned at `1.125`.                                                                                                                                                                                               | Dependencies / Correctness | Medium                 | S      | Low      | High       | [`package.json`](package.json), [`run-integration-tests.mjs`](scripts/run-integration-tests.mjs). VS Code documents `engines.vscode` as the minimum API and `@types/vscode` as the API declaration in [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy).          |
| 7   | Add explicit loading, retry, and actionable error states for every RPC operation. Refresh, add, and delete failures currently become rejected click-handler promises with no visible recovery path; this work should consume the state architecture from finding #3 rather than create another independent state mechanism.              | Correctness / UX           | Medium                 | S      | Low      | High       | [`App.tsx:55`](src/webview/reviewPanel/App.tsx#L55), [`App.tsx:63`](src/webview/reviewPanel/App.tsx#L63), [`App.tsx:77`](src/webview/reviewPanel/App.tsx#L77)                                                                                                                                        |
| 8   | **Completed 2026-07-14.** Runtime and development dependencies use their latest stable releases, the lockfile installs under npm 10, and the full dependency audit is clean.                                                                                                                                                             | Security / Dependencies    | Medium                 | S      | Medium   | High       | [`package.json`](package.json), [`package-lock.json`](package-lock.json)                                                                                                                                                                                                                             |

Recommended landing order: #1–#3, #6, and #8 are complete. Address the remaining refresh hot path in #4 with regression tests. The license work in #5 must precede any public distribution.

## What is already good

- Strict TypeScript is enabled and `npm run check-types` passes.
- The webview uses a restrictive CSP, local resource roots, React-escaped content, and fixed-argument `execFile`; no credible command-injection, XSS, or credential issue was found.
- `npm audit` reports zero vulnerabilities across production and development dependencies.
- `vsce ls` contains the expected runtime files, and the worktree was clean before this report was added.

## Maintainer architecture decisions

### Retain the VS Code dependency-injection framework

The earlier recommendation to remove the copied VS Code dependency-injection framework has been withdrawn. The framework is an intentional architectural choice and must be preserved by future implementation plans.

Near-term work around the DI code should be limited to tests, license compliance, documenting its upstream provenance, and defining an update strategy. Extracting it into a standalone npm package is a possible future project and should receive its own API, packaging, compatibility, and release plan rather than being folded into extension cleanup.

## Product-direction decisions to make soon

### Introduce an explicit review-session model

The README promises session detection, but storage is currently a flat note array with transient branch/file context. Capturing repository identity, revision/base, and stable source anchors now avoids a difficult persistence migration later.

### Define an agent-adapter boundary

Define this boundary before enabling **Send bundle**. Agent detection and external command IDs are currently embedded in the panel service, while the UI already anticipates multiple targets. A small capability/handoff interface would isolate Codex and Copilot contract changes.

## Verification performed

- `npm run check` — passed on 2026-07-14.
- Formatting and ESLint — passed with zero warnings.
- Vitest — seven unit cases passed.
- VS Code 1.125 Extension Host — extension activation and public command registration passed.
- TypeScript and the production build — passed.
- `vsce ls` — passed and listed the expected five runtime files.
- `npm audit --omit=dev --json` — zero production vulnerabilities.
- Full `npm audit --json` — zero vulnerabilities.

## Audit scope and limitations

All tracked source and configuration files were reviewed. The package lock was assessed through npm's dependency and audit tooling rather than line by line. The Extension Development Host was not launched manually, and generated assets were not rebuilt during the read-only audit.

## Recommended planning scope

Each remaining finding is deliberately separable so it can be reviewed and implemented one at a time. No plan should remove or replace the VS Code dependency-injection framework. Finding #4 can now build on the state coordinator; #5 and #7 remain independent compliance and UX passes.
