import type { AddReviewNoteParams, DeleteReviewNoteParams, ReviewNote, ReviewRange } from "../common/reviewProtocol";

export function normalizeAddReviewNoteParams(value: unknown): AddReviewNoteParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected review note parameters");
	}

	const params = value as Partial<AddReviewNoteParams>;
	if (typeof params.body !== "string" || params.body.trim().length === 0) {
		throw new Error("Review note body is required");
	}

	return {
		body: params.body.trim(),
		filePath: isNonEmptyString(params.filePath) ? params.filePath : undefined,
		line: isPositiveInteger(params.line) ? params.line : undefined,
		range: isReviewRange(params.range) ? params.range : undefined
	};
}

export function normalizeDeleteReviewNoteParams(value: unknown): DeleteReviewNoteParams {
	if (!value || typeof value !== "object") {
		throw new Error("Expected delete note parameters");
	}

	const id = (value as Partial<DeleteReviewNoteParams>).id;
	if (!isNonEmptyString(id)) {
		throw new Error("Review note id is required");
	}

	return { id };
}

export function isReviewNote(value: unknown): value is ReviewNote {
	if (!value || typeof value !== "object") {
		return false;
	}

	const note = value as Partial<ReviewNote>;
	return (
		isNonEmptyString(note.id) &&
		isNonEmptyString(note.body) &&
		(note.filePath === undefined || typeof note.filePath === "string") &&
		(note.line === undefined || isPositiveInteger(note.line)) &&
		(note.range === undefined || isReviewRange(note.range)) &&
		isNonEmptyString(note.createdAt)
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

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
