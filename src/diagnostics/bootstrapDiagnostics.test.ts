import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnosticsRecorder, readDiagnosticsLaunchConfig } from "./bootstrapDiagnostics";

describe("readDiagnosticsLaunchConfig", () => {
	it("uses the agreed defaults", () => {
		const config = readDiagnosticsLaunchConfig({});

		expect(config.level).toBe("info");
		expect([...config.areas]).toEqual([
			"lifecycle",
			"diagnostics",
			"reviewStore",
			"reviewState",
			"git",
			"commands",
			"webview"
		]);
		expect(config.artifactDirectory).toBe(".artifacts");
		expect(config.artifactFileName).toBe("{runId}.ndjson");
		expect(config.retentionCount).toBe(20);
	});

	it("normalizes filters and rejects unsafe filenames", () => {
		const config = readDiagnosticsLaunchConfig({
			AIREVIEW_LOG_LEVEL: "DEBUG",
			AIREVIEW_LOG_AREAS: "git, reviewState, unknown",
			AIREVIEW_LOG_DIRECTORY: "logs",
			AIREVIEW_LOG_FILE: "../escape.ndjson"
		});

		expect(config.level).toBe("debug");
		expect([...config.areas]).toEqual(["git", "reviewState"]);
		expect(config.artifactDirectory).toBe("logs");
		expect(config.artifactFileName).toBe("{runId}.ndjson");
		expect(config.warnings).toHaveLength(2);
	});
});

describe("createDiagnosticsRecorder", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
	});

	it("writes configured NDJSON files with the same sequenced events shown in the channel", async () => {
		const extensionPath = await mkdtemp(path.join(tmpdir(), "aireview-diagnostics-"));
		temporaryDirectories.push(extensionPath);
		const channel = new FakeLogOutputChannel();
		const config = readDiagnosticsLaunchConfig({
			AIREVIEW_LOG_LEVEL: "debug",
			AIREVIEW_LOG_DIRECTORY: "diagnostic-output",
			AIREVIEW_LOG_FILE: "custom-{runId}.ndjson"
		});
		const recorder = await createDiagnosticsRecorder({
			config,
			outputChannel: channel as unknown as vscode.LogOutputChannel,
			extensionPath,
			extensionVersion: "1.2.3"
		});

		recorder.info("lifecycle", "test.event", () => ({ body: "not persisted", count: 2 }));
		await recorder.close();

		const directory = path.join(extensionPath, "diagnostic-output");
		const files = await readdir(directory);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatch(/^custom-aireview-.*\.ndjson$/u);
		const events = (await readFile(path.join(directory, files[0]), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { sequence: number; name: string; data?: Record<string, unknown> });
		expect(events.map((event) => event.sequence)).toEqual([1, 2]);
		expect(events[1]).toMatchObject({ name: "test.event", data: { body: "[redacted]", count: 2 } });
		expect(channel.entries).toHaveLength(2);
	});

	it("retains only the newest twenty artifacts for a custom filename pattern", async () => {
		const extensionPath = await mkdtemp(path.join(tmpdir(), "aireview-retention-"));
		temporaryDirectories.push(extensionPath);
		const config = readDiagnosticsLaunchConfig({
			AIREVIEW_LOG_DIRECTORY: "diagnostic-output",
			AIREVIEW_LOG_FILE: "review-{timestamp}-{runId}.ndjson"
		});

		for (let index = 0; index < 22; index += 1) {
			const recorder = await createDiagnosticsRecorder({
				config,
				outputChannel: new FakeLogOutputChannel() as unknown as vscode.LogOutputChannel,
				extensionPath,
				extensionVersion: "1.2.3"
			});
			recorder.info("lifecycle", "retention.event", () => ({ index }));
			await recorder.close();
		}

		const files = await readdir(path.join(extensionPath, "diagnostic-output"));
		expect(files).toHaveLength(20);
		expect(files.every((file) => /^review-[0-9TZ]+-aireview-.*\.ndjson$/u.test(file))).toBe(true);
	});
});

class FakeLogOutputChannel {
	readonly entries: { level: string; message: string }[] = [];

	trace(message: string): void {
		this.entries.push({ level: "trace", message });
	}

	debug(message: string): void {
		this.entries.push({ level: "debug", message });
	}

	info(message: string): void {
		this.entries.push({ level: "info", message });
	}

	warn(message: string): void {
		this.entries.push({ level: "warn", message });
	}

	error(message: string): void {
		this.entries.push({ level: "error", message });
	}
}
