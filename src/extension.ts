import * as vscode from "vscode";
import { CommandRegistrationService, ICommandRegistrationService } from "./services/commandRegistrationService";
import { ExtensionContextService, IExtensionContextService } from "./services/extensionContextService";
import { InstantiationServiceBuilder, SyncDescriptor } from "./util/di";
import { IReviewPanelService, ReviewPanelService } from "./webviewPanel/reviewPanelService";

export function activate(context: vscode.ExtensionContext): void {
	const builder = new InstantiationServiceBuilder();
	builder.define(IExtensionContextService, new ExtensionContextService(context));
	builder.define(ICommandRegistrationService, new SyncDescriptor(CommandRegistrationService));
	builder.define(IReviewPanelService, new SyncDescriptor(ReviewPanelService));
	const instantiationService = builder.seal();
	instantiationService.invokeFunction((accessor) => accessor.get(IReviewPanelService));

	context.subscriptions.push({ dispose: () => instantiationService.dispose() });
}

export function deactivate(): void {}
