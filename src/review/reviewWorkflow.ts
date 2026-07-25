import { randomUUID } from "node:crypto";
import type { ReviewComment, ReviewCommentResult, UnresolvedReviewCommentReason } from "../common/reviewProtocol";
import type { ReviewLedgerState } from "./reviewLedger";

export const defaultClaimLeaseMilliseconds = 60 * 60 * 1_000;

export interface ClaimReviewCommentInput {
	readonly commentId: string;
	readonly expectedVersion: number;
}

export type ClaimRejectionReason = "not_found" | "version_conflict" | "not_open" | "already_claimed";

export type ClaimReviewCommentResult =
	| {
			readonly commentId: string;
			readonly accepted: true;
			readonly version: number;
			readonly claimToken: string;
			readonly expiresAt: string;
	  }
	| {
			readonly commentId: string;
			readonly accepted: false;
			readonly reason: ClaimRejectionReason;
	  };

interface CompletionInputBase {
	readonly commentId: string;
	readonly expectedVersion: number;
	readonly claimToken: string;
}

export interface ResolvedCompletionInput extends CompletionInputBase {
	readonly outcome: "resolved";
	readonly summary: string;
	readonly changedFiles: readonly string[];
	readonly verification?: string;
	readonly limitations?: string;
}

export interface UnresolvedCompletionInput extends CompletionInputBase {
	readonly outcome: "unresolved";
	readonly reason: UnresolvedReviewCommentReason;
	readonly explanation: string;
	readonly suggestedNewComment?: string;
}

export type CompleteReviewCommentInput = ResolvedCompletionInput | UnresolvedCompletionInput;

export type CompletionRejectionReason =
	"not_found" | "not_in_progress" | "version_conflict" | "claim_mismatch" | "claim_expired" | "already_completed";

export type CompleteReviewCommentResult =
	| {
			readonly commentId: string;
			readonly accepted: true;
			readonly status: "resolved" | "unresolved";
			readonly alreadyCompleted?: true;
	  }
	| {
			readonly commentId: string;
			readonly accepted: false;
			readonly reason: CompletionRejectionReason;
	  };

export function claimReviewComments(
	current: ReviewLedgerState,
	inputs: readonly ClaimReviewCommentInput[],
	client: string,
	now = new Date(),
	leaseMilliseconds = defaultClaimLeaseMilliseconds
): { readonly state: ReviewLedgerState; readonly results: readonly ClaimReviewCommentResult[] } {
	const uniqueInputs = deduplicateByCommentId(inputs);
	const comments = [...current.comments];
	const results: ClaimReviewCommentResult[] = [];
	let changed = false;

	for (const input of uniqueInputs) {
		const index = comments.findIndex((comment) => comment.id === input.commentId);
		if (index < 0) {
			results.push({ commentId: input.commentId, accepted: false, reason: "not_found" });
			continue;
		}
		let comment = comments[index];
		if (comment.status === "in_progress" && isExpired(comment, now)) {
			comment = {
				...comment,
				status: "open",
				claim: undefined,
				updatedAt: now.toISOString()
			};
			comments[index] = comment;
			changed = true;
		}
		if (comment.version !== input.expectedVersion) {
			results.push({ commentId: input.commentId, accepted: false, reason: "version_conflict" });
			continue;
		}
		if (comment.status === "in_progress") {
			results.push({ commentId: input.commentId, accepted: false, reason: "already_claimed" });
			continue;
		}
		if (comment.status !== "open") {
			results.push({ commentId: input.commentId, accepted: false, reason: "not_open" });
			continue;
		}
		const claimToken = randomUUID();
		const expiresAt = new Date(now.getTime() + leaseMilliseconds).toISOString();
		comments[index] = {
			...comment,
			status: "in_progress",
			claim: {
				token: claimToken,
				client,
				commentVersion: comment.version,
				claimedAt: now.toISOString(),
				expiresAt
			},
			updatedAt: now.toISOString()
		};
		changed = true;
		results.push({
			commentId: input.commentId,
			accepted: true,
			version: comment.version,
			claimToken,
			expiresAt
		});
	}
	return {
		state: changed ? { ...current, comments } : current,
		results
	};
}

export function completeReviewComments(
	current: ReviewLedgerState,
	inputs: readonly CompleteReviewCommentInput[],
	client: string,
	now = new Date()
): { readonly state: ReviewLedgerState; readonly results: readonly CompleteReviewCommentResult[] } {
	const uniqueInputs = deduplicateByCommentId(inputs);
	const comments = [...current.comments];
	const results: CompleteReviewCommentResult[] = [];
	let changed = false;

	for (const input of uniqueInputs) {
		const index = comments.findIndex((comment) => comment.id === input.commentId);
		if (index < 0) {
			results.push({ commentId: input.commentId, accepted: false, reason: "not_found" });
			continue;
		}
		const comment = comments[index];
		if (comment.status === "resolved" || comment.status === "unresolved") {
			if (comment.version !== input.expectedVersion) {
				results.push({ commentId: input.commentId, accepted: false, reason: "version_conflict" });
				continue;
			}
			if (
				comment.result?.claimToken === input.claimToken &&
				completionMatchesResult(input, comment.result, client)
			) {
				results.push({
					commentId: input.commentId,
					accepted: true,
					status: comment.status,
					alreadyCompleted: true
				});
			} else {
				results.push({ commentId: input.commentId, accepted: false, reason: "already_completed" });
			}
			continue;
		}
		if (comment.status !== "in_progress" || !comment.claim) {
			results.push({ commentId: input.commentId, accepted: false, reason: "not_in_progress" });
			continue;
		}
		if (comment.version !== input.expectedVersion) {
			results.push({ commentId: input.commentId, accepted: false, reason: "version_conflict" });
			continue;
		}
		if (comment.claim.token !== input.claimToken) {
			results.push({ commentId: input.commentId, accepted: false, reason: "claim_mismatch" });
			continue;
		}
		if (isExpired(comment, now)) {
			comments[index] = {
				...comment,
				status: "open",
				claim: undefined,
				updatedAt: now.toISOString()
			};
			changed = true;
			results.push({ commentId: input.commentId, accepted: false, reason: "claim_expired" });
			continue;
		}
		const result = toStoredResult(input, client, now.toISOString());
		comments[index] = {
			...comment,
			status: input.outcome,
			claim: undefined,
			result,
			updatedAt: now.toISOString()
		};
		changed = true;
		results.push({ commentId: input.commentId, accepted: true, status: input.outcome });
	}
	return {
		state: changed ? { ...current, comments } : current,
		results
	};
}

export function recoverExpiredReviewClaims(
	current: ReviewLedgerState,
	now = new Date()
): { readonly state: ReviewLedgerState; readonly recoveredCount: number } {
	let recoveredCount = 0;
	const comments = current.comments.map((comment) => {
		if (comment.status !== "in_progress" || !isExpired(comment, now)) {
			return comment;
		}
		recoveredCount += 1;
		return {
			...comment,
			status: "open" as const,
			claim: undefined,
			updatedAt: now.toISOString()
		};
	});
	return {
		state: recoveredCount ? { ...current, comments } : current,
		recoveredCount
	};
}

function isExpired(comment: ReviewComment, now: Date): boolean {
	return Boolean(comment.claim && Date.parse(comment.claim.expiresAt) <= now.getTime());
}

function toStoredResult(input: CompleteReviewCommentInput, client: string, completedAt: string): ReviewCommentResult {
	return input.outcome === "resolved"
		? {
				outcome: "resolved",
				client,
				summary: input.summary,
				changedFiles: input.changedFiles,
				verification: input.verification,
				limitations: input.limitations,
				completedAt,
				claimToken: input.claimToken
			}
		: {
				outcome: "unresolved",
				client,
				reason: input.reason,
				explanation: input.explanation,
				suggestedNewComment: input.suggestedNewComment,
				completedAt,
				claimToken: input.claimToken
			};
}

function completionMatchesResult(
	input: CompleteReviewCommentInput,
	result: ReviewCommentResult,
	client: string
): boolean {
	if (input.outcome !== result.outcome || result.client !== client) {
		return false;
	}
	if (input.outcome === "resolved" && result.outcome === "resolved") {
		return (
			input.summary === result.summary &&
			arraysEqual(input.changedFiles, result.changedFiles) &&
			input.verification === result.verification &&
			input.limitations === result.limitations
		);
	}
	return (
		input.outcome === "unresolved" &&
		result.outcome === "unresolved" &&
		input.reason === result.reason &&
		input.explanation === result.explanation &&
		input.suggestedNewComment === result.suggestedNewComment
	);
}

function deduplicateByCommentId<T extends { readonly commentId: string }>(inputs: readonly T[]): T[] {
	const seen = new Set<string>();
	return inputs.filter((input) => {
		if (seen.has(input.commentId)) {
			return false;
		}
		seen.add(input.commentId);
		return true;
	});
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
