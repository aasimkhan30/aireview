import { AiReviewCommand } from "../common/commands";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { ICommandRegistrationService } from "../services/commandRegistrationService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { WebviewPanelHost } from "../webviewHost/webviewPanelHost";
import { IReviewSettingsService } from "./reviewSettingsService";
import { ReviewSettingsWebviewController } from "./reviewSettingsWebviewController";

export const IReviewSettingsViewService =
	createServiceIdentifier<IReviewSettingsViewService>("reviewSettingsViewService");

export interface IReviewSettingsViewService {
	readonly _serviceBrand: undefined;
	open(): void;
}

export class ReviewSettingsViewService extends Disposable implements IReviewSettingsViewService {
	declare readonly _serviceBrand: undefined;
	private readonly host: WebviewPanelHost;

	constructor(
		@IExtensionContextService extensionContextService: IExtensionContextService,
		@ICommandRegistrationService commandRegistrationService: ICommandRegistrationService,
		@IReviewSettingsService settingsService: IReviewSettingsService,
		@IDiagnosticsService diagnostics: IDiagnosticsService
	) {
		super();
		this.host = this._register(
			new WebviewPanelHost({
				viewType: "aireview.settings",
				title: "AI Review Settings",
				extensionUri: extensionContextService.context.extensionUri,
				diagnostics,
				content: {
					title: "AI Review Settings",
					scriptPath: ["media", "settings.js"],
					stylePaths: [["media", "settings.css"]],
					localResourceRootPaths: [["media"]]
				},
				createController: (connection) =>
					new ReviewSettingsWebviewController(connection, settingsService, diagnostics)
			})
		);
		commandRegistrationService.registerCommand(AiReviewCommand.OpenSettings, () => this.open());
	}

	open(): void {
		this.host.show();
	}
}
