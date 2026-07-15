import type { ReviewNote, ReviewResolution } from "../common/reviewProtocol";
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
import { isReviewNote } from "./reviewValidation";

const legacyReviewStateStorageKey = "requestchanges.reviewState";

export type PersistedReviewStateV3 = ReviewLedgerState;

export const IReviewStore = createServiceIdentifier<IReviewStore>("reviewStore");

export interface IReviewStore {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<PersistedReviewStateV3>;
	getState(): Promise<PersistedReviewStateV3>;
	getLocation(): Promise<ReviewLedgerLocation>;
	addNote(note: ReviewNote): Promise<void>;
	updateNote(note: ReviewNote): Promise<boolean>;
	deleteNote(id: string): Promise<boolean>;
	setEffectiveInstructions(value: string): Promise<void>;
}

export class ReviewStore extends Disposable implements IReviewStore {
	declare readonly _serviceBrand: undefined;

	private readonly changeEmitter = this._register(new Emitter<PersistedReviewStateV3>());
	readonly onDidChange = this.changeEmitter.event;

	private state: PersistedReviewStateV3 | undefined;
	private ledgerPromise: Promise<ReviewLedger> | undefined;
	private loadingState: Promise<PersistedReviewStateV3> | undefined;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		@IExtensionContextService private readonly extensionContextService: IExtensionContextService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
	}

	async getState(): Promise<PersistedReviewStateV3> {
		const operation = this.diagnostics.startOperation("reviewStore", "state.get");
		try {
			await this.mutationQueue;
			const ledger = await this.getLedger();
			const state = await ledger.read(await this.getMigrationState(ledger));
			this.acceptState(state);
			operation.complete(() => ({ noteCount: state.notes.length, ledgerRevision: state.revision }));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async getLocation(): Promise<ReviewLedgerLocation> {
		return (await this.getLedger()).location;
	}

	async addNote(note: ReviewNote): Promise<void> {
		const operation = this.diagnostics.startOperation("reviewStore", "note.add");
		try {
			await this.enqueueMutation((current) => ({ ...current, notes: [note, ...current.notes] }));
			operation.complete(() => ({ noteId: note.id }));
		} catch (error) {
			operation.fail(error, () => ({ noteId: note.id }));
			throw error;
		}
	}

	updateNote(note: ReviewNote): Promise<boolean> {
		return this.enqueueMutationWithResult((current) => {
			const index = current.notes.findIndex((candidate) => candidate.id === note.id);
			if (index < 0) {
				return { state: current, result: false };
			}
			const notes = [...current.notes];
			notes[index] = note;
			return { state: { ...current, notes }, result: true };
		});
	}

	deleteNote(id: string): Promise<boolean> {
		return this.enqueueMutationWithResult((current) => {
			const notes = current.notes.filter((note) => note.id !== id);
			return notes.length === current.notes.length
				? { state: current, result: false }
				: { state: { ...current, notes }, result: true };
		});
	}

	async setEffectiveInstructions(value: string): Promise<void> {
		const current = await this.getState();
		if (current.effectiveInstructions !== value) {
			await this.enqueueMutation((state) => ({ ...state, effectiveInstructions: value }));
		}
	}

	private enqueueMutation(operation: (current: PersistedReviewStateV3) => PersistedReviewStateV3): Promise<void> {
		return this.enqueueMutationWithResult((current) => ({ state: operation(current), result: undefined }));
	}

	private enqueueMutationWithResult<T>(
		operation: (current: PersistedReviewStateV3) => { state: PersistedReviewStateV3; result: T }
	): Promise<T> {
		const result = this.mutationQueue.then(async () => {
			const ledger = await this.getLedger();
			await ledger.read(await this.getMigrationState(ledger));
			let operationResult: T | undefined;
			const next = await ledger.mutate((current) => {
				const outcome = operation(current);
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
					this._register(
						ledger.watch(() => {
							void this.refreshFromLedger(ledger);
						})
					);
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

	private acceptState(state: PersistedReviewStateV3): void {
		if (!this.state || state.revision > this.state.revision) {
			this.state = state;
			this.changeEmitter.fire(state);
		}
	}

	private getMigrationState(ledger: ReviewLedger): Promise<PersistedReviewStateV3> {
		if (!this.loadingState) {
			this.loadingState = this.createMigrationState(ledger);
		}
		return this.loadingState;
	}

	private async createMigrationState(ledger: ReviewLedger): Promise<PersistedReviewStateV3> {
		const base = createEmptyReviewLedgerState(ledger.workspaceRoot);
		const legacy = this.extensionContextService.context.workspaceState.get<unknown>(legacyReviewStateStorageKey);
		const migrated = normalizeLegacyState(legacy, base);
		if (migrated.notes.length > 0 || migrated.effectiveInstructions) {
			this.diagnostics.info("reviewStore", "state.migrationPrepared", () => ({
				noteCount: migrated.notes.length
			}));
		}
		return migrated;
	}
}

function normalizeLegacyState(value: unknown, base: PersistedReviewStateV3): PersistedReviewStateV3 {
	if (!value || typeof value !== "object") {
		return base;
	}
	const state = value as {
		version?: unknown;
		notes?: unknown;
		overallInstructions?: unknown;
		selectedTarget?: unknown;
	};
	const notes = Array.isArray(state.notes)
		? state.notes.flatMap((note) => {
				const normalized = normalizeLegacyNote(note);
				return normalized ? [normalized] : [];
			})
		: [];
	return {
		...base,
		notes,
		effectiveInstructions: typeof state.overallInstructions === "string" ? state.overallInstructions : "",
		selectedTarget: state.selectedTarget === "copilot" ? "copilot" : "codex"
	};
}

function normalizeLegacyNote(value: unknown): ReviewNote | undefined {
	if (isReviewNote(value)) {
		return value;
	}
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const note = value as Omit<Partial<ReviewNote>, "status"> & { status?: unknown };
	if (typeof note.id !== "string" || typeof note.body !== "string" || typeof note.createdAt !== "string") {
		return undefined;
	}
	const updatedAt = typeof note.updatedAt === "string" ? note.updatedAt : note.createdAt;
	const sentResolution: ReviewResolution | undefined =
		note.status === "sent"
			? { client: "legacy handoff", changedFiles: [], summary: "Previously sent to an agent", updatedAt }
			: undefined;
	return {
		id: note.id,
		body: note.body,
		kind: note.kind === "question" || note.kind === "explain" || note.kind === "test" ? note.kind : "change",
		status: note.status === "resolved" ? "resolved" : note.status === "sent" ? "addressed" : "draft",
		anchor: note.anchor,
		anchorState:
			note.anchorState === "attached" || note.anchorState === "moved" || note.anchorState === "orphaned"
				? note.anchorState
				: "orphaned",
		resolution: note.resolution ?? sentResolution,
		createdAt: note.createdAt,
		updatedAt
	};
}
