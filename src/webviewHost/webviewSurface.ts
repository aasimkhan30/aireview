import type * as vscode from "vscode";
import type { IDisposable } from "../util/vs/base/common/lifecycle";

/**
 * Lifecycle shared by VS Code webview views and webview panels.
 * Surface-specific creation, reveal, and serialization remain in their hosts.
 */
export interface WebviewSurface {
	readonly webview: vscode.Webview;
	readonly visible: boolean;
	onDidChangeVisibility(listener: () => void): IDisposable;
	onDidDispose(listener: () => void): IDisposable;
}
