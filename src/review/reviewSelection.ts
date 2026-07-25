import type { ReviewComment } from "../common/reviewProtocol";

export function selectOpenReviewComments(
	allComments: readonly ReviewComment[],
	requestedIds: readonly string[]
): ReviewComment[] {
	const ids = [...new Set(requestedIds)];
	if (ids.length === 0) {
		throw new Error("Select at least one open review comment");
	}
	const byId = new Map(allComments.map((comment) => [comment.id, comment]));
	return ids.map((id) => {
		const comment = byId.get(id);
		if (!comment) {
			throw new Error(`Review comment ${id} was not found`);
		}
		if (comment.status !== "open") {
			throw new Error(`Review comment ${id} is not open`);
		}
		return comment;
	});
}

export function reconcileSelectedCommentIds(
	selectedIds: readonly string[],
	openIds: readonly string[],
	previousOpenIds: ReadonlySet<string> | undefined,
	initialized: boolean
): string[] {
	const currentOpenIds = new Set(openIds);
	if (!initialized) {
		return [...currentOpenIds];
	}
	const retained = selectedIds.filter((id) => currentOpenIds.has(id));
	const newlyCreated = previousOpenIds ? openIds.filter((id) => !previousOpenIds.has(id)) : [];
	return [...new Set([...retained, ...newlyCreated])];
}
