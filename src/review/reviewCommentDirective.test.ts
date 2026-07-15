import { describe, expect, it } from "vitest";
import { parseReviewComment } from "./reviewCommentDirective";

describe("parseReviewComment", () => {
	it("defaults new comments to change", () => {
		expect(parseReviewComment("Handle the empty state")).toEqual({
			body: "Handle the empty state",
			kind: "change",
			hadDirective: false
		});
	});

	it.each([
		["#aireview:change Update this", "change"],
		["#aireview:question\nWhy is this nullable?", "question"],
		["  #aireview:explain Explain the fallback", "explain"],
		["#aireview:addTest Add the regression case", "test"]
	] as const)("parses and strips %s", (value, kind) => {
		const parsed = parseReviewComment(value);
		expect(parsed.kind).toBe(kind);
		expect(parsed.hadDirective).toBe(true);
		expect(parsed.body).not.toContain("#aireview:");
	});

	it("preserves the current kind when an edited comment has no directive", () => {
		expect(parseReviewComment("Updated question", "question").kind).toBe("question");
	});

	it("does not treat @ mentions as directives", () => {
		expect(parseReviewComment("@aireview:question Please take a look")).toEqual({
			body: "@aireview:question Please take a look",
			kind: "change",
			hadDirective: false
		});
	});

	it("accepts directive keywords case-insensitively", () => {
		expect(parseReviewComment("#AIReview:AddTest Cover this").kind).toBe("test");
	});

	it("rejects unknown and incomplete directives", () => {
		expect(() => parseReviewComment("#aireview:fix Handle this")).toThrow("Unknown AI Review type");
		expect(() => parseReviewComment("#aireview:")).toThrow("Invalid AI Review type directive");
	});
});
