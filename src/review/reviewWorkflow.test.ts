import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../common/reviewProtocol";
import { createEmptyReviewLedgerState } from "./reviewLedger";
import { claimReviewComments, completeReviewComments, recoverExpiredReviewClaims } from "./reviewWorkflow";

const now = new Date("2026-07-25T08:00:00.000Z");

describe("review workflow claims", () => {
	it("allows exactly one agent to claim an open version", () => {
		const state = stateWith(createComment("RC-1"));
		const first = claimReviewComments(state, [{ commentId: "RC-1", expectedVersion: 1 }], "first", now);
		const second = claimReviewComments(first.state, [{ commentId: "RC-1", expectedVersion: 1 }], "second", now);

		expect(first.results[0]).toMatchObject({ accepted: true, version: 1 });
		expect(second.results).toEqual([{ commentId: "RC-1", accepted: false, reason: "already_claimed" }]);
	});

	it("returns per-ID failures and deduplicates repeated IDs", () => {
		const state = stateWith(createComment("RC-1"));
		const outcome = claimReviewComments(
			state,
			[
				{ commentId: "missing", expectedVersion: 1 },
				{ commentId: "RC-1", expectedVersion: 2 },
				{ commentId: "RC-1", expectedVersion: 1 }
			],
			"agent",
			now
		);
		expect(outcome.results).toEqual([
			{ commentId: "missing", accepted: false, reason: "not_found" },
			{ commentId: "RC-1", accepted: false, reason: "version_conflict" }
		]);
	});

	it.each(["resolved", "unresolved"] as const)("does not claim a terminal %s comment", (status) => {
		const terminal = createTerminalComment("RC-1", status);
		const result = claimReviewComments(
			stateWith(terminal),
			[{ commentId: terminal.id, expectedVersion: 1 }],
			"agent",
			now
		);
		expect(result.results[0]).toMatchObject({ accepted: false, reason: "not_open" });
	});

	it("recovers an expired claim to open without changing the comment version", () => {
		const claimed = claimReviewComments(
			stateWith(createComment("RC-1")),
			[{ commentId: "RC-1", expectedVersion: 1 }],
			"agent",
			now,
			1_000
		);
		const recovered = recoverExpiredReviewClaims(claimed.state, new Date(now.getTime() + 1_001));
		expect(recovered.recoveredCount).toBe(1);
		expect(recovered.state.comments[0]).toMatchObject({
			status: "open",
			version: 1,
			claim: undefined
		});
	});
});

describe("review workflow completion", () => {
	it("resolves a claimed comment and is idempotent for the same result", () => {
		const claimed = claimOne();
		const acceptedClaim = claimed.results[0];
		if (!acceptedClaim.accepted) {
			throw new Error("Expected accepted claim");
		}
		const input = {
			commentId: "RC-1",
			expectedVersion: 1,
			claimToken: acceptedClaim.claimToken,
			outcome: "resolved" as const,
			summary: "Implemented the requested behavior.",
			changedFiles: ["src/index.ts"],
			verification: "Focused tests passed."
		};
		const completed = completeReviewComments(claimed.state, [input], "agent", now);
		const repeated = completeReviewComments(completed.state, [input], "agent", now);

		expect(completed.results[0]).toEqual({
			commentId: "RC-1",
			accepted: true,
			status: "resolved"
		});
		expect(completed.state.comments[0]).toMatchObject({
			body: "Request RC-1",
			intent: "change",
			status: "resolved",
			claim: undefined,
			result: { outcome: "resolved", summary: input.summary }
		});
		expect(repeated.results[0]).toMatchObject({
			accepted: true,
			status: "resolved",
			alreadyCompleted: true
		});
	});

	it("records a terminal unresolved result", () => {
		const claimed = claimOne();
		const acceptedClaim = claimed.results[0];
		if (!acceptedClaim.accepted) {
			throw new Error("Expected accepted claim");
		}
		const completed = completeReviewComments(
			claimed.state,
			[
				{
					commentId: "RC-1",
					expectedVersion: 1,
					claimToken: acceptedClaim.claimToken,
					outcome: "unresolved",
					reason: "missing_requirement",
					explanation: "The required behavior is not defined.",
					suggestedNewComment: "Specify whether archived projects should be included."
				}
			],
			"agent",
			now
		);
		expect(completed.state.comments[0]).toMatchObject({
			status: "unresolved",
			result: {
				outcome: "unresolved",
				reason: "missing_requirement"
			}
		});
	});

	it("rejects incorrect tokens, stale versions, open comments, and unknown IDs", () => {
		const claimed = claimOne();
		const base = {
			outcome: "resolved" as const,
			summary: "Done",
			changedFiles: [] as string[]
		};
		const result = completeReviewComments(
			claimed.state,
			[
				{
					...base,
					commentId: "RC-1",
					expectedVersion: 1,
					claimToken: "wrong"
				},
				{
					...base,
					commentId: "missing",
					expectedVersion: 1,
					claimToken: "wrong"
				}
			],
			"agent",
			now
		);
		expect(result.results).toEqual([
			{ commentId: "RC-1", accepted: false, reason: "claim_mismatch" },
			{ commentId: "missing", accepted: false, reason: "not_found" }
		]);

		const openResult = completeReviewComments(
			stateWith(createComment("RC-open")),
			[
				{
					...base,
					commentId: "RC-open",
					expectedVersion: 1,
					claimToken: "token"
				}
			],
			"agent",
			now
		);
		expect(openResult.results[0]).toMatchObject({
			accepted: false,
			reason: "not_in_progress"
		});
	});

	it("rejects an expired claim and returns the comment to open", () => {
		const claimed = claimReviewComments(
			stateWith(createComment("RC-1")),
			[{ commentId: "RC-1", expectedVersion: 1 }],
			"agent",
			now,
			1_000
		);
		const acceptedClaim = claimed.results[0];
		if (!acceptedClaim.accepted) {
			throw new Error("Expected accepted claim");
		}
		const completed = completeReviewComments(
			claimed.state,
			[
				{
					commentId: "RC-1",
					expectedVersion: 1,
					claimToken: acceptedClaim.claimToken,
					outcome: "resolved",
					summary: "Late",
					changedFiles: []
				}
			],
			"agent",
			new Date(now.getTime() + 1_001)
		);
		expect(completed.results[0]).toMatchObject({
			accepted: false,
			reason: "claim_expired"
		});
		expect(completed.state.comments[0]).toMatchObject({ status: "open", claim: undefined });
	});

	it("rejects a conflicting repeated completion", () => {
		const claimed = claimOne();
		const acceptedClaim = claimed.results[0];
		if (!acceptedClaim.accepted) {
			throw new Error("Expected accepted claim");
		}
		const completed = completeReviewComments(
			claimed.state,
			[
				{
					commentId: "RC-1",
					expectedVersion: 1,
					claimToken: acceptedClaim.claimToken,
					outcome: "resolved",
					summary: "First",
					changedFiles: []
				}
			],
			"agent",
			now
		);
		const conflict = completeReviewComments(
			completed.state,
			[
				{
					commentId: "RC-1",
					expectedVersion: 1,
					claimToken: acceptedClaim.claimToken,
					outcome: "resolved",
					summary: "Different",
					changedFiles: []
				}
			],
			"agent",
			now
		);
		expect(conflict.results[0]).toMatchObject({
			accepted: false,
			reason: "already_completed"
		});
		const stale = completeReviewComments(
			completed.state,
			[
				{
					commentId: "RC-1",
					expectedVersion: 2,
					claimToken: acceptedClaim.claimToken,
					outcome: "resolved",
					summary: "First",
					changedFiles: []
				}
			],
			"agent",
			now
		);
		expect(stale.results[0]).toMatchObject({
			accepted: false,
			reason: "version_conflict"
		});
	});
});

function claimOne() {
	return claimReviewComments(
		stateWith(createComment("RC-1")),
		[{ commentId: "RC-1", expectedVersion: 1 }],
		"agent",
		now
	);
}

function stateWith(...comments: ReviewComment[]) {
	return { ...createEmptyReviewLedgerState("/workspace"), comments };
}

function createComment(id: string): ReviewComment {
	return {
		id,
		version: 1,
		body: `Request ${id}`,
		intent: "change",
		status: "open",
		anchor: undefined,
		anchorState: "orphaned",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString()
	};
}

function createTerminalComment(id: string, status: "resolved" | "unresolved"): ReviewComment {
	return {
		...createComment(id),
		status,
		result:
			status === "resolved"
				? {
						outcome: "resolved",
						client: "agent",
						summary: "Done",
						changedFiles: [],
						completedAt: now.toISOString(),
						claimToken: "terminal"
					}
				: {
						outcome: "unresolved",
						client: "agent",
						reason: "missing_requirement",
						explanation: "Missing",
						completedAt: now.toISOString(),
						claimToken: "terminal"
					}
	};
}
