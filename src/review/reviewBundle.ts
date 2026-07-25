import {
	reviewIntentPresentation,
	type ReviewAnchor,
	type ReviewAnchorState,
	type ReviewComment,
	type ReviewCommentIntent
} from "../common/reviewProtocol";

export interface ReviewCommentRequest {
	readonly id: string;
	readonly version: number;
	readonly intent: ReviewCommentIntent;
	readonly status: "open";
	readonly intentLabel: string;
	readonly instruction: string;
	readonly body: string;
	readonly anchor: ReviewAnchor | undefined;
	readonly anchorState: ReviewAnchorState;
}

export function createReviewCommentRequests(comments: readonly ReviewComment[]): readonly ReviewCommentRequest[] {
	return comments.map((comment) => {
		if (comment.status !== "open") {
			throw new Error(`Review comment ${comment.id} is not open`);
		}
		return {
			id: comment.id,
			version: comment.version,
			intent: comment.intent,
			status: "open",
			intentLabel: reviewIntentPresentation[comment.intent].label,
			instruction: reviewIntentPresentation[comment.intent].instruction,
			body: comment.body,
			anchor: comment.anchor,
			anchorState: comment.anchorState
		};
	});
}

export function buildReviewCommentsMarkdown(
	overallInstructions: string,
	requests: readonly ReviewCommentRequest[]
): string {
	const sections = [
		"# Review comments",
		[
			"Use the `requestchanges` MCP server to process only the comments listed below.",
			"",
			"For each comment:",
			"",
			"1. Claim it using its exact ID and version.",
			"2. Perform the requested work.",
			"3. Report exactly one terminal result: `resolved` or `unresolved`.",
			"4. Do not process other open comments."
		].join("\n")
	];
	if (overallInstructions) {
		sections.push(`## Overall instructions\n\n${overallInstructions}`);
	}
	const grouped = new Map<string, ReviewCommentRequest[]>();
	for (const request of requests) {
		const filePath = request.anchor?.filePath || "Comments needing reattachment";
		const group = grouped.get(filePath) ?? [];
		group.push(request);
		grouped.set(filePath, group);
	}
	for (const [filePath, fileComments] of grouped) {
		const commentSections = fileComments.map((request) => {
			const range = request.anchor?.range;
			const location = range ? `Lines ${range.startLine}–${range.endLine}` : "Location unavailable";
			const selectedText = request.anchor?.selectedText
				? `\n\nSelected code:\n\n\`\`\`\n${request.anchor.selectedText.slice(0, 12_000)}\n\`\`\``
				: "";
			const needsReattachment =
				request.anchorState === "orphaned" ? "\n\n> The original code location needs reattachment." : "";
			return [
				`### ${request.id} · Version ${request.version} · ${request.intentLabel} · ${location}`,
				request.body,
				`AI instruction: ${request.instruction}${selectedText}${needsReattachment}`
			].join("\n\n");
		});
		sections.push(`## ${filePath}\n\n${commentSections.join("\n\n")}`);
	}
	return `${sections.join("\n\n")}\n`;
}
