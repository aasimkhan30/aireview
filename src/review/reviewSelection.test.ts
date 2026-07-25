import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../common/reviewProtocol";
import { reconcileSelectedCommentIds, selectOpenReviewComments } from "./reviewSelection";

describe("review comment selection", () => {
	it("selects all open comments on first load", () => {
		expect(reconcileSelectedCommentIds([], ["one", "two"], undefined, false)).toEqual(["one", "two"]);
	});

	it("retains only open IDs and selects a newly created open comment", () => {
		expect(
			reconcileSelectedCommentIds(["open", "working"], ["open", "new"], new Set(["open", "working"]), true)
		).toEqual(["open", "new"]);
	});

	it("preserves selection order, deduplicates IDs, and returns exactly the selection", () => {
		const comments = [comment("one", "open"), comment("two", "open")];
		expect(selectOpenReviewComments(comments, ["two", "one", "two"]).map((item) => item.id)).toEqual([
			"two",
			"one"
		]);
	});

	it("rejects empty, unknown, and non-open selections without silently dropping IDs", () => {
		const comments = [comment("open", "open"), comment("working", "in_progress")];
		expect(() => selectOpenReviewComments(comments, [])).toThrow("Select at least one");
		expect(() => selectOpenReviewComments(comments, ["missing"])).toThrow("was not found");
		expect(() => selectOpenReviewComments(comments, ["working"])).toThrow("is not open");
	});
});

function comment(id: string, status: ReviewComment["status"]): ReviewComment {
	const base: ReviewComment = {
		id,
		version: 1,
		body: id,
		intent: "change",
		status: "open",
		anchor: undefined,
		anchorState: "orphaned",
		createdAt: "2026-07-25T00:00:00.000Z",
		updatedAt: "2026-07-25T00:00:00.000Z"
	};
	if (status === "in_progress") {
		return {
			...base,
			status,
			claim: {
				token: "token",
				client: "agent",
				commentVersion: 1,
				claimedAt: "2026-07-25T00:00:00.000Z",
				expiresAt: "2026-07-25T01:00:00.000Z"
			}
		};
	}
	return base;
}
