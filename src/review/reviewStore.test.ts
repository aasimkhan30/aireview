import { chmod, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReviewComment } from "../common/reviewProtocol";
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
		temporaryDirectory = await mkdtemp(join(tmpdir(), "requestchanges-store-"));
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

	it("starts with an empty version four ledger", async () => {
		const store = createStore(new FakeMemento());
		await expect(store.getState()).resolves.toMatchObject({
			version: 4,
			revision: 0,
			comments: [],
			effectiveInstructions: "",
			selectedTarget: "codex"
		});
	});

	it("migrates version two workspace state into open comments", async () => {
		const storage = new FakeMemento({
			"requestchanges.reviewState": {
				version: 2,
				notes: [createComment("legacy")],
				overallInstructions: "Keep the public API stable.",
				selectedTarget: "copilot"
			}
		});
		const state = await createStore(storage).getState();
		expect(state).toMatchObject({
			version: 4,
			effectiveInstructions: "Keep the public API stable.",
			selectedTarget: "copilot"
		});
		expect(state.comments[0]).toMatchObject({
			id: "legacy",
			body: "Comment legacy",
			status: "open"
		});
	});

	it("serializes concurrent mutations without losing comments", async () => {
		const store = createStore(new FakeMemento());
		await store.getState();
		await Promise.all([store.addComment(createComment("first")), store.addComment(createComment("second"))]);
		expect((await store.getState()).comments.map((comment) => comment.id).sort()).toEqual(["first", "second"]);
	});

	it("edits only open comments and increments the request version", async () => {
		const store = createStore(new FakeMemento());
		await store.addComment(createComment("open"));
		await expect(
			store.editOpenComment({
				id: "open",
				expectedVersion: 1,
				body: "Updated",
				intent: "question"
			})
		).resolves.toBe(true);
		expect((await store.getState()).comments[0]).toMatchObject({
			version: 2,
			body: "Updated",
			intent: "question"
		});
		await expect(
			store.editOpenComment({
				id: "open",
				expectedVersion: 1,
				body: "Stale",
				intent: "change"
			})
		).rejects.toThrow("changed");
	});

	it("keeps working and terminal comments immutable while allowing terminal deletion", async () => {
		const store = createStore(new FakeMemento());
		const ledger = await ReviewLedger.open(workspaceRoot, dataDirectory);
		await ledger.read();
		await ledger.mutate((state) => ({
			...state,
			comments: [
				createWorkingComment("working", "2101-07-26T00:00:00.000Z"),
				createTerminalComment("resolved", "resolved"),
				createTerminalComment("unresolved", "unresolved")
			]
		}));
		for (const id of ["working", "resolved", "unresolved"]) {
			await expect(
				store.editOpenComment({
					id,
					expectedVersion: 1,
					body: "Changed",
					intent: "change"
				})
			).rejects.toThrow("Only open");
		}
		await expect(store.deleteComment("working")).rejects.toThrow("cannot be deleted");
		await expect(store.deleteComment("resolved")).resolves.toBe(true);
		await expect(store.deleteComment("unresolved")).resolves.toBe(true);
	});

	it("clears resolved comments atomically and leaves all other states", async () => {
		const store = createStore(new FakeMemento());
		const ledger = await ReviewLedger.open(workspaceRoot, dataDirectory);
		await ledger.read();
		await ledger.mutate((state) => ({
			...state,
			comments: [
				createTerminalComment("resolved", "resolved"),
				createTerminalComment("unresolved", "unresolved"),
				createComment("open"),
				createWorkingComment("working")
			]
		}));
		await expect(store.clearResolvedComments()).resolves.toBe(1);
		expect((await store.getState()).comments.map((comment) => comment.id).sort()).toEqual([
			"open",
			"unresolved",
			"working"
		]);
	});

	it("recovers expired claims but preserves live claims", async () => {
		const store = createStore(new FakeMemento());
		const ledger = await ReviewLedger.open(workspaceRoot, dataDirectory);
		await ledger.read();
		await ledger.mutate((state) => ({
			...state,
			comments: [
				createWorkingComment("expired", "2099-07-24T23:00:00.000Z"),
				createWorkingComment("live", "2101-07-26T00:00:00.000Z")
			]
		}));
		await expect(store.recoverExpiredClaims(new Date("2100-07-25T00:00:00.000Z"))).resolves.toBe(1);
		const comments = (await store.getState()).comments;
		expect(comments).toMatchObject([
			{ id: "expired", status: "open" },
			{ id: "live", status: "in_progress" }
		]);
		expect(comments[0].claim).toBeUndefined();
	});

	it("observes state written by another process", async () => {
		const store = createStore(new FakeMemento());
		await store.getState();
		const ledger = await ReviewLedger.open(workspaceRoot, dataDirectory);
		const changed = new Promise<void>((resolveChanged, rejectChanged) => {
			const timeout = setTimeout(() => rejectChanged(new Error("Timed out waiting for ledger change")), 1_000);
			const disposable = store.onDidChange((state) => {
				if (state.comments.some((comment) => comment.id === "external")) {
					clearTimeout(timeout);
					disposable.dispose();
					resolveChanged();
				}
			});
		});
		await ledger.mutate((state) => ({
			...state,
			comments: [createComment("external"), ...state.comments]
		}));
		await changed;
		expect((await store.getState()).comments[0].id).toBe("external");
	});

	it("does not replace the ledger when an atomic write fails", async () => {
		const store = createStore(new FakeMemento());
		await store.addComment(createTerminalComment("resolved", "resolved"));
		const location = await store.getLocation();
		const before = await readFile(location.stateFile, "utf8");
		await chmod(location.workspaceDirectory, 0o500);
		try {
			await expect(store.clearResolvedComments()).rejects.toThrow();
		} finally {
			await chmod(location.workspaceDirectory, 0o700);
		}
		const after = await readFile(location.stateFile, "utf8");
		expect(after).toBe(before);
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

function createComment(id: string): ReviewComment {
	return {
		id,
		version: 1,
		body: `Comment ${id}`,
		intent: "change",
		status: "open",
		anchor: undefined,
		anchorState: "orphaned",
		createdAt: "2026-07-14T00:00:00.000Z",
		updatedAt: "2026-07-14T00:00:00.000Z"
	};
}

function createWorkingComment(id: string, expiresAt = "2026-07-25T08:00:00.000Z"): ReviewComment {
	return {
		...createComment(id),
		status: "in_progress",
		claim: {
			token: `token-${id}`,
			client: "test",
			commentVersion: 1,
			claimedAt: "2026-07-25T07:00:00.000Z",
			expiresAt
		}
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
						client: "test",
						summary: "Done",
						changedFiles: [],
						completedAt: "2026-07-25T08:00:00.000Z",
						claimToken: `token-${id}`
					}
				: {
						outcome: "unresolved",
						client: "test",
						reason: "missing_requirement",
						explanation: "Missing behavior",
						completedAt: "2026-07-25T08:00:00.000Z",
						claimToken: `token-${id}`
					}
	};
}
