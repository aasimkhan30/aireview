# AI Review Router

AI Review Router is a VS Code extension and local MCP server for collecting code-change review notes and handing them to Codex, Claude Code, GitHub Copilot CLI, or GitHub Copilot in VS Code.

Select code in the editor and run **AI Review: Add Note to Selection** (or use the comment gutter) to create an inline review note. Notes stay synchronized between native VS Code comment threads and the AI Review sidebar, where they can be grouped, edited, resolved, previewed as a structured implementation bundle, and handed off to Codex or Copilot.

Agents read annotations through the bundled MCP server, edit code with their normal coding tools, and report notes as **Addressed** or **Blocked**. Addressed notes remain visible until a person accepts and resolves them.

Type `#` in a new or edited AI Review comment to select a note type from completion suggestions: `#aireview:change`, `#aireview:question`, `#aireview:explain`, or `#aireview:addTest`. The directive is removed when the note is saved; new comments without one default to **Change**, while edited comments keep their existing type. Types can also be changed from the Review Notes webview.

## Agent integrations

Open **AI Review: Open Settings** or use the gear in the Review Notes view. The settings panel:

- installs or removes the MCP server for Codex, Claude Code, and GitHub Copilot CLI at Workspace or User scope;
- shows the MCP server that the extension registers automatically for GitHub Copilot in VS Code;
- configures user-level default instructions and an optional workspace override; and
- shows the private review ledger and bundled server locations.

The integration grid tracks Workspace and User scope independently. AI Review only removes configuration entries it manages; externally configured entries are identified and can be opened for manual editing without being overwritten.

Explicitly invoke AI Review when you want an agent to address comments:

- GitHub Copilot in VS Code: `Fix the open comments with #aireview`
- Claude Code: run `/mcp__aireview__fix_review` or ask it to use `aireview`
- Codex or GitHub Copilot CLI: `Use aireview to fix the open review comments`

The MCP server exposes one read tool named `aireview`, status tools for claiming and reporting notes, resources for open and individual annotations, and a `fix_review` prompt. Its server instructions tell clients not to use AI Review unless the user explicitly asks for it.

## Architecture

The extension and MCP process share a revisioned, atomically written review ledger. Webview clients receive snapshots over typed JSON-RPC, and native comment threads are projections of the same state rather than a second store. A file watcher publishes MCP status changes back into the native comments and webview.

Review data is private user data, not repository content. Each canonical workspace root gets a hashed directory under:

- macOS: `~/Library/Application Support/AIReview`
- Windows: `%LOCALAPPDATA%/AIReview`
- Linux: `$XDG_STATE_HOME/aireview` or `~/.local/state/aireview`

Set `AIREVIEW_DATA_DIR` to override the location.

Review notes use versioned anchors containing their URI, range, selected-text hash, and bounded surrounding context. Anchors are reconciled when documents open or change; moved notes are reattached and deleted or ambiguous selections are retained as orphaned notes. Previous workspace-state versions migrate into the shared ledger without discarding note text or instructions.

Reusable webview infrastructure is split between a surface-neutral `WebviewSession`, the sidebar `WebviewViewHost`, and a `WebviewPanelHost` used by Settings. HTML, CSP, resource, transport, visibility, and disposal behavior remain shared.

## Development

Use Node.js 26, then install the locked dependencies:

```powershell
npm ci
```

Press `F5` in VS Code to launch an Extension Development Host.

Before submitting a change, run the complete local verification gate:

```powershell
npm run check
```

The gate checks formatting and linting, runs unit tests, type-checks and builds the production bundles, exercises the MCP server over stdio, launches a VS Code 1.125 Extension Host smoke test, and validates the packaged file list. The first integration-test run downloads the configured VS Code version into `.vscode-test/`.

Useful focused commands:

```powershell
npm run format
npm run lint
npm run test:unit
npm run test:unit:watch
npm run test:integration
npm run compile
```

## Diagnostics

The extension creates the `AI Review` VS Code log channel before initializing dependency injection. Selected events are sent both to that channel and to one NDJSON artifact for each activation. Artifact failures do not prevent activation, and individual sink failures are isolated.

Launch-time environment variables control capture:

```jsonc
"env": {
  "AIREVIEW_LOG_LEVEL": "debug",
  "AIREVIEW_LOG_AREAS": "lifecycle,diagnostics,reviewStore,reviewState,git,commands,webview",
  "AIREVIEW_LOG_DIRECTORY": ".artifacts",
  "AIREVIEW_LOG_FILE": "{runId}.ndjson"
}
```

- `AIREVIEW_LOG_LEVEL` accepts `trace`, `debug`, `info`, `warn`, `error`, or `off` and defaults to `info`.
- `AIREVIEW_LOG_AREAS` is a comma-separated allowlist and defaults to every known area.
- `AIREVIEW_LOG_DIRECTORY` may be absolute or relative to the extension directory and defaults to `.artifacts`.
- `AIREVIEW_LOG_FILE` must be a basename ending in `.ndjson`. It supports `{runId}`, `{timestamp}`, and `{pid}` tokens. A run ID is appended when the template omits `{runId}` so activations never overwrite one another.

The newest 20 artifacts for a filename pattern are retained. Payloads are lazy, bounded, and sanitized before either sink receives an event; review bodies, content-like fields, credentials, environment data, and absolute user paths are not recorded.
