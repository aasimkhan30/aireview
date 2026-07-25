import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { RequestChangesCommand } from "../common/commands";
import {
	reviewIntentPresentation,
	reviewStatusPresentation,
	type ReviewComment as ReviewCommentData,
	type ReviewPanelStateEnvelope
} from "../common/reviewProtocol";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { ICommandRegistrationService } from "../services/commandRegistrationService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { createReviewAnchor, rangesEqual, resolveReviewAnchor } from "./reviewAnchors";
import { parseReviewComment, reviewCommentDirectives } from "./reviewCommentDirective";
import { IReviewPanelStateService, toReviewRange, toVsCodeRange } from "./reviewPanelStateService";

export const IReviewCommentService = createServiceIdentifier<IReviewCommentService>("reviewCommentService");

export interface IReviewCommentService {
	readonly _serviceBrand: undefined;
	startAnnotation(): Promise<void>;
	revealComment(id: string): Promise<void>;
}

export class ReviewCommentService extends Disposable implements IReviewCommentService {
	declare readonly _serviceBrand: undefined;

	private readonly controller = this._register(
		vscode.comments.createCommentController("requestchanges.comments", "Request Changes")
	);
	private readonly decoration = this._register(
		vscode.window.createTextEditorDecorationType({
			backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
			overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.infoForeground"),
			overviewRulerLane: vscode.OverviewRulerLane.Right
		})
	);
	private readonly threadsByCommentId = new Map<string, vscode.CommentThread>();
	private readonly commentIdsByThread = new Map<vscode.CommentThread, string>();
	private readonly reconciliationTimers = new Map<string, NodeJS.Timeout>();
	private readonly editCommentDocumentUris = new Set<string>();
	private pendingEditCommentDocumentTimer: NodeJS.Timeout | undefined;
	private latestState: ReviewPanelStateEnvelope | undefined;

	constructor(
		@IReviewPanelStateService private readonly stateService: IReviewPanelStateService,
		@ICommandRegistrationService private readonly commandRegistrationService: ICommandRegistrationService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
		this.controller.options = {
			prompt: "Add a review comment · type # for comment types",
			placeHolder: "#requestchanges:change Describe the exact change you want"
		};
		this._register(
			vscode.languages.registerCompletionItemProvider(
				{ scheme: "comment", language: "markdown" },
				{
					provideCompletionItems: (document, position) => this.provideDirectiveCompletions(document, position)
				},
				"#",
				":"
			)
		);
		this.controller.commentingRangeProvider = {
			provideCommentingRanges: (document) => {
				if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
					return [];
				}
				const lastLine = Math.max(0, document.lineCount - 1);
				return [new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).range.end.character)];
			}
		};

		this.commandRegistrationService.registerCommand(RequestChangesCommand.AddReviewComment, () =>
			this.startAnnotation()
		);
		this.commandRegistrationService.registerCommand(RequestChangesCommand.CreateComment, (value) =>
			this.createComment(value)
		);
		this.commandRegistrationService.registerCommand(RequestChangesCommand.EditComment, (value) =>
			this.editComment(value)
		);
		this.commandRegistrationService.registerCommand(RequestChangesCommand.SaveComment, (value) =>
			this.saveComment(value)
		);
		this.commandRegistrationService.registerCommand(RequestChangesCommand.CancelCommentEdit, (value) =>
			this.cancelCommentEdit(value)
		);
		this.commandRegistrationService.registerCommand(RequestChangesCommand.DeleteComment, (value) =>
			this.deleteComment(value)
		);
		this._register(stateService.onDidChangeState((state) => this.syncState(state)));
		this._register(
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (
					this.latestState?.value.comments.some(
						(comment) => comment.anchor?.uri === event.document.uri.toString()
					)
				) {
					this.scheduleReconciliation(event.document);
				}
			})
		);
		this._register(
			vscode.workspace.onDidOpenTextDocument((document) => {
				this.claimPendingEditCommentDocument(document);
				if (
					this.latestState?.value.comments.some((comment) => comment.anchor?.uri === document.uri.toString())
				) {
					this.scheduleReconciliation(document);
				}
			})
		);
		this._register(
			vscode.workspace.onDidCloseTextDocument((document) => {
				this.editCommentDocumentUris.delete(document.uri.toString());
			})
		);
		this._register(vscode.window.onDidChangeVisibleTextEditors(() => this.updateDecorations()));
		this._register({
			dispose: () => {
				for (const timer of this.reconciliationTimers.values()) {
					clearTimeout(timer);
				}
				this.reconciliationTimers.clear();
				this.clearPendingEditCommentDocument();
				this.editCommentDocumentUris.clear();
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
			void vscode.window.showInformationMessage("Select code in an editor before adding a review comment.");
			return;
		}
		const thread = this.controller.createCommentThread(editor.document.uri, editor.selection, []);
		thread.contextValue = "requestchanges.newComment";
		thread.label = "New review comment";
		thread.canReply = true;
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
		this.diagnostics.info("reviewState", "annotation.started", () => ({
			filePath: vscode.workspace.asRelativePath(editor.document.uri, false)
		}));
	}

	async revealComment(id: string): Promise<void> {
		const comment = this.latestState?.value.comments.find((candidate) => candidate.id === id);
		if (!comment?.anchor) {
			void vscode.window.showWarningMessage("This review comment is no longer attached to code.");
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(comment.anchor.uri));
		const resolved = resolveReviewAnchor(document.getText(), comment.anchor);
		if (resolved.state === "orphaned") {
			await this.stateService.updateCommentAnchor(comment.id, resolved.anchor, "orphaned");
			void vscode.window.showWarningMessage("This review comment is no longer attached to code.");
			return;
		}
		if (!rangesEqual(resolved.anchor.range, comment.anchor.range)) {
			await this.stateService.updateCommentAnchor(comment.id, resolved.anchor, "moved");
		}
		const editor = await vscode.window.showTextDocument(document, { preserveFocus: false, preview: true });
		const range = toVsCodeRange(resolved.anchor.range);
		editor.selection = new vscode.Selection(range.start, range.end);
		editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		const thread = this.threadsByCommentId.get(id);
		if (thread) {
			thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
		}
	}

	private async createComment(value: unknown): Promise<void> {
		if (!isCommentReply(value) || value.text.trim().length === 0) {
			return;
		}
		const parsed = this.parseSubmittedComment(value.text, "change");
		if (!parsed) {
			return;
		}
		if (!parsed.body) {
			void vscode.window.showWarningMessage("Review comment cannot be empty.");
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
		const state = await this.stateService.addComment({
			id,
			body: parsed.body,
			intent: parsed.kind,
			anchor
		});
		this.bindThread(id, thread);
		const comment = state.value.comments.find((candidate) => candidate.id === id);
		if (comment) {
			this.syncCommentThread(comment);
		}
		thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
	}

	private editComment(value: unknown): void {
		if (!(value instanceof ReviewComment)) {
			return;
		}
		if (value.status !== "open") {
			return;
		}
		value.savedBody = value.body;
		this.expectEditCommentDocument();
		value.mode = vscode.CommentMode.Editing;
		value.parent.comments = [...value.parent.comments];
	}

	private async saveComment(value: unknown): Promise<void> {
		if (!(value instanceof ReviewComment)) {
			return;
		}
		const parsed = this.parseSubmittedComment(commentBody(value.body), value.intent);
		if (!parsed) {
			return;
		}
		if (!parsed.body) {
			void vscode.window.showWarningMessage("Review comment cannot be empty.");
			return;
		}
		await this.stateService.editOpenComment({
			id: value.commentId,
			expectedVersion: value.version,
			body: parsed.body,
			intent: parsed.kind
		});
		value.version += 1;
		value.savedBody = parsed.body;
		value.body = parsed.body;
		value.intent = parsed.kind;
		value.label = formatCommentIntent(parsed.kind);
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
		const commentId = this.commentIdsByThread.get(thread);
		if (!commentId) {
			thread.dispose();
			return;
		}
		await this.stateService.deleteComment(commentId);
	}

	private syncState(state: ReviewPanelStateEnvelope): void {
		this.latestState = state;
		const activeIds = new Set(state.value.comments.map((comment) => comment.id));
		for (const [commentId, thread] of this.threadsByCommentId) {
			if (!activeIds.has(commentId)) {
				this.unbindThread(commentId, thread);
			}
		}
		for (const comment of state.value.comments) {
			this.syncCommentThread(comment);
		}
		this.updateDecorations();
		for (const document of vscode.workspace.textDocuments) {
			if (state.value.comments.some((comment) => comment.anchor?.uri === document.uri.toString())) {
				this.scheduleReconciliation(document);
			}
		}
	}

	private syncCommentThread(comment: ReviewCommentData): void {
		let thread = this.threadsByCommentId.get(comment.id);
		if (!comment.anchor || comment.anchorState === "orphaned") {
			if (thread) {
				this.unbindThread(comment.id, thread);
			}
			return;
		}
		if (!thread) {
			thread = this.controller.createCommentThread(
				vscode.Uri.parse(comment.anchor.uri),
				toVsCodeRange(comment.anchor.range),
				[]
			);
			this.bindThread(comment.id, thread);
		}
		thread.range = toVsCodeRange(comment.anchor.range);
		thread.label = `${formatCommentStatus(comment.status)} · ${formatCommentIntent(comment.intent)} · ${comment.anchor.filePath}`;
		thread.contextValue = `requestchanges.${comment.status}`;
		thread.state =
			comment.status === "resolved" ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
		thread.canReply = false;
		const existing = thread.comments[0];
		if (existing instanceof ReviewComment && existing.mode === vscode.CommentMode.Editing) {
			return;
		}
		const humanComment = new ReviewComment(comment, thread);
		thread.comments = comment.result ? [humanComment, new ReviewResultComment(comment)] : [humanComment];
	}

	private bindThread(commentId: string, thread: vscode.CommentThread): void {
		const existing = this.threadsByCommentId.get(commentId);
		if (existing && existing !== thread) {
			this.unbindThread(commentId, existing);
		}
		this.threadsByCommentId.set(commentId, thread);
		this.commentIdsByThread.set(thread, commentId);
	}

	private unbindThread(commentId: string, thread: vscode.CommentThread): void {
		this.threadsByCommentId.delete(commentId);
		this.commentIdsByThread.delete(thread);
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
		for (const comment of state.value.comments) {
			if (!comment.anchor || comment.anchor.uri !== document.uri.toString()) {
				continue;
			}
			const resolved = resolveReviewAnchor(document.getText(), comment.anchor);
			const anchorState =
				resolved.state === "attached" && comment.anchorState === "moved" ? "moved" : resolved.state;
			if (!rangesEqual(resolved.anchor.range, comment.anchor.range) || anchorState !== comment.anchorState) {
				await this.stateService.updateCommentAnchor(comment.id, resolved.anchor, anchorState);
			}
		}
	}

	private updateDecorations(): void {
		const comments = this.latestState?.value.comments ?? [];
		for (const editor of vscode.window.visibleTextEditors) {
			const uri = editor.document.uri.toString();
			const ranges = comments
				.filter(
					(comment) =>
						comment.anchor?.uri === uri &&
						comment.anchorState !== "orphaned" &&
						comment.status !== "resolved"
				)
				.map((comment) => toVsCodeRange(comment.anchor!.range));
			editor.setDecorations(this.decoration, ranges);
		}
	}

	private provideDirectiveCompletions(
		document: vscode.TextDocument,
		position: vscode.Position
	): vscode.CompletionItem[] | undefined {
		if (!this.ownsCommentDocument(document) || position.line !== 0) {
			return undefined;
		}
		const prefix = document.lineAt(position.line).text.slice(0, position.character);
		const leadingWhitespace = prefix.match(/^\s*/u)?.[0].length ?? 0;
		const token = prefix.slice(leadingWhitespace);
		const canonicalPrefix = "#requestchanges:";
		const normalized = token.toLowerCase();
		const isDirectivePrefix = canonicalPrefix.startsWith(normalized);
		const isKeywordPrefix =
			normalized.startsWith(canonicalPrefix) && /^[a-z]*$/u.test(normalized.slice(canonicalPrefix.length));
		if (token && !isDirectivePrefix && !isKeywordPrefix) {
			return undefined;
		}

		const range = new vscode.Range(0, leadingWhitespace, position.line, position.character);
		return reviewCommentDirectives.map((directive, index) => {
			const label = `#requestchanges:${directive.keyword}`;
			const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.EnumMember);
			item.detail = directive.detail;
			item.insertText = `${label} `;
			item.filterText = label;
			item.range = range;
			item.sortText = `0000-${index.toString().padStart(2, "0")}`;
			item.preselect = directive.kind === "change";
			return item;
		});
	}

	private ownsCommentDocument(document: vscode.TextDocument): boolean {
		return (
			document.uri.authority === this.controller.id || this.editCommentDocumentUris.has(document.uri.toString())
		);
	}

	private expectEditCommentDocument(): void {
		this.clearPendingEditCommentDocument();
		// The public Comments API does not expose the input URI for an edited comment. Correlate the
		// next unscoped comment document with the Request Changes Edit action that caused it to open.
		this.pendingEditCommentDocumentTimer = setTimeout(() => {
			this.pendingEditCommentDocumentTimer = undefined;
		}, 2_000);
	}

	private claimPendingEditCommentDocument(document: vscode.TextDocument): void {
		if (
			!this.pendingEditCommentDocumentTimer ||
			document.uri.scheme !== "comment" ||
			document.uri.authority ||
			document.languageId !== "markdown"
		) {
			return;
		}
		this.editCommentDocumentUris.add(document.uri.toString());
		this.clearPendingEditCommentDocument();
	}

	private clearPendingEditCommentDocument(): void {
		if (this.pendingEditCommentDocumentTimer) {
			clearTimeout(this.pendingEditCommentDocumentTimer);
			this.pendingEditCommentDocumentTimer = undefined;
		}
	}

	private parseSubmittedComment(value: string, defaultIntent: ReviewCommentData["intent"]) {
		try {
			return parseReviewComment(value, defaultIntent);
		} catch (error) {
			void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
			return undefined;
		}
	}
}

class ReviewComment implements vscode.Comment {
	readonly commentId: string;
	version: number;
	readonly status: ReviewCommentData["status"];
	body: string | vscode.MarkdownString;
	savedBody: string | vscode.MarkdownString;
	mode = vscode.CommentMode.Preview;
	author = { name: "You" };
	contextValue: string;
	intent: ReviewCommentData["intent"];
	label: string;
	timestamp: Date;

	constructor(
		comment: ReviewCommentData,
		readonly parent: vscode.CommentThread
	) {
		this.commentId = comment.id;
		this.version = comment.version;
		this.status = comment.status;
		this.body = comment.body;
		this.savedBody = comment.body;
		this.intent = comment.intent;
		this.contextValue =
			comment.status === "open"
				? "requestchanges.openComment"
				: comment.status === "in_progress"
					? "requestchanges.workingComment"
					: "requestchanges.terminalComment";
		this.label = formatCommentIntent(comment.intent);
		this.timestamp = new Date(comment.updatedAt);
	}
}

class ReviewResultComment implements vscode.Comment {
	readonly mode = vscode.CommentMode.Preview;
	readonly contextValue = "requestchanges.aiResult";
	readonly author: vscode.CommentAuthorInformation;
	readonly body: vscode.MarkdownString;
	readonly timestamp: Date;

	constructor(comment: ReviewCommentData) {
		const result = comment.result!;
		this.author = { name: result.client };
		this.timestamp = new Date(result.completedAt);
		const markdown = new vscode.MarkdownString();
		if (result.outcome === "resolved") {
			markdown.appendMarkdown(`**Resolved**\n\n${result.summary}`);
			if (result.changedFiles.length) {
				markdown.appendMarkdown(
					`\n\n**Changed files**\n\n${result.changedFiles.map((file) => `- \`${file}\``).join("\n")}`
				);
			}
			if (result.verification) {
				markdown.appendMarkdown(`\n\n**Verification**\n\n${result.verification}`);
			}
			if (result.limitations) {
				markdown.appendMarkdown(`\n\n**Limitations**\n\n${result.limitations}`);
			}
		} else {
			markdown.appendMarkdown(`**Couldn’t resolve**\n\n${result.explanation}`);
			if (result.suggestedNewComment) {
				markdown.appendMarkdown(`\n\n**Suggested new comment**\n\n> ${result.suggestedNewComment}`);
			}
		}
		this.body = markdown;
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

function formatCommentStatus(status: ReviewCommentData["status"]): string {
	return reviewStatusPresentation[status].label;
}

function formatCommentIntent(intent: ReviewCommentData["intent"]): string {
	return reviewIntentPresentation[intent].label;
}
