const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
	const extension = vscode.extensions.getExtension("aaskhan.aireview");
	assert.ok(extension, "Expected the extension under test to be installed");

	await extension.activate();
	assert.equal(extension.isActive, true);

	const commands = await vscode.commands.getCommands(true);
	assert.ok(commands.includes("aireview.openReviewPanel"));
	await vscode.commands.executeCommand("aireview.openReviewPanel");

	console.log("AI Review Extension Host smoke test passed");
}

module.exports = { run };
