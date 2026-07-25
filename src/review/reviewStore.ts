import type {
	EditOpenCommentParams,
	ReviewAnchor,
	ReviewAnchorState,
	ReviewComment,
	VersionedReviewCommentParams
} from "../common/reviewProtocol";
import { Emitter, type Event } from "../common/emitter";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import {
	createEmptyReviewLedgerState,
	ReviewLedger,
	type ReviewLedgerLocation,
	type ReviewLedgerState
} from "./reviewLedger";
import { isReviewAnchor, isReviewComment, isReviewCommentIntent } from "./reviewValidation";

const legacyReviewStateStorageKey = "requestchanges.reviewState";

export type PersistedReviewStateV4 = ReviewLedgerState;

export const IReviewStore = createServiceIdentifier<IReviewStore>("reviewStore");

export interface IReviewStore {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<PersistedReviewStateV4>;
	getState(): Promise<PersistedReviewStateV4>;
	getLocation(): Promise<ReviewLedgerLocation>;
	addComment(comment: ReviewComment): Promise<void>;
	editOpenComment(input: EditOpenCommentParams): Promise<boolean>;
	reattachOpenComment(input: VersionedReviewCommentParams, anchor: ReviewAnchor): Promise<boolean>;
	createUnresolvedFollowUp(input: VersionedReviewCommentParams, comment: ReviewComment): Promise<boolean>;
	updateCommentAnchor(id: string, anchor: ReviewAnchor, anchorState: ReviewAnchorState): Promise<boolean>;
	deleteComment(id: string): Promise<boolean>;
	clearResolvedComments(): Promise<number>;
	recoverExpiredClaims(now?: Date): Promise<number>;
	setEffectiveInstructions(value: string): Promise<void>;
}

export class ReviewStore extends Disposable implements IReviewStore {
	declare readonly _serviceBrand: undefined;

	private readonly changeEmitter = this._register(new Emitter<PersistedReviewStateV4>());
	readonly onDidChange = this.changeEmitter.event;

	private state: PersistedReviewStateV4 | undefined;
	private ledgerPromise: Promise<ReviewLedger> | undefined;
	private loadingState: Promise<PersistedReviewStateV4> | undefined;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		@IExtensionContextService private readonly extensionContextService: IExtensionContextService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
	}

	async getState(): Promise<PersistedReviewStateV4> {
		const operation = this.diagnostics.startOperation("reviewStore", "state.get");
		try {
			await this.mutationQueue;
			const ledger = await this.getLedger();
			let state = await ledger.read(await this.getMigrationState(ledger));
			if (hasExpiredClaims(state.comments, new Date())) {
				state = await ledger.mutate((current) => recoverClaims(current, new Date()).state);
			}
			this.acceptState(state);
			operation.complete(() => ({ commentCount: state.comments.length, ledgerRevision: state.revision }));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async getLocation(): Promise<ReviewLedgerLocation> {
		return (await this.getLedger()).location;
	}

	async addComment(comment: ReviewComment): Promise<void> {
		const operation = this.diagnostics.startOperation("reviewStore", "comment.add");
		try {
			await this.enqueueMutation((current) => ({
				...current,
				comments: [comment, ...current.comments]
			}));
			operation.complete(() => ({ commentId: comment.id }));
		} catch (error) {
			operation.fail(error, () => ({ commentId: comment.id }));
			throw error;
		}
	}

	editOpenComment(input: EditOpenCommentParams): Promise<boolean> {
		if (!input.body.trim()) {
			return Promise.reject(new Error("Review comment body is required"));
		}
		return this.enqueueMutationWithResult((current) => {
			const index = current.comments.findIndex((candidate) => candidate.id === input.id);
			if (index < 0) {
				return { state: current, result: false };
			}
			const comment = current.comments[index];
			if (comment.status !== "open") {
				throw new Error("Only open review comments can be edited");
			}
			if (comment.version !== input.expectedVersion) {
				throw new Error("This review comment changed; refresh and try again");
			}
			const comments = [...current.comments];
			comments[index] = {
				...comment,
				version: comment.version + 1,
				body: input.body.trim(),
				intent: input.intent,
				updatedAt: new Date().toISOString()
			};
			return { state: { ...current, comments }, result: true };
		});
	}

	reattachOpenComment(input: VersionedReviewCommentParams, anchor: ReviewAnchor): Promise<boolean> {
		return this.enqueueMutationWithResult((current) => {
			const index = current.comments.findIndex((candidate) => candidate.id === input.id);
			if (index < 0) {
				return { state: current, result: false };
			}
			const comment = current.comments[index];
			if (comment.status !== "open" || comment.anchorState !== "orphaned") {
				throw new Error("Only open comments needing reattachment can be reattached");
			}
			if (comment.version !== input.expectedVersion) {
				throw new Error("This review comment changed; refresh and try again");
			}
			const comments = [...current.comments];
			comments[index] = {
				...comment,
				version: comment.version + 1,
				anchor,
				anchorState: "attached",
				updatedAt: new Date().toISOString()
			};
			return { state: { ...current, comments }, result: true };
		});
	}

	createUnresolvedFollowUp(input: VersionedReviewCommentParams, comment: ReviewComment): Promise<boolean> {
		return this.enqueueMutationWithResult((current) => {
			const original = current.comments.find((candidate) => candidate.id === input.id);
			if (!original) {
				return { state: current, result: false };
			}
			if (
				original.status !== "unresolved" ||
				original.result?.outcome !== "unresolved" ||
				!original.result.suggestedNewComment?.trim()
			) {
				throw new Error("This unresolved comment does not have a suggested follow-up");
			}
			if (original.version !== input.expectedVersion) {
				throw new Error("This review comment changed; refresh and try again");
			}
			return {
				state: { ...current, comments: [comment, ...current.comments] },
				result: true
			};
		});
	}

	updateCommentAnchor(id: string, anchor: ReviewAnchor, anchorState: ReviewAnchorState): Promise<boolean> {
		return this.enqueueMutationWithResult((current) => {
			const index = current.comments.findIndex((candidate) => candidate.id === id);
			if (index < 0) {
				return { state: current, result: false };
			}
			const comments = [...current.comments];
			comments[index] = {
				...comments[index],
				anchor,
				anchorState,
				updatedAt: new Date().toISOString()
			};
			return { state: { ...current, comments }, result: true };
		});
	}

	deleteComment(id: string): Promise<boolean> {
		return this.enqueueMutationWithResult((current) => {
			const comment = current.comments.find((candidate) => candidate.id === id);
			if (!comment) {
				return { state: current, result: false };
			}
			if (comment.status === "in_progress") {
				throw new Error("A working review comment cannot be deleted");
			}
			return {
				state: { ...current, comments: current.comments.filter((candidate) => candidate.id !== id) },
				result: true
			};
		});
	}

	clearResolvedComments(): Promise<number> {
		return this.enqueueMutationWithResult((current) => {
			const comments = current.comments.filter((comment) => comment.status !== "resolved");
			const clearedCount = current.comments.length - comments.length;
			return {
				state: clearedCount === 0 ? current : { ...current, comments },
				result: clearedCount
			};
		});
	}

	recoverExpiredClaims(now = new Date()): Promise<number> {
		return this.enqueueMutationWithResult((current) => recoverClaims(current, now));
	}

	async setEffectiveInstructions(value: string): Promise<void> {
		const current = await this.getState();
		if (current.effectiveInstructions !== value) {
			await this.enqueueMutation((state) => ({ ...state, effectiveInstructions: value }));
		}
	}

	private enqueueMutation(operation: (current: PersistedReviewStateV4) => PersistedReviewStateV4): Promise<void> {
		return this.enqueueMutationWithResult((current) => ({ state: operation(current), result: undefined }));
	}

	private enqueueMutationWithResult<T>(
		operation: (current: PersistedReviewStateV4) => { state: PersistedReviewStateV4; result: T }
	): Promise<T> {
		const result = this.mutationQueue.then(async () => {
			const ledger = await this.getLedger();
			await ledger.read(await this.getMigrationState(ledger));
			let operationResult: T | undefined;
			const next = await ledger.mutate((current) => {
				const recovered = recoverClaims(current, new Date()).state;
				const outcome = operation(recovered);
				operationResult = outcome.result;
				return outcome.state;
			});
			this.acceptState(next);
			return operationResult as T;
		});

		this.mutationQueue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private getLedger(): Promise<ReviewLedger> {
		if (!this.ledgerPromise) {
			const workspaceRoot = this.extensionContextService.workspaceRoots[0] ?? process.cwd();
			this.ledgerPromise = ReviewLedger.open(workspaceRoot, this.extensionContextService.dataDirectory).then(
				(ledger) => {
					this._register(ledger.watch(() => void this.refreshFromLedger(ledger)));
					return ledger;
				}
			);
		}
		return this.ledgerPromise;
	}

	private async refreshFromLedger(ledger: ReviewLedger): Promise<void> {
		try {
			const state = await ledger.read();
			this.acceptState(state);
		} catch (error) {
			this.diagnostics.error("reviewStore", "state.externalRefreshFailed", error);
		}
	}

	private acceptState(state: PersistedReviewStateV4): void {
		if (!this.state || state.revision > this.state.revision) {
			this.state = state;
			this.changeEmitter.fire(state);
		}
	}

	private getMigrationState(ledger: ReviewLedger): Promise<PersistedReviewStateV4> {
		if (!this.loadingState) {
			this.loadingState = this.createMigrationState(ledger);
		}
		return this.loadingState;
	}

	private async createMigrationState(ledger: ReviewLedger): Promise<PersistedReviewStateV4> {
		const base = createEmptyReviewLedgerState(ledger.workspaceRoot);
		const legacy = this.extensionContextService.context.workspaceState.get<unknown>(legacyReviewStateStorageKey);
		const migrated = normalizeLegacyWorkspaceState(legacy, base);
		if (migrated.comments.length > 0 || migrated.effectiveInstructions) {
			this.diagnostics.info("reviewStore", "state.migrationPrepared", () => ({
				commentCount: migrated.comments.length
			}));
		}
		return migrated;
	}
}

function recoverClaims(current: PersistedReviewStateV4, now: Date): { state: PersistedReviewStateV4; result: number } {
	let recoveredCount = 0;
	const comments = current.comments.map((comment) => {
		if (comment.status !== "in_progress" || !comment.claim || Date.parse(comment.claim.expiresAt) > now.getTime()) {
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
		state: recoveredCount === 0 ? current : { ...current, comments },
		result: recoveredCount
	};
}

function hasExpiredClaims(comments: readonly ReviewComment[], now: Date): boolean {
	return comments.some(
		(comment) =>
			comment.status === "in_progress" &&
			Boolean(comment.claim) &&
			Date.parse(comment.claim!.expiresAt) <= now.getTime()
	);
}

function normalizeLegacyWorkspaceState(value: unknown, base: PersistedReviewStateV4): PersistedReviewStateV4 {
	if (!value || typeof value !== "object") {
		return base;
	}
	const state = value as {
		notes?: unknown;
		comments?: unknown;
		overallInstructions?: unknown;
		selectedTarget?: unknown;
	};
	const records = Array.isArray(state.comments) ? state.comments : Array.isArray(state.notes) ? state.notes : [];
	const comments = records.flatMap((record) => {
		const normalized = normalizeLegacyWorkspaceComment(record);
		return normalized ? [normalized] : [];
	});
	return {
		...base,
		comments,
		effectiveInstructions: typeof state.overallInstructions === "string" ? state.overallInstructions : "",
		selectedTarget: state.selectedTarget === "copilot" ? "copilot" : "codex"
	};
}

function normalizeLegacyWorkspaceComment(value: unknown): ReviewComment | undefined {
	if (isReviewComment(value)) {
		return value;
	}
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const old = value as Record<string, unknown>;
	if (typeof old.id !== "string" || typeof old.body !== "string" || typeof old.createdAt !== "string") {
		return undefined;
	}
	const intentValue = old.intent ?? old.kind;
	const intent = isReviewCommentIntent(intentValue) ? intentValue : "change";
	const updatedAt = typeof old.updatedAt === "string" ? old.updatedAt : old.createdAt;
	const anchor = isReviewAnchor(old.anchor) ? old.anchor : undefined;
	const anchorState =
		old.anchorState === "attached" || old.anchorState === "moved" || old.anchorState === "orphaned"
			? old.anchorState
			: "orphaned";
	return {
		id: old.id,
		version: 1,
		body: old.body,
		intent,
		status: "open",
		anchor,
		anchorState,
		createdAt: old.createdAt,
		updatedAt
	};
}
