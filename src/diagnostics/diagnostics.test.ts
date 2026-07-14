import { describe, expect, it } from "vitest";
import {
	type DiagnosticConfig,
	type DiagnosticEvent,
	type DiagnosticSink,
	DiagnosticsRecorder,
	sanitizeDiagnosticData
} from "./diagnostics";

describe("DiagnosticsRecorder", () => {
	it("filters before constructing lazy payloads and sends one event to both sinks", () => {
		const first = new CapturingSink("first");
		const second = new CapturingSink("second");
		const recorder = new DiagnosticsRecorder("run", config({ level: "info" }), [first, second]);
		let payloadCalls = 0;

		recorder.debug("lifecycle", "not.captured", () => {
			payloadCalls += 1;
			return { ignored: true };
		});
		recorder.info("lifecycle", "captured", () => {
			payloadCalls += 1;
			return { value: 42 };
		});

		expect(payloadCalls).toBe(1);
		expect(first.events).toHaveLength(1);
		expect(second.events).toHaveLength(1);
		expect(first.events[0]).toBe(second.events[0]);
		expect(first.events[0]).toMatchObject({ sequence: 1, name: "captured", data: { value: 42 } });
	});

	it("uses one correlation id and completes an operation once", () => {
		const sink = new CapturingSink("capture");
		const recorder = new DiagnosticsRecorder("run", config(), [sink]);
		const operation = recorder.startOperation("reviewState", "refresh");

		operation.complete(() => ({ revision: 3 }));
		operation.fail(new Error("late"));

		expect(sink.events.map((event) => event.name)).toEqual(["refresh.started", "refresh.completed"]);
		expect(sink.events[0].correlationId).toBe(operation.correlationId);
		expect(sink.events[1]).toMatchObject({ correlationId: operation.correlationId, data: { revision: 3 } });
		expect(sink.events[1].durationMs).toBeTypeOf("number");
	});

	it("isolates a failed sink and warns the remaining sink without recursion", () => {
		const failed = new ThrowingSink();
		const capture = new CapturingSink("capture");
		const recorder = new DiagnosticsRecorder("run", config(), [failed, capture]);

		recorder.info("lifecycle", "first");
		recorder.info("lifecycle", "second");

		expect(failed.calls).toBe(1);
		expect(capture.events.map((event) => event.name)).toEqual(["first", "sink.disabled", "second"]);
	});

	it("records operation failures when the configured level is error", () => {
		const sink = new CapturingSink("capture");
		const recorder = new DiagnosticsRecorder("run", config({ level: "error" }), [sink]);
		const operation = recorder.startOperation("reviewState", "refresh", () => {
			throw new Error("the start payload must stay lazy");
		});

		operation.fail(new Error("refresh failed"));

		expect(sink.events).toHaveLength(1);
		expect(sink.events[0]).toMatchObject({ name: "refresh.failed", level: "error" });
	});
});

describe("sanitizeDiagnosticData", () => {
	it("redacts sensitive keys, bounds collections, handles cycles, and removes absolute user paths", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const data = sanitizeDiagnosticData({
			token: "secret",
			noteBody: "private review text",
			path: "/Users/example/private/repository/file.ts",
			long: "x".repeat(5_000),
			many: Array.from({ length: 60 }, (_, index) => index),
			circular
		});

		expect(data.token).toBe("[redacted]");
		expect(data.noteBody).toBe("[redacted]");
		expect(data.path).toBe("<path>");
		expect(String(data.long)).toContain("[truncated]");
		expect(data.many).toHaveLength(51);
		expect(data.circular).toEqual({ self: "[circular]" });
	});
});

class CapturingSink implements DiagnosticSink {
	readonly events: DiagnosticEvent[] = [];

	constructor(readonly id: string) {}

	emit(event: DiagnosticEvent): void {
		this.events.push(event);
	}
}

class ThrowingSink implements DiagnosticSink {
	readonly id = "failed";
	calls = 0;

	emit(): void {
		this.calls += 1;
		throw new Error("sink failure");
	}
}

function config(overrides: Partial<DiagnosticConfig> = {}): DiagnosticConfig {
	return {
		level: "trace",
		areas: new Set(["lifecycle", "diagnostics", "reviewState"]),
		artifactDirectory: ".artifacts",
		artifactFileName: "{runId}.ndjson",
		retentionCount: 20,
		warnings: [],
		...overrides
	};
}
