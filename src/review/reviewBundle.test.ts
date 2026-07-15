import { describe, expect, it } from "vitest";
import type { ReviewNote } from "../common/reviewProtocol";
import { createReviewAnchor } from "./reviewAnchors";
import { buildReviewBundle } from "./reviewBundle";

describe("buildReviewBundle", () => {
	it("groups actionable notes by file with overall instructions and selected code", () => {
		const note = createNote("change", "Use the cached value here.");
		const resolved = {
			...createNote("test", "This should not be supplied by the caller."),
			status: "resolved" as const
		};
		const markdown = buildReviewBundle(
			"Keep the public API stable.",
			[note, resolved].filter((item) => item.status !== "resolved")
		);

		expect(markdown).toContain("## Overall instructions\n\nKeep the public API stable.");
		expect(markdown).toContain("## src/file.ts");
		expect(markdown).toContain("### Lines 1–1 · change");
		expect(markdown).toContain("const value = load();");
		expect(markdown).not.toContain("supplied by the caller");
	});

	it("keeps orphaned notes visible and explains their missing location", () => {
		const note: ReviewNote = {
			...createNote("question", "Is this still needed?"),
			anchor: undefined,
			anchorState: "orphaned"
		};
		const markdown = buildReviewBundle("", [note]);

		expect(markdown).toContain("## Unattached notes");
		expect(markdown).toContain("Location unavailable");
		expect(markdown).toContain("could not be reattached");
	});
});

function createNote(kind: ReviewNote["kind"], body: string): ReviewNote {
	const text = "const value = load();\n";
	return {
		id: `${kind}-note`,
		body,
		kind,
		status: "draft",
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
