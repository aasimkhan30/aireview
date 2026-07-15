import * as vscode from "vscode";
import type { ReviewNote } from "../common/reviewProtocol";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { IReviewStore } from "./reviewStore";

const mcpProviderId = "aireview.mcpProvider";
const languageModelToolName = "aireview";

export const IReviewMcpService = createServiceIdentifier<IReviewMcpService>("reviewMcpService");

export interface IReviewMcpService {
	readonly _serviceBrand: undefined;
}

/** Registers the bundled server for VS Code and the explicit #aireview read tool. */
export class ReviewMcpService extends Disposable implements IReviewMcpService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IExtensionContextService extensionContextService: IExtensionContextService,
		@IReviewStore reviewStore: IReviewStore,
		@IDiagnosticsService diagnostics: IDiagnosticsService
	) {
		super();
		const workspaceRoot = extensionContextService.workspaceRoots[0];
		if (workspaceRoot) {
			const serverPath = vscode.Uri.joinPath(
				extensionContextService.context.extensionUri,
				"out",
				"aireview-mcp.js"
			).fsPath;
			this._register(
				vscode.lm.registerMcpServerDefinitionProvider(mcpProviderId, {
					provideMcpServerDefinitions: () => {
						const definition = new vscode.McpStdioServerDefinition(
							"aireview",
							process.execPath,
							[
								serverPath,
								"--workspace",
								workspaceRoot,
								"--data-dir",
								extensionContextService.dataDirectory,
								"--client",
								"GitHub Copilot in VS Code"
							],
							{ ELECTRON_RUN_AS_NODE: "1" },
							String(extensionContextService.context.extension.packageJSON.version ?? "unknown")
						);
						definition.cwd = vscode.Uri.file(workspaceRoot);
						return [definition];
					},
					resolveMcpServerDefinition: (definition) => definition
				})
			);
		}

		this._register(
			vscode.lm.registerTool(languageModelToolName, {
				invoke: async () => {
					const state = await reviewStore.getState();
					const notes = state.notes.filter((note) => isActionable(note));
					diagnostics.info("reviewState", "languageModelTool.invoked", () => ({ noteCount: notes.length }));
					return new vscode.LanguageModelToolResult([
						new vscode.LanguageModelTextPart(
							JSON.stringify(
								{
									revision: state.revision,
									overallInstructions: state.effectiveInstructions,
									notes
								},
								undefined,
								2
							)
						)
					]);
				},
				prepareInvocation: () => ({ invocationMessage: "Reading AI Review annotations" })
			})
		);
	}
}

function isActionable(note: ReviewNote): boolean {
	return note.status === "draft" || note.status === "in_progress" || note.status === "blocked";
}
