import type { ReviewComment } from "../../common/reviewProtocol";

export interface ReviewCommentGroups {
	readonly ready: readonly ReviewComment[];
	readonly working: readonly ReviewComment[];
	readonly attention: readonly ReviewComment[];
	readonly resolved: readonly ReviewComment[];
	readonly reviewCount: number;
}

export function groupReviewComments(comments: readonly ReviewComment[]): ReviewCommentGroups {
	const ready = comments.filter((comment) => comment.status === "open" && comment.anchorState !== "orphaned");
	const working = comments.filter((comment) => comment.status === "in_progress");
	const attention = comments.filter(
		(comment) =>
			comment.status === "unresolved" || (comment.status === "open" && comment.anchorState === "orphaned")
	);
	const resolved = comments.filter((comment) => comment.status === "resolved");
	return {
		ready,
		working,
		attention,
		resolved,
		reviewCount: ready.length + working.length + attention.length
	};
}

export function getCopyCommentIds(
	ready: readonly ReviewComment[],
	selectionMode: boolean,
	selectedIds: readonly string[]
): string[] {
	if (!selectionMode) {
		return ready.map((comment) => comment.id);
	}
	const readyIds = new Set(ready.map((comment) => comment.id));
	return selectedIds.filter((id) => readyIds.has(id));
}
