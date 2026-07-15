import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AgentTargetId, ReviewNote } from "../common/reviewProtocol";
import { isReviewNote } from "./reviewValidation";

export const reviewLedgerVersion = 3;

export interface ReviewLedgerState {
	readonly version: 3;
	readonly revision: number;
	readonly workspace: {
		readonly root: string;
		readonly name: string;
	};
	readonly notes: readonly ReviewNote[];
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

export class ReviewLedger {
	private constructor(
		readonly workspaceRoot: string,
		readonly location: ReviewLedgerLocation
	) {}

	static async open(workspaceRoot: string, dataDirectory = getDefaultAiReviewDataDirectory()): Promise<ReviewLedger> {
		const canonicalRoot = await canonicalizeWorkspaceRoot(workspaceRoot);
		const location = getReviewLedgerLocation(canonicalRoot, dataDirectory);
		await mkdir(location.workspaceDirectory, { recursive: true, mode: 0o700 });
		return new ReviewLedger(canonicalRoot, location);
	}

	async read(initialState?: ReviewLedgerState): Promise<ReviewLedgerState> {
		try {
			const state = await this.readExistingState();
			if (state) {
				return state;
			}
			throw new Error(`AI Review state is invalid: ${this.location.stateFile}`);
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
			const current = await this.readExistingState();
			if (!current) {
				throw new Error(`AI Review state became unavailable: ${this.location.stateFile}`);
			}
			const proposed = mutation(current);
			const next: ReviewLedgerState = {
				...proposed,
				version: reviewLedgerVersion,
				revision: current.revision + 1,
				updatedAt: new Date().toISOString()
			};
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
		return {
			dispose: () => {
				watcher.close();
			}
		};
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

	private async readExistingState(): Promise<ReviewLedgerState | undefined> {
		const parsed = JSON.parse(await readFile(this.location.stateFile, "utf8")) as unknown;
		return normalizeReviewLedgerState(parsed, this.workspaceRoot);
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
		throw new Error(`Timed out waiting for AI Review state lock: ${lockFile}`);
	}
}

export function getDefaultAiReviewDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
	if (environment.AIREVIEW_DATA_DIR) {
		return resolve(environment.AIREVIEW_DATA_DIR);
	}
	const home = homedir();
	switch (platform()) {
		case "darwin":
			return join(home, "Library", "Application Support", "AIReview");
		case "win32":
			return join(environment.LOCALAPPDATA ?? environment.APPDATA ?? home, "AIReview");
		default:
			return join(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "aireview");
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
		notes: [],
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
		!Array.isArray(state.notes) ||
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
		notes: state.notes.filter(isReviewNote),
		effectiveInstructions: state.effectiveInstructions,
		selectedTarget: state.selectedTarget,
		updatedAt: state.updatedAt
	};
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
