import * as vscode from "vscode";
import { CommandRegistrationService, ICommandRegistrationService } from "./services/commandRegistrationService";
import { ExtensionContextService, IExtensionContextService } from "./services/extensionContextService";
import { IReviewPanelStateService, ReviewPanelStateService } from "./review/reviewPanelStateService";
import { IReviewStore, ReviewStore } from "./review/reviewStore";
import { IReviewViewService, ReviewViewService } from "./review/reviewViewService";
import { InstantiationServiceBuilder, SyncDescriptor } from "./util/di";

export function activate(context: vscode.ExtensionContext): void {
	const builder = new InstantiationServiceBuilder();
	builder.define(IExtensionContextService, new ExtensionContextService(context));
	builder.define(ICommandRegistrationService, new SyncDescriptor(CommandRegistrationService));
	builder.define(IReviewStore, new SyncDescriptor(ReviewStore));
	builder.define(IReviewPanelStateService, new SyncDescriptor(ReviewPanelStateService));
	builder.define(IReviewViewService, new SyncDescriptor(ReviewViewService));
	const instantiationService = builder.seal();
	instantiationService.invokeFunction((accessor) => accessor.get(IReviewViewService));

	context.subscriptions.push({ dispose: () => instantiationService.dispose() });
}

export function deactivate(): void {}
