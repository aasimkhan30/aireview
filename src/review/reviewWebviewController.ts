import type { MessageConnection } from "vscode-jsonrpc/node";
import { ReviewRpc } from "../common/reviewProtocol";
import { Disposable } from "../util/vs/base/common/lifecycle";
import type { IReviewPanelStateService } from "./reviewPanelStateService";
import { normalizeAddReviewNoteParams, normalizeDeleteReviewNoteParams } from "./reviewValidation";

/** Binds one webview session to the shared, host-authoritative review state. */
export class ReviewWebviewController extends Disposable {
	constructor(
		private readonly connection: MessageConnection,
		private readonly stateService: IReviewPanelStateService,
		private readonly isVisible: () => boolean
	) {
		super();
		this._register(connection.onRequest(ReviewRpc.getState, () => stateService.refresh()));
		this._register(
			connection.onRequest(ReviewRpc.addNote, (params: unknown) =>
				stateService.addNote(normalizeAddReviewNoteParams(params))
			)
		);
		this._register(
			connection.onRequest(ReviewRpc.deleteNote, (params: unknown) =>
				stateService.deleteNote(normalizeDeleteReviewNoteParams(params).id)
			)
		);
		this._register(
			stateService.onDidChangeState((state) => {
				if (!this.isVisible()) {
					return;
				}
				void this.connection
					.sendNotification(ReviewRpc.stateChanged, state)
					.catch((error) => console.error("Failed to publish AI Review state", error));
			})
		);
	}
}
