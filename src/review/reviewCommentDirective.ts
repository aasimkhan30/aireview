import type { ReviewNoteKind } from "../common/reviewProtocol";

export interface ReviewCommentDirective {
	readonly keyword: "change" | "question" | "explain" | "addTest";
	readonly kind: ReviewNoteKind;
	readonly detail: string;
}

export const reviewCommentDirectives: readonly ReviewCommentDirective[] = [
	{ keyword: "change", kind: "change", detail: "Request a code change" },
	{ keyword: "question", kind: "question", detail: "Ask a question about the selected code" },
	{ keyword: "explain", kind: "explain", detail: "Request an explanation" },
	{ keyword: "addTest", kind: "test", detail: "Request test coverage" }
];

export interface ParsedReviewComment {
	readonly body: string;
	readonly kind: ReviewNoteKind;
	readonly hadDirective: boolean;
}

const directiveStart = /^\s*#aireview:/iu;
const directive = /^\s*#aireview:([^\s]+)(?:[ \t]+|\r?\n|$)/iu;

export function parseReviewComment(value: string, defaultKind: ReviewNoteKind = "change"): ParsedReviewComment {
	const match = directive.exec(value);
	if (!match) {
		if (directiveStart.test(value)) {
			throw new Error(directiveHelp("Invalid AI Review type directive"));
		}
		return { body: value.trim(), kind: defaultKind, hadDirective: false };
	}

	const selected = reviewCommentDirectives.find(
		(candidate) => candidate.keyword.toLowerCase() === match[1].toLowerCase()
	);
	if (!selected) {
		throw new Error(directiveHelp(`Unknown AI Review type “${match[1]}”`));
	}

	return {
		body: value.slice(match[0].length).trim(),
		kind: selected.kind,
		hadDirective: true
	};
}

function directiveHelp(message: string): string {
	return `${message}. Use #aireview:change, #aireview:question, #aireview:explain, or #aireview:addTest.`;
}
