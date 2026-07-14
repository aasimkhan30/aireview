import * as vscode from "vscode";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { Disposable, type IDisposable } from "../util/vs/base/common/lifecycle";
import type { WebviewContentDefinition } from "./webviewContent";
import { WebviewSession } from "./webviewSession";
import type { WebviewSurface } from "./webviewSurface";

export interface WebviewViewHostOptions {
	readonly viewId: string;
	readonly extensionUri: vscode.Uri;
	readonly diagnostics: IDiagnosticsService;
	readonly content: WebviewContentDefinition;
	readonly retainContextWhenHidden?: boolean;
	readonly createController: (connection: MessageConnection, surface: WebviewSurface) => IDisposable;
	readonly onDidBecomeVisible?: () => void | Promise<void>;
}

/** VS Code WebviewView-specific owner. Shared content and RPC behavior live in WebviewSession. */
export class WebviewViewHost extends Disposable implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private session: WebviewSession | undefined;

	constructor(private readonly options: WebviewViewHostOptions) {
		super();
		this._register(
			vscode.window.registerWebviewViewProvider(options.viewId, this, {
				webviewOptions: { retainContextWhenHidden: options.retainContextWhenHidden ?? false }
			})
		);
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken
	): void {
		if (token.isCancellationRequested) {
			this.options.diagnostics.debug("webview", "view.resolve.cancelled");
			return;
		}

		this.session?.dispose();
		this.view = webviewView;
		const surface = new WebviewViewSurface(webviewView);
		const session = new WebviewSession(surface, {
			extensionUri: this.options.extensionUri,
			diagnostics: this.options.diagnostics,
			content: this.options.content,
			createController: this.options.createController,
			onDidBecomeVisible: this.options.onDidBecomeVisible,
			onDidDispose: () => {
				if (this.session === session) {
					this.session = undefined;
					this.view = undefined;
				}
			}
		});
		this.session = session;
		this.options.diagnostics.info("webview", "view.resolved");
	}

	show(preserveFocus = false): boolean {
		if (!this.view) {
			return false;
		}

		this.view.show(preserveFocus);
		this.options.diagnostics.debug("webview", "view.shown", () => ({ preserveFocus }));
		return true;
	}

	override dispose(): void {
		this.session?.dispose();
		this.session = undefined;
		this.view = undefined;
		super.dispose();
	}
}

class WebviewViewSurface implements WebviewSurface {
	constructor(private readonly view: vscode.WebviewView) {}

	get webview(): vscode.Webview {
		return this.view.webview;
	}

	get visible(): boolean {
		return this.view.visible;
	}

	onDidChangeVisibility(listener: () => void): vscode.Disposable {
		return this.view.onDidChangeVisibility(listener);
	}

	onDidDispose(listener: () => void): vscode.Disposable {
		return this.view.onDidDispose(listener);
	}
}
