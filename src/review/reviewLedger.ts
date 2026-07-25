import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
	AgentTargetId,
	ReviewAnchorState,
	ReviewComment,
	ReviewCommentIntent,
	ReviewCommentResult
} from "../common/reviewProtocol";
import { isReviewAnchor, isReviewComment } from "./reviewValidation";

export const reviewLedgerVersion = 4;

export interface ReviewLedgerState {
	readonly version: 4;
	readonly revision: number;
	readonly workspace: {
		readonly root: string;
		readonly name: string;
	};
	readonly comments: readonly ReviewComment[];
	readonly effectiveInstructions: string;
	readonly selectedTarget: AgentTargetId;
	readonly updatedAt: string;
}

export interface ReviewLedgerLocation {
	readonly dataDirectory: string;
	readonly workspaceDirectory: string;
	readonly stateFile: string;
	readonly workspaceKey: string;
}

export type ReviewLedgerMutation = (state: ReviewLedgerState) => ReviewLedgerState;

interface ReadStateResult {
	readonly state: ReviewLedgerState;
	readonly migrated: boolean;
}

export class ReviewLedger {
	private constructor(
		readonly workspaceRoot: string,
		readonly location: ReviewLedgerLocation
	) {}

	static async open(
		workspaceRoot: string,
		dataDirectory = getDefaultRequestChangesDataDirectory()
	): Promise<ReviewLedger> {
		const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
		const location = getReviewLedgerLocation(canonicalRoot, dataDirectory);
		await mkdir(location.workspaceDirectory, { recursive: true, mode: 0o700 });
		return new ReviewLedger(canonicalRoot, location);
	}

	async read(initialState?: ReviewLedgerState): Promise<ReviewLedgerState> {
		try {
			const existing = await this.readExistingState();
			if (existing.migrated) {
				return this.withLock(async () => {
					const latest = await this.readExistingState();
					if (latest.migrated) {
						await this.writeState(latest.state);
					}
					return latest.state;
				});
			}
			return existing.state;
		} catch (error) {
			if (!isFileNotFound(error)) {
				throw error;
			}
		}

		const state = initialState ?? createEmptyReviewLedgerState(this.workspaceRoot);
		await this.writeInitialState(state);
		return state;
	}

	async mutate(mutation: ReviewLedgerMutation): Promise<ReviewLedgerState> {
		await this.read();
		return this.withLock(async () => {
			const current = (await this.readExistingState()).state;
			const proposed = mutation(current);
			if (proposed === current) {
				return current;
			}
			const next: ReviewLedgerState = {
				...proposed,
				version: reviewLedgerVersion,
				revision: current.revision + 1,
				updatedAt: new Date().toISOString()
			};
			if (!isValidReviewLedgerState(next)) {
				throw new Error("Request Changes refused to write an invalid review ledger");
			}
			await this.writeState(next);
			return next;
		});
	}

	watch(listener: () => void): { dispose(): void } {
		const watcher: FSWatcher = watch(this.location.workspaceDirectory, (_event, filename) => {
			if (!filename || filename.toString() === basename(this.location.stateFile)) {
				listener();
			}
		});
		watcher.on("error", () => undefined);
		return { dispose: () => watcher.close() };
	}

	private async writeInitialState(state: ReviewLedgerState): Promise<void> {
		await this.withLock(async () => {
			try {
				await stat(this.location.stateFile);
				return;
			} catch (error) {
				if (!isFileNotFound(error)) {
					throw error;
				}
			}
			await this.writeState(state);
		});
	}

	private async readExistingState(): Promise<ReadStateResult> {
		const parsed = JSON.parse(await readFile(this.location.stateFile, "utf8")) as unknown;
		const current = normalizeReviewLedgerState(parsed, this.workspaceRoot);
		if (current) {
			return { state: current, migrated: false };
		}
		const migrated = migrateVersion3ReviewLedgerState(parsed, this.workspaceRoot);
		if (migrated) {
			return { state: migrated, migrated: true };
		}
		throw new Error(`Request Changes state is invalid: ${this.location.stateFile}`);
	}

	private async writeState(state: ReviewLedgerState): Promise<void> {
		await mkdir(this.location.workspaceDirectory, { recursive: true, mode: 0o700 });
		const temporaryFile = join(this.location.workspaceDirectory, `.review-state-${randomUUID()}.tmp`);
		await writeFile(temporaryFile, `${JSON.stringify(state, undefined, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryFile, this.location.stateFile);
		await chmod(this.location.stateFile, 0o600).catch(() => undefined);
	}

	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await mkdir(this.location.workspaceDirectory, { recursive: true, mode: 0o700 });
		const lockFile = `${this.location.stateFile}.lock`;
		for (let attempt = 0; attempt < 80; attempt += 1) {
			try {
				const handle = await open(lockFile, "wx", 0o600);
				try {
					return await operation();
				} finally {
					await handle.close();
					await rm(lockFile, { force: true });
				}
			} catch (error) {
				if (!isAlreadyExists(error)) {
					throw error;
				}
				if (await isStaleLock(lockFile)) {
					await rm(lockFile, { force: true });
					continue;
				}
				await delay(25);
			}
		}
		throw new Error(`Timed out waiting for Request Changes state lock: ${lockFile}`);
	}
}

export function getDefaultRequestChangesDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.REQUEST_CHANGES_DATA_DIR) {
		return resolve(environment.REQUEST_CHANGES_DATA_DIR);
	}
	const home = homedir();
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", "Request Changes");
		case "win32":
			return join(environment.LOCALAPPDATA ?? environment.APPDATA ?? home, "Request Changes");
		default:
			return join(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "request-changes");
	}
}

export function getReviewLedgerLocation(workspaceRoot: string, dataDirectory: string): ReviewLedgerLocation {
	const workspaceKey = createWorkspaceKey(workspaceRoot);
	const workspaceDirectory = join(resolve(dataDirectory), "workspaces", workspaceKey);
	return {
		dataDirectory: resolve(dataDirectory),
		workspaceDirectory,
		stateFile: join(workspaceDirectory, "review-state.json"),
		workspaceKey
	};
}

export function createWorkspaceKey(workspaceRoot: string): string {
	const normalized = platform() === "win32" ? resolve(workspaceRoot).toLowerCase() : resolve(workspaceRoot);
	return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export function createEmptyReviewLedgerState(workspaceRoot: string): ReviewLedgerState {
	return {
		version: reviewLedgerVersion,
		revision: 0,
		workspace: { root: workspaceRoot, name: basename(workspaceRoot) || workspaceRoot },
		comments: [],
		effectiveInstructions: "",
		selectedTarget: "codex",
		updatedAt: new Date().toISOString()
	};
}

export function normalizeReviewLedgerState(value: unknown, workspaceRoot: string): ReviewLedgerState | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const state = value as Partial<ReviewLedgerState>;
	if (
		state.version !== reviewLedgerVersion ||
		!Number.isInteger(state.revision) ||
		(state.revision ?? -1) < 0 ||
		!Array.isArray(state.comments) ||
		!state.comments.every(isReviewComment) ||
		typeof state.effectiveInstructions !== "string" ||
		(state.selectedTarget !== "codex" && state.selectedTarget !== "copilot") ||
		typeof state.updatedAt !== "string"
	) {
		return undefined;
	}
	return {
		version: reviewLedgerVersion,
		revision: state.revision!,
		workspace: { root: workspaceRoot, name: basename(workspaceRoot) || workspaceRoot },
		comments: state.comments,
		effectiveInstructions: state.effectiveInstructions,
		selectedTarget: state.selectedTarget,
		updatedAt: state.updatedAt
	};
}

export function migrateVersion3ReviewLedgerState(value: unknown, workspaceRoot: string): ReviewLedgerState | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const state = value as {
		version?: unknown;
		revision?: unknown;
		notes?: unknown;
		effectiveInstructions?: unknown;
		selectedTarget?: unknown;
		updatedAt?: unknown;
	};
	if (
		state.version !== 3 ||
		!Number.isInteger(state.revision) ||
		(state.revision as number) < 0 ||
		!Array.isArray(state.notes) ||
		typeof state.effectiveInstructions !== "string" ||
		(state.selectedTarget !== "codex" && state.selectedTarget !== "copilot") ||
		typeof state.updatedAt !== "string"
	) {
		return undefined;
	}
	const comments = state.notes.map(migrateVersion3Comment);
	// Abort the complete migration instead of silently discarding an invalid record.
	if (comments.some((comment) => !comment)) {
		return undefined;
	}
	const migrated: ReviewLedgerState = {
		version: reviewLedgerVersion,
		revision: state.revision as number,
		workspace: { root: workspaceRoot, name: basename(workspaceRoot) || workspaceRoot },
		comments: comments as ReviewComment[],
		effectiveInstructions: state.effectiveInstructions,
		selectedTarget: state.selectedTarget,
		updatedAt: state.updatedAt
	};
	return isValidReviewLedgerState(migrated) ? migrated : undefined;
}

function migrateVersion3Comment(value: unknown): ReviewComment | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const old = value as Record<string, unknown>;
	if (
		typeof old.id !== "string" ||
		!old.id.trim() ||
		typeof old.body !== "string" ||
		!old.body.trim() ||
		typeof old.createdAt !== "string"
	) {
		return undefined;
	}
	const intent = normalizeLegacyIntent(old.kind);
	const anchorState = normalizeAnchorState(old.anchorState);
	const anchor = old.anchor === undefined || isReviewAnchor(old.anchor) ? old.anchor : undefined;
	if (!intent || !anchorState || (old.anchor !== undefined && anchor === undefined)) {
		return undefined;
	}
	const updatedAt = typeof old.updatedAt === "string" ? old.updatedAt : old.createdAt;
	const version =
		typeof old.version === "number" && Number.isInteger(old.version) && old.version >= 1 ? old.version : 1;
	const status = old.status;
	if (status === "draft" || status === "in_progress") {
		return {
			id: old.id,
			version,
			body: old.body,
			intent,
			status: "open",
			anchor,
			anchorState,
			createdAt: old.createdAt,
			updatedAt
		};
	}
	if (status !== "addressed" && status !== "blocked" && status !== "resolved") {
		return undefined;
	}
	const result = migrateLegacyResult(old.id, status, old.resolution, updatedAt);
	return {
		id: old.id,
		version,
		body: old.body,
		intent,
		status: status === "blocked" ? "unresolved" : "resolved",
		anchor,
		anchorState,
		result,
		createdAt: old.createdAt,
		updatedAt
	};
}

function migrateLegacyResult(
	id: string,
	status: "addressed" | "blocked" | "resolved",
	value: unknown,
	updatedAt: string
): ReviewCommentResult {
	const resolution = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const client =
		typeof resolution.client === "string" && resolution.client.trim()
			? resolution.client
			: "Request Changes migration";
	const completedAt =
		typeof resolution.updatedAt === "string" && resolution.updatedAt ? resolution.updatedAt : updatedAt;
	const claimToken = `migrated:${id}`;
	if (status === "blocked") {
		return {
			outcome: "unresolved",
			client,
			reason: "missing_requirement",
			explanation:
				typeof resolution.blockedReason === "string" && resolution.blockedReason.trim()
					? resolution.blockedReason
					: "The agent could not resolve this comment.",
			completedAt,
			claimToken
		};
	}
	return {
		outcome: "resolved",
		client,
		summary:
			typeof resolution.summary === "string" && resolution.summary.trim()
				? resolution.summary
				: status === "addressed"
					? "The agent completed this comment before the simplified workflow was introduced."
					: "Resolved before the simplified workflow was introduced.",
		changedFiles: Array.isArray(resolution.changedFiles)
			? resolution.changedFiles.filter((file): file is string => typeof file === "string")
			: [],
		verification: typeof resolution.verification === "string" ? resolution.verification : undefined,
		completedAt,
		claimToken
	};
}

function normalizeLegacyIntent(value: unknown): ReviewCommentIntent | undefined {
	return value === "change" || value === "question" || value === "explain" || value === "test" ? value : undefined;
}

function normalizeAnchorState(value: unknown): ReviewAnchorState | undefined {
	return value === "attached" || value === "moved" || value === "orphaned" ? value : undefined;
}

function isValidReviewLedgerState(state: ReviewLedgerState): boolean {
	return (
		state.version === reviewLedgerVersion &&
		Number.isInteger(state.revision) &&
		state.revision >= 0 &&
		state.comments.every(isReviewComment) &&
		typeof state.effectiveInstructions === "string" &&
		(state.selectedTarget === "codex" || state.selectedTarget === "copilot") &&
		typeof state.updatedAt === "string"
	);
}

async function canonicalizeWorkspaceRoot(workspaceRoot: string): Promise<string> {
	const absolute = resolve(workspaceRoot);
	return realpath(absolute).catch(() => absolute);
}

async function isStaleLock(lockFile: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(lockFile)).mtimeMs > 10_000;
	} catch {
		return false;
	}
}

function isFileNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
