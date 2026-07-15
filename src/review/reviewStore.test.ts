import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewNote } from "../common/reviewProtocol";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import type { IExtensionContextService } from "../services/extensionContextService";
import { ReviewLedger } from "./reviewLedger";
import { ReviewStore } from "./reviewStore";

describe("ReviewStore", () => {
	let temporaryDirectory: string;
	let workspaceRoot: string;
	let dataDirectory: string;
	const stores: ReviewStore[] = [];

	beforeEach(async () => {
		temporaryDirectory = await mkdtemp(join(tmpdir(), "aireview-store-"));
		workspaceRoot = join(temporaryDirectory, "workspace");
		dataDirectory = join(temporaryDirectory, "data");
		await mkdir(workspaceRoot);
	});

	afterEach(async () => {
		for (const store of stores) {
			store.dispose();
		}
		stores.length = 0;
		await rm(temporaryDirectory, { recursive: true, force: true });
	});

	it("starts with an empty user-scoped ledger", async () => {
		const store = createStore(new FakeMemento());

		await expect(store.getState()).resolves.toMatchObject({
			version: 3,
			revision: 0,
			notes: [],
			effectiveInstructions: "",
			selectedTarget: "codex"
		});
		expect((await store.getLocation()).stateFile).toContain(dataDirectory);
	});

	it("migrates version two workspace state without losing note text", async () => {
		const storage = new FakeMemento({
			"aireview.reviewState": {
				version: 2,
				notes: [createNote("legacy")],
				overallInstructions: "Keep the public API stable.",
				selectedTarget: "copilot"
			}
		});
		const state = await createStore(storage).getState();

		expect(state).toMatchObject({
			version: 3,
			effectiveInstructions: "Keep the public API stable.",
			selectedTarget: "copilot"
		});
		expect(state.notes[0]).toMatchObject({ id: "legacy", body: "Note legacy", status: "draft" });
	});

	it("serializes concurrent mutations without losing notes", async () => {
		const store = createStore(new FakeMemento());
		await store.getState();

		await Promise.all([store.addNote(createNote("first")), store.addNote(createNote("second"))]);

		expect((await store.getState()).notes.map((note) => note.id).sort()).toEqual(["first", "second"]);
	});

	it("observes state written by another process", async () => {
		const store = createStore(new FakeMemento());
		await store.getState();
		const ledger = await ReviewLedger.open(workspaceRoot, dataDirectory);
		const changed = new Promise<void>((resolveChanged, rejectChanged) => {
			const timeout = setTimeout(() => rejectChanged(new Error("Timed out waiting for ledger change")), 1_000);
			const disposable = store.onDidChange((state) => {
				if (state.notes.some((note) => note.id === "external")) {
					clearTimeout(timeout);
					disposable.dispose();
					resolveChanged();
				}
			});
		});

		await ledger.mutate((state) => ({ ...state, notes: [createNote("external"), ...state.notes] }));
		await changed;

		expect((await store.getState()).notes[0].id).toBe("external");
	});

	function createStore(storage: FakeMemento): ReviewStore {
		const contextService = {
			_serviceBrand: undefined,
			context: { workspaceState: storage as vscode.Memento } as vscode.ExtensionContext,
			workspaceRoots: [workspaceRoot],
			dataDirectory
		} satisfies IExtensionContextService;
		const store = new ReviewStore(contextService, noOpDiagnostics);
		stores.push(store);
		return store;
	}
});

class FakeMemento {
	readonly values = new Map<string, unknown>();

	constructor(initial: Readonly<Record<string, unknown>> = {}) {
		for (const [key, value] of Object.entries(initial)) {
			this.values.set(key, value);
		}
	}

	get<T>(key: string, defaultValue?: T): T | undefined {
		return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
	}

	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}
	}

	keys(): readonly string[] {
		return [...this.values.keys()];
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
		kind: "change",
		status: "draft",
		anchor: undefined,
		anchorState: "orphaned",
		createdAt: "2026-07-14T00:00:00.000Z",
		updatedAt: "2026-07-14T00:00:00.000Z"
	};
}
