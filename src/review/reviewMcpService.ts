import * as vscode from "vscode";
import type { ReviewNote } from "../common/reviewProtocol";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { IReviewStore } from "./reviewStore";

const mcpProviderId = "requestchanges.mcpProvider";
const languageModelToolName = "requestchanges";

export const IReviewMcpService = createServiceIdentifier<IReviewMcpService>("reviewMcpService");

export interface IReviewMcpService {
	readonly _serviceBrand: undefined;
}

/** Registers the bundled server for VS Code and the explicit #requestchanges read tool. */
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
				"requestchanges-mcp.js"
			).fsPath;
			this._register(
				vscode.lm.registerMcpServerDefinitionProvider(mcpProviderId, {
					provideMcpServerDefinitions: () => {
						const definition = new vscode.McpStdioServerDefinition(
							"requestchanges",
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
					const comments = state.notes.filter((note) => isActionable(note));
					diagnostics.info("reviewState", "languageModelTool.invoked", () => ({
						commentCount: comments.length
					}));
					return new vscode.LanguageModelToolResult([
						new vscode.LanguageModelTextPart(
							JSON.stringify(
								{
									revision: state.revision,
									overallInstructions: state.effectiveInstructions,
									commentCount: comments.length,
									comments
								},
								undefined,
								2
							)
						)
					]);
				},
				prepareInvocation: () => ({ invocationMessage: "Reading Request Changes review comments" })
			})
		);
	}
}

function isActionable(note: ReviewNote): boolean {
	return note.status === "draft" || note.status === "in_progress" || note.status === "blocked";
}
