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
		["#requestchanges:change Update this", "change"],
		["#requestchanges:question\nWhy is this nullable?", "question"],
		["  #requestchanges:explain Explain the fallback", "explain"],
		["#requestchanges:addTest Add the regression case", "test"]
	] as const)("parses and strips %s", (value, kind) => {
		const parsed = parseReviewComment(value);
		expect(parsed.kind).toBe(kind);
		expect(parsed.hadDirective).toBe(true);
		expect(parsed.body).not.toContain("#requestchanges:");
	});

	it("preserves the current kind when an edited comment has no directive", () => {
		expect(parseReviewComment("Updated question", "question").kind).toBe("question");
	});

	it("does not treat @ mentions as directives", () => {
		expect(parseReviewComment("@requestchanges:question Please take a look")).toEqual({
			body: "@requestchanges:question Please take a look",
			kind: "change",
			hadDirective: false
		});
	});

	it("accepts directive keywords case-insensitively", () => {
		expect(parseReviewComment("#RequestChanges:AddTest Cover this").kind).toBe("test");
	});

	it("rejects unknown and incomplete directives", () => {
		expect(() => parseReviewComment("#requestchanges:fix Handle this")).toThrow("Unknown Request Changes type");
		expect(() => parseReviewComment("#requestchanges:")).toThrow("Invalid Request Changes type directive");
	});
});
