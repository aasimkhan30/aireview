import type * as vscode from "vscode";
import {
	AbstractMessageReader,
	AbstractMessageWriter,
	type DataCallback,
	type Disposable,
	type Message,
	type MessageReader,
	type MessageWriter
} from "vscode-jsonrpc/node";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { isRpcEnvelope, rpcEnvelopeKind } from "../common/webviewProtocol";

export class ExtensionWebviewMessageReader extends AbstractMessageReader implements MessageReader {
	constructor(private readonly webview: vscode.Webview) {
		super();
	}

	listen(callback: DataCallback): Disposable {
		const disposable = this.webview.onDidReceiveMessage((message: unknown) => {
			if (isRpcEnvelope(message)) {
				callback(message.payload as Message);
			}
		});

		return { dispose: () => disposable.dispose() };
	}
}

export class ExtensionWebviewMessageWriter extends AbstractMessageWriter implements MessageWriter {
	private errorCount = 0;
	private ended = false;

	constructor(
		private readonly webview: vscode.Webview,
		private readonly diagnostics: IDiagnosticsService,
		private readonly isSessionDisposed: () => boolean
	) {
		super();
	}

	async write(message: Message): Promise<void> {
		try {
			const accepted = await this.webview.postMessage({
				kind: rpcEnvelopeKind,
				payload: message
			});

			if (!accepted) {
				throw new Error("Webview did not accept JSON-RPC message");
			}
		} catch (error) {
			this.errorCount += 1;
			if (!this.ended && !this.isSessionDisposed()) {
				this.diagnostics.error("webview", "rpc.write.failed", error, () => ({ errorCount: this.errorCount }));
			}
			this.fireError(error, message, this.errorCount);
			throw error;
		}
	}

	end(): void {
		this.ended = true;
		this.fireClose();
	}
}
