import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// VS Code-launched terminals inherit this flag, which would make the downloaded
// Electron binary run as Node instead of starting the Extension Host.
delete process.env.ELECTRON_RUN_AS_NODE;

try {
	await runTests({
		version: "1.92.0",
		extensionDevelopmentPath: repositoryRoot,
		extensionTestsPath: path.join(repositoryRoot, "test", "integration", "index.cjs"),
		launchArgs: ["--disable-extensions"]
	});
} catch (error) {
	console.error("VS Code Extension Host smoke test failed", error);
	process.exitCode = 1;
}
