import type { MessageConnection } from "vscode-jsonrpc/node";
import { DiagnosticsRpc, normalizeWebviewDiagnosticInput } from "../common/diagnosticsProtocol";
import { ReviewRpc } from "../common/reviewProtocol";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { Disposable } from "../util/vs/base/common/lifecycle";
import type { IReviewCommentService } from "./reviewCommentService";
import type { IReviewPanelStateService } from "./reviewPanelStateService";
import {
	normalizeEditOpenCommentParams,
	normalizeReviewCommentIdParams,
	normalizeSelectedReviewCommentsParams
} from "./reviewValidation";

export class ReviewWebviewController extends Disposable {
	private disposed = false;

	constructor(
		private readonly connection: MessageConnection,
		private readonly stateService: IReviewPanelStateService,
		private readonly commentService: IReviewCommentService,
		private readonly isVisible: () => boolean,
		private readonly diagnostics: IDiagnosticsService
	) {
		super();
		this._register(
			connection.onRequest(ReviewRpc.getState, () => this.runRequest("state.get", () => stateService.refresh()))
		);
		this._register(
			connection.onRequest(ReviewRpc.startAnnotation, () =>
				this.runRequest("annotation.start", () => commentService.startAnnotation())
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.editOpenComment, (params: unknown) =>
				this.runRequest("comment.edit", () =>
					stateService.editOpenComment(normalizeEditOpenCommentParams(params))
				)
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.deleteComment, (params: unknown) =>
				this.runRequest("comment.delete", () =>
					stateService.deleteComment(normalizeReviewCommentIdParams(params).id)
				)
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.revealComment, (params: unknown) =>
				this.runRequest("comment.reveal", () =>
					commentService.revealComment(normalizeReviewCommentIdParams(params).id)
				)
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.previewComments, (params: unknown) =>
				this.runRequest("comments.preview", () =>
					stateService.previewComments(normalizeSelectedReviewCommentsParams(params))
				)
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.copyComments, (params: unknown) =>
				this.runRequest("comments.copy", () =>
					stateService.copyComments(normalizeSelectedReviewCommentsParams(params))
				)
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.clearResolvedComments, () =>
				this.runRequest("comments.clearResolved", () => stateService.clearResolvedComments())
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
