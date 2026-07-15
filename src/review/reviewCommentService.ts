import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { AiReviewCommand } from "../common/commands";
import type { ReviewNote, ReviewPanelStateEnvelope } from "../common/reviewProtocol";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { ICommandRegistrationService } from "../services/commandRegistrationService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { createReviewAnchor, rangesEqual, resolveReviewAnchor } from "./reviewAnchors";
import { IReviewPanelStateService, toReviewRange, toVsCodeRange } from "./reviewPanelStateService";

export const IReviewCommentService = createServiceIdentifier<IReviewCommentService>("reviewCommentService");

export interface IReviewCommentService {
	readonly _serviceBrand: undefined;
	startAnnotation(): Promise<void>;
	revealNote(id: string): Promise<void>;
}

export class ReviewCommentService extends Disposable implements IReviewCommentService {
	declare readonly _serviceBrand: undefined;

	private readonly controller = this._register(
		vscode.comments.createCommentController("aireview.comments", "AI Review")
	);
	private readonly decoration = this._register(
		vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
			overviewRulerLane: vscode.OverviewRulerLane.Right
		})
	);
	private readonly threadsByNoteId = new Map<string, vscode.CommentThread>();
	private readonly noteIdsByThread = new Map<vscode.CommentThread, string>();
	private readonly reconciliationTimers = new Map<string, NodeJS.Timeout>();
	private latestState: ReviewPanelStateEnvelope | undefined;

	constructor(
		@IReviewPanelStateService private readonly stateService: IReviewPanelStateService,
		@ICommandRegistrationService private readonly commandRegistrationService: ICommandRegistrationService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
		this.controller.options = {
			prompt: "Add an AI Review note",
			placeHolder: "Describe the exact change you want"
		};
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: (document) => {
				if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
					return [];
				}
				const lastLine = Math.max(0, document.lineCount - 1);
				return [new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).range.end.character)];
			}
		};

		this.commandRegistrationService.registerCommand(AiReviewCommand.AddReviewNote, () => this.startAnnotation());
		this.commandRegistrationService.registerCommand(AiReviewCommand.CreateComment, (value) =>
			this.createComment(value)
		);
		this.commandRegistrationService.registerCommand(AiReviewCommand.EditComment, (value) =>
			this.editComment(value)
		);
		this.commandRegistrationService.registerCommand(AiReviewCommand.SaveComment, (value) =>
			this.saveComment(value)
		);
		this.commandRegistrationService.registerCommand(AiReviewCommand.CancelCommentEdit, (value) =>
			this.cancelCommentEdit(value)
		);
		this.commandRegistrationService.registerCommand(AiReviewCommand.DeleteComment, (value) =>
			this.deleteComment(value)
		);
		this.commandRegistrationService.registerCommand(AiReviewCommand.ResolveComment, (value) =>
			this.setThreadResolved(value, true)
		);
		this.commandRegistrationService.registerCommand(AiReviewCommand.ReopenComment, (value) =>
			this.setThreadResolved(value, false)
		);

		this._register(stateService.onDidChangeState((state) => this.syncState(state)));
		this._register(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.latestState?.value.notes.some((note) => note.anchor?.uri === event.document.uri.toString())) {
					this.scheduleReconciliation(event.document);
				}
			})
		);
		this._register(
			vscode.workspace.onDidOpenTextDocument((document) => {
				if (this.latestState?.value.notes.some((note) => note.anchor?.uri === document.uri.toString())) {
					this.scheduleReconciliation(document);
				}
			})
		);
		this._register(vscode.window.onDidChangeVisibleTextEditors(() => this.updateDecorations()));
		this._register({
			dispose: () => {
				for (const timer of this.reconciliationTimers.values()) {
					clearTimeout(timer);
				}
				this.reconciliationTimers.clear();
			}
		});

		void stateService
			.getState()
			.then((state) => this.syncState(state))
			.catch((error) => this.diagnostics.error("reviewState", "comments.initialize.failed", error));
	}

	async startAnnotation(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.selection.isEmpty) {
			void vscode.window.showInformationMessage("Select code in an editor before adding an AI Review note.");
			return;
		}
		const thread = this.controller.createCommentThread(editor.document.uri, editor.selection, []);
		thread.contextValue = "aireview.draft";
		thread.label = "New AI Review note";
		thread.canReply = true;
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
		this.diagnostics.info("reviewState", "annotation.started", () => ({
			filePath: vscode.workspace.asRelativePath(editor.document.uri, false)
		}));
	}

	async revealNote(id: string): Promise<void> {
		const note = this.latestState?.value.notes.find((candidate) => candidate.id === id);
		if (!note?.anchor) {
			void vscode.window.showWarningMessage("This review note is no longer attached to code.");
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(note.anchor.uri));
		const resolved = resolveReviewAnchor(document.getText(), note.anchor);
		if (resolved.state === "orphaned") {
			await this.stateService.updateNoteAnchor(note.id, resolved.anchor, "orphaned");
			void vscode.window.showWarningMessage("This review note is no longer attached to code.");
			return;
		}
		if (!rangesEqual(resolved.anchor.range, note.anchor.range)) {
			await this.stateService.updateNoteAnchor(note.id, resolved.anchor, "moved");
		}
		const editor = await vscode.window.showTextDocument(document, { preserveFocus: false, preview: true });
		const range = toVsCodeRange(resolved.anchor.range);
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		const thread = this.threadsByNoteId.get(id);
		if (thread) {
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
		}
	}

	private async createComment(value: unknown): Promise<void> {
		if (!isCommentReply(value) || value.text.trim().length === 0) {
			return;
		}
		const thread = value.thread;
		const document = await vscode.workspace.openTextDocument(thread.uri);
		const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
		const id = randomUUID();
		const anchor = createReviewAnchor(
			document.getText(),
			document.uri.toString(),
			vscode.workspace.asRelativePath(document.uri, false),
			toReviewRange(range)
		);
		const state = await this.stateService.addNote({ id, body: value.text.trim(), anchor });
		this.bindThread(id, thread);
		const note = state.value.notes.find((candidate) => candidate.id === id);
		if (note) {
			this.syncNoteThread(note);
		}
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
	}

	private editComment(value: unknown): void {
		if (!(value instanceof ReviewComment)) {
			return;
		}
		value.savedBody = value.body;
		value.mode = vscode.CommentMode.Editing;
		value.parent.comments = [...value.parent.comments];
	}

	private async saveComment(value: unknown): Promise<void> {
		if (!(value instanceof ReviewComment)) {
			return;
		}
		const body = commentBody(value.body).trim();
		if (!body) {
			void vscode.window.showWarningMessage("Review note body cannot be empty.");
			return;
		}
		await this.stateService.updateNote({ id: value.noteId, body });
		value.savedBody = body;
		value.body = body;
		value.mode = vscode.CommentMode.Preview;
		value.parent.comments = [...value.parent.comments];
	}

	private cancelCommentEdit(value: unknown): void {
		if (!(value instanceof ReviewComment)) {
			return;
		}
		value.body = value.savedBody;
		value.mode = vscode.CommentMode.Preview;
		value.parent.comments = [...value.parent.comments];
	}

	private async deleteComment(value: unknown): Promise<void> {
		const thread = value instanceof ReviewComment ? value.parent : isCommentThread(value) ? value : undefined;
		if (!thread) {
			return;
		}
		const noteId = this.noteIdsByThread.get(thread);
		if (!noteId) {
			thread.dispose();
			return;
		}
		await this.stateService.deleteNote(noteId);
	}

	private async setThreadResolved(value: unknown, resolved: boolean): Promise<void> {
		if (!isCommentThread(value)) {
			return;
		}
		const noteId = this.noteIdsByThread.get(value);
		if (noteId) {
			await this.stateService.updateNote({ id: noteId, status: resolved ? "resolved" : "draft" });
		}
	}

	private syncState(state: ReviewPanelStateEnvelope): void {
		this.latestState = state;
		const activeIds = new Set(state.value.notes.map((note) => note.id));
		for (const [noteId, thread] of this.threadsByNoteId) {
			if (!activeIds.has(noteId)) {
				this.unbindThread(noteId, thread);
			}
		}
		for (const note of state.value.notes) {
			this.syncNoteThread(note);
		}
		this.updateDecorations();
		for (const document of vscode.workspace.textDocuments) {
			if (state.value.notes.some((note) => note.anchor?.uri === document.uri.toString())) {
				this.scheduleReconciliation(document);
			}
		}
	}

	private syncNoteThread(note: ReviewNote): void {
		let thread = this.threadsByNoteId.get(note.id);
		if (!note.anchor || note.anchorState === "orphaned") {
			if (thread) {
				this.unbindThread(note.id, thread);
			}
			return;
		}
		if (!thread) {
			thread = this.controller.createCommentThread(
				vscode.Uri.parse(note.anchor.uri),
				toVsCodeRange(note.anchor.range),
				[]
			);
			this.bindThread(note.id, thread);
		}
		thread.range = toVsCodeRange(note.anchor.range);
		thread.label = `${formatCommentStatus(note.status)} · ${note.kind} · ${note.anchor.filePath}`;
		thread.contextValue = note.status === "resolved" ? "aireview.resolved" : "aireview.unresolved";
		thread.state =
			note.status === "resolved" ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
		thread.canReply = false;
		const existing = thread.comments[0];
		if (existing instanceof ReviewComment && existing.mode === vscode.CommentMode.Editing) {
			return;
		}
		thread.comments = [new ReviewComment(note, thread)];
	}

	private bindThread(noteId: string, thread: vscode.CommentThread): void {
		const existing = this.threadsByNoteId.get(noteId);
		if (existing && existing !== thread) {
			this.unbindThread(noteId, existing);
		}
		this.threadsByNoteId.set(noteId, thread);
		this.noteIdsByThread.set(thread, noteId);
	}

	private unbindThread(noteId: string, thread: vscode.CommentThread): void {
		this.threadsByNoteId.delete(noteId);
		this.noteIdsByThread.delete(thread);
		thread.dispose();
	}

	private scheduleReconciliation(document: vscode.TextDocument): void {
		const uri = document.uri.toString();
		const existing = this.reconciliationTimers.get(uri);
		if (existing) {
			clearTimeout(existing);
		}
		this.reconciliationTimers.set(
			uri,
			setTimeout(() => {
				this.reconciliationTimers.delete(uri);
				void this.reconcileDocument(document).catch((error) =>
					this.diagnostics.error("reviewState", "anchor.reconcile.failed", error)
				);
			}, 250)
		);
	}

	private async reconcileDocument(document: vscode.TextDocument): Promise<void> {
		const state = await this.stateService.getState();
		for (const note of state.value.notes) {
			if (!note.anchor || note.anchor.uri !== document.uri.toString()) {
				continue;
			}
			const resolved = resolveReviewAnchor(document.getText(), note.anchor);
			const anchorState =
				resolved.state === "attached" && note.anchorState === "moved" ? "moved" : resolved.state;
			if (!rangesEqual(resolved.anchor.range, note.anchor.range) || anchorState !== note.anchorState) {
				await this.stateService.updateNoteAnchor(note.id, resolved.anchor, anchorState);
			}
		}
	}

	private updateDecorations(): void {
		const notes = this.latestState?.value.notes ?? [];
		for (const editor of vscode.window.visibleTextEditors) {
			const uri = editor.document.uri.toString();
			const ranges = notes
				.filter(
					(note) => note.anchor?.uri === uri && note.anchorState !== "orphaned" && note.status !== "resolved"
				)
				.map((note) => toVsCodeRange(note.anchor!.range));
			editor.setDecorations(this.decoration, ranges);
		}
	}
}

class ReviewComment implements vscode.Comment {
	readonly noteId: string;
	body: string | vscode.MarkdownString;
	savedBody: string | vscode.MarkdownString;
	mode = vscode.CommentMode.Preview;
	author = { name: "AI Review" };
	contextValue = "aireview.note";
	timestamp: Date;

	constructor(
		note: ReviewNote,
		readonly parent: vscode.CommentThread
	) {
		this.noteId = note.id;
		this.body = note.body;
		this.savedBody = note.body;
		this.timestamp = new Date(note.updatedAt);
	}
}

function commentBody(body: string | vscode.MarkdownString): string {
	return typeof body === "string" ? body : body.value;
}

function isCommentReply(value: unknown): value is vscode.CommentReply {
	return Boolean(
		value &&
		typeof value === "object" &&
		"thread" in value &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

function isCommentThread(value: unknown): value is vscode.CommentThread {
	return Boolean(value && typeof value === "object" && "comments" in value && "uri" in value && "dispose" in value);
}

function formatCommentStatus(status: ReviewNote["status"]): string {
	return {
		draft: "Open",
		in_progress: "In progress",
		addressed: "Addressed",
		blocked: "Blocked",
		resolved: "Resolved"
	}[status];
}
