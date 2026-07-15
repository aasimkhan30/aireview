import * as vscode from "vscode";
import type {
	AiReviewSettingsState,
	McpClientId,
	McpIntegrationState,
	SettingsScope
} from "../common/settingsProtocol";
import { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { IExtensionContextService } from "../services/extensionContextService";
import { createServiceIdentifier } from "../util/di";
import { Disposable } from "../util/vs/base/common/lifecycle";
import { ReviewMcpInstaller } from "./reviewMcpInstaller";
import { IReviewStore } from "./reviewStore";

const instructionsSetting = "defaultOverallInstructions";
const clients: readonly McpClientId[] = ["codex", "claude", "copilotCli", "copilotVscode"];

export const IReviewSettingsService = createServiceIdentifier<IReviewSettingsService>("reviewSettingsService");

export interface IReviewSettingsService {
	readonly _serviceBrand: undefined;
	getState(): Promise<AiReviewSettingsState>;
	setInstructions(scope: SettingsScope, value: string): Promise<AiReviewSettingsState>;
	install(client: McpClientId, scope: SettingsScope): Promise<AiReviewSettingsState>;
	uninstall(client: McpClientId, scope: SettingsScope): Promise<AiReviewSettingsState>;
	revealMcpConfig(client: McpClientId, scope: SettingsScope): Promise<void>;
	revealData(): Promise<void>;
}

export class ReviewSettingsService extends Disposable implements IReviewSettingsService {
	declare readonly _serviceBrand: undefined;

	private readonly installer: ReviewMcpInstaller;
	private readonly workspaceUri: vscode.Uri | undefined;

	constructor(
		@IExtensionContextService private readonly extensionContextService: IExtensionContextService,
		@IReviewStore private readonly reviewStore: IReviewStore,
		@IDiagnosticsService private readonly diagnostics: IDiagnosticsService
	) {
		super();
		const workspaceRoot = extensionContextService.workspaceRoots[0] ?? process.cwd();
		this.workspaceUri = extensionContextService.workspaceRoots[0]
			? vscode.Uri.file(extensionContextService.workspaceRoots[0])
			: undefined;
		this.installer = new ReviewMcpInstaller({
			workspaceRoot,
			dataDirectory: extensionContextService.dataDirectory,
			bundledServerFile: vscode.Uri.joinPath(
				extensionContextService.context.extensionUri,
				"out",
				"aireview-mcp.js"
			).fsPath
		});
		this._register(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(`aireview.${instructionsSetting}`, this.workspaceUri)) {
					void this.syncEffectiveInstructions(true);
				}
			})
		);
		void this.installer
			.prepareServer()
			.catch((error) => this.diagnostics.error("reviewState", "mcp.prepare.failed", error));
		void this.syncEffectiveInstructions();
	}

	async getState(): Promise<AiReviewSettingsState> {
		const configuration = vscode.workspace.getConfiguration("aireview", this.workspaceUri);
		const inspected = configuration.inspect<string>(instructionsSetting);
		const [location, ledgerState, integrations] = await Promise.all([
			this.reviewStore.getLocation(),
			this.reviewStore.getState(),
			Promise.all(clients.map((client) => this.getIntegrationState(client)))
		]);
		const configured = inspected?.globalValue !== undefined || inspected?.workspaceValue !== undefined;
		return {
			instructions: {
				user: inspected?.globalValue ?? "",
				workspace: inspected?.workspaceValue ?? "",
				effective: configured
					? configuration.get<string>(instructionsSetting, "")
					: ledgerState.effectiveInstructions
			},
			dataDirectory: this.extensionContextService.dataDirectory,
			ledgerFile: location.stateFile,
			serverFile: this.installer.serverFile,
			integrations
		};
	}

	async setInstructions(scope: SettingsScope, value: string): Promise<AiReviewSettingsState> {
		const configuration = vscode.workspace.getConfiguration("aireview", this.workspaceUri);
		await configuration.update(
			instructionsSetting,
			value.trim().slice(0, 20_000) || undefined,
			scope === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace
		);
		await this.syncEffectiveInstructions(true);
		return this.getState();
	}

	async install(client: McpClientId, scope: SettingsScope): Promise<AiReviewSettingsState> {
		const operation = this.diagnostics.startOperation("reviewState", "mcp.install", () => ({ client, scope }));
		try {
			await this.installer.install(client, scope);
			operation.complete();
			return this.getState();
		} catch (error) {
			operation.fail(error);
			throw error;
		}
	}

	async uninstall(client: McpClientId, scope: SettingsScope): Promise<AiReviewSettingsState> {
		const installation = await this.installer.getInstallation(client, scope);
		if (scope === "user" && installation.status === "managed") {
			const action = "Remove user installation";
			const confirmed = await vscode.window.showWarningMessage(
				`Remove the ${clientLabel(client)} MCP integration from your user configuration? This affects every project that uses it.`,
				{ modal: true },
				action
			);
			if (confirmed !== action) {
				return this.getState();
			}
		}
		await this.installer.uninstall(client, scope);
		return this.getState();
	}

	async revealMcpConfig(client: McpClientId, scope: SettingsScope): Promise<void> {
		const installation = await this.installer.getInstallation(client, scope);
		if (!installation.configFile || installation.status === "absent") {
			throw new Error(`No ${clientLabel(client)} configuration exists at ${scope} scope`);
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(installation.configFile));
		await vscode.window.showTextDocument(document, { preview: true });
	}

	async revealData(): Promise<void> {
		const location = await this.reviewStore.getLocation();
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(location.stateFile));
		await vscode.window.showTextDocument(document, { preview: true });
	}

	private async getIntegrationState(client: McpClientId): Promise<McpIntegrationState> {
		const builtIn = client === "copilotVscode";
		const [detected, workspace, user] = await Promise.all([
			this.installer.isClientDetected(client),
			this.installer.getInstallation(client, "workspace"),
			this.installer.getInstallation(client, "user")
		]);
		return {
			id: client,
			label: clientLabel(client),
			detected,
			installations: { workspace, user },
			builtIn,
			detail: builtIn
				? "Provided directly by the AI Review extension; use #aireview in Agent mode."
				: detected
					? "Install for this workspace or for all projects."
					: `${clientLabel(client)} command was not found on PATH; configuration can still be installed.`
		};
	}

	private async syncEffectiveInstructions(force = false): Promise<void> {
		const configuration = vscode.workspace.getConfiguration("aireview", this.workspaceUri);
		const inspected = configuration.inspect<string>(instructionsSetting);
		if (!force && inspected?.globalValue === undefined && inspected?.workspaceValue === undefined) {
			return;
		}
		const value = configuration.get<string>(instructionsSetting, "");
		await this.reviewStore.setEffectiveInstructions(value);
	}
}

function clientLabel(client: McpClientId): string {
	return {
		codex: "Codex",
		claude: "Claude Code",
		copilotCli: "GitHub Copilot CLI",
		copilotVscode: "GitHub Copilot in VS Code"
	}[client];
}
