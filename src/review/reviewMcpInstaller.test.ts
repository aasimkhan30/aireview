import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewMcpInstaller } from "./reviewMcpInstaller";

describe("ReviewMcpInstaller", () => {
	let root: string;
	let workspaceRoot: string;
	let installer: ReviewMcpInstaller;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "requestchanges-installer-"));
		workspaceRoot = join(root, "workspace");
		const bundledServerFile = join(root, "bundled-server.js");
		await mkdir(workspaceRoot);
		await writeFile(bundledServerFile, "// bundled server\n", "utf8");
		installer = new ReviewMcpInstaller({
			workspaceRoot,
			dataDirectory: join(root, "data"),
			bundledServerFile,
			nodeCommand: process.execPath
		});
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("merges and removes the managed Codex workspace block", async () => {
		const configFile = join(workspaceRoot, ".codex", "config.toml");
		await mkdir(join(workspaceRoot, ".codex"));
		await writeFile(configFile, 'model = "gpt-5"\n', "utf8");

		await installer.install("codex", "workspace");
		const installed = await readFile(configFile, "utf8");
		expect(installed).toContain('model = "gpt-5"');
		expect(installed).toContain("[mcp_servers.requestchanges]");
		expect((await installer.getInstallation("codex", "workspace")).status).toBe("managed");

		await installer.uninstall("codex", "workspace");
		expect(await readFile(configFile, "utf8")).toContain('model = "gpt-5"');
		expect((await installer.getInstallation("codex", "workspace")).status).toBe("absent");
	});

	it("preserves unrelated shared MCP servers", async () => {
		const configFile = join(workspaceRoot, ".mcp.json");
		await writeFile(
			configFile,
			`${JSON.stringify({ mcpServers: { existing: { command: "existing" } }, project: "kept" })}\n`,
			"utf8"
		);

		await installer.install("claude", "workspace");
		const installed = JSON.parse(await readFile(configFile, "utf8")) as {
			mcpServers: Record<string, { command: string }>;
			project: string;
		};
		expect(installed.project).toBe("kept");
		expect(installed.mcpServers.existing.command).toBe("existing");
		expect(installed.mcpServers.requestchanges.command).toBe(process.execPath);

		await installer.uninstall("copilotCli", "workspace");
		const uninstalled = JSON.parse(await readFile(configFile, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(uninstalled.mcpServers.existing).toBeDefined();
		expect(uninstalled.mcpServers.requestchanges).toBeUndefined();
	});

	it("detects but never replaces or removes an external Codex configuration", async () => {
		const configFile = join(workspaceRoot, ".codex", "config.toml");
		await mkdir(join(workspaceRoot, ".codex"));
		const external = '[mcp_servers.requestchanges]\ncommand = "custom-requestchanges"\n';
		await writeFile(configFile, external, "utf8");

		expect((await installer.getInstallation("codex", "workspace")).status).toBe("external");
		await expect(installer.install("codex", "workspace")).rejects.toThrow("cannot replace");
		await expect(installer.uninstall("codex", "workspace")).rejects.toThrow("will not remove");
		expect(await readFile(configFile, "utf8")).toBe(external);
	});

	it("detects but never replaces or removes an external JSON configuration", async () => {
		const configFile = join(workspaceRoot, ".mcp.json");
		const external = `${JSON.stringify({ mcpServers: { requestchanges: { command: "custom-requestchanges" } } })}\n`;
		await writeFile(configFile, external, "utf8");

		expect((await installer.getInstallation("claude", "workspace")).status).toBe("external");
		await expect(installer.install("claude", "workspace")).rejects.toThrow("cannot replace");
		await expect(installer.uninstall("claude", "workspace")).rejects.toThrow("will not remove");
		expect(await readFile(configFile, "utf8")).toBe(external);
	});

	it("reports invalid JSON without overwriting it", async () => {
		const configFile = join(workspaceRoot, ".mcp.json");
		await writeFile(configFile, "{ invalid json\n", "utf8");

		const installation = await installer.getInstallation("claude", "workspace");
		expect(installation).toEqual({ status: "invalid", configFile });
		await expect(installer.install("claude", "workspace")).rejects.toThrow("invalid JSON");
	});
});
