import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	McpClientId,
	McpInstallationStatus,
	McpScopeInstallationState,
	SettingsScope
} from "../common/settingsProtocol";

const managedBlockStart = "# BEGIN REQUEST CHANGES MCP (managed by aasimkhan30.request-changes)";
const managedBlockEnd = "# END REQUEST CHANGES MCP";

export interface McpInstallerOptions {
	readonly workspaceRoot: string;
	readonly dataDirectory: string;
	readonly bundledServerFile: string;
	readonly nodeCommand?: string;
}

export class ReviewMcpInstaller {
	readonly serverFile: string;

	constructor(private readonly options: McpInstallerOptions) {
		this.serverFile = join(options.dataDirectory, "bin", "requestchanges-mcp.js");
	}

	async prepareServer(): Promise<void> {
		await mkdir(dirname(this.serverFile), { recursive: true, mode: 0o700 });
		await copyFile(this.options.bundledServerFile, this.serverFile);
	}

	async isClientDetected(client: McpClientId): Promise<boolean> {
		if (client === "copilotVscode") {
			return true;
		}
		return Boolean(await findExecutable(clientCommand(client)));
	}

	async getInstallation(client: McpClientId, scope: SettingsScope): Promise<McpScopeInstallationState> {
		if (client === "copilotVscode") {
			return { status: "managed", configFile: "" };
		}
		const target = getConfigTarget(client, scope, this.options.workspaceRoot);
		const content = await readOptionalFile(target.path);
		let status: McpInstallationStatus;
		if (target.format === "toml") {
			status = !content
				? "absent"
				: content.includes(managedBlockStart)
					? "managed"
					: /^\s*\[mcp_servers\.requestchanges\]\s*$/mu.test(content)
						? "external"
						: "absent";
			return { status, configFile: target.path };
		}
		if (!content) {
			return { status: "absent", configFile: target.path };
		}
		try {
			const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
			const configured = parsed.mcpServers?.requestchanges as { args?: unknown } | undefined;
			status = !configured
				? "absent"
				: Array.isArray(configured.args) && configured.args.includes(this.serverFile)
					? "managed"
					: "external";
		} catch {
			status = "invalid";
		}
		return { status, configFile: target.path };
	}

	async install(client: McpClientId, scope: SettingsScope): Promise<void> {
		if (client === "copilotVscode") {
			return;
		}
		const existing = await this.getInstallation(client, scope);
		if (existing.status === "external") {
			throw new Error(
				`Request Changes cannot replace the externally managed configuration in ${existing.configFile}`
			);
		}
		if (existing.status === "invalid") {
			throw new Error(
				`Fix the invalid JSON configuration in ${existing.configFile} before installing Request Changes`
			);
		}
		await this.prepareServer();
		const nodeCommand = this.options.nodeCommand ?? (await findExecutable("node")) ?? "node";
		const target = getConfigTarget(client, scope, this.options.workspaceRoot);
		if (target.format === "toml") {
			await installToml(
				target.path,
				nodeCommand,
				this.serverFile,
				this.options.dataDirectory,
				clientLabel(client),
				join(this.options.dataDirectory, "backups")
			);
			return;
		}
		await installJson(
			target.path,
			createJsonServer(nodeCommand, this.serverFile, this.options.dataDirectory, clientLabel(client)),
			join(this.options.dataDirectory, "backups")
		);
	}

	async uninstall(client: McpClientId, scope: SettingsScope): Promise<void> {
		if (client === "copilotVscode") {
			return;
		}
		const existing = await this.getInstallation(client, scope);
		if (existing.status === "absent") {
			return;
		}
		if (existing.status !== "managed") {
			throw new Error(
				`Request Changes will not remove the externally managed configuration in ${existing.configFile}`
			);
		}
		const target = getConfigTarget(client, scope, this.options.workspaceRoot);
		if (target.format === "toml") {
			const content = await readOptionalFile(target.path);
			if (content?.includes(managedBlockStart)) {
				await writeAtomic(target.path, removeManagedTomlBlock(content));
			}
			return;
		}
		const content = await readOptionalFile(target.path);
		if (!content) {
			return;
		}
		const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
		const servers = parsed.mcpServers;
		const configured = servers?.requestchanges as { args?: unknown } | undefined;
		if (servers && configured && Array.isArray(configured.args) && configured.args.includes(this.serverFile)) {
			delete servers.requestchanges;
			await writeAtomic(target.path, `${JSON.stringify(parsed, undefined, 2)}\n`);
		}
	}
}

function getConfigTarget(
	client: McpClientId,
	scope: SettingsScope,
	workspaceRoot: string
): { path: string; format: "json" | "toml" } {
	if (client === "codex") {
		return {
			path:
				scope === "workspace"
					? join(workspaceRoot, ".codex", "config.toml")
					: join(homedir(), ".codex", "config.toml"),
			format: "toml"
		};
	}
	if (client === "claude") {
		return {
			path: scope === "workspace" ? join(workspaceRoot, ".mcp.json") : join(homedir(), ".claude.json"),
			format: "json"
		};
	}
	return {
		path: scope === "workspace" ? join(workspaceRoot, ".mcp.json") : join(homedir(), ".copilot", "mcp-config.json"),
		format: "json"
	};
}

async function installToml(
	path: string,
	nodeCommand: string,
	serverFile: string,
	dataDirectory: string,
	client: string,
	backupDirectory: string
): Promise<void> {
	const current = (await readOptionalFile(path)) ?? "";
	const withoutManagedBlock = removeManagedTomlBlock(current).trimEnd();
	const block = [
		managedBlockStart,
		"[mcp_servers.requestchanges]",
		`command = ${JSON.stringify(nodeCommand)}`,
		`args = ${JSON.stringify([serverFile, "--data-dir", dataDirectory, "--client", client])}`,
		managedBlockEnd
	].join("\n");
	await backupIfPresent(path, backupDirectory);
	await writeAtomic(path, `${withoutManagedBlock ? `${withoutManagedBlock}\n\n` : ""}${block}\n`);
}

async function installJson(path: string, server: Record<string, unknown>, backupDirectory: string): Promise<void> {
	const current = await readOptionalFile(path);
	const parsed = current ? (JSON.parse(current) as { mcpServers?: Record<string, unknown> }) : {};
	parsed.mcpServers = { ...(parsed.mcpServers ?? {}), requestchanges: server };
	await backupIfPresent(path, backupDirectory);
	await writeAtomic(path, `${JSON.stringify(parsed, undefined, 2)}\n`);
}

function createJsonServer(
	nodeCommand: string,
	serverFile: string,
	dataDirectory: string,
	client: string
): Record<string, unknown> {
	return {
		type: "stdio",
		command: nodeCommand,
		args: [serverFile, "--data-dir", dataDirectory, "--client", client],
		tools: ["*"]
	};
}

function removeManagedTomlBlock(content: string): string {
	const start = content.indexOf(managedBlockStart);
	if (start < 0) {
		return content;
	}
	const end = content.indexOf(managedBlockEnd, start);
	return end < 0
		? content.slice(0, start)
		: `${content.slice(0, start)}${content.slice(end + managedBlockEnd.length)}`;
}

async function backupIfPresent(path: string, backupDirectory: string): Promise<void> {
	try {
		await stat(path);
		await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
		const key = createHash("sha256").update(path).digest("hex").slice(0, 16);
		await copyFile(path, join(backupDirectory, `${key}-${Date.now()}.bak`));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

async function writeAtomic(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.requestchanges-tmp-${process.pid}`;
	let mode = 0o600;
	try {
		mode = (await stat(path)).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
	await writeFile(temporary, content, { encoding: "utf8", mode });
	await rename(temporary, path);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function clientCommand(client: McpClientId): string {
	return client === "copilotCli" ? "copilot" : client;
}

function clientLabel(client: McpClientId): string {
	return {
		codex: "Codex",
		claude: "Claude Code",
		copilotCli: "GitHub Copilot CLI",
		copilotVscode: "Copilot in VS Code"
	}[client];
}

async function findExecutable(command: string): Promise<string | undefined> {
	const locator = process.platform === "win32" ? "where" : "which";
	return new Promise((resolveExecutable) => {
		execFile(locator, [command], { windowsHide: true }, (error, stdout) => {
			resolveExecutable(error ? undefined : stdout.trim().split(/\r?\n/)[0]);
		});
	});
}
