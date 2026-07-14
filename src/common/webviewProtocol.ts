export const rpcEnvelopeKind = "aireview.jsonrpc";

export interface RpcEnvelope {
	readonly kind: typeof rpcEnvelopeKind;
	readonly payload: unknown;
}

export interface StateEnvelope<T> {
	readonly sourceId: string;
	readonly revision: number;
	readonly value: T;
}

export function isRpcEnvelope(value: unknown): value is RpcEnvelope {
	return Boolean(
		value &&
		typeof value === "object" &&
		(value as Partial<RpcEnvelope>).kind === rpcEnvelopeKind &&
		"payload" in value
	);
}

export function shouldAcceptStateEnvelope<T>(current: StateEnvelope<T> | undefined, next: StateEnvelope<T>): boolean {
	return !current || current.sourceId !== next.sourceId || next.revision > current.revision;
}
