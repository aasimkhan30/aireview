const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
	const extension = vscode.extensions.getExtension("aasimkhan30.request-changes");
	assert.ok(extension, "Expected the extension under test to be installed");

	await extension.activate();
	assert.equal(extension.isActive, true);

	const commands = await vscode.commands.getCommands(true);
	assert.ok(commands.includes("requestchanges.openReviewPanel"));
	assert.ok(commands.includes("requestchanges.addReviewComment"));
	assert.ok(commands.includes("requestchanges.openSettings"));
	assert.ok(vscode.lm.tools.some((tool) => tool.name === "requestchanges"));
	const toolResult = await vscode.lm.invokeTool("requestchanges", { input: {} });
	assert.match(toolResult.content[0].value, /"comments": \[\]/);

	const commentUri = vscode.Uri.from({
		scheme: "comment",
		authority: "requestchanges.comments",
		path: "/aasimkhan30.request-changes/commentinput-integration.md"
	});
	await vscode.workspace.openTextDocument(commentUri);
	const completions = await vscode.commands.executeCommand(
		"vscode.executeCompletionItemProvider",
		commentUri,
		new vscode.Position(0, 0)
	);
	const completionLabels = completions.items.map((item) =>
		typeof item.label === "string" ? item.label : item.label.label
	);
	assert.deepEqual(
		completionLabels.filter((label) => label.startsWith("#requestchanges:")),
		["#requestchanges:change", "#requestchanges:question", "#requestchanges:explain", "#requestchanges:addTest"]
	);

	const document = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(extension.extensionUri, "src", "extension.ts")
	);
	const editor = await vscode.window.showTextDocument(document);
	editor.selection = new vscode.Selection(0, 0, 0, Math.min(20, document.lineAt(0).text.length));
	await vscode.commands.executeCommand("requestchanges.addReviewComment");
	await vscode.commands.executeCommand("requestchanges.openReviewPanel");
	await vscode.commands.executeCommand("requestchanges.openSettings");
	await new Promise((resolve) => setTimeout(resolve, 300));

	console.log("Request Changes Extension Host smoke test passed");
}

module.exports = { run };
