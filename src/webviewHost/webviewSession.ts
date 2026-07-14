import type * as vscode from "vscode";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import { Disposable, type IDisposable } from "../util/vs/base/common/lifecycle";
import { getLocalResourceRoots, getWebviewHtml, type WebviewContentDefinition } from "./webviewContent";
import { ExtensionWebviewMessageReader, ExtensionWebviewMessageWriter } from "./webviewRpc";
import type { WebviewSurface } from "./webviewSurface";

export interface WebviewSessionOptions {
	readonly extensionUri: vscode.Uri;
	readonly content: WebviewContentDefinition;
	readonly createController: (connection: MessageConnection, surface: WebviewSurface) => IDisposable;
	readonly onDidBecomeVisible?: () => void | Promise<void>;
	readonly onDidDispose?: () => void;
}

/** Owns the content, connection, and disposables for one resolved webview surface. */
export class WebviewSession extends Disposable {
	readonly connection: MessageConnection;
	private disposed = false;

	constructor(
		readonly surface: WebviewSurface,
		private readonly options: WebviewSessionOptions
	) {
		super();

		try {
			surface.webview.options = {
				enableScripts: true,
				localResourceRoots: getLocalResourceRoots(options.extensionUri, options.content)
			};

			this.connection = createMessageConnection(
				new ExtensionWebviewMessageReader(surface.webview),
				new ExtensionWebviewMessageWriter(surface.webview)
			);
			this._register(this.connection);
			this._register(options.createController(this.connection, surface));
			this.connection.listen();

			this._register(
				surface.onDidChangeVisibility(() => {
					if (surface.visible) {
						void this.notifyVisible();
					}
				})
			);
			this._register(surface.onDidDispose(() => this.dispose()));

			surface.webview.html = getWebviewHtml(surface.webview, options.extensionUri, options.content);
		} catch (error) {
			super.dispose();
			throw error;
		}
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		try {
			super.dispose();
		} finally {
			this.options.onDidDispose?.();
		}
	}

	private async notifyVisible(): Promise<void> {
		try {
			await this.options.onDidBecomeVisible?.();
		} catch (error) {
			if (!this.disposed && this.surface.visible) {
				console.error("Failed to refresh visible webview", error);
			}
		}
	}
}
