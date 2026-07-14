import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export interface WebviewContentDefinition {
	readonly title: string;
	readonly scriptPath: readonly string[];
	readonly stylePaths: readonly (readonly string[])[];
	readonly localResourceRootPaths: readonly (readonly string[])[];
}

export function getWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	definition: WebviewContentDefinition
): string {
	const scriptUri = getResourceUri(webview, extensionUri, definition.scriptPath);
	const styleLinks = definition.stylePaths
		.map((path) => `<link rel="stylesheet" href="${getResourceUri(webview, extensionUri, path)}">`)
		.join("\n\t");
	const nonce = randomBytes(16).toString("hex");

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
	${styleLinks}
	<title>${escapeHtml(definition.title)}</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function getLocalResourceRoots(
	extensionUri: vscode.Uri,
	definition: WebviewContentDefinition
): readonly vscode.Uri[] {
	return definition.localResourceRootPaths.map((path) => vscode.Uri.joinPath(extensionUri, ...path));
}

function getResourceUri(webview: vscode.Webview, extensionUri: vscode.Uri, path: readonly string[]): string {
	return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path)).toString();
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		switch (character) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}
