import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { RequestChangesCommand } from "../common/commands";
import type {
	AddReviewCommentParams,
	ClearResolvedCommentsResult,
	EditOpenCommentParams,
	ReviewAnchor,
	ReviewAnchorState,
	ReviewComment,
	ReviewCommentsPreview,
	ReviewCopyResult,
	ReviewPanelState,
	ReviewPanelStateEnvelope,
	ReviewRange,
	SelectedReviewCommentsParams,
	VersionedReviewCommentParams,
	WorkspaceSnapshot
} from "../common/reviewProtocol";
import { Emitter, type Event } from "../common/emitter";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { ICommandRegistrationService } from "../services/commandRegistrationService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { createReviewAnchor } from "./reviewAnchors";
import { buildReviewCommentsMarkdown, createReviewCommentRequests } from "./reviewBundle";
import { selectOpenReviewComments } from "./reviewSelection";
import { IReviewStore } from "./reviewStore";

export const IReviewPanelStateService = createServiceIdentifier<IReviewPanelStateService>("reviewPanelStateService");

export interface IReviewPanelStateService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeState: Event<ReviewPanelStateEnvelope>;
	captureActiveTextEditor(): void;
	getState(): Promise<ReviewPanelStateEnvelope>;
	refresh(): Promise<ReviewPanelStateEnvelope>;
	addComment(input: AddReviewCommentParams): Promise<ReviewPanelStateEnvelope>;
	editOpenComment(input: EditOpenCommentParams): Promise<ReviewPanelStateEnvelope>;
	reattachOpenComment(input: VersionedReviewCommentParams): Promise<ReviewPanelStateEnvelope>;
	createUnresolvedFollowUp(input: VersionedReviewCommentParams): Promise<ReviewPanelStateEnvelope>;
	updateCommentAnchor(id: string, anchor: ReviewAnchor, anchorState: ReviewAnchorState): Promise<void>;
	deleteComment(id: string): Promise<ReviewPanelStateEnvelope>;
	clearResolvedComments(): Promise<ClearResolvedCommentsResult>;
	previewComments(input: SelectedReviewCommentsParams): Promise<ReviewCommentsPreview>;
	copyComments(input: SelectedReviewCommentsParams): Promise<ReviewCopyResult>;
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
		@ICommandRegistrationService commandRegistrationService: ICommandRegistrationService,
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
		commandRegistrationService.registerCommand(RequestChangesCommand.ClearResolvedComments, async () => {
			const state = await this.getState();
			const resolvedCount = state.value.comments.filter((comment) => comment.status === "resolved").length;
			if (resolvedCount === 0) {
				void vscode.window.showInformationMessage("There are no resolved comments to clear.");
				return;
			}
			const action = `Clear ${resolvedCount}`;
			const confirmed = await vscode.window.showWarningMessage(
				`Remove ${resolvedCount} resolved ${
					resolvedCount === 1 ? "comment" : "comments"
				} from this workspace?\n\nThis permanently removes their comments and AI results.`,
				{ modal: true },
				action
			);
			if (confirmed !== action) {
				return;
			}
			const result = await this.clearResolvedComments();
			void vscode.window.showInformationMessage(
				`Cleared ${result.clearedCount} resolved ${result.clearedCount === 1 ? "comment" : "comments"}.`
			);
		});
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

	async addComment(input: AddReviewCommentParams): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "comment.add");
		const comment = createOpenReviewComment(input);
		try {
			await this.reviewStore.addComment(comment);
			const state = await this.refresh();
			operation.complete(() => ({
				revision: state.revision,
				commentCount: state.value.comments.length
			}));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async editOpenComment(input: EditOpenCommentParams): Promise<ReviewPanelStateEnvelope> {
		const updated = await this.reviewStore.editOpenComment(input);
		if (!updated) {
			throw new Error("Review comment not found");
		}
		return this.refresh();
	}

	async reattachOpenComment(input: VersionedReviewCommentParams): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "comment.reattach");
		try {
			const anchor = this.createAnchorFromActiveSelection();
			const updated = await this.reviewStore.reattachOpenComment(input, anchor);
			if (!updated) {
				throw new Error("Review comment not found");
			}
			const state = await this.refresh();
			operation.complete(() => ({ commentId: input.id, revision: state.revision }));
			return state;
		} catch (error) {
			operation.fail(error, () => ({ commentId: input.id }));
			throw error;
		}
	}

	async createUnresolvedFollowUp(input: VersionedReviewCommentParams): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "comment.followUp");
		try {
			const persisted = await this.reviewStore.getState();
			const original = persisted.comments.find((comment) => comment.id === input.id);
			if (!original) {
				throw new Error("Review comment not found");
			}
			if (
				original.status !== "unresolved" ||
				original.result?.outcome !== "unresolved" ||
				!original.result.suggestedNewComment?.trim()
			) {
				throw new Error("This unresolved comment does not have a suggested follow-up");
			}
			const anchor =
				original.anchor && original.anchorState !== "orphaned"
					? original.anchor
					: this.createAnchorFromActiveSelection();
			const followUp = createOpenReviewComment({
				body: original.result.suggestedNewComment,
				intent: original.intent,
				anchor
			});
			const created = await this.reviewStore.createUnresolvedFollowUp(input, followUp);
			if (!created) {
				throw new Error("Review comment not found");
			}
			const state = await this.refresh();
			operation.complete(() => ({
				commentId: input.id,
				followUpId: followUp.id,
				revision: state.revision
			}));
			return state;
		} catch (error) {
			operation.fail(error, () => ({ commentId: input.id }));
			throw error;
		}
	}

	async updateCommentAnchor(id: string, anchor: ReviewAnchor, anchorState: ReviewAnchorState): Promise<void> {
		await this.reviewStore.updateCommentAnchor(id, anchor, anchorState);
	}

	async deleteComment(id: string): Promise<ReviewPanelStateEnvelope> {
		const operation = this.diagnostics.startOperation("reviewState", "comment.delete");
		try {
			const deleted = await this.reviewStore.deleteComment(id);
			const state = deleted ? await this.refresh() : await this.getState();
			operation.complete(() => ({
				deleted,
				revision: state.revision,
				commentCount: state.value.comments.length
			}));
			return state;
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async clearResolvedComments(): Promise<ClearResolvedCommentsResult> {
		const operation = this.diagnostics.startOperation("reviewState", "comments.clearResolved");
		try {
			const clearedCount = await this.reviewStore.clearResolvedComments();
			const state = clearedCount ? await this.refresh() : await this.getState();
			operation.complete(() => ({ clearedCount, revision: state.revision }));
			return { clearedCount, state };
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async previewComments(input: SelectedReviewCommentsParams): Promise<ReviewCommentsPreview> {
		const state = await this.reviewStore.getState();
		const comments = selectOpenReviewComments(state.comments, input.commentIds);
		const filePaths = new Set(
			comments.map((comment) => comment.anchor?.filePath).filter((value): value is string => Boolean(value))
		);
		return {
			markdown: buildReviewCommentsMarkdown(state.effectiveInstructions, createReviewCommentRequests(comments)),
			fileCount: filePaths.size,
			commentCount: comments.length,
			needsReattachmentCount: comments.filter((comment) => comment.anchorState === "orphaned").length
		};
	}

	async copyComments(input: SelectedReviewCommentsParams): Promise<ReviewCopyResult> {
		const operation = this.diagnostics.startOperation("reviewState", "comments.copy");
		try {
			const preview = await this.previewComments(input);
			await vscode.env.clipboard.writeText(preview.markdown);
			const message = `${preview.commentCount} ${
				preview.commentCount === 1 ? "comment" : "comments"
			} copied for AI.`;
			operation.complete(() => ({ commentCount: preview.commentCount }));
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
				commentCount: state.value.comments.length,
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
			void vscode.commands.executeCommand(
				"setContext",
				"requestchanges.hasResolvedComments",
				value.comments.some((comment) => comment.status === "resolved")
			);
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
		return { workspace, comments: persistedState.comments };
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

	private createAnchorFromActiveSelection(): ReviewAnchor {
		this.captureActiveTextEditor();
		const editor = this.lastTextEditor;
		if (!editor || editor.selection.isEmpty) {
			throw new Error("Select replacement code in an editor first");
		}
		return createReviewAnchor(
			editor.document.getText(),
			editor.document.uri.toString(),
			vscode.workspace.asRelativePath(editor.document.uri, false),
			toReviewRange(editor.selection)
		);
	}
}

function createOpenReviewComment(input: AddReviewCommentParams): ReviewComment {
	const now = new Date().toISOString();
	return {
		id: input.id ?? randomUUID(),
		version: 1,
		body: input.body.trim(),
		intent: input.intent ?? "change",
		status: "open",
		anchor: input.anchor,
		anchorState: input.anchor ? "attached" : "orphaned",
		createdAt: now,
		updatedAt: now
	};
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
			execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, windowsHide: true }, (error, output) =>
				error ? reject(error) : resolve(output)
			);
		});
		const branch = stdout.trim();
		operation.complete(() => ({ found: branch.length > 0 }));
		return branch.length > 0 ? branch : undefined;
	} catch (error) {
		operation.fail(error);
		return undefined;
	}
}
