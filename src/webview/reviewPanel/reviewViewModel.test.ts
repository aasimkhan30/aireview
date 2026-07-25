import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../../common/reviewProtocol";
import { getCopyCommentIds, groupReviewComments } from "./reviewViewModel";

describe("review sidebar view model", () => {
	it("groups ready, working, attention, and resolved comments", () => {
		const comments = [
			comment("ready", "open", "attached"),
			comment("moved", "open", "moved"),
			comment("orphaned", "open", "orphaned"),
			comment("working", "in_progress", "attached"),
			comment("unresolved", "unresolved", "attached"),
			comment("resolved", "resolved", "attached")
		];
		const groups = groupReviewComments(comments);
		expect(groups.ready.map(({ id }) => id)).toEqual(["ready", "moved"]);
		expect(groups.working.map(({ id }) => id)).toEqual(["working"]);
		expect(groups.attention.map(({ id }) => id)).toEqual(["orphaned", "unresolved"]);
		expect(groups.resolved.map(({ id }) => id)).toEqual(["resolved"]);
		expect(groups.reviewCount).toBe(5);
	});

	it("copies every ready comment by default and only the chosen subset in selection mode", () => {
		const ready = [comment("one"), comment("two")];
		expect(getCopyCommentIds(ready, false, [])).toEqual(["one", "two"]);
		expect(getCopyCommentIds(ready, true, ["two", "missing"])).toEqual(["two"]);
	});
});

function comment(
	id: string,
	status: ReviewComment["status"] = "open",
	anchorState: ReviewComment["anchorState"] = "attached"
): ReviewComment {
	const base: ReviewComment = {
		id,
		version: 1,
		body: id,
		intent: "change",
		status: "open",
		anchor: {
			uri: `file:///${id}.ts`,
			filePath: `${id}.ts`,
			range: { startLine: 1, startCharacter: 1, endLine: 1, endCharacter: 2 },
			selectedText: "x",
			selectedTextHash: "hash",
			contextBefore: "",
			contextAfter: ""
		},
		anchorState,
		createdAt: "2026-07-25T00:00:00.000Z",
		updatedAt: "2026-07-25T00:00:00.000Z"
	};
	if (status === "in_progress") {
		return {
			...base,
			status,
			claim: {
				token: "token",
				client: "Codex",
				commentVersion: 1,
				claimedAt: "2026-07-25T00:00:00.000Z",
				expiresAt: "2100-07-25T00:00:00.000Z"
			}
		};
	}
	if (status === "resolved") {
		return {
			...base,
			status,
			result: {
				outcome: "resolved",
				client: "Codex",
				summary: "Done",
				changedFiles: [],
				completedAt: "2026-07-25T00:00:00.000Z",
				claimToken: "token"
			}
		};
	}
	if (status === "unresolved") {
		return {
			...base,
			status,
			result: {
				outcome: "unresolved",
				client: "Codex",
				reason: "missing_requirement",
				explanation: "Missing",
				completedAt: "2026-07-25T00:00:00.000Z",
				claimToken: "token"
			}
		};
	}
	return { ...base, anchorState };
}
