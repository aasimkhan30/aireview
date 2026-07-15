import assert from "node:assert/strict";
import test from "node:test";
import { getNextStableVersion, getPreviewVersion } from "./release-version.mjs";

test("uses a Marketplace-compatible readable UTC timestamp for previews", () => {
	assert.equal(getPreviewVersion(new Date("2026-07-15T03:00:04Z")), "20260715.030004.0");
});

test("increments only the stable patch version", () => {
	assert.equal(getNextStableVersion("0.0.1"), "0.0.2");
	assert.equal(getNextStableVersion("0.0.41"), "0.0.42");
});

test("rejects an invalid preview timestamp", () => {
	assert.throws(() => getPreviewVersion(new Date("invalid")), /valid preview timestamp/u);
});

test("rejects a stable version outside the 0.0.x line", () => {
	assert.throws(() => getNextStableVersion("0.1.2"), /0\.0\.x/u);
});
