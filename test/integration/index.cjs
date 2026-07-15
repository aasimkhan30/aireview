const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
	const extension = vscode.extensions.getExtension("aaskhan.aireview");
	assert.ok(extension, "Expected the extension under test to be installed");

	await extension.activate();
	assert.equal(extension.isActive, true);

	const commands = await vscode.commands.getCommands(true);
	assert.ok(commands.includes("aireview.openReviewPanel"));
	assert.ok(commands.includes("aireview.addReviewNote"));
	assert.ok(commands.includes("aireview.openSettings"));
	assert.ok(vscode.lm.tools.some((tool) => tool.name === "aireview"));
	const toolResult = await vscode.lm.invokeTool("aireview", { input: {} });
	assert.match(toolResult.content[0].value, /"notes": \[\]/);

	const document = await vscode.workspace.openTextDocument(
		vscode.Uri.joinPath(extension.extensionUri, "src", "extension.ts")
	);
	const editor = await vscode.window.showTextDocument(document);
	editor.selection = new vscode.Selection(0, 0, 0, Math.min(20, document.lineAt(0).text.length));
	await vscode.commands.executeCommand("aireview.addReviewNote");
	await vscode.commands.executeCommand("aireview.openReviewPanel");
	await vscode.commands.executeCommand("aireview.openSettings");
	await new Promise((resolve) => setTimeout(resolve, 300));

	console.log("AI Review Extension Host smoke test passed");
}

module.exports = { run };
