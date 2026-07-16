# Development

This guide is for maintainers and contributors working on Request Changes.

## Architecture

The extension and MCP process share a revisioned, atomically written review ledger. Webview clients receive snapshots over typed JSON-RPC, and native comment threads are projections of the same state rather than a second store. A file watcher publishes MCP status changes back into the native comments and webview.

Review data is private user data, not repository content. Each canonical workspace root gets a hashed directory under:

- macOS: `~/Library/Application Support/Request Changes`
- Windows: `%LOCALAPPDATA%/Request Changes`
- Linux: `$XDG_STATE_HOME/request-changes` or `~/.local/state/request-changes`

Set `REQUEST_CHANGES_DATA_DIR` to override the location.

Review comments use versioned anchors containing their URI, range, selected-text hash, and bounded surrounding context. Anchors are reconciled when documents open or change; moved comments are reattached, while deleted or ambiguous selections are retained as orphaned comments.

Reusable webview infrastructure is split between a surface-neutral `WebviewSession`, the sidebar `WebviewViewHost`, and a `WebviewPanelHost` used by Settings. HTML, CSP, resource, transport, visibility, and disposal behavior remain shared.

## Local setup

Use Node.js 26, then install the locked dependencies:

```powershell
npm ci
```

Press `F5` in VS Code to launch an Extension Development Host.

## Verification

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

## Demo data

Maintainers can recreate all review data with `npm run seed:development` in `~/src/pulseboard-demo`, then launch **Run Extension with Screenshot Demo** from this repository.

## Agent integration details

Open **Request Changes: Open Settings** or use the gear in the Review Comments view. The settings panel:

- installs or removes the MCP server for Codex, Claude Code, and GitHub Copilot CLI at Workspace or User scope;
- shows the MCP server that the extension registers automatically for GitHub Copilot in VS Code;
- configures user-level default instructions and an optional workspace override; and
- shows the private review ledger and bundled server locations.

The integration grid tracks Workspace and User scope independently. Request Changes only removes configuration entries it manages; externally configured entries are identified and can be opened for manual editing without being overwritten.

The MCP server exposes one read tool named `requestchanges`, status tools for claiming and reporting comments, resources for open and individual comments, and an `address_review_comments` prompt. Its server instructions tell clients not to use Request Changes unless the user explicitly asks for it.

## Publishing

The [Publish VS Code Marketplace](.github/workflows/publish.yml) workflow has separate preview and stable channels. Every publication passes the full verification gate, builds a downloadable VSIX artifact and standalone MCP server, and only then authenticates to the Marketplace. A successful Marketplace publication creates a matching GitHub release containing both `request-changes[-preview]-<version>.vsix` and the directly runnable `requestchanges-mcp-<version>.js` asset.

Preview releases run daily at 08:17 UTC when `main` has changed since the last successful preview. Choose **preview** in the manual workflow to publish the current `main` commit even when it already has a preview. Preview versions encode an ephemeral UTC timestamp as `YYYYMMDD.HHmmss.0`, with the numeric time component omitting any leading zero. For example, `20260715.30004.0` represents 03:00:04 UTC. Neither `package.json` nor `package-lock.json` is committed. Splitting the timestamp keeps every component within Visual Studio Marketplace's numeric limit. Because these versions sort above the stable `0.0.x` line, preview users intentionally remain on the preview track. Their GitHub releases use `preview-v<version>` tags and are marked as prereleases.

Stable releases only run manually. Choose **stable** to increment the committed patch version (`0.0.1` to `0.0.2` to `0.0.3`), verify it, commit and tag the version, publish it, and create a GitHub release containing the VSIX and MCP server. A prepared tag without a GitHub release is treated as an interrupted publication and safely retried instead of bumping again.

Publishing uses Microsoft Entra workload identity federation instead of a long-lived Personal Access Token. One-time setup is required:

1. Create the `aasimkhan30` Visual Studio Marketplace publisher and authorize a Microsoft Entra managed identity as a Contributor.
2. Configure that identity to trust this repository's `vscode-marketplace-preview` and `vscode-marketplace` GitHub environments through OIDC.
3. Add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` as repository variables available to both environments.
4. Leave `vscode-marketplace-preview` automatic. Add required reviewers to `vscode-marketplace` so stable publishing needs explicit approval.
5. Allow the workflow's GitHub Actions token to push the stable version commit and tag to `main`, including any necessary branch-protection exception.

See the official [secure automated publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) and [GitHub OIDC with Azure](https://docs.github.com/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-azure) setup guides.

## Diagnostics

The extension creates the `Request Changes` VS Code log channel before initializing dependency injection. Selected events are sent both to that channel and to one NDJSON artifact for each activation. Artifact failures do not prevent activation, and individual sink failures are isolated.

Launch-time environment variables control capture:

```jsonc
"env": {
  "REQUEST_CHANGES_LOG_LEVEL": "debug",
  "REQUEST_CHANGES_LOG_AREAS": "lifecycle,diagnostics,reviewStore,reviewState,git,commands,webview",
  "REQUEST_CHANGES_LOG_DIRECTORY": ".artifacts",
  "REQUEST_CHANGES_LOG_FILE": "{runId}.ndjson"
}
```

- `REQUEST_CHANGES_LOG_LEVEL` accepts `trace`, `debug`, `info`, `warn`, `error`, or `off` and defaults to `info`.
- `REQUEST_CHANGES_LOG_AREAS` is a comma-separated allowlist and defaults to every known area.
- `REQUEST_CHANGES_LOG_DIRECTORY` may be absolute or relative to the extension directory and defaults to `.artifacts`.
- `REQUEST_CHANGES_LOG_FILE` must be a basename ending in `.ndjson`. It supports `{runId}`, `{timestamp}`, and `{pid}` tokens. A run ID is appended when the template omits `{runId}` so activations never overwrite one another.

The newest 20 artifacts for a filename pattern are retained. Payloads are lazy, bounded, and sanitized before either sink receives an event; review bodies, content-like fields, credentials, environment data, and absolute user paths are not recorded.
