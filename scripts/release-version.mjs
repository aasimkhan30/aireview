import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function getPreviewVersion(date) {
	if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
		throw new Error("A valid preview timestamp is required");
	}
	const datePart = [
		String(date.getUTCFullYear()).padStart(4, "0"),
		String(date.getUTCMonth() + 1).padStart(2, "0"),
		String(date.getUTCDate()).padStart(2, "0")
	].join("");
	const timePart = [
		String(date.getUTCHours()).padStart(2, "0"),
		String(date.getUTCMinutes()).padStart(2, "0"),
		String(date.getUTCSeconds()).padStart(2, "0")
	].join("");
	return `${datePart}.${timePart}.0`;
}

export function getNextStableVersion(currentVersion) {
	const { patch } = parseStableVersion(currentVersion);
	return `0.0.${patch + 1}`;
}

function parseStableVersion(version) {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
	if (!match) {
		throw new Error(`Expected a major.minor.patch version, received ${version}`);
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (major !== 0 || minor !== 0) {
		throw new Error(`Stable versions must remain on the 0.0.x line, received ${version}`);
	}
	return { patch };
}

async function main() {
	const currentVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
	switch (process.argv[2]) {
		case "preview":
			process.stdout.write(`${getPreviewVersion(new Date())}\n`);
			break;
		case "stable":
			process.stdout.write(`${getNextStableVersion(currentVersion)}\n`);
			break;
		default:
			throw new Error("Usage: node scripts/release-version.mjs <preview|stable>");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
