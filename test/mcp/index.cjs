const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtemp, mkdir, realpath, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function run() {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "requestchanges-mcp-smoke-"));
	const workspace = join(temporaryDirectory, "workspace");
	const dataDirectory = join(temporaryDirectory, "data");
	await mkdir(workspace);
	const canonicalWorkspace = await realpath(workspace);
	const workspaceKey = createHash("sha256").update(canonicalWorkspace).digest("hex").slice(0, 24);
	const ledgerDirectory = join(dataDirectory, "workspaces", workspaceKey);
	await mkdir(ledgerDirectory, { recursive: true });
	await writeFile(
		join(ledgerDirectory, "review-state.json"),
		`${JSON.stringify({
			version: 4,
			revision: 0,
			workspace: { root: canonicalWorkspace, name: "workspace" },
			comments: [createComment()],
			effectiveInstructions: "Keep the public API stable.",
			selectedTarget: "codex",
			updatedAt: "2026-07-15T00:00:00.000Z"
		})}\n`,
		"utf8"
	);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			join(__dirname, "..", "..", "out", "requestchanges-mcp.js"),
			"--workspace",
			workspace,
			"--data-dir",
			dataDirectory,
			"--client",
			"smoke test"
		],
		stderr: "pipe"
	});
	const client = new Client({ name: "requestchanges-smoke", version: "1.0.0" });
	try {
		await client.connect(transport);
		assert.equal(client.getServerVersion()?.name, "requestchanges");
		assert.equal(client.getServerVersion()?.version, require("../../package.json").version);
		const tools = await client.listTools();
		assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
			"claim_review_comments",
			"complete_review_comments",
			"get_review_status",
			"requestchanges"
		]);
		const context = await client.callTool({ name: "requestchanges", arguments: {} });
		assert.equal(context.isError, undefined);
		assert.match(context.content[0].text, /"commentCount": 1/);
		assert.match(context.content[0].text, /"version": 1/);
		assert.match(context.content[0].text, /Keep the public API stable/);
		const emptyClaim = await client.callTool({
			name: "claim_review_comments",
			arguments: { comments: [] }
		});
		assert.equal(emptyClaim.isError, true);
		const claim = await client.callTool({
			name: "claim_review_comments",
			arguments: { comments: [{ commentId: "RC-1", expectedVersion: 1 }] }
		});
		const claimResult = JSON.parse(claim.content[0].text).results[0];
		assert.equal(claimResult.accepted, true);
		await client.callTool({
			name: "complete_review_comments",
			arguments: {
				results: [
					{
						commentId: "RC-1",
						expectedVersion: 1,
						claimToken: claimResult.claimToken,
						outcome: "resolved",
						summary: "Kept the exported signature stable.",
						changedFiles: ["src/index.ts"],
						verification: "npm test"
					}
				]
			}
		});
		const status = await client.callTool({ name: "get_review_status", arguments: {} });
		assert.match(status.content[0].text, /"resolved": 1/);
		const prompt = await client.getPrompt({ name: "resolve_review_comments", arguments: {} });
		assert.match(prompt.messages[0].content.text, /Use the requestchanges tool/);
		assert.match(prompt.messages[0].content.text, /summary of each individual comment/);
		const resource = await client.readResource({ uri: "requestchanges://comments/open" });
		assert.match(resource.contents[0].text, /"commentCount": 0/);
		console.log("Request Changes MCP smoke test passed");
	} finally {
		await client.close();
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

function createComment() {
	return {
		id: "RC-1",
		version: 1,
		body: "Do not change the public signature.",
		intent: "change",
		status: "open",
		anchorState: "orphaned",
		createdAt: "2026-07-15T00:00:00.000Z",
		updatedAt: "2026-07-15T00:00:00.000Z"
	};
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
