import { createServiceIdentifier } from "../util/di";
import {
	type DiagnosticArea,
	type DiagnosticDataFactory,
	type DiagnosticEventOptions,
	type DiagnosticLevel,
	type DiagnosticOperation,
	DiagnosticsRecorder
} from "./diagnostics";

export const IDiagnosticsService = createServiceIdentifier<IDiagnosticsService>("diagnosticsService");

export interface IDiagnosticsService {
	readonly _serviceBrand: undefined;
	isEnabled(level: DiagnosticLevel, area: DiagnosticArea): boolean;
	trace(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void;
	debug(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void;
	info(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void;
	warn(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void;
	error(area: DiagnosticArea, name: string, error: unknown, data?: DiagnosticDataFactory): void;
	record(level: DiagnosticLevel, area: DiagnosticArea, name: string, options?: DiagnosticEventOptions): void;
	startOperation(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): DiagnosticOperation;
}

export class DiagnosticsServiceAdapter implements IDiagnosticsService {
	declare readonly _serviceBrand: undefined;

	constructor(private readonly recorder: DiagnosticsRecorder) {}

	isEnabled(level: DiagnosticLevel, area: DiagnosticArea): boolean {
		return this.recorder.isEnabled(level, area);
	}

	trace(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.recorder.trace(area, name, data);
	}

	debug(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.recorder.debug(area, name, data);
	}

	info(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.recorder.info(area, name, data);
	}

	warn(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): void {
		this.recorder.warn(area, name, data);
	}

	error(area: DiagnosticArea, name: string, error: unknown, data?: DiagnosticDataFactory): void {
		this.recorder.error(area, name, error, data);
	}

	record(level: DiagnosticLevel, area: DiagnosticArea, name: string, options?: DiagnosticEventOptions): void {
		this.recorder.record(level, area, name, options);
	}

	startOperation(area: DiagnosticArea, name: string, data?: DiagnosticDataFactory): DiagnosticOperation {
		return this.recorder.startOperation(area, name, data);
	}
}
