import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, stat, unlink, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type * as vscode from "vscode";
import {
	diagnosticAreas,
	diagnosticLevels,
	type DiagnosticArea,
	type DiagnosticConfig,
	type DiagnosticConfiguredLevel,
	type DiagnosticEvent,
	type DiagnosticSink,
	DiagnosticsRecorder
} from "./diagnostics";

const defaultArtifactDirectory = ".artifacts";
const defaultArtifactFileName = "{runId}.ndjson";
const defaultRetentionCount = 20;

export interface CreateDiagnosticsRecorderOptions {
	readonly config: DiagnosticConfig;
	readonly outputChannel: vscode.LogOutputChannel;
	readonly extensionPath: string;
	readonly extensionVersion: string;
}

export function readDiagnosticsLaunchConfig(env: NodeJS.ProcessEnv): DiagnosticConfig {
	const warnings: string[] = [];
	const level = readLevel(env.REQUEST_CHANGES_LOG_LEVEL, warnings);
	const areas = readAreas(env.REQUEST_CHANGES_LOG_AREAS, warnings);
	const artifactDirectory = env.REQUEST_CHANGES_LOG_DIRECTORY?.trim() || defaultArtifactDirectory;
	const artifactFileName = readArtifactFileName(env.REQUEST_CHANGES_LOG_FILE, warnings);
	return {
		level,
		areas,
		artifactDirectory,
		artifactFileName,
		retentionCount: defaultRetentionCount,
		warnings
	};
}

export async function createDiagnosticsRecorder(
	options: CreateDiagnosticsRecorderOptions
): Promise<DiagnosticsRecorder> {
	const runId = createRunId();
	const sinks: DiagnosticSink[] = [new LogOutputChannelSink(options.outputChannel)];
	let artifactPath: string | undefined;
	let artifactError: unknown;

	if (options.config.level !== "off") {
		try {
			const directory = path.resolve(options.extensionPath, options.config.artifactDirectory);
			await mkdir(directory, { recursive: true });
			const fileName = renderArtifactFileName(options.config.artifactFileName, runId);
			artifactPath = path.join(directory, fileName);
			await pruneArtifacts(directory, options.config.artifactFileName, options.config.retentionCount - 1);
			sinks.push(await NdjsonFileSink.create(artifactPath));
		} catch (error) {
			artifactError = error;
		}
	}

	const recorder = new DiagnosticsRecorder(runId, options.config, sinks);
	for (const warning of options.config.warnings) {
		recorder.systemWarning("configuration.invalid", () => ({ warning }));
	}
	if (artifactError !== undefined) {
		recorder.systemWarning("artifactSink.unavailable", () => ({ error: artifactError }));
	}
	recorder.debug("diagnostics", "recorder.created", () => ({
		extensionVersion: options.extensionVersion,
		artifactPath,
		level: options.config.level,
		areas: [...options.config.areas]
	}));
	return recorder;
}

class LogOutputChannelSink implements DiagnosticSink {
	readonly id = "logOutputChannel";

	constructor(private readonly channel: vscode.LogOutputChannel) {}

	emit(event: DiagnosticEvent): void {
		const message = formatChannelEvent(event);
		this.channel[event.level](message);
	}

	close(): Promise<void> {
		return Promise.resolve();
	}
}

class NdjsonFileSink implements DiagnosticSink {
	readonly id = "ndjsonFile";
	private queue: Promise<void> = Promise.resolve();
	private failure: unknown;

	private constructor(private readonly handle: FileHandle) {}

	static async create(filePath: string): Promise<NdjsonFileSink> {
		return new NdjsonFileSink(await open(filePath, "wx"));
	}

	emit(event: DiagnosticEvent): Promise<void> {
		const line = `${JSON.stringify(event)}\n`;
		const write = this.queue.then(async () => {
			if (this.failure !== undefined) {
				throw this.failure;
			}
			try {
				await this.handle.writeFile(line, { encoding: "utf8" });
			} catch (error) {
				this.failure = error;
				throw error;
			}
		});
		this.queue = write.catch(() => undefined);
		return write;
	}

	async flush(): Promise<void> {
		await this.queue;
		await this.handle.sync();
	}

	async close(): Promise<void> {
		await this.queue;
		await this.handle.close();
	}
}

function readLevel(value: string | undefined, warnings: string[]): DiagnosticConfiguredLevel {
	if (!value?.trim()) {
		return "info";
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "off" || (diagnosticLevels as readonly string[]).includes(normalized)) {
		return normalized as DiagnosticConfiguredLevel;
	}
	warnings.push(`Unknown REQUEST_CHANGES_LOG_LEVEL '${value}'; using 'info'.`);
	return "info";
}

function readAreas(value: string | undefined, warnings: string[]): ReadonlySet<DiagnosticArea> {
	if (!value?.trim()) {
		return new Set(diagnosticAreas);
	}
	const lookup = new Map(diagnosticAreas.map((area) => [area.toLowerCase(), area]));
	const areas = new Set<DiagnosticArea>();
	for (const entry of value
		.split(",")
		.map((area) => area.trim())
		.filter(Boolean)) {
		const area = lookup.get(entry.toLowerCase());
		if (area) {
			areas.add(area);
		} else {
			warnings.push(`Unknown REQUEST_CHANGES_LOG_AREAS entry '${entry}'; ignoring it.`);
		}
	}
	return areas;
}

function readArtifactFileName(value: string | undefined, warnings: string[]): string {
	const fileName = value?.trim() || defaultArtifactFileName;
	if (path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
		warnings.push(`Invalid REQUEST_CHANGES_LOG_FILE '${fileName}'; using '${defaultArtifactFileName}'.`);
		return defaultArtifactFileName;
	}
	if (!fileName.toLowerCase().endsWith(".ndjson")) {
		warnings.push(`REQUEST_CHANGES_LOG_FILE must end in '.ndjson'; using '${defaultArtifactFileName}'.`);
		return defaultArtifactFileName;
	}
	return fileName;
}

function renderArtifactFileName(template: string, runId: string): string {
	const timestamp = runId.split("-")[1];
	let fileName = template
		.replaceAll("{runId}", runId)
		.replaceAll("{timestamp}", timestamp)
		.replaceAll("{pid}", String(process.pid));
	if (!template.includes("{runId}")) {
		fileName = `${fileName.slice(0, -".ndjson".length)}-${runId}.ndjson`;
	}
	return fileName;
}

function createRunId(): string {
	const timestamp = new Date().toISOString().replace(/[-:]/gu, "").replace(".", "");
	return `requestchanges-${timestamp}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

async function pruneArtifacts(directory: string, fileNameTemplate: string, keepExisting: number): Promise<void> {
	const filePattern = artifactFilePattern(fileNameTemplate);
	const entries = await readdir(directory, { withFileTypes: true });
	const candidates = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && filePattern.test(entry.name))
			.map(async (entry) => ({
				path: path.join(directory, entry.name),
				modified: (await stat(path.join(directory, entry.name))).mtimeMs
			}))
	);
	candidates.sort((left, right) => right.modified - left.modified);
	await Promise.all(candidates.slice(Math.max(0, keepExisting)).map((candidate) => unlink(candidate.path)));
}

function artifactFilePattern(template: string): RegExp {
	const effectiveTemplate = template.includes("{runId}")
		? template
		: `${template.slice(0, -".ndjson".length)}-{runId}.ndjson`;
	const pattern = effectiveTemplate
		.split(/(\{runId\}|\{timestamp\}|\{pid\})/gu)
		.map((part) => {
			switch (part) {
				case "{runId}":
					return "requestchanges-.*";
				case "{timestamp}":
					return "[0-9TZ]+";
				case "{pid}":
					return "[0-9]+";
				default:
					return escapeRegExp(part);
			}
		})
		.join("");
	return new RegExp(`^${pattern}$`, "u");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function formatChannelEvent(event: DiagnosticEvent): string {
	const details: string[] = [];
	if (event.correlationId) {
		details.push(`correlation=${event.correlationId}`);
	}
	if (event.durationMs !== undefined) {
		details.push(`duration=${event.durationMs}ms`);
	}
	if (event.data) {
		for (const [key, value] of Object.entries(event.data)) {
			details.push(`${key}=${formatChannelValue(value)}`);
		}
	}
	if (event.error) {
		details.push(`error=${formatChannelValue(event.error.message)}`);
	}
	const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
	return `${event.timestamp} [${event.origin}] [${event.area}] ${event.name}${suffix}`;
}

function formatChannelValue(value: unknown): string {
	if (typeof value === "string" && /^[a-zA-Z0-9._:/@-]+$/u.test(value)) {
		return value;
	}
	return JSON.stringify(value);
}
