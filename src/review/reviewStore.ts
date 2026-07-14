import type { ReviewNote } from "../common/reviewProtocol";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { Emitter, type Event } from "../common/emitter";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { isReviewNote } from "./reviewValidation";

const reviewStateStorageKey = "aireview.reviewState";

export interface PersistedReviewStateV1 {
	readonly version: 1;
	readonly notes: readonly ReviewNote[];
}

export const IReviewStore = createServiceIdentifier<IReviewStore>("reviewStore");

export interface IReviewStore {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<PersistedReviewStateV1>;
	getState(): Promise<PersistedReviewStateV1>;
	addNote(note: ReviewNote): Promise<void>;
	deleteNote(id: string): Promise<boolean>;
}

export class ReviewStore extends Disposable implements IReviewStore {
	declare readonly _serviceBrand: undefined;

	private readonly changeEmitter = this._register(new Emitter<PersistedReviewStateV1>());
	readonly onDidChange = this.changeEmitter.event;

	private state: PersistedReviewStateV1 | undefined;
	private loadingState: Promise<PersistedReviewStateV1> | undefined;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		@IExtensionContextService private readonly extensionContextService: IExtensionContextService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
	}

	async getState(): Promise<PersistedReviewStateV1> {
		const operation = this.diagnostics.startOperation("reviewStore", "state.get");
		try {
			await this.mutationQueue;
			const state = await this.loadState();
			operation.complete(() => ({ noteCount: state.notes.length }));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async addNote(note: ReviewNote): Promise<void> {
		const operation = this.diagnostics.startOperation("reviewStore", "note.add");
		try {
			await this.enqueueMutation(async (current) => ({
				state: { version: 1, notes: [note, ...current.notes] },
				result: undefined
			}));
			operation.complete(() => ({ noteId: note.id }));
		} catch (error) {
			operation.fail(error, () => ({ noteId: note.id }));
			throw error;
		}
	}

	async deleteNote(id: string): Promise<boolean> {
		const operation = this.diagnostics.startOperation("reviewStore", "note.delete");
		try {
			const deleted = await this.enqueueMutation(async (current) => {
				const notes = current.notes.filter((note) => note.id !== id);
				return notes.length === current.notes.length
					? { state: current, result: false }
					: { state: { version: 1, notes }, result: true };
			});
			operation.complete(() => ({ noteId: id, deleted }));
			return deleted;
		} catch (error) {
			operation.fail(error, () => ({ noteId: id }));
			throw error;
		}
	}

	private enqueueMutation<T>(
		operation: (current: PersistedReviewStateV1) => Promise<{ state: PersistedReviewStateV1; result: T }>
	): Promise<T> {
		const result = this.mutationQueue.then(async () => {
			const current = await this.loadState();
			const outcome = await operation(current);
			if (outcome.state !== current) {
				await this.extensionContextService.context.workspaceState.update(reviewStateStorageKey, outcome.state);
				this.state = outcome.state;
				this.changeEmitter.fire(outcome.state);
			}
			return outcome.result;
		});

		this.mutationQueue = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	}

	private loadState(): Promise<PersistedReviewStateV1> {
		if (this.state) {
			return Promise.resolve(this.state);
		}

		if (!this.loadingState) {
			const loadingState = this.readState();
			this.loadingState = loadingState;
			void loadingState.then(undefined, () => {
				if (this.loadingState === loadingState) {
					this.loadingState = undefined;
				}
			});
		}
		return this.loadingState;
	}

	private async readState(): Promise<PersistedReviewStateV1> {
		const storage = this.extensionContextService.context.workspaceState;
		const stored = normalizePersistedState(storage.get<unknown>(reviewStateStorageKey));
		if (stored) {
			this.state = stored;
			this.diagnostics.debug("reviewStore", "state.loaded", () => ({ noteCount: stored.notes.length }));
			return stored;
		}

		const initialState: PersistedReviewStateV1 = {
			version: 1,
			notes: []
		};
		await storage.update(reviewStateStorageKey, initialState);
		this.state = initialState;
		this.diagnostics.info("reviewStore", "state.initialized");
		return initialState;
	}
}

function normalizePersistedState(value: unknown): PersistedReviewStateV1 | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const state = value as Partial<PersistedReviewStateV1>;
	if (state.version !== 1 || !Array.isArray(state.notes)) {
		return undefined;
	}

	return { version: 1, notes: state.notes.filter(isReviewNote) };
}
