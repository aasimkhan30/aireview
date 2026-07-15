import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
	AddReviewNoteParams,
	ReviewAnchor,
	ReviewAnchorState,
	ReviewBundlePreview,
	ReviewCopyResult,
	ReviewNote,
	ReviewPanelState,
	ReviewPanelStateEnvelope,
	ReviewRange,
	UpdateReviewNoteParams,
	WorkspaceSnapshot
} from "../common/reviewProtocol";
import { Emitter, type Event } from "../common/emitter";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { IReviewStore } from "./reviewStore";
import { buildReviewBundle } from "./reviewBundle";

export const IReviewPanelStateService = createServiceIdentifier<IReviewPanelStateService>("reviewPanelStateService");

export interface IReviewPanelStateService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<ReviewPanelStateEnvelope>;
	captureActiveTextEditor(): void;
	getState(): Promise<ReviewPanelStateEnvelope>;
	refresh(): Promise<ReviewPanelStateEnvelope>;
	addNote(input: AddReviewNoteParams): Promise<ReviewPanelStateEnvelope>;
	updateNote(input: UpdateReviewNoteParams): Promise<ReviewPanelStateEnvelope>;
	updateNoteAnchor(id: string, anchor: ReviewAnchor, anchorState: ReviewAnchorState): Promise<void>;
	deleteNote(id: string): Promise<ReviewPanelStateEnvelope>;
	previewBundle(): Promise<ReviewBundlePreview>;
	copyBundle(): Promise<ReviewCopyResult>;
}

export class ReviewPanelStateService extends Disposable implements IReviewPanelStateService {
	declare readonly _serviceBrand: undefined;

	private readonly sourceId = randomUUID();
	private readonly stateEmitter = this._register(new Emitter<ReviewPanelStateEnvelope>());
	readonly onDidChangeState = this.stateEmitter.event;

	private lastTextEditor: vscode.TextEditor | undefined;
	private latestState: ReviewPanelStateEnvelope | undefined;
	private revision = 0;
	private refreshRequested = false;
	private refreshPromise: Promise<ReviewPanelStateEnvelope> | undefined;

	constructor(
		@IReviewStore private readonly reviewStore: IReviewStore,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
		this.lastTextEditor = vscode.window.activeTextEditor;
		this._register(reviewStore.onDidChange(() => this.requestRefresh()));
		this._register(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.lastTextEditor = editor;
				}
				this.requestRefresh();
			})
		);
		this._register(
			vscode.window.onDidChangeTextEditorSelection((event) => {
				this.lastTextEditor = event.textEditor;
				this.requestRefresh();
			})
		);
	}

	captureActiveTextEditor(): void {
		this.lastTextEditor = vscode.window.activeTextEditor ?? this.lastTextEditor;
	}

	getState(): Promise<ReviewPanelStateEnvelope> {
		return this.latestState ? Promise.resolve(this.latestState) : this.refresh();
	}

	refresh(): Promise<ReviewPanelStateEnvelope> {
		this.refreshRequested = true;
		if (!this.refreshPromise) {
			const promise = this.runRefreshWithDiagnostics();
			this.refreshPromise = promise;
			void promise.then(
				() => this.clearRefreshPromise(promise),
				() => this.clearRefreshPromise(promise)
			);
		}
		return this.refreshPromise;
	}

	async addNote(input: AddReviewNoteParams): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "note.add");
		const now = new Date().toISOString();
		const note: ReviewNote = {
			id: input.id ?? randomUUID(),
			body: input.body.trim(),
			kind: input.kind ?? "change",
			status: "draft",
			anchor: input.anchor,
			anchorState: input.anchor ? "attached" : "orphaned",
			createdAt: now,
			updatedAt: now
		};
		try {
			await this.reviewStore.addNote(note);
			const state = await this.refresh();
			operation.complete(() => ({ revision: state.revision, noteCount: state.value.notes.length }));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async updateNote(input: UpdateReviewNoteParams): Promise<ReviewPanelStateEnvelope> {
		const state = await this.reviewStore.getState();
		const current = state.notes.find((note) => note.id === input.id);
		if (!current) {
			throw new Error("Review note not found");
		}
		const note: ReviewNote = {
			...current,
			body: input.body ?? current.body,
			kind: input.kind ?? current.kind,
			status: input.status ?? current.status,
			resolution: input.status === "draft" ? undefined : (input.resolution ?? current.resolution),
			updatedAt: new Date().toISOString()
		};
		await this.reviewStore.updateNote(note);
		return this.refresh();
	}

	async updateNoteAnchor(id: string, anchor: ReviewAnchor, anchorState: ReviewAnchorState): Promise<void> {
		const state = await this.reviewStore.getState();
		const current = state.notes.find((note) => note.id === id);
		if (!current) {
			return;
		}
		await this.reviewStore.updateNote({ ...current, anchor, anchorState, updatedAt: new Date().toISOString() });
	}

	async deleteNote(id: string): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "note.delete");
		try {
			const deleted = await this.reviewStore.deleteNote(id);
			const state = deleted ? await this.refresh() : await this.getState();
			operation.complete(() => ({ deleted, revision: state.revision, noteCount: state.value.notes.length }));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async previewBundle(): Promise<ReviewBundlePreview> {
		const state = await this.reviewStore.getState();
		const notes = state.notes.filter((note) => isActionableStatus(note.status));
		const filePaths = new Set(
			notes.map((note) => note.anchor?.filePath).filter((value): value is string => Boolean(value))
		);
		return {
			markdown: buildReviewBundle(state.effectiveInstructions, notes),
			fileCount: filePaths.size,
			noteCount: notes.length,
			orphanedCount: notes.filter((note) => note.anchorState === "orphaned").length
		};
	}

	async copyBundle(): Promise<ReviewCopyResult> {
		const operation = this.diagnostics.startOperation("reviewState", "bundle.copy");
		try {
			const preview = await this.previewBundle();
			if (preview.noteCount === 0) {
				throw new Error("Add at least one open review note before copying");
			}
			await vscode.env.clipboard.writeText(preview.markdown);
			const message = "Review bundle copied to the clipboard.";
			operation.complete(() => ({ noteCount: preview.noteCount }));
			return { message };
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	private async runRefreshWithDiagnostics(): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "refresh");
		try {
			const state = await this.runRefreshLoop();
			operation.complete(() => ({
				revision: state.revision,
				noteCount: state.value.notes.length,
				hasActiveFile: state.value.workspace.activeFile !== undefined
			}));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	private async runRefreshLoop(): Promise<ReviewPanelStateEnvelope> {
		let accepted = this.latestState;
		do {
			this.refreshRequested = false;
			const value = await this.buildState();
			if (this.refreshRequested) {
				continue;
			}
			accepted = { sourceId: this.sourceId, revision: ++this.revision, value };
			this.latestState = accepted;
			this.stateEmitter.fire(accepted);
		} while (this.refreshRequested);
		if (!accepted) {
			throw new Error("Review state refresh completed without producing a snapshot");
		}
		return accepted;
	}

	private clearRefreshPromise(promise: Promise<ReviewPanelStateEnvelope>): void {
		if (this.refreshPromise === promise) {
			this.refreshPromise = undefined;
		}
	}

	private requestRefresh(): void {
		void this.refresh().catch((error) => this.diagnostics.error("reviewState", "refresh.backgroundFailed", error));
	}

	private async buildState(): Promise<ReviewPanelState> {
		const [workspace, persistedState] = await Promise.all([
			this.getWorkspaceSnapshot(),
			this.reviewStore.getState()
		]);
		return {
			workspace,
			notes: persistedState.notes
		};
	}

	private async getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
		const activeFile = this.getActiveFileSnapshot();
		const activeFileUri = activeFile ? vscode.Uri.parse(activeFile.uri) : undefined;
		const activeWorkspaceFolder = activeFileUri
			? vscode.workspace.getWorkspaceFolder(activeFileUri)
			: vscode.workspace.workspaceFolders?.[0];
		const workspaceFolder = activeWorkspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
		return {
			name: workspaceFolder?.name ?? "No workspace",
			uri: workspaceFolder?.uri.toString(),
			branch: await getGitBranch(workspaceFolder?.uri.fsPath, this.diagnostics),
			activeFile
		};
	}

	private getActiveFileSnapshot(): WorkspaceSnapshot["activeFile"] {
		this.captureActiveTextEditor();
		const editor = this.lastTextEditor;
		if (!editor) {
			return undefined;
		}
		return {
			filePath: vscode.workspace.asRelativePath(editor.document.uri, false),
			uri: editor.document.uri.toString(),
			selection: editor.selection.isEmpty ? undefined : toReviewRange(editor.selection)
		};
	}
}

function isActionableStatus(status: ReviewNote["status"]): boolean {
	return status === "draft" || status === "in_progress" || status === "blocked";
}

export function toReviewRange(range: vscode.Range): ReviewRange {
	return {
		startLine: range.start.line + 1,
		startCharacter: range.start.character + 1,
		endLine: range.end.line + 1,
		endCharacter: range.end.character + 1
	};
}

export function toVsCodeRange(range: ReviewRange): vscode.Range {
	return new vscode.Range(range.startLine - 1, range.startCharacter - 1, range.endLine - 1, range.endCharacter - 1);
}

async function getGitBranch(cwd: string | undefined, diagnostics: IDiagnosticsService): Promise<string | undefined> {
	if (!cwd) {
		diagnostics.debug("git", "branch.skipped", () => ({ reason: "missingWorkspace" }));
		return undefined;
	}
	const operation = diagnostics.startOperation("git", "branch.resolve");
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, windowsHide: true }, (error, output) => {
				if (error) {
					reject(error);
				} else {
					resolve(output);
				}
			});
		});
		const branch = stdout.trim();
		operation.complete(() => ({ found: branch.length > 0 }));
		return branch.length > 0 ? branch : undefined;
	} catch (error) {
		operation.fail(error);
		return undefined;
	}
}
