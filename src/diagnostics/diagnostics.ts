import { randomBytes } from "node:crypto";

export const diagnosticLevels = ["trace", "debug", "info", "warn", "error"] as const;
export type DiagnosticLevel = (typeof diagnosticLevels)[number];
export type DiagnosticConfiguredLevel = DiagnosticLevel | "off";

export const diagnosticAreas = [
	"lifecycle",
	"diagnostics",
	"reviewStore",
	"reviewState",
	"git",
	"commands",
	"webview"
] as const;
export type DiagnosticArea = (typeof diagnosticAreas)[number];
export type DiagnosticOrigin = "extensionHost" | "webview";
export type DiagnosticData = Readonly<Record<string, unknown>>;
export type DiagnosticDataFactory = () => DiagnosticData;

export interface DiagnosticError {
	readonly name: string;
	readonly message: string;
	readonly code?: string | number;
	readonly stack?: string;
}

export interface DiagnosticEvent {
	readonly version: 1;
	readonly sequence: number;
	readonly timestamp: string;
	readonly runId: string;
	readonly level: DiagnosticLevel;
	readonly origin: DiagnosticOrigin;
	readonly area: DiagnosticArea;
	readonly name: string;
	readonly correlationId?: string;
	readonly durationMs?: number;
	readonly data?: DiagnosticData;
	readonly error?: DiagnosticError;
}

export interface DiagnosticConfig {
	readonly level: DiagnosticConfiguredLevel;
	readonly areas: ReadonlySet<DiagnosticArea>;
	readonly artifactDirectory: string;
	readonly artifactFileName: string;
	readonly retentionCount: number;
	readonly warnings: readonly string[];
}

export interface DiagnosticSink {
	readonly id: string;
	emit(event: DiagnosticEvent): void | Promise<void>;
	flush?(): Promise<void>;
	close?(): Promise<void>;
}

export interface DiagnosticOperation {
	readonly correlationId: string | undefined;
	complete(data?: DiagnosticDataFactory): void;
	fail(error: unknown, data?: DiagnosticDataFactory): void;
}

export interface DiagnosticEventOptions {
	readonly origin?: DiagnosticOrigin;
	readonly correlationId?: string;
	readonly durationMs?: number;
	readonly error?: unknown;
	readonly data?: DiagnosticDataFactory;
}

const levelRank: Readonly<Record<DiagnosticLevel, number>> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4
};

export class DiagnosticsRecorder {
	private sequence = 0;
	private closed = false;
	private readonly disabledSinks = new Set<DiagnosticSink>();

	constructor(
		readonly runId: string,
		private readonly config: DiagnosticConfig,
		private readonly sinks: readonly DiagnosticSink[]
	) {}

	isEnabled(level: DiagnosticLevel, area: DiagnosticArea): boolean {
		return (
			!this.closed &&
			this.config.level !== "off" &&
			levelRank[level] >= levelRank[this.config.level] &&
			this.config.areas.has(area)
		);
	}

	trace(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.record("trace", area, name, { data });
	}

	debug(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.record("debug", area, name, { data });
	}

	info(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.record("info", area, name, { data });
	}

	warn(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.record("warn", area, name, { data });
	}

	error(area: DiagnosticArea, name: string, error: unknown, data?: DiagnosticDataFactory): void {
		this.record("error", area, name, { error, data });
	}

	record(level: DiagnosticLevel, area: DiagnosticArea, name: string, options: DiagnosticEventOptions = {}): void {
		if (!this.isEnabled(level, area)) {
			return;
		}

		let data: DiagnosticData | undefined;
		try {
			data = options.data ? sanitizeDiagnosticData(options.data()) : undefined;
		} catch (error) {
			data = { payloadFactoryError: sanitizeError(error).message };
		}

		const event = boundEvent({
			version: 1,
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			runId: this.runId,
			level,
			origin: options.origin ?? "extensionHost",
			area,
			name: sanitizeEventName(name),
			correlationId: options.correlationId ? sanitizeString(options.correlationId) : undefined,
			durationMs: normalizeDuration(options.durationMs),
			data,
			error: options.error === undefined ? undefined : sanitizeError(options.error)
		});
		this.emitToSinks(event);
	}

	startOperation(
		area: DiagnosticArea,
		name: string,
		data?: DiagnosticDataFactory,
		origin: DiagnosticOrigin = "extensionHost",
		correlationId?: string
	): DiagnosticOperation {
		if (!this.isEnabled("info", area) && !this.isEnabled("error", area)) {
			return disabledOperation;
		}

		const operationCorrelationId = correlationId ?? createCorrelationId();
		const startedAt = process.hrtime.bigint();
		let completed = false;
		this.record("info", area, `${name}.started`, { origin, correlationId: operationCorrelationId, data });
		return {
			correlationId: operationCorrelationId,
			complete: (completionData) => {
				if (completed) {
					return;
				}
				completed = true;
				this.record("info", area, `${name}.completed`, {
					origin,
					correlationId: operationCorrelationId,
					durationMs: elapsedMilliseconds(startedAt),
					data: completionData
				});
			},
			fail: (error, failureData) => {
				if (completed) {
					return;
				}
				completed = true;
				this.record("error", area, `${name}.failed`, {
					origin,
					correlationId: operationCorrelationId,
					durationMs: elapsedMilliseconds(startedAt),
					error,
					data: failureData
				});
			}
		};
	}

	systemWarning(name: string, data?: DiagnosticDataFactory): void {
		if (this.closed) {
			return;
		}
		let sanitizedData: DiagnosticData | undefined;
		try {
			sanitizedData = data ? sanitizeDiagnosticData(data()) : undefined;
		} catch (error) {
			sanitizedData = { payloadFactoryError: sanitizeError(error).message };
		}
		const event = boundEvent({
			version: 1,
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			runId: this.runId,
			level: "warn",
			origin: "extensionHost",
			area: "diagnostics",
			name: sanitizeEventName(name),
			data: sanitizedData
		});
		this.emitToSinks(event);
	}

	async flush(): Promise<void> {
		await Promise.all(this.sinks.map((sink) => this.callSink(sink, "flush")));
	}

	async close(): Promise<void> {
		if (this.closed) {
			return;
		}
		await this.flush();
		this.closed = true;
		await Promise.all(this.sinks.map((sink) => this.callSink(sink, "close")));
	}

	private emitToSinks(event: DiagnosticEvent): void {
		const synchronousFailures: { sink: DiagnosticSink; error: unknown }[] = [];
		for (const sink of this.sinks) {
			if (this.disabledSinks.has(sink)) {
				continue;
			}
			try {
				const result = sink.emit(event);
				if (result) {
					void result.catch((error: unknown) => this.disableSink(sink, error));
				}
			} catch (error) {
				synchronousFailures.push({ sink, error });
			}
		}
		for (const failure of synchronousFailures) {
			this.disableSink(failure.sink, failure.error);
		}
	}

	private disableSink(sink: DiagnosticSink, error: unknown): void {
		if (this.disabledSinks.has(sink)) {
			return;
		}
		this.disabledSinks.add(sink);
		const warning = boundEvent({
			version: 1,
			sequence: ++this.sequence,
			timestamp: new Date().toISOString(),
			runId: this.runId,
			level: "warn",
			origin: "extensionHost",
			area: "diagnostics",
			name: "sink.disabled",
			data: { sink: sink.id, reason: sanitizeError(error).message }
		});

		for (const otherSink of this.sinks) {
			if (otherSink === sink || this.disabledSinks.has(otherSink)) {
				continue;
			}
			try {
				const result = otherSink.emit(warning);
				if (result) {
					void result.catch(() => this.disabledSinks.add(otherSink));
				}
			} catch {
				this.disabledSinks.add(otherSink);
			}
		}
	}

	private async callSink(sink: DiagnosticSink, method: "flush" | "close"): Promise<void> {
		try {
			await sink[method]?.();
		} catch (error) {
			this.disableSink(sink, error);
		}
	}
}

const disabledOperation: DiagnosticOperation = {
	correlationId: undefined,
	complete: () => undefined,
	fail: () => undefined
};

const sensitiveKeyPattern = /(?:auth|body|content|cookie|credential|document|env|password|secret|token)/iu;
const maxDepth = 6;
const maxEntries = 50;
const maxStringLength = 4 * 1024;
const maxEventBytes = 64 * 1024;

export function sanitizeDiagnosticData(data: DiagnosticData): DiagnosticData {
	return sanitizeValue(data, 0, new WeakSet<object>()) as DiagnosticData;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || value === undefined || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return sanitizeString(value);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : String(value);
	}
	if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
		return String(value);
	}
	if (depth >= maxDepth) {
		return "[max-depth]";
	}
	if (value instanceof Error) {
		return sanitizeError(value);
	}
	if (seen.has(value as object)) {
		return "[circular]";
	}
	seen.add(value as object);
	try {
		if (Array.isArray(value)) {
			const result = value.slice(0, maxEntries).map((entry) => sanitizeValue(entry, depth + 1, seen));
			if (value.length > maxEntries) {
				result.push(`[${value.length - maxEntries} more entries]`);
			}
			return result;
		}

		const result: Record<string, unknown> = {};
		const entries = Object.entries(value as Record<string, unknown>);
		for (const [key, entry] of entries.slice(0, maxEntries)) {
			result[key] = sensitiveKeyPattern.test(key) ? "[redacted]" : sanitizeValue(entry, depth + 1, seen);
		}
		if (entries.length > maxEntries) {
			result.truncatedEntries = entries.length - maxEntries;
		}
		return result;
	} finally {
		seen.delete(value as object);
	}
}

function sanitizeError(error: unknown): DiagnosticError {
	if (error instanceof Error) {
		const errorWithCode = error as Error & { code?: unknown };
		const code =
			typeof errorWithCode.code === "string" || typeof errorWithCode.code === "number"
				? errorWithCode.code
				: undefined;
		return {
			name: sanitizeString(error.name),
			message: sanitizeString(error.message),
			code,
			stack: error.stack ? sanitizeString(error.stack) : undefined
		};
	}
	return { name: "Error", message: sanitizeString(String(error)) };
}

function sanitizeString(value: string): string {
	const withoutPaths = value
		.replace(/file:\/\/\/?[^\s)]+/giu, "<path>")
		.replace(/(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s)]+/gu, "<path>");
	return withoutPaths.length <= maxStringLength
		? withoutPaths
		: `${withoutPaths.slice(0, maxStringLength)}[truncated]`;
}

function sanitizeEventName(name: string): string {
	const normalized = name.replace(/[^a-zA-Z0-9._-]/gu, "_");
	return normalized.slice(0, 160) || "unnamed";
}

function normalizeDuration(durationMs: number | undefined): number | undefined {
	return durationMs === undefined || !Number.isFinite(durationMs) ? undefined : Math.max(0, Math.round(durationMs));
}

function boundEvent(event: DiagnosticEvent): DiagnosticEvent {
	if (Buffer.byteLength(JSON.stringify(event), "utf8") <= maxEventBytes) {
		return event;
	}
	return { ...event, data: { truncated: true, reason: "event-size-limit" } };
}

function createCorrelationId(): string {
	return randomBytes(4).toString("hex");
}

function elapsedMilliseconds(startedAt: bigint): number {
	return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
