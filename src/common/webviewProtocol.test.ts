import { describe, expect, it } from "vitest";
import { normalizeWebviewDiagnosticInput } from "./diagnosticsProtocol";
import { isRpcEnvelope, rpcEnvelopeKind, shouldAcceptStateEnvelope, type StateEnvelope } from "./webviewProtocol";

describe("isRpcEnvelope", () => {
	it("accepts the project envelope kind with any explicit payload", () => {
		expect(isRpcEnvelope({ kind: rpcEnvelopeKind, payload: undefined })).toBe(true);
		expect(isRpcEnvelope({ kind: rpcEnvelopeKind, payload: { jsonrpc: "2.0" } })).toBe(true);
	});

	it.each([
		null,
		undefined,
		"requestchanges.jsonrpc",
		{},
		{ kind: rpcEnvelopeKind },
		{ kind: "another-envelope", payload: {} }
	])("rejects malformed input %#", (value) => {
		expect(isRpcEnvelope(value)).toBe(false);
	});
});

describe("shouldAcceptStateEnvelope", () => {
	const state = (sourceId: string, revision: number): StateEnvelope<string> => ({
		sourceId,
		revision,
		value: `${sourceId}:${revision}`
	});

	it("accepts the first state and higher revisions from the same source", () => {
		expect(shouldAcceptStateEnvelope(undefined, state("host-a", 1))).toBe(true);
		expect(shouldAcceptStateEnvelope(state("host-a", 1), state("host-a", 2))).toBe(true);
	});

	it("rejects duplicate and stale revisions from the same source", () => {
		expect(shouldAcceptStateEnvelope(state("host-a", 2), state("host-a", 2))).toBe(false);
		expect(shouldAcceptStateEnvelope(state("host-a", 2), state("host-a", 1))).toBe(false);
	});

	it("accepts a new extension-host source even when its revision restarts", () => {
		expect(shouldAcceptStateEnvelope(state("host-a", 42), state("host-b", 1))).toBe(true);
	});
});

describe("normalizeWebviewDiagnosticInput", () => {
	it("accepts known events and strips unrecognized data", () => {
		expect(
			normalizeWebviewDiagnosticInput({
				level: "info",
				name: "state.load.completed",
				correlationId: "abc123",
				durationMs: 12.5,
				data: { revision: 4, noteCount: 2, body: "must not cross the boundary" }
			})
		).toEqual({
			level: "info",
			name: "state.load.completed",
			correlationId: "abc123",
			durationMs: 12.5,
			data: { revision: 4, noteCount: 2, hasActiveFile: undefined, errorName: undefined, errorMessage: undefined }
		});
	});

	it("rejects unknown event names and levels", () => {
		expect(normalizeWebviewDiagnosticInput({ level: "trace", name: "state.load.completed" })).toBeUndefined();
		expect(normalizeWebviewDiagnosticInput({ level: "info", name: "arbitrary.event" })).toBeUndefined();
	});
});
