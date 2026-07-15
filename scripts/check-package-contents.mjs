import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vsceCli = fileURLToPath(new URL("../node_modules/@vscode/vsce/vsce", import.meta.url));
const output = execFileSync(process.execPath, [vsceCli, "ls"], {
	cwd: fileURLToPath(new URL("..", import.meta.url)),
	encoding: "utf8"
});

process.stdout.write(output);

const packagedFiles = new Set(output.split(/\r?\n/u).filter(Boolean));
const requiredFiles = [
	"License.txt",
	"media/icon.png",
	"media/reviewPanel.css",
	"media/reviewPanel.js",
	"media/settings.css",
	"media/settings.js",
	"out/requestchanges-mcp.js",
	"out/extension.js",
	"package.json"
];
const missingFiles = requiredFiles.filter((file) => !packagedFiles.has(file));

if (missingFiles.length > 0) {
	throw new Error(`VSIX is missing required files: ${missingFiles.join(", ")}`);
}
