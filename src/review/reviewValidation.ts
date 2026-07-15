import type {
	DeleteReviewNoteParams,
	ReviewAnchor,
	ReviewNote,
	ReviewNoteIdParams,
	ReviewNoteKind,
	ReviewNoteStatus,
	ReviewRange,
	UpdateReviewNoteParams
} from "../common/reviewProtocol";

const noteKinds: readonly ReviewNoteKind[] = ["change", "question", "explain", "test"];
const noteStatuses: readonly ReviewNoteStatus[] = ["draft", "in_progress", "addressed", "blocked", "resolved"];

export function normalizeUpdateReviewNoteParams(value: unknown): UpdateReviewNoteParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected review note parameters");
	}
	const params = value as Partial<UpdateReviewNoteParams>;
	if (!isNonEmptyString(params.id)) {
		throw new Error("Review note id is required");
	}
	const body = params.body === undefined ? undefined : params.body.trim();
	if (body !== undefined && body.length === 0) {
		throw new Error("Review note body is required");
	}
	return {
		id: params.id,
		body,
		kind: isReviewNoteKind(params.kind) ? params.kind : undefined,
		status: isReviewNoteStatus(params.status) ? params.status : undefined,
		resolution: params.resolution
	};
}

export function normalizeDeleteReviewNoteParams(value: unknown): DeleteReviewNoteParams {
	return normalizeReviewNoteIdParams(value);
}

export function normalizeReviewNoteIdParams(value: unknown): ReviewNoteIdParams {
	if (!value || typeof value !== "object" || !isNonEmptyString((value as Partial<ReviewNoteIdParams>).id)) {
		throw new Error("Review note id is required");
	}
	return { id: (value as ReviewNoteIdParams).id };
}

export function isReviewNote(value: unknown): value is ReviewNote {
	if (!value || typeof value !== "object") {
		return false;
	}
	const note = value as Partial<ReviewNote>;
	return (
		isNonEmptyString(note.id) &&
		isNonEmptyString(note.body) &&
		isReviewNoteKind(note.kind) &&
		isReviewNoteStatus(note.status) &&
		(note.anchor === undefined || isReviewAnchor(note.anchor)) &&
		(note.anchorState === "attached" || note.anchorState === "moved" || note.anchorState === "orphaned") &&
		(note.resolution === undefined || isReviewResolution(note.resolution)) &&
		isNonEmptyString(note.createdAt) &&
		isNonEmptyString(note.updatedAt)
	);
}

function isReviewResolution(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const resolution = value as ReviewNote["resolution"];
	return Boolean(
		resolution &&
		isNonEmptyString(resolution.client) &&
		(resolution.summary === undefined || typeof resolution.summary === "string") &&
		Array.isArray(resolution.changedFiles) &&
		resolution.changedFiles.every((file) => typeof file === "string") &&
		(resolution.verification === undefined || typeof resolution.verification === "string") &&
		(resolution.blockedReason === undefined || typeof resolution.blockedReason === "string") &&
		isNonEmptyString(resolution.updatedAt)
	);
}

export function isReviewAnchor(value: unknown): value is ReviewAnchor {
	if (!value || typeof value !== "object") {
		return false;
	}
	const anchor = value as Partial<ReviewAnchor>;
	return (
		isNonEmptyString(anchor.uri) &&
		typeof anchor.filePath === "string" &&
		isReviewRange(anchor.range) &&
		typeof anchor.selectedText === "string" &&
		isNonEmptyString(anchor.selectedTextHash) &&
		typeof anchor.contextBefore === "string" &&
		typeof anchor.contextAfter === "string"
	);
}

export function isReviewRange(value: unknown): value is ReviewRange {
	if (!value || typeof value !== "object") {
		return false;
	}
	const range = value as Partial<ReviewRange>;
	return (
		isPositiveInteger(range.startLine) &&
		isPositiveInteger(range.startCharacter) &&
		isPositiveInteger(range.endLine) &&
		isPositiveInteger(range.endCharacter)
	);
}

export function isReviewNoteKind(value: unknown): value is ReviewNoteKind {
	return noteKinds.includes(value as ReviewNoteKind);
}

export function isReviewNoteStatus(value: unknown): value is ReviewNoteStatus {
	return noteStatuses.includes(value as ReviewNoteStatus);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
