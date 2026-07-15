import { createHash } from "node:crypto";
import type { ReviewAnchor, ReviewAnchorState, ReviewRange } from "../common/reviewProtocol";

const contextLength = 240;

export interface ResolvedReviewAnchor {
	readonly anchor: ReviewAnchor;
	readonly state: ReviewAnchorState;
}

export function createReviewAnchor(
	documentText: string,
	uri: string,
	filePath: string,
	range: ReviewRange
): ReviewAnchor {
	const startOffset = offsetAt(documentText, range.startLine, range.startCharacter);
	const endOffset = offsetAt(documentText, range.endLine, range.endCharacter);
	const selectedText = documentText.slice(startOffset, endOffset);
	return {
		uri,
		filePath,
		range,
		selectedText,
		selectedTextHash: hashText(selectedText),
		contextBefore: documentText.slice(Math.max(0, startOffset - contextLength), startOffset),
		contextAfter: documentText.slice(endOffset, endOffset + contextLength)
	};
}

export function resolveReviewAnchor(documentText: string, anchor: ReviewAnchor): ResolvedReviewAnchor {
	const startOffset = offsetAt(documentText, anchor.range.startLine, anchor.range.startCharacter);
	const endOffset = offsetAt(documentText, anchor.range.endLine, anchor.range.endCharacter);
	const currentText = documentText.slice(startOffset, endOffset);
	if (anchor.selectedText.length === 0 || hashText(currentText) === anchor.selectedTextHash) {
		return { anchor, state: "attached" };
	}

	const candidates: { offset: number; score: number }[] = [];
	let offset = documentText.indexOf(anchor.selectedText);
	while (offset >= 0 && candidates.length < 100) {
		candidates.push({ offset, score: scoreCandidate(documentText, offset, anchor) });
		offset = documentText.indexOf(anchor.selectedText, offset + 1);
	}
	if (candidates.length === 0) {
		return { anchor, state: "orphaned" };
	}

	candidates.sort((left, right) => right.score - left.score);
	if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
		return { anchor, state: "orphaned" };
	}
	const candidate = candidates[0];
	const range = rangeFromOffsets(documentText, candidate.offset, candidate.offset + anchor.selectedText.length);
	return {
		anchor: {
			...anchor,
			range,
			contextBefore: documentText.slice(Math.max(0, candidate.offset - contextLength), candidate.offset),
			contextAfter: documentText.slice(
				candidate.offset + anchor.selectedText.length,
				candidate.offset + anchor.selectedText.length + contextLength
			)
		},
		state: rangesEqual(range, anchor.range) ? "attached" : "moved"
	};
}

export function rangesEqual(left: ReviewRange, right: ReviewRange): boolean {
	return (
		left.startLine === right.startLine &&
		left.startCharacter === right.startCharacter &&
		left.endLine === right.endLine &&
		left.endCharacter === right.endCharacter
	);
}

function scoreCandidate(documentText: string, offset: number, anchor: ReviewAnchor): number {
	let score = 0;
	if (anchor.contextBefore) {
		const before = documentText.slice(Math.max(0, offset - anchor.contextBefore.length), offset);
		score += matchingSuffixLength(before, anchor.contextBefore);
	}
	if (anchor.contextAfter) {
		const afterStart = offset + anchor.selectedText.length;
		const after = documentText.slice(afterStart, afterStart + anchor.contextAfter.length);
		score += matchingPrefixLength(after, anchor.contextAfter);
	}
	return score;
}

function matchingPrefixLength(left: string, right: string): number {
	const length = Math.min(left.length, right.length);
	let index = 0;
	while (index < length && left[index] === right[index]) {
		index += 1;
	}
	return index;
}

function matchingSuffixLength(left: string, right: string): number {
	const length = Math.min(left.length, right.length);
	let count = 0;
	while (count < length && left[left.length - 1 - count] === right[right.length - 1 - count]) {
		count += 1;
	}
	return count;
}

function hashText(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function offsetAt(text: string, line: number, character: number): number {
	const lines = lineStarts(text);
	const lineIndex = Math.max(0, Math.min(line - 1, lines.length - 1));
	const lineStart = lines[lineIndex];
	const lineEnd = lineIndex + 1 < lines.length ? lines[lineIndex + 1] - 1 : text.length;
	return Math.max(lineStart, Math.min(lineStart + character - 1, lineEnd));
}

function rangeFromOffsets(text: string, startOffset: number, endOffset: number): ReviewRange {
	const starts = lineStarts(text);
	const start = positionAt(starts, startOffset);
	const end = positionAt(starts, endOffset);
	return {
		startLine: start.line,
		startCharacter: start.character,
		endLine: end.line,
		endCharacter: end.character
	};
}

function positionAt(starts: readonly number[], offset: number): { line: number; character: number } {
	let low = 0;
	let high = starts.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (starts[middle] > offset) {
			high = middle;
		} else {
			low = middle + 1;
		}
	}
	const lineIndex = Math.max(0, low - 1);
	return { line: lineIndex + 1, character: offset - starts[lineIndex] + 1 };
}

function lineStarts(text: string): number[] {
	const starts = [0];
	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\n") {
			starts.push(index + 1);
		}
	}
	return starts;
}
