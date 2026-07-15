import * as vscode from "vscode";
import { DiagnosticsServiceAdapter, IDiagnosticsService } from "./diagnostics/diagnosticsService";
import type { DiagnosticsRecorder } from "./diagnostics/diagnostics";
import { IReviewCommentService, ReviewCommentService } from "./review/reviewCommentService";
import { getDefaultAiReviewDataDirectory } from "./review/reviewLedger";
import { IReviewMcpService, ReviewMcpService } from "./review/reviewMcpService";
import { IReviewSettingsService, ReviewSettingsService } from "./review/reviewSettingsService";
import { IReviewSettingsViewService, ReviewSettingsViewService } from "./review/reviewSettingsViewService";
import { IReviewPanelStateService, ReviewPanelStateService } from "./review/reviewPanelStateService";
import { IReviewStore, ReviewStore } from "./review/reviewStore";
import { IReviewViewService, ReviewViewService } from "./review/reviewViewService";
import { CommandRegistrationService, ICommandRegistrationService } from "./services/commandRegistrationService";
import { ExtensionContextService, IExtensionContextService } from "./services/extensionContextService";
import { InstantiationServiceBuilder, SyncDescriptor } from "./util/di";

export interface ExtensionRuntime {
	dispose(): void;
}

export interface CreateExtensionRuntimeOptions {
	readonly context: vscode.ExtensionContext;
	readonly diagnosticsRecorder: DiagnosticsRecorder;
}

export async function createExtensionRuntime(options: CreateExtensionRuntimeOptions): Promise<ExtensionRuntime> {
	const builder = new InstantiationServiceBuilder();
	builder.define(
		IExtensionContextService,
		new ExtensionContextService(
			options.context,
			vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
			getDefaultAiReviewDataDirectory()
		)
	);
	builder.define(IDiagnosticsService, new DiagnosticsServiceAdapter(options.diagnosticsRecorder));
	builder.define(ICommandRegistrationService, new SyncDescriptor(CommandRegistrationService));
	builder.define(IReviewStore, new SyncDescriptor(ReviewStore));
	builder.define(IReviewPanelStateService, new SyncDescriptor(ReviewPanelStateService));
	builder.define(IReviewCommentService, new SyncDescriptor(ReviewCommentService));
	builder.define(IReviewMcpService, new SyncDescriptor(ReviewMcpService));
	builder.define(IReviewSettingsService, new SyncDescriptor(ReviewSettingsService));
	builder.define(IReviewSettingsViewService, new SyncDescriptor(ReviewSettingsViewService));
	builder.define(IReviewViewService, new SyncDescriptor(ReviewViewService));
	const instantiationService = builder.seal();
	instantiationService.invokeFunction((accessor) => {
		accessor.get(IReviewViewService);
		accessor.get(IReviewMcpService);
		accessor.get(IReviewSettingsViewService);
	});
	return { dispose: () => instantiationService.dispose() };
}
