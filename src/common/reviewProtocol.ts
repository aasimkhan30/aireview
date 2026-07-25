import { NotificationType, RequestType, RequestType0 } from "vscode-jsonrpc";
import type { StateEnvelope } from "./webviewProtocol";

export const ReviewRpc = {
	getState: new RequestType0<ReviewPanelStateEnvelope, void>("requestchanges.review.getState"),
	startAnnotation: new RequestType0<void, void>("requestchanges.review.startAnnotation"),
	editOpenComment: new RequestType<EditOpenCommentParams, ReviewPanelStateEnvelope, void>(
		"requestchanges.review.editOpenComment"
	),
	deleteComment: new RequestType<ReviewCommentIdParams, ReviewPanelStateEnvelope, void>(
		"requestchanges.review.deleteComment"
	),
	revealComment: new RequestType<ReviewCommentIdParams, void, void>("requestchanges.review.revealComment"),
	reattachOpenComment: new RequestType<VersionedReviewCommentParams, ReviewPanelStateEnvelope, void>(
		"requestchanges.review.reattachOpenComment"
	),
	createUnresolvedFollowUp: new RequestType<VersionedReviewCommentParams, ReviewPanelStateEnvelope, void>(
		"requestchanges.review.createUnresolvedFollowUp"
	),
	previewComments: new RequestType<SelectedReviewCommentsParams, ReviewCommentsPreview, void>(
		"requestchanges.review.previewComments"
	),
	copyComments: new RequestType<SelectedReviewCommentsParams, ReviewCopyResult, void>(
		"requestchanges.review.copyComments"
	),
	clearResolvedComments: new RequestType0<ClearResolvedCommentsResult, void>(
		"requestchanges.review.clearResolvedComments"
	),
	openSettings: new RequestType0<void, void>("requestchanges.review.openSettings"),
	stateChanged: new NotificationType<ReviewPanelStateEnvelope>("requestchanges.review.stateChanged")
} as const;

export interface ReviewPanelState {
	readonly workspace: WorkspaceSnapshot;
	readonly comments: readonly ReviewComment[];
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

export type ReviewCommentIntent = "change" | "question" | "explain" | "test";
export type ReviewCommentStatus = "open" | "in_progress" | "resolved" | "unresolved";
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

export interface ReviewClaim {
	readonly token: string;
	readonly client: string;
	readonly commentVersion: number;
	readonly claimedAt: string;
	readonly expiresAt: string;
}

export type UnresolvedReviewCommentReason =
	| "missing_requirement"
	| "missing_resource"
	| "missing_permission"
	| "target_unavailable"
	| "unsafe_change"
	| "environment_failure";

export interface ResolvedReviewCommentResult {
	readonly outcome: "resolved";
	readonly client: string;
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly verification?: string;
	readonly limitations?: string;
	readonly completedAt: string;
	readonly claimToken: string;
}

export interface UnresolvedReviewCommentResult {
	readonly outcome: "unresolved";
	readonly client: string;
	readonly reason: UnresolvedReviewCommentReason;
	readonly explanation: string;
	readonly suggestedNewComment?: string;
	readonly completedAt: string;
	readonly claimToken: string;
}

export type ReviewCommentResult = ResolvedReviewCommentResult | UnresolvedReviewCommentResult;

export interface ReviewComment {
	readonly id: string;
	readonly version: number;
	readonly body: string;
	readonly intent: ReviewCommentIntent;
	readonly status: ReviewCommentStatus;
	readonly anchor: ReviewAnchor | undefined;
	readonly anchorState: ReviewAnchorState;
	readonly claim?: ReviewClaim;
	readonly result?: ReviewCommentResult;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface AddReviewCommentParams {
	readonly id?: string;
	readonly body: string;
	readonly intent?: ReviewCommentIntent;
	readonly anchor?: ReviewAnchor;
}

export interface EditOpenCommentParams {
	readonly id: string;
	readonly expectedVersion: number;
	readonly body: string;
	readonly intent: ReviewCommentIntent;
}

export interface ReviewCommentIdParams {
	readonly id: string;
}

export interface VersionedReviewCommentParams extends ReviewCommentIdParams {
	readonly expectedVersion: number;
}

export interface SelectedReviewCommentsParams {
	readonly commentIds: readonly string[];
}

export interface ReviewCommentsPreview {
	readonly markdown: string;
	readonly fileCount: number;
	readonly commentCount: number;
	readonly needsReattachmentCount: number;
}

export interface ReviewCopyResult {
	readonly message: string;
}

export interface ClearResolvedCommentsResult {
	readonly clearedCount: number;
	readonly state: ReviewPanelStateEnvelope;
}

export type AgentTargetId = "codex" | "copilot";

export const reviewIntentPresentation = {
	change: {
		label: "Change code",
		description: "Request a code modification",
		instruction: "Implement the requested modification."
	},
	question: {
		label: "Answer a question",
		description: "Ask about the current implementation",
		instruction: "Answer without changing code unless explicitly requested."
	},
	explain: {
		label: "Explain this",
		description: "Request an explanation of the selected code",
		instruction: "Explain the behavior and trade-offs without changing code."
	},
	test: {
		label: "Add or update tests",
		description: "Request test coverage",
		instruction: "Add or update relevant tests; avoid unrelated production changes."
	}
} satisfies Record<
	ReviewCommentIntent,
	{ readonly label: string; readonly description: string; readonly instruction: string }
>;

export const reviewStatusPresentation = {
	open: { label: "Open" },
	in_progress: { label: "Working" },
	resolved: { label: "Resolved" },
	unresolved: { label: "Couldn’t resolve" }
} satisfies Record<ReviewCommentStatus, { readonly label: string }>;
