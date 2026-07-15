import { RequestType, RequestType0 } from "vscode-jsonrpc";

export const SettingsRpc = {
	getState: new RequestType0<AiReviewSettingsState, void>("aireview.settings.getState"),
	setInstructions: new RequestType<SetDefaultInstructionsParams, AiReviewSettingsState, void>(
		"aireview.settings.setInstructions"
	),
	installMcp: new RequestType<ManageMcpInstallationParams, AiReviewSettingsState, void>(
		"aireview.settings.installMcp"
	),
	uninstallMcp: new RequestType<ManageMcpInstallationParams, AiReviewSettingsState, void>(
		"aireview.settings.uninstallMcp"
	),
	revealMcpConfig: new RequestType<ManageMcpInstallationParams, void, void>("aireview.settings.revealMcpConfig"),
	revealData: new RequestType0<void, void>("aireview.settings.revealData")
} as const;

export type SettingsScope = "workspace" | "user";
export type McpClientId = "codex" | "claude" | "copilotCli" | "copilotVscode";
export type McpInstallationStatus = "absent" | "managed" | "external" | "invalid";

export interface AiReviewSettingsState {
	readonly instructions: {
		readonly user: string;
		readonly workspace: string;
		readonly effective: string;
	};
	readonly dataDirectory: string;
	readonly ledgerFile: string;
	readonly serverFile: string;
	readonly integrations: readonly McpIntegrationState[];
}

export interface McpIntegrationState {
	readonly id: McpClientId;
	readonly label: string;
	readonly detected: boolean;
	readonly installations: Readonly<Record<SettingsScope, McpScopeInstallationState>>;
	readonly builtIn: boolean;
	readonly detail: string;
}

export interface McpScopeInstallationState {
	readonly status: McpInstallationStatus;
	readonly configFile: string;
}

export interface SetDefaultInstructionsParams {
	readonly scope: SettingsScope;
	readonly value: string;
}

export interface ManageMcpInstallationParams {
	readonly client: McpClientId;
	readonly scope: SettingsScope;
}
