import { NotificationType, RequestType, RequestType0 } from "vscode-jsonrpc";
import type { StateEnvelope } from "./webviewProtocol";

export const ReviewRpc = {
	getState: new RequestType0<ReviewPanelStateEnvelope, void>("requestchanges.review.getState"),
	startAnnotation: new RequestType0<void, void>("requestchanges.review.startAnnotation"),
	updateNote: new RequestType<UpdateReviewNoteParams, ReviewPanelStateEnvelope, void>(
		"requestchanges.review.updateNote"
	),
	deleteNote: new RequestType<DeleteReviewNoteParams, ReviewPanelStateEnvelope, void>(
		"requestchanges.review.deleteNote"
	),
	revealNote: new RequestType<ReviewNoteIdParams, void, void>("requestchanges.review.revealNote"),
	previewBundle: new RequestType0<ReviewBundlePreview, void>("requestchanges.review.previewBundle"),
	copyBundle: new RequestType0<ReviewCopyResult, void>("requestchanges.review.copyBundle"),
	stateChanged: new NotificationType<ReviewPanelStateEnvelope>("requestchanges.review.stateChanged")
} as const;

export interface ReviewPanelState {
	readonly workspace: WorkspaceSnapshot;
	readonly notes: readonly ReviewNote[];
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

export type ReviewNoteKind = "change" | "question" | "explain" | "test";
export type ReviewNoteStatus = "draft" | "in_progress" | "addressed" | "blocked" | "resolved";
export type ReviewAnchorState = "attached" | "moved" | "orphaned";

export interface ReviewAnchor {
	readonly uri: string;
	readonly filePath: string;
	readonly range: ReviewRange;
	readonly selectedText: string;
	readonly selectedTextHash: string;
	readonly contextBefore: string;
	readonly contextAfter: string;
}

export interface ReviewNote {
	readonly id: string;
	readonly body: string;
	readonly kind: ReviewNoteKind;
	readonly status: ReviewNoteStatus;
	readonly anchor: ReviewAnchor | undefined;
	readonly anchorState: ReviewAnchorState;
	readonly resolution?: ReviewResolution;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface ReviewResolution {
	readonly client: string;
	readonly summary?: string;
	readonly changedFiles: readonly string[];
	readonly verification?: string;
	readonly blockedReason?: string;
	readonly updatedAt: string;
}

export interface AddReviewCommentParams {
	readonly id?: string;
	readonly body: string;
	readonly kind?: ReviewNoteKind;
	readonly anchor?: ReviewAnchor;
}

export interface UpdateReviewNoteParams {
	readonly id: string;
	readonly body?: string;
	readonly kind?: ReviewNoteKind;
	readonly status?: ReviewNoteStatus;
	readonly resolution?: ReviewResolution;
}

export interface DeleteReviewNoteParams {
	readonly id: string;
}

export interface ReviewNoteIdParams {
	readonly id: string;
}

export type AgentTargetId = "codex" | "copilot";

export interface ReviewBundlePreview {
	readonly markdown: string;
	readonly fileCount: number;
	readonly noteCount: number;
	readonly orphanedCount: number;
}

export interface ReviewCopyResult {
	readonly message: string;
}
