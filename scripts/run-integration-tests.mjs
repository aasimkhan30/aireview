import path from "node:path";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationDataDirectory = path.join(repositoryRoot, ".artifacts", "integration-data");

// VS Code-launched terminals inherit this flag, which would make the downloaded
// Electron binary run as Node instead of starting the Extension Host.
delete process.env.ELECTRON_RUN_AS_NODE;
process.env.AIREVIEW_DATA_DIR = integrationDataDirectory;

try {
	await rm(integrationDataDirectory, { recursive: true, force: true });
	await runTests({
		version: "1.125.0",
		extensionDevelopmentPath: repositoryRoot,
		extensionTestsPath: path.join(repositoryRoot, "test", "integration", "index.cjs"),
		launchArgs: ["--disable-extensions"]
	});
} catch (error) {
	console.error("VS Code Extension Host smoke test failed", error);
	process.exitCode = 1;
} finally {
	await rm(integrationDataDirectory, { recursive: true, force: true });
}
