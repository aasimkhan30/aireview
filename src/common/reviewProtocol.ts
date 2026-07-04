export const rpcEnvelopeKind = "aireview.jsonrpc";

export const ReviewRpc = {
	getState: "aireview.review.getState",
	addNote: "aireview.review.addNote",
	deleteNote: "aireview.review.deleteNote",
	stateChanged: "aireview.review.stateChanged"
} as const;

export interface RpcEnvelope {
	readonly kind: typeof rpcEnvelopeKind;
	readonly payload: unknown;
}

export interface ReviewPanelState {
	readonly workspace: WorkspaceSnapshot;
	readonly notes: readonly ReviewNote[];
	readonly agentTargets: readonly AgentTarget[];
}

export interface WorkspaceSnapshot {
	readonly name: string;
	readonly uri: string | undefined;
	readonly branch: string | undefined;
	readonly activeFile: ActiveFileSnapshot | undefined;
}

export interface ActiveFileSnapshot {
	readonly filePath: string;
	readonly uri: string;
	readonly selection: ReviewRange | undefined;
}

export interface ReviewRange {
	readonly startLine: number;
	readonly startCharacter: number;
	readonly endLine: number;
	readonly endCharacter: number;
}

export interface ReviewNote {
	readonly id: string;
	readonly body: string;
	readonly filePath: string | undefined;
	readonly line: number | undefined;
	readonly range: ReviewRange | undefined;
	readonly createdAt: string;
}

export interface AddReviewNoteParams {
	readonly body: string;
	readonly filePath?: string;
	readonly line?: number;
	readonly range?: ReviewRange;
}

export interface DeleteReviewNoteParams {
	readonly id: string;
}

export interface AgentTarget {
	readonly id: "codex" | "copilot";
	readonly label: string;
	readonly available: boolean;
	readonly detail: string;
}

export function isRpcEnvelope(value: unknown): value is RpcEnvelope {
	return Boolean(
		value
		&& typeof value === "object"
		&& (value as Partial<RpcEnvelope>).kind === rpcEnvelopeKind
		&& "payload" in value
	);
}
