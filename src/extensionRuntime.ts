import type * as vscode from "vscode";
import { DiagnosticsServiceAdapter, IDiagnosticsService } from "./diagnostics/diagnosticsService";
import type { DiagnosticsRecorder } from "./diagnostics/diagnostics";
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
	builder.define(IExtensionContextService, new ExtensionContextService(options.context));
	builder.define(IDiagnosticsService, new DiagnosticsServiceAdapter(options.diagnosticsRecorder));
	builder.define(ICommandRegistrationService, new SyncDescriptor(CommandRegistrationService));
	builder.define(IReviewStore, new SyncDescriptor(ReviewStore));
	builder.define(IReviewPanelStateService, new SyncDescriptor(ReviewPanelStateService));
	builder.define(IReviewViewService, new SyncDescriptor(ReviewViewService));
	const instantiationService = builder.seal();
	instantiationService.invokeFunction((accessor) => accessor.get(IReviewViewService));
	return { dispose: () => instantiationService.dispose() };
}
