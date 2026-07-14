import { describe, expect, it } from "vitest";
import { isRpcEnvelope, rpcEnvelopeKind } from "./reviewProtocol";

describe("isRpcEnvelope", () => {
	it("accepts the project envelope kind with any explicit payload", () => {
		expect(isRpcEnvelope({ kind: rpcEnvelopeKind, payload: undefined })).toBe(true);
		expect(isRpcEnvelope({ kind: rpcEnvelopeKind, payload: { jsonrpc: "2.0" } })).toBe(true);
	});

	it.each([
		null,
		undefined,
		"aireview.jsonrpc",
		{},
		{ kind: rpcEnvelopeKind },
		{ kind: "another-envelope", payload: {} }
	])("rejects malformed input %#", (value) => {
		expect(isRpcEnvelope(value)).toBe(false);
	});
});
