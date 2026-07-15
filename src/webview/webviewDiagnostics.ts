import type { MessageConnection } from "vscode-jsonrpc/browser";
import {
	DiagnosticsRpc,
	type WebviewDiagnosticData,
	type WebviewDiagnosticInput,
	type WebviewDiagnosticName
} from "../common/diagnosticsProtocol";

export interface WebviewDiagnosticOperation {
	complete(data?: WebviewDiagnosticData): void;
	fail(error: unknown): void;
}

export class WebviewDiagnostics {
	constructor(private readonly connection: MessageConnection) {}

	debug(name: WebviewDiagnosticName, data?: WebviewDiagnosticData): void {
		this.send({ level: "debug", name, data });
	}

	info(name: WebviewDiagnosticName, data?: WebviewDiagnosticData): void {
		this.send({ level: "info", name, data });
	}

	startOperation(
		baseName:
			| "state.load"
			| "state.refresh"
			| "annotation.start"
			| "note.update"
			| "note.delete"
			| "note.reveal"
			| "instructions.update"
			| "bundle.preview"
			| "bundle.copy"
	): WebviewDiagnosticOperation {
		const correlationId = createCorrelationId();
		const startedAt = performance.now();
		let completed = false;
		this.send({ level: "info", name: `${baseName}.started`, correlationId });
		return {
			complete: (data) => {
				if (completed) {
					return;
				}
				completed = true;
				this.send({
					level: "info",
					name: `${baseName}.completed`,
					correlationId,
					durationMs: performance.now() - startedAt,
					data
				});
			},
			fail: (error) => {
				if (completed) {
					return;
				}
				completed = true;
				this.send({
					level: "error",
					name: `${baseName}.failed`,
					correlationId,
					durationMs: performance.now() - startedAt,
					data: toErrorData(error)
				});
			}
		};
	}

	private send(input: WebviewDiagnosticInput): void {
		try {
			const result = this.connection.sendNotification(DiagnosticsRpc.report, input);
			if (result) {
				void result.catch(() => undefined);
			}
		} catch {
			// Diagnostics must never affect the observed webview operation.
		}
	}
}

function toErrorData(error: unknown): WebviewDiagnosticData {
	return error instanceof Error
		? { errorName: error.name, errorMessage: error.message }
		: { errorName: "Error", errorMessage: String(error) };
}

function createCorrelationId(): string {
	if (typeof crypto.randomUUID === "function") {
		return crypto.randomUUID().slice(0, 8);
	}
	return Math.random().toString(16).slice(2, 10);
}
