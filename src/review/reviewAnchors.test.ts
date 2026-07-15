import { describe, expect, it } from "vitest";
import { createReviewAnchor, resolveReviewAnchor } from "./reviewAnchors";

describe("review anchors", () => {
	it("keeps an unchanged selection attached", () => {
		const text = "const one = 1;\nconst two = 2;\n";
		const anchor = createReviewAnchor(text, "file:///workspace/file.ts", "file.ts", {
			startLine: 2,
			startCharacter: 1,
			endLine: 2,
			endCharacter: 15
		});

		expect(resolveReviewAnchor(text, anchor)).toEqual({ anchor, state: "attached" });
	});

	it("moves an anchor when unique selected code shifts", () => {
		const original = "const one = 1;\nconst two = 2;\n";
		const anchor = createReviewAnchor(original, "file:///workspace/file.ts", "file.ts", {
			startLine: 2,
			startCharacter: 1,
			endLine: 2,
			endCharacter: 15
		});
		const resolved = resolveReviewAnchor(`// heading\n${original}`, anchor);

		expect(resolved.state).toBe("moved");
		expect(resolved.anchor.range).toEqual({
			startLine: 3,
			startCharacter: 1,
			endLine: 3,
			endCharacter: 15
		});
	});

	it("marks deleted and ambiguous selections as orphaned", () => {
		const selected = "doWork();";
		const anchor = createReviewAnchor(selected, "file:///workspace/file.ts", "file.ts", {
			startLine: 1,
			startCharacter: 1,
			endLine: 1,
			endCharacter: 10
		});

		expect(resolveReviewAnchor("nothing here", anchor).state).toBe("orphaned");
		expect(resolveReviewAnchor("// moved\ndoWork();\ndoWork();", anchor).state).toBe("orphaned");
	});
});
