import {
	AbstractMessageReader,
	AbstractMessageWriter,
	createMessageConnection,
	type DataCallback,
	type Disposable,
	type Message,
	type MessageConnection,
	type MessageReader,
	type MessageWriter
} from "vscode-jsonrpc/browser";
import { isRpcEnvelope, rpcEnvelopeKind } from "../common/webviewProtocol";
import { getVsCodeApi } from "./vscodeApi";

export function createWebviewConnection(): MessageConnection {
	return createMessageConnection(new WebviewMessageReader(), new WebviewMessageWriter());
}

class WebviewMessageReader extends AbstractMessageReader implements MessageReader {
	listen(callback: DataCallback): Disposable {
		const listener = (event: MessageEvent<unknown>) => {
			if (isRpcEnvelope(event.data)) {
				callback(event.data.payload as Message);
			}
		};

		window.addEventListener("message", listener);
		return { dispose: () => window.removeEventListener("message", listener) };
	}
}

class WebviewMessageWriter extends AbstractMessageWriter implements MessageWriter {
	private errorCount = 0;

	async write(message: Message): Promise<void> {
		try {
			getVsCodeApi().postMessage({ kind: rpcEnvelopeKind, payload: message });
		} catch (error) {
			this.errorCount += 1;
			this.fireError(error, message, this.errorCount);
			throw error;
		}
	}

	end(): void {
		this.fireClose();
	}
}
