import { describe, expect, it } from "vitest";
import type { ReviewComment } from "../common/reviewProtocol";
import { createReviewAnchor } from "./reviewAnchors";
import { buildReviewCommentsMarkdown, createReviewCommentRequests } from "./reviewBundle";

describe("review comment instructions", () => {
	it("includes exact IDs, versions, intent guidance, instructions, and selected code", () => {
		const comment = createComment("change", "Use the cached value here.");
		const markdown = buildReviewCommentsMarkdown(
			"Keep the public API stable.",
			createReviewCommentRequests([comment])
		);

		expect(markdown).toContain("# Review comments");
		expect(markdown).toContain("## Overall instructions\n\nKeep the public API stable.");
		expect(markdown).toContain("## src/file.ts");
		expect(markdown).toContain("### RC-change · Version 2 · Change code · Lines 1–1");
		expect(markdown).toContain("Implement the requested modification.");
		expect(markdown).toContain("const value = load();");
	});

	it("gives questions non-editing guidance and identifies locations needing reattachment", () => {
		const comment: ReviewComment = {
			...createComment("question", "Is this still needed?"),
			anchor: undefined,
			anchorState: "orphaned"
		};
		const markdown = buildReviewCommentsMarkdown("", createReviewCommentRequests([comment]));

		expect(markdown).toContain("## Comments needing reattachment");
		expect(markdown).toContain("Answer without changing code unless explicitly requested.");
		expect(markdown).toContain("needs reattachment");
	});
});

function createComment(intent: ReviewComment["intent"], body: string): ReviewComment {
	const text = "const value = load();\n";
	return {
		id: `RC-${intent}`,
		version: 2,
		body,
		intent,
		status: "open",
		anchor: createReviewAnchor(text, "file:///workspace/src/file.ts", "src/file.ts", {
			startLine: 1,
			startCharacter: 1,
			endLine: 1,
			endCharacter: 22
		}),
		anchorState: "attached",
		createdAt: "2026-07-14T00:00:00.000Z",
		updatedAt: "2026-07-14T00:00:00.000Z"
	};
}
