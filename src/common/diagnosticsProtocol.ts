import { NotificationType } from "vscode-jsonrpc";

export const webviewDiagnosticLevels = ["debug", "info", "warn", "error"] as const;
export type WebviewDiagnosticLevel = (typeof webviewDiagnosticLevels)[number];

export const webviewDiagnosticNames = [
	"ui.mounted",
	"ui.unmounted",
	"state.changed",
	"state.load.started",
	"state.load.completed",
	"state.load.failed",
	"state.refresh.started",
	"state.refresh.completed",
	"state.refresh.failed",
	"annotation.start.started",
	"annotation.start.completed",
	"annotation.start.failed",
	"note.update.started",
	"note.update.completed",
	"note.update.failed",
	"note.delete.started",
	"note.delete.completed",
	"note.delete.failed",
	"note.reveal.started",
	"note.reveal.completed",
	"note.reveal.failed",
	"instructions.update.started",
	"instructions.update.completed",
	"instructions.update.failed",
	"bundle.preview.started",
	"bundle.preview.completed",
	"bundle.preview.failed",
	"bundle.copy.started",
	"bundle.copy.completed",
	"bundle.copy.failed"
] as const;
export type WebviewDiagnosticName = (typeof webviewDiagnosticNames)[number];

export interface WebviewDiagnosticData {
	readonly revision?: number;
	readonly noteCount?: number;
	readonly hasActiveFile?: boolean;
	readonly errorName?: string;
	readonly errorMessage?: string;
}

export interface WebviewDiagnosticInput {
	readonly level: WebviewDiagnosticLevel;
	readonly name: WebviewDiagnosticName;
	readonly correlationId?: string;
	readonly durationMs?: number;
	readonly data?: WebviewDiagnosticData;
}

export const DiagnosticsRpc = {
	report: new NotificationType<WebviewDiagnosticInput>("requestchanges.diagnostics.report")
} as const;

export function normalizeWebviewDiagnosticInput(value: unknown): WebviewDiagnosticInput | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const input = value as Partial<WebviewDiagnosticInput>;
	if (
		!webviewDiagnosticLevels.includes(input.level as WebviewDiagnosticLevel) ||
		!webviewDiagnosticNames.includes(input.name as WebviewDiagnosticName)
	) {
		return undefined;
	}

	const data = normalizeData(input.data);
	return {
		level: input.level as WebviewDiagnosticLevel,
		name: input.name as WebviewDiagnosticName,
		correlationId: normalizeString(input.correlationId, 64),
		durationMs: normalizeNonNegativeNumber(input.durationMs),
		data
	};
}

function normalizeData(value: unknown): WebviewDiagnosticData | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const data = value as WebviewDiagnosticData;
	const normalized: WebviewDiagnosticData = {
		revision: normalizeNonNegativeInteger(data.revision),
		noteCount: normalizeNonNegativeInteger(data.noteCount),
		hasActiveFile: typeof data.hasActiveFile === "boolean" ? data.hasActiveFile : undefined,
		errorName: normalizeString(data.errorName, 80),
		errorMessage: normalizeString(data.errorMessage, 512)
	};
	return Object.values(normalized).some((entry) => entry !== undefined) ? normalized : undefined;
}

function normalizeString(value: unknown, maximumLength: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, maximumLength) : undefined;
}

function normalizeNonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
