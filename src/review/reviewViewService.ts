import { RequestChangesCommand, type CommandWithoutArguments } from "../common/commands";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { ICommandRegistrationService } from "../services/commandRegistrationService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { WebviewViewHost } from "../webviewHost/webviewViewHost";
import { IReviewCommentService } from "./reviewCommentService";
import { IReviewPanelStateService } from "./reviewPanelStateService";
import { ReviewWebviewController } from "./reviewWebviewController";

export const openReviewPanelCommandId = RequestChangesCommand.OpenReviewPanel;
export const requestChangesViewId = "requestchanges.reviewView";

export const IReviewViewService = createServiceIdentifier<IReviewViewService>("reviewViewService");

export interface IReviewViewService {
	readonly _serviceBrand: undefined;
	open(): Promise<void>;
}

/** Owns the current WebviewView surface; review behavior remains in injected collaborators. */
export class ReviewViewService extends Disposable implements IReviewViewService {
	declare readonly _serviceBrand: undefined;

	private readonly host: WebviewViewHost;

	constructor(
		@IExtensionContextService extensionContextService: IExtensionContextService,
		@ICommandRegistrationService private readonly commandRegistrationService: ICommandRegistrationService,
		@IReviewPanelStateService private readonly stateService: IReviewPanelStateService,
		@IReviewCommentService private readonly commentService: IReviewCommentService,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
		this.host = this._register(
			new WebviewViewHost({
				viewId: requestChangesViewId,
				extensionUri: extensionContextService.context.extensionUri,
				diagnostics,
				content: {
					title: "Review Comments",
					scriptPath: ["media", "reviewPanel.js"],
					stylePaths: [["media", "reviewPanel.css"]],
					localResourceRootPaths: [["media"]]
				},
				createController: (connection, surface) =>
					new ReviewWebviewController(
						connection,
						stateService,
						commentService,
						() => surface.visible,
						diagnostics
					),
				onDidBecomeVisible: async () => {
					await stateService.refresh();
				}
			})
		);
		this.commandRegistrationService.registerCommand(openReviewPanelCommandId, () => this.open());
	}

	async open(): Promise<void> {
		const operation = this.diagnostics.startOperation("webview", "view.open");
		try {
			this.stateService.captureActiveTextEditor();
			if (!this.host.show(false)) {
				await this.executeFirstAvailableCommand(
					RequestChangesCommand.ReviewViewFocus,
					RequestChangesCommand.ReviewViewOpen
				);
			}
			await this.stateService.refresh();
			operation.complete();
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	private async executeFirstAvailableCommand(...commandIds: CommandWithoutArguments[]): Promise<void> {
		const commands = await this.commandRegistrationService.getCommands(true);
		const commandId = commandIds.find((id) => commands.includes(id));
		if (!commandId) {
			throw new Error(`Request Changes view command not found. Tried: ${commandIds.join(", ")}`);
		}
		await this.commandRegistrationService.executeCommand(commandId);
	}
}
