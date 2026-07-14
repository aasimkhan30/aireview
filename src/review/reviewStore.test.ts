import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import type { ReviewNote } from "../common/reviewProtocol";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import type { IExtensionContextService } from "../services/extensionContextService";
import { ReviewStore } from "./reviewStore";

describe("ReviewStore", () => {
	const stores: ReviewStore[] = [];

	afterEach(() => {
		for (const store of stores) {
			store.dispose();
		}
		stores.length = 0;
	});

	it("starts with empty versioned state and ignores legacy notes", async () => {
		const storage = new FakeMemento({ "aireview.reviewNotes": [createNote("legacy")] });
		const store = createStore(storage);

		await expect(store.getState()).resolves.toEqual({ version: 1, notes: [] });
		expect(storage.get("aireview.reviewState")).toEqual({ version: 1, notes: [] });
	});

	it("serializes concurrent mutations without losing notes", async () => {
		const storage = new FakeMemento();
		const store = createStore(storage);
		await store.getState();
		storage.resetUpdateMetrics();

		await Promise.all([store.addNote(createNote("first")), store.addNote(createNote("second"))]);

		expect((await store.getState()).notes.map((note) => note.id)).toEqual(["second", "first"]);
		expect(storage.maximumConcurrentUpdates).toBe(1);
	});

	it("continues processing mutations after a failed persistence update", async () => {
		const storage = new FakeMemento();
		const store = createStore(storage);
		await store.getState();
		storage.failNextUpdate = true;

		await expect(store.addNote(createNote("failed"))).rejects.toThrow("Simulated storage failure");
		await expect(store.addNote(createNote("saved"))).resolves.toBeUndefined();
		expect((await store.getState()).notes.map((note) => note.id)).toEqual(["saved"]);
	});

	it("retries initial state loading after its persistence write fails", async () => {
		const storage = new FakeMemento();
		storage.failNextUpdate = true;
		const store = createStore(storage);

		await expect(store.getState()).rejects.toThrow("Simulated storage failure");
		await expect(store.getState()).resolves.toEqual({ version: 1, notes: [] });
	});

	function createStore(storage: FakeMemento): ReviewStore {
		const contextService = {
			_serviceBrand: undefined,
			context: { workspaceState: storage as vscode.Memento } as vscode.ExtensionContext
		} satisfies IExtensionContextService;
		const store = new ReviewStore(contextService, noOpDiagnostics);
		stores.push(store);
		return store;
	}
});

class FakeMemento {
	readonly values = new Map<string, unknown>();
	maximumConcurrentUpdates = 0;
	failNextUpdate = false;
	private concurrentUpdates = 0;

	constructor(initial: Readonly<Record<string, unknown>> = {}) {
		for (const [key, value] of Object.entries(initial)) {
			this.values.set(key, value);
		}
	}

	get<T>(key: string, defaultValue?: T): T | undefined {
		return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		this.concurrentUpdates += 1;
		this.maximumConcurrentUpdates = Math.max(this.maximumConcurrentUpdates, this.concurrentUpdates);
		try {
			await Promise.resolve();
			if (this.failNextUpdate) {
				this.failNextUpdate = false;
				throw new Error("Simulated storage failure");
			}
			if (value === undefined) {
				this.values.delete(key);
			} else {
				this.values.set(key, value);
			}
		} finally {
			this.concurrentUpdates -= 1;
		}
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
	}

	resetUpdateMetrics(): void {
		this.maximumConcurrentUpdates = 0;
	}
}

const noOpDiagnostics: IDiagnosticsService = {
	_serviceBrand: undefined,
	isEnabled: () => false,
	trace: () => undefined,
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
	record: () => undefined,
	startOperation: () => ({ correlationId: undefined, complete: () => undefined, fail: () => undefined })
};

function createNote(id: string): ReviewNote {
	return {
		id,
		body: `Note ${id}`,
		filePath: undefined,
		line: undefined,
		range: undefined,
		createdAt: "2026-07-14T00:00:00.000Z"
	};
}
