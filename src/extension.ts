import * as vscode from "vscode";
import { ExtensionContextService, IExtensionContextService } from "./services/extensionContextService";
import { InstantiationServiceBuilder, SyncDescriptor } from "./util/di";
import { IReviewPanelService, ReviewPanelService } from "./webviewPanel/reviewPanelService";

export function activate(context: vscode.ExtensionContext): void {
  const builder = new InstantiationServiceBuilder();
  builder.define(IExtensionContextService, new ExtensionContextService(context));
  builder.define(IReviewPanelService, new SyncDescriptor(ReviewPanelService));
  const instantiationService = builder.seal();
  const reviewPanelService = instantiationService.invokeFunction(accessor => accessor.get(IReviewPanelService));

  const openReviewPanel = vscode.commands.registerCommand("aireview.openReviewPanel", () => {
    reviewPanelService.open();
  });

  context.subscriptions.push({ dispose: () => instantiationService.dispose() });
  context.subscriptions.push(openReviewPanel);
}

export function deactivate(): void {}
