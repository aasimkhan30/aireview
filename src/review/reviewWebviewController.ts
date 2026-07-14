import type { MessageConnection } from "vscode-jsonrpc/node";
import { DiagnosticsRpc, normalizeWebviewDiagnosticInput } from "../common/diagnosticsProtocol";
import { ReviewRpc } from "../common/reviewProtocol";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { Disposable } from "../util/vs/base/common/lifecycle";
import type { IReviewPanelStateService } from "./reviewPanelStateService";
import { normalizeAddReviewNoteParams, normalizeDeleteReviewNoteParams } from "./reviewValidation";

/** Binds one webview session to the shared, host-authoritative review state. */
export class ReviewWebviewController extends Disposable {
	private disposed = false;

	constructor(
		private readonly connection: MessageConnection,
		private readonly stateService: IReviewPanelStateService,
		private readonly isVisible: () => boolean,
		private readonly diagnostics: IDiagnosticsService
	) {
		super();
		this._register(
			connection.onRequest(ReviewRpc.getState, () => this.runRequest("state.get", () => stateService.refresh()))
		);
		this._register(
			connection.onRequest(ReviewRpc.addNote, (params: unknown) =>
				this.runRequest("note.add", () => stateService.addNote(normalizeAddReviewNoteParams(params)))
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.deleteNote, (params: unknown) =>
				this.runRequest("note.delete", () =>
					stateService.deleteNote(normalizeDeleteReviewNoteParams(params).id)
				)
			)
		);
		this._register(
			connection.onNotification(DiagnosticsRpc.report, (input: unknown) => {
				const diagnostic = normalizeWebviewDiagnosticInput(input);
				if (!diagnostic) {
					this.diagnostics.warn("webview", "diagnostic.rejected");
					return;
				}
				this.diagnostics.record(diagnostic.level, "webview", diagnostic.name, {
					origin: "webview",
					correlationId: diagnostic.correlationId,
					durationMs: diagnostic.durationMs,
					data: diagnostic.data ? () => ({ ...diagnostic.data }) : undefined
				});
			})
		);
		this._register(
			stateService.onDidChangeState((state) => {
				if (!this.isVisible()) {
					return;
				}
				void this.connection.sendNotification(ReviewRpc.stateChanged, state).catch((error) => {
					if (!this.disposed) {
						this.diagnostics.error("webview", "state.publish.failed", error);
					}
				});
			})
		);
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}

	private async runRequest<T>(name: string, operation: () => Promise<T>): Promise<T> {
		const diagnosticOperation = this.diagnostics.startOperation("webview", `rpc.${name}`);
		try {
			const result = await operation();
			diagnosticOperation.complete();
			return result;
		} catch (error) {
			diagnosticOperation.fail(error);
			throw error;
		}
	}
}
