# AI Review Router

AI Review Router is a VS Code extension for collecting code-change review notes and sending them to an implementation agent such as Codex or GitHub Copilot Chat.

This repository currently contains the initial extension scaffold. The review capture, session detection, and agent handoff flows will be added incrementally.

## Development

Use Node.js 22.13 or newer, then install the locked dependencies:

```powershell
npm ci
```

Press `F5` in VS Code to launch an Extension Development Host.

Before submitting a change, run the complete local verification gate:

```powershell
npm run check
```

The gate checks formatting and linting, runs unit tests, type-checks and builds the production bundles, launches a VS Code 1.125 Extension Host smoke test, and validates the packaged file list. The first integration-test run downloads the configured VS Code version into `.vscode-test/`.

Useful focused commands:

```powershell
npm run format
npm run lint
npm run test:unit
npm run test:unit:watch
npm run test:integration
npm run compile
```
