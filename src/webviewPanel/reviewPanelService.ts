import { execFile } from "child_process";
import * as vscode from "vscode";
import { createMessageConnection, type MessageConnection } from "vscode-jsonrpc/node";
import {
	type AddReviewNoteParams,
	type AgentTarget,
	type DeleteReviewNoteParams,
	type ReviewNote,
	type ReviewPanelState,
	type ReviewRange,
	ReviewRpc,
	type WorkspaceSnapshot
} from "../common/reviewProtocol";
import { AiReviewCommand, type CommandWithoutArguments } from "../common/commands";
import { ICommandRegistrationService } from "../services/commandRegistrationService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { ExtensionWebviewMessageReader, ExtensionWebviewMessageWriter } from "./webviewRpc";

const reviewNotesStorageKey = "aireview.reviewNotes";
export const openReviewPanelCommandId = AiReviewCommand.OpenReviewPanel;
export const aiReviewViewId = "aireview.reviewView";

export const IReviewPanelService = createServiceIdentifier<IReviewPanelService>("reviewPanelService");

export interface IReviewPanelService extends vscode.WebviewViewProvider {
	readonly _serviceBrand: undefined;
	open(): Promise<void>;
}

export class ReviewPanelService implements IReviewPanelService {
	declare readonly _serviceBrand: undefined;

	private view: vscode.WebviewView | undefined;
	private connection: MessageConnection | undefined;
	private lastTextEditor: vscode.TextEditor | undefined;

	constructor(
		@IExtensionContextService private readonly extensionContextService: IExtensionContextService,
		@ICommandRegistrationService private readonly commandRegistrationService: ICommandRegistrationService
	) {
		this.lastTextEditor = vscode.window.activeTextEditor;

		const context = this.extensionContextService.context;
		context.subscriptions.push(
			vscode.window.registerWebviewViewProvider(aiReviewViewId, this, {
				webviewOptions: { retainContextWhenHidden: true }
			})
		);
		this.commandRegistrationService.registerCommand(openReviewPanelCommandId, () => this.open());
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				if (editor) {
					this.lastTextEditor = editor;
				}
				void this.publishState();
			})
		);
		context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection((event) => {
				this.lastTextEditor = event.textEditor;
				void this.publishState();
			})
		);
	}

	async open(): Promise<void> {
		this.captureActiveTextEditor();

		if (this.view) {
			this.view.show(false);
			await this.publishState();
			return;
		}

		await this.executeFirstAvailableCommand(AiReviewCommand.ReviewViewFocus, AiReviewCommand.ReviewViewOpen);
		await this.publishState();
	}

	private async executeFirstAvailableCommand(...commandIds: CommandWithoutArguments[]): Promise<void> {
		const commands = await this.commandRegistrationService.getCommands(true);
		const commandId = commandIds.find((id) => commands.includes(id));
		if (!commandId) {
			throw new Error(`AI Review view command not found. Tried: ${commandIds.join(", ")}`);
		}

		await this.commandRegistrationService.executeCommand(commandId);
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		const context = this.extensionContextService.context;
		this.connection?.dispose();
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")]
		};

		const reader = new ExtensionWebviewMessageReader(webviewView.webview);
		const writer = new ExtensionWebviewMessageWriter(webviewView.webview);
		const connection = createMessageConnection(reader, writer);
		this.connection = connection;
		this.registerRpcHandlers(connection);
		connection.listen();
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				void this.publishState();
			}
		});

		webviewView.onDidDispose(() => {
			connection.dispose();
			if (this.connection === connection) {
				this.connection = undefined;
			}
			if (this.view === webviewView) {
				this.view = undefined;
			}
		});
	}

	private registerRpcHandlers(connection: MessageConnection): void {
		connection.onRequest(ReviewRpc.getState, () => this.getState());
		connection.onRequest(ReviewRpc.addNote, (params: unknown) => this.addNote(params));
		connection.onRequest(ReviewRpc.deleteNote, (params: unknown) => this.deleteNote(params));
	}

	private async addNote(params: unknown): Promise<ReviewNote> {
		const input = normalizeAddReviewNoteParams(params);
		const activeFile = this.getActiveFileSnapshot();
		const now = new Date().toISOString();
		const note: ReviewNote = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			body: input.body,
			filePath: input.filePath ?? activeFile?.filePath,
			line: input.line ?? activeFile?.selection?.startLine,
			range: input.range ?? activeFile?.selection,
			createdAt: now
		};

		const notes = this.getNotes();
		await this.saveNotes([note, ...notes]);
		await this.publishState();
		return note;
	}

	private async deleteNote(params: unknown): Promise<boolean> {
		const input = normalizeDeleteReviewNoteParams(params);
		const notes = this.getNotes();
		const nextNotes = notes.filter((note) => note.id !== input.id);

		if (nextNotes.length === notes.length) {
			return false;
		}

		await this.saveNotes(nextNotes);
		await this.publishState();
		return true;
	}

	private async publishState(): Promise<void> {
		const connection = this.connection;
		const view = this.view;
		if (!connection || !view?.visible) {
			return;
		}

		try {
			await connection.sendNotification(ReviewRpc.stateChanged, await this.getState());
		} catch (error) {
			if (this.connection === connection && this.view === view && view.visible) {
				console.error("Failed to publish AI Review panel state", error);
			}
		}
	}

	private async getState(): Promise<ReviewPanelState> {
		return {
			workspace: await this.getWorkspaceSnapshot(),
			notes: this.getNotes(),
			agentTargets: await this.getAgentTargets()
		};
	}

	private async getAgentTargets(): Promise<AgentTarget[]> {
		const commands = await this.commandRegistrationService.getCommands(true);
		return [
			{
				id: "codex",
				label: "Codex",
				available: false,
				detail: commands.includes(AiReviewCommand.CodexOpenSidebar)
					? "Codex command bridge detected; handoff not wired yet"
					: "Pending command integration"
			},
			{
				id: "copilot",
				label: "Copilot Chat",
				available: commands.includes(AiReviewCommand.CopilotCliOpenInCopilotCli),
				detail: "GitHub Copilot extension command bridge"
			}
		];
	}

	private getNotes(): ReviewNote[] {
		return this.extensionContextService.context.workspaceState.get<ReviewNote[]>(reviewNotesStorageKey, []);
	}

	private async saveNotes(notes: readonly ReviewNote[]): Promise<void> {
		await this.extensionContextService.context.workspaceState.update(reviewNotesStorageKey, notes);
	}

	private getHtml(webview: vscode.Webview): string {
		const context = this.extensionContextService.context;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "reviewPanel.js"));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "reviewPanel.css"));
		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src ${webview.cspSource};">
	<link rel="stylesheet" href="${styleUri}">
	<title>AI Review</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private captureActiveTextEditor(): vscode.TextEditor | undefined {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			this.lastTextEditor = editor;
		}
		return this.lastTextEditor;
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
			branch: await getGitBranch(workspaceFolder?.uri.fsPath),
			activeFile
		};
	}

	private getActiveFileSnapshot(): WorkspaceSnapshot["activeFile"] {
		const editor = this.captureActiveTextEditor();
		if (!editor) {
			return undefined;
		}

		const selection = editor.selection;
		return {
			filePath: vscode.workspace.asRelativePath(editor.document.uri, false),
			uri: editor.document.uri.toString(),
			selection: selection.isEmpty ? undefined : toReviewRange(selection)
		};
	}
}

function toReviewRange(range: vscode.Range): ReviewRange {
	return {
		startLine: range.start.line + 1,
		startCharacter: range.start.character + 1,
		endLine: range.end.line + 1,
		endCharacter: range.end.character + 1
	};
}

async function getGitBranch(cwd: string | undefined): Promise<string | undefined> {
	if (!cwd) {
		return undefined;
	}

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
		return branch.length > 0 ? branch : undefined;
	} catch {
		return undefined;
	}
}

function normalizeAddReviewNoteParams(value: unknown): AddReviewNoteParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected review note parameters");
	}

	const params = value as Partial<AddReviewNoteParams>;
	if (typeof params.body !== "string" || params.body.trim().length === 0) {
		throw new Error("Review note body is required");
	}

	return {
		body: params.body.trim(),
		filePath: typeof params.filePath === "string" ? params.filePath : undefined,
		line: typeof params.line === "number" ? params.line : undefined,
		range: isReviewRange(params.range) ? params.range : undefined
	};
}

function normalizeDeleteReviewNoteParams(value: unknown): DeleteReviewNoteParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected delete note parameters");
	}

	const id = (value as Partial<DeleteReviewNoteParams>).id;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error("Review note id is required");
	}

	return { id };
}

function isReviewRange(value: unknown): value is ReviewRange {
	if (!value || typeof value !== "object") {
		return false;
	}

	const range = value as Partial<ReviewRange>;
	return (
		typeof range.startLine === "number" &&
		typeof range.startCharacter === "number" &&
		typeof range.endLine === "number" &&
		typeof range.endCharacter === "number"
	);
}

function getNonce(): string {
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	let text = "";
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
