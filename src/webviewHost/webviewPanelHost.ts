import * as vscode from "vscode";
import type { MessageConnection } from "vscode-jsonrpc/node";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { Disposable, type IDisposable } from "../util/vs/base/common/lifecycle";
import type { WebviewContentDefinition } from "./webviewContent";
import { WebviewSession } from "./webviewSession";
import type { WebviewSurface } from "./webviewSurface";

export interface WebviewPanelHostOptions {
	readonly viewType: string;
	readonly title: string;
	readonly extensionUri: vscode.Uri;
	readonly diagnostics: IDiagnosticsService;
	readonly content: WebviewContentDefinition;
	readonly createController: (connection: MessageConnection, surface: WebviewSurface) => IDisposable;
}

/** Owns one reusable WebviewPanel while delegating content and RPC lifecycle to WebviewSession. */
export class WebviewPanelHost extends Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private session: WebviewSession | undefined;

	constructor(private readonly options: WebviewPanelHostOptions) {
		super();
	}

	show(): void {
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.Active, false);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			this.options.viewType,
			this.options.title,
			vscode.ViewColumn.Active,
			{ enableFindWidget: true, retainContextWhenHidden: true }
		);
		this.panel = panel;
		const surface = new WebviewPanelSurface(panel);
		const session = new WebviewSession(surface, {
			extensionUri: this.options.extensionUri,
			diagnostics: this.options.diagnostics,
			content: this.options.content,
			createController: this.options.createController,
			onDidDispose: () => {
				if (this.session === session) {
					this.session = undefined;
					this.panel = undefined;
				}
			}
		});
		this.session = session;
	}

	override dispose(): void {
		this.session?.dispose();
		this.panel?.dispose();
		this.session = undefined;
		this.panel = undefined;
		super.dispose();
	}
}

class WebviewPanelSurface implements WebviewSurface {
	constructor(private readonly panel: vscode.WebviewPanel) {}

	get webview(): vscode.Webview {
		return this.panel.webview;
	}

	get visible(): boolean {
		return this.panel.visible;
	}

	onDidChangeVisibility(listener: () => void): vscode.Disposable {
		return this.panel.onDidChangeViewState(listener);
	}

	onDidDispose(listener: () => void): vscode.Disposable {
		return this.panel.onDidDispose(listener);
	}
}
