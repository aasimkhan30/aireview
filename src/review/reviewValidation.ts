import type {
	EditOpenCommentParams,
	ReviewAnchor,
	ReviewComment,
	ReviewCommentIdParams,
	ReviewCommentIntent,
	ReviewCommentResult,
	ReviewCommentStatus,
	ReviewRange,
	SelectedReviewCommentsParams,
	UnresolvedReviewCommentReason
} from "../common/reviewProtocol";

const commentIntents: readonly ReviewCommentIntent[] = ["change", "question", "explain", "test"];
const commentStatuses: readonly ReviewCommentStatus[] = ["open", "in_progress", "resolved", "unresolved"];
const unresolvedReasons: readonly UnresolvedReviewCommentReason[] = [
	"missing_requirement",
	"missing_resource",
	"missing_permission",
	"target_unavailable",
	"unsafe_change",
	"environment_failure"
];

export function normalizeEditOpenCommentParams(value: unknown): EditOpenCommentParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected review comment parameters");
	}
	const params = value as Partial<EditOpenCommentParams>;
	if (!isNonEmptyString(params.id)) {
		throw new Error("Review comment id is required");
	}
	if (!isPositiveVersion(params.expectedVersion)) {
		throw new Error("Expected comment version is required");
	}
	if (!isNonEmptyString(params.body)) {
		throw new Error("Review comment body is required");
	}
	if (!isReviewCommentIntent(params.intent)) {
		throw new Error("Review comment intent is required");
	}
	return {
		id: params.id,
		expectedVersion: params.expectedVersion,
		body: params.body.trim(),
		intent: params.intent
	};
}

export function normalizeReviewCommentIdParams(value: unknown): ReviewCommentIdParams {
	if (!value || typeof value !== "object" || !isNonEmptyString((value as Partial<ReviewCommentIdParams>).id)) {
		throw new Error("Review comment id is required");
	}
	return { id: (value as ReviewCommentIdParams).id };
}

export function normalizeSelectedReviewCommentsParams(value: unknown): SelectedReviewCommentsParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected selected review comments");
	}
	const ids = (value as Partial<SelectedReviewCommentsParams>).commentIds;
	if (!Array.isArray(ids) || ids.length === 0) {
		throw new Error("Select at least one open review comment");
	}
	if (!ids.every(isNonEmptyString)) {
		throw new Error("Every selected review comment must have an id");
	}
	return { commentIds: [...new Set(ids)] };
}

export function isReviewComment(value: unknown): value is ReviewComment {
	if (!value || typeof value !== "object") {
		return false;
	}
	const comment = value as Partial<ReviewComment>;
	if (
		!isNonEmptyString(comment.id) ||
		!isPositiveVersion(comment.version) ||
		!isNonEmptyString(comment.body) ||
		!isReviewCommentIntent(comment.intent) ||
		!isReviewCommentStatus(comment.status) ||
		(comment.anchor !== undefined && !isReviewAnchor(comment.anchor)) ||
		(comment.anchorState !== "attached" && comment.anchorState !== "moved" && comment.anchorState !== "orphaned") ||
		!isNonEmptyString(comment.createdAt) ||
		!isNonEmptyString(comment.updatedAt)
	) {
		return false;
	}
	if (comment.status === "open") {
		return comment.claim === undefined && comment.result === undefined;
	}
	if (comment.status === "in_progress") {
		return (
			comment.claim !== undefined &&
			isReviewClaim(comment.claim) &&
			comment.claim.commentVersion === comment.version &&
			comment.result === undefined
		);
	}
	if (comment.claim !== undefined || !isReviewCommentResult(comment.result)) {
		return false;
	}
	return comment.result.outcome === comment.status;
}

function isReviewClaim(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const claim = value as NonNullable<ReviewComment["claim"]>;
	return (
		isNonEmptyString(claim.token) &&
		isNonEmptyString(claim.client) &&
		isPositiveVersion(claim.commentVersion) &&
		isNonEmptyString(claim.claimedAt) &&
		isNonEmptyString(claim.expiresAt)
	);
}

function isReviewCommentResult(value: unknown): value is ReviewCommentResult {
	if (!value || typeof value !== "object") {
		return false;
	}
	const result = value as Partial<ReviewCommentResult>;
	const common =
		isNonEmptyString(result.client) && isNonEmptyString(result.completedAt) && isNonEmptyString(result.claimToken);
	if (!common) {
		return false;
	}
	if (result.outcome === "resolved") {
		return (
			isNonEmptyString(result.summary) &&
			Array.isArray(result.changedFiles) &&
			result.changedFiles.every((file) => typeof file === "string") &&
			(result.verification === undefined || typeof result.verification === "string") &&
			(result.limitations === undefined || typeof result.limitations === "string")
		);
	}
	if (result.outcome === "unresolved") {
		return (
			unresolvedReasons.includes(result.reason as UnresolvedReviewCommentReason) &&
			isNonEmptyString(result.explanation) &&
			(result.suggestedNewComment === undefined || typeof result.suggestedNewComment === "string")
		);
	}
	return false;
}

export function isReviewAnchor(value: unknown): value is ReviewAnchor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const anchor = value as Partial<ReviewAnchor>;
	return (
		isNonEmptyString(anchor.uri) &&
		typeof anchor.filePath === "string" &&
		isReviewRange(anchor.range) &&
		typeof anchor.selectedText === "string" &&
		isNonEmptyString(anchor.selectedTextHash) &&
		typeof anchor.contextBefore === "string" &&
		typeof anchor.contextAfter === "string"
	);
}

export function isReviewRange(value: unknown): value is ReviewRange {
	if (!value || typeof value !== "object") {
		return false;
	}
	const range = value as Partial<ReviewRange>;
	return (
		isPositiveCoordinate(range.startLine) &&
		isPositiveCoordinate(range.startCharacter) &&
		isPositiveCoordinate(range.endLine) &&
		isPositiveCoordinate(range.endCharacter)
	);
}

export function isReviewCommentIntent(value: unknown): value is ReviewCommentIntent {
	return commentIntents.includes(value as ReviewCommentIntent);
}

export function isReviewCommentStatus(value: unknown): value is ReviewCommentStatus {
	return commentStatuses.includes(value as ReviewCommentStatus);
}

export function isUnresolvedReviewCommentReason(value: unknown): value is UnresolvedReviewCommentReason {
	return unresolvedReasons.includes(value as UnresolvedReviewCommentReason);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isPositiveCoordinate(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
