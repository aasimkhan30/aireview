import type { MessageConnection } from "vscode-jsonrpc/node";
import {
	SettingsRpc,
	type ManageMcpInstallationParams,
	type SetDefaultInstructionsParams
} from "../common/settingsProtocol";
import type { IDiagnosticsService } from "../diagnostics/diagnosticsService";
import { Disposable } from "../util/vs/base/common/lifecycle";
import type { IReviewSettingsService } from "./reviewSettingsService";

export class ReviewSettingsWebviewController extends Disposable {
	constructor(
		connection: MessageConnection,
		settingsService: IReviewSettingsService,
		diagnostics: IDiagnosticsService
	) {
		super();
		this._register(connection.onRequest(SettingsRpc.getState, () => settingsService.getState()));
		this._register(
			connection.onRequest(SettingsRpc.setInstructions, (value: unknown) => {
				const params = normalizeInstructions(value);
				return settingsService.setInstructions(params.scope, params.value);
			})
		);
		this._register(
			connection.onRequest(SettingsRpc.installMcp, (value: unknown) => {
				const params = normalizeMcpParams(value);
				return settingsService.install(params.client, params.scope);
			})
		);
		this._register(
			connection.onRequest(SettingsRpc.uninstallMcp, (value: unknown) => {
				const params = normalizeMcpParams(value);
				return settingsService.uninstall(params.client, params.scope);
			})
		);
		this._register(
			connection.onRequest(SettingsRpc.revealMcpConfig, (value: unknown) => {
				const params = normalizeMcpParams(value);
				return settingsService.revealMcpConfig(params.client, params.scope);
			})
		);
		this._register(
			connection.onRequest(SettingsRpc.revealData, async () => {
				try {
					await settingsService.revealData();
				} catch (error) {
					diagnostics.error("webview", "settings.revealData.failed", error);
					throw error;
				}
			})
		);
	}
}

function normalizeInstructions(value: unknown): SetDefaultInstructionsParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected instruction settings");
	}
	const params = value as Partial<SetDefaultInstructionsParams>;
	if ((params.scope !== "workspace" && params.scope !== "user") || typeof params.value !== "string") {
		throw new Error("Invalid instruction settings");
	}
	return { scope: params.scope, value: params.value };
}

function normalizeMcpParams(value: unknown): ManageMcpInstallationParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected MCP installation settings");
	}
	const params = value as Partial<ManageMcpInstallationParams>;
	const clients = ["codex", "claude", "copilotCli", "copilotVscode"];
	if (!clients.includes(params.client ?? "") || (params.scope !== "workspace" && params.scope !== "user")) {
		throw new Error("Invalid MCP installation settings");
	}
	return params as ManageMcpInstallationParams;
}
