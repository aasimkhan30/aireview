import * as React from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, FolderOpen, RefreshCw, Settings2, Unplug } from "lucide-react";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import {
	SettingsRpc,
	type RequestChangesSettingsState,
	type McpClientId,
	type McpIntegrationState,
	type SettingsScope
} from "../../common/settingsProtocol";

export function SettingsApp({ connection }: { readonly connection: MessageConnection }) {
	const [state, setState] = React.useState<RequestChangesSettingsState>();
	const [userInstructions, setUserInstructions] = React.useState("");
	const [workspaceInstructions, setWorkspaceInstructions] = React.useState("");
	const [busy, setBusy] = React.useState<string>();
	const [message, setMessage] = React.useState<string>();

	const acceptState = React.useCallback((next: RequestChangesSettingsState) => {
		setState(next);
		setUserInstructions(next.instructions.user);
		setWorkspaceInstructions(next.instructions.workspace);
	}, []);

	React.useEffect(() => {
		void connection
			.sendRequest(SettingsRpc.getState)
			.then(acceptState)
			.catch((error) => setMessage(errorMessage(error)));
	}, [acceptState, connection]);

	async function run(key: string, operation: () => Promise<RequestChangesSettingsState>): Promise<void> {
		setBusy(key);
		setMessage(undefined);
		try {
			acceptState(await operation());
		} catch (error) {
			setMessage(errorMessage(error));
		} finally {
			setBusy(undefined);
		}
	}

	async function saveInstructions(scope: SettingsScope): Promise<void> {
		await run(`instructions:${scope}`, () =>
			connection.sendRequest(SettingsRpc.setInstructions, {
				scope,
				value: scope === "user" ? userInstructions : workspaceInstructions
			})
		);
	}

	async function manageInstallation(client: McpClientId, scope: SettingsScope, remove: boolean): Promise<void> {
		await run(`${client}:${scope}:${remove ? "remove" : "install"}`, () =>
			connection.sendRequest(remove ? SettingsRpc.uninstallMcp : SettingsRpc.installMcp, { client, scope })
		);
	}

	async function revealMcpConfig(client: McpClientId, scope: SettingsScope): Promise<void> {
		setBusy(`${client}:${scope}:reveal`);
		setMessage(undefined);
		try {
			await connection.sendRequest(SettingsRpc.revealMcpConfig, { client, scope });
		} catch (error) {
			setMessage(errorMessage(error));
		} finally {
			setBusy(undefined);
		}
	}

	function handleInstructionShortcut(event: React.KeyboardEvent<HTMLTextAreaElement>, scope: SettingsScope): void {
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			const value = scope === "user" ? userInstructions : workspaceInstructions;
			if (!busy && value !== state?.instructions[scope]) {
				void saveInstructions(scope);
			}
		}
	}

	async function revealData(): Promise<void> {
		setBusy("data:reveal");
		setMessage(undefined);
		try {
			await connection.sendRequest(SettingsRpc.revealData);
		} catch (error) {
			setMessage(errorMessage(error));
		} finally {
			setBusy(undefined);
		}
	}

	const configurableIntegrations = state?.integrations.filter((integration) => !integration.builtIn) ?? [];
	const builtInIntegration = state?.integrations.find((integration) => integration.builtIn);

	return (
		<main className="settings-shell" aria-busy={Boolean(busy)}>
			<header className="settings-header">
				<div>
					<Settings2 aria-hidden="true" size={20} />
					<div>
						<h1>Request Changes Settings</h1>
						<p>Defaults, local data, and coding-agent integrations</p>
					</div>
				</div>
				<button
					type="button"
					className="icon-button"
					aria-label="Refresh settings"
					title="Refresh settings"
					onClick={() => void run("refresh", () => connection.sendRequest(SettingsRpc.getState))}
					disabled={busy !== undefined}
				>
					<RefreshCw aria-hidden="true" size={16} />
				</button>
			</header>
			{busy ? (
				<div className="sr-only" role="status" aria-live="polite">
					Updating Request Changes settings.
				</div>
			) : undefined}

			{!state && !message ? (
				<div className="sr-only" role="status" aria-live="polite">
					Loading Request Changes settings.
				</div>
			) : undefined}
			{message ? (
				<div className="settings-message" role="alert">
					{message}
				</div>
			) : undefined}

			<section className="settings-section" aria-labelledby="instructions-heading">
				<header>
					<h2 id="instructions-heading">Default overall instructions</h2>
					<p id="instructions-description">
						The workspace value overrides your user default and is included with every agent run.
					</p>
				</header>
				<div className="instruction-grid">
					<div className="instruction-field">
						<label htmlFor="user-instructions">User default</label>
						<textarea
							id="user-instructions"
							value={userInstructions}
							onChange={(event) => setUserInstructions(event.target.value)}
							onKeyDown={(event) => handleInstructionShortcut(event, "user")}
							aria-describedby="instructions-description instruction-shortcut"
							aria-keyshortcuts="Control+Enter Meta+Enter"
							placeholder="Instructions for every project"
							rows={6}
						/>
						<button
							type="button"
							onClick={() => void saveInstructions("user")}
							disabled={busy !== undefined || userInstructions === state?.instructions.user}
						>
							Save user default
						</button>
					</div>
					<div className="instruction-field">
						<label htmlFor="workspace-instructions">Workspace override</label>
						<textarea
							id="workspace-instructions"
							value={workspaceInstructions}
							onChange={(event) => setWorkspaceInstructions(event.target.value)}
							onKeyDown={(event) => handleInstructionShortcut(event, "workspace")}
							aria-describedby="instructions-description instruction-shortcut"
							aria-keyshortcuts="Control+Enter Meta+Enter"
							placeholder="Leave empty to inherit the user default"
							rows={6}
						/>
						<button
							type="button"
							onClick={() => void saveInstructions("workspace")}
							disabled={busy !== undefined || workspaceInstructions === state?.instructions.workspace}
						>
							Save workspace override
						</button>
					</div>
				</div>
				<p className="sr-only" id="instruction-shortcut">
					Press Control or Command plus Enter to save instructions.
				</p>
				<div className="effective-instructions" aria-labelledby="effective-instructions-label">
					<strong id="effective-instructions-label">Effective instructions</strong>
					<pre>{state?.instructions.effective || "No default instructions configured."}</pre>
				</div>
			</section>

			<section className="settings-section" aria-labelledby="integrations-heading">
				<header>
					<h2 id="integrations-heading">MCP integrations</h2>
					<p>Workspace installs affect this repository. User installs are available across your projects.</p>
				</header>
				<table className="integration-table">
					<caption className="sr-only">MCP installation status by client and scope</caption>
					<thead>
						<tr>
							<th scope="col">Integration</th>
							<th scope="col">Workspace</th>
							<th scope="col">User</th>
						</tr>
					</thead>
					<tbody>
						{configurableIntegrations.map((integration) => (
							<tr key={integration.id}>
								<th scope="row">
									<div className="integration-name">
										<span>{integration.label}</span>
										{!integration.detected ? (
											<span className="status">CLI not detected</span>
										) : undefined}
									</div>
									<p>{integration.detail}</p>
									<IntegrationUsageHint client={integration.id} />
								</th>
								{(["workspace", "user"] as const).map((scope) => (
									<td className="integration-scope" data-label={scopeLabel(scope)} key={scope}>
										<InstallationCell
											integration={integration}
											scope={scope}
											busy={busy}
											onInstall={() => void manageInstallation(integration.id, scope, false)}
											onRemove={() => void manageInstallation(integration.id, scope, true)}
											onReveal={() => void revealMcpConfig(integration.id, scope)}
										/>
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
				<p className="integration-footnote">
					Claude Code and GitHub Copilot CLI share the workspace <code>.mcp.json</code> configuration.
				</p>
				{builtInIntegration ? (
					<article className="built-in-integration" aria-labelledby="built-in-integration-heading">
						<CheckCircle2 aria-hidden="true" size={18} />
						<div>
							<div className="integration-name">
								<strong id="built-in-integration-heading">{builtInIntegration.label}</strong>
								<span className="status status--installed">Available automatically</span>
							</div>
							<p>{builtInIntegration.detail}</p>
							<IntegrationUsageHint client={builtInIntegration.id} />
						</div>
					</article>
				) : undefined}
			</section>

			<section className="settings-section data-section" aria-labelledby="review-data-heading">
				<header>
					<h2 id="review-data-heading">Review data</h2>
					<p>Review comments are private user data and are not written into the reviewed repository.</p>
				</header>
				<dl>
					<dt>Data directory</dt>
					<dd>{state?.dataDirectory}</dd>
					<dt>Current ledger</dt>
					<dd>{state?.ledgerFile}</dd>
					<dt>Bundled MCP server</dt>
					<dd>{state?.serverFile}</dd>
				</dl>
				<button
					type="button"
					className="secondary"
					onClick={() => void revealData()}
					disabled={busy !== undefined || !state}
				>
					<FolderOpen aria-hidden="true" size={14} /> Reveal current ledger
				</button>
			</section>
		</main>
	);
}

interface InstallationCellProps {
	readonly integration: McpIntegrationState;
	readonly scope: SettingsScope;
	readonly busy: string | undefined;
	readonly onInstall: () => void;
	readonly onRemove: () => void;
	readonly onReveal: () => void;
}

function InstallationCell({ integration, scope, busy, onInstall, onRemove, onReveal }: InstallationCellProps) {
	const installation = integration.installations[scope];
	const operation = `${integration.id}:${scope}`;
	const installing = busy === `${operation}:install`;
	const removing = busy === `${operation}:remove`;
	const disabled = busy !== undefined;
	const accessibleScope = scopeLabel(scope).toLowerCase();

	if (installation.status === "managed") {
		return (
			<div className="installation-state">
				<span className="status status--installed">
					<CheckCircle2 aria-hidden="true" size={13} /> Installed
				</span>
				<button
					type="button"
					className="secondary danger"
					aria-label={`Remove ${integration.label} MCP integration from ${accessibleScope} scope`}
					onClick={onRemove}
					disabled={disabled}
				>
					<Unplug aria-hidden="true" size={13} /> {removing ? "Removing…" : "Remove"}
				</button>
			</div>
		);
	}

	if (installation.status === "external" || installation.status === "invalid") {
		const invalid = installation.status === "invalid";
		return (
			<div className="installation-state">
				<span className={`status ${invalid ? "status--warning" : "status--external"}`}>
					{invalid ? <AlertTriangle aria-hidden="true" size={13} /> : undefined}
					{invalid ? "Configuration error" : "Detected externally"}
				</span>
				<span className="installation-state__note">
					{invalid ? "Fix this file before installing." : "Request Changes won’t modify this entry."}
				</span>
				<button
					type="button"
					className="secondary"
					aria-label={`Open ${integration.label} ${accessibleScope} MCP configuration`}
					onClick={onReveal}
					disabled={disabled}
				>
					<ExternalLink aria-hidden="true" size={13} /> Open config
				</button>
			</div>
		);
	}

	return (
		<div className="installation-state">
			<span className="status">Not installed</span>
			<button
				type="button"
				aria-label={`Install ${integration.label} MCP integration at ${accessibleScope} scope`}
				onClick={onInstall}
				disabled={disabled}
			>
				{installing ? "Installing…" : "Install"}
			</button>
		</div>
	);
}

function scopeLabel(scope: SettingsScope): string {
	return scope === "workspace" ? "Workspace" : "User";
}

const integrationUsage: Readonly<
	Record<McpClientId, { readonly steps: readonly string[]; readonly invocation: string }>
> = {
	codex: {
		steps: [
			"Install Request Changes from the Workspace column for this repository, or User for every repository.",
			"Restart Codex and open this repository.",
			"Run /mcp and confirm that requestchanges is listed and enabled.",
			"Send this prompt:"
		],
		invocation:
			"Use the requestchanges MCP server to read all open review comments, implement them, run relevant tests, report each comment as addressed or blocked, and finish with a concise summary of each comment."
	},
	claude: {
		steps: ["Start a new Claude Code session in the reviewed workspace, then run the MCP prompt:"],
		invocation: "/mcp__requestchanges__address_review_comments"
	},
	copilotCli: {
		steps: ["Start a new Copilot CLI session in the reviewed workspace, then ask:"],
		invocation:
			"Use the requestchanges MCP server to fix the open review comments, then summarize each comment and whether it was addressed or blocked."
	},
	copilotVscode: {
		steps: ["Open Copilot Chat in Agent mode for this workspace, then ask:"],
		invocation: "Fix the open review comments with #requestchanges, then summarize each comment when done."
	}
};

function IntegrationUsageHint({ client }: { readonly client: McpClientId }) {
	const usage = integrationUsage[client];
	return (
		<details className="integration-usage">
			<summary>How to use</summary>
			<ol>
				{usage.steps.map((step) => (
					<li key={step}>{step}</li>
				))}
			</ol>
			<code>{usage.invocation}</code>
		</details>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
