import { NotificationType, RequestType, RequestType0 } from "vscode-jsonrpc";
import type { StateEnvelope } from "./webviewProtocol";

export const ReviewRpc = {
	getState: new RequestType0<ReviewPanelStateEnvelope, void>("aireview.review.getState"),
	addNote: new RequestType<AddReviewNoteParams, ReviewPanelStateEnvelope, void>("aireview.review.addNote"),
	deleteNote: new RequestType<DeleteReviewNoteParams, ReviewPanelStateEnvelope, void>("aireview.review.deleteNote"),
	stateChanged: new NotificationType<ReviewPanelStateEnvelope>("aireview.review.stateChanged")
} as const;

export interface ReviewPanelState {
	readonly workspace: WorkspaceSnapshot;
	readonly notes: readonly ReviewNote[];
	readonly agentTargets: readonly AgentTarget[];
}

export type ReviewPanelStateEnvelope = StateEnvelope<ReviewPanelState>;

export interface WorkspaceSnapshot {
	readonly name: string;
	readonly uri: string | undefined;
	readonly branch: string | undefined;
	readonly activeFile: ActiveFileSnapshot | undefined;
}

export interface ActiveFileSnapshot {
	readonly filePath: string;
	readonly uri: string;
	readonly selection: ReviewRange | undefined;
}

export interface ReviewRange {
	readonly startLine: number;
	readonly startCharacter: number;
	readonly endLine: number;
	readonly endCharacter: number;
}

export interface ReviewNote {
	readonly id: string;
	readonly body: string;
	readonly filePath: string | undefined;
	readonly line: number | undefined;
	readonly range: ReviewRange | undefined;
	readonly createdAt: string;
}

export interface AddReviewNoteParams {
	readonly body: string;
	readonly filePath?: string;
	readonly line?: number;
	readonly range?: ReviewRange;
}

export interface DeleteReviewNoteParams {
	readonly id: string;
}

export interface AgentTarget {
	readonly id: "codex" | "copilot";
	readonly label: string;
	readonly available: boolean;
	readonly detail: string;
}
