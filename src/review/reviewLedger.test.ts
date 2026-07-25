import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrateVersion3ReviewLedgerState, ReviewLedger } from "./reviewLedger";

describe("version 3 review ledger migration", () => {
	it("deterministically migrates every previous status and preserves evidence", () => {
		const fixture = {
			version: 3,
			revision: 42,
			workspace: { root: "/old", name: "old" },
			notes: [
				oldComment("draft"),
				oldComment("in_progress"),
				oldComment("addressed"),
				oldComment("blocked"),
				oldComment("resolved")
			],
			effectiveInstructions: "Keep compatibility.",
			selectedTarget: "codex",
			updatedAt: "2026-07-24T00:00:00.000Z"
		};
		const first = migrateVersion3ReviewLedgerState(fixture, "/workspace");
		const second = migrateVersion3ReviewLedgerState(fixture, "/workspace");

		expect(first).toEqual(second);
		expect(first?.version).toBe(4);
		expect(first?.comments.map((comment) => comment.status)).toEqual([
			"open",
			"open",
			"resolved",
			"unresolved",
			"resolved"
		]);
		expect(first?.comments[2]).toMatchObject({
			id: "addressed",
			body: "Request addressed",
			intent: "test",
			anchorState: "orphaned",
			result: {
				outcome: "resolved",
				summary: "Completed addressed",
				changedFiles: ["src/addressed.ts"],
				verification: "tests passed",
				completedAt: "2026-07-24T01:00:00.000Z"
			}
		});
		expect(first?.comments[3]).toMatchObject({
			result: {
				outcome: "unresolved",
				explanation: "Missing requirement for blocked"
			}
		});
	});

	it("rejects the complete migration when an individual version 3 record is invalid", () => {
		const fixture = {
			version: 3,
			revision: 1,
			notes: [{ status: "draft" }],
			effectiveInstructions: "",
			selectedTarget: "codex",
			updatedAt: "2026-07-24T00:00:00.000Z"
		};
		expect(migrateVersion3ReviewLedgerState(fixture, "/workspace")).toBeUndefined();
	});

	it("writes version four only after a complete version three ledger validates", async () => {
		const directory = await mkdtemp(join(tmpdir(), "requestchanges-ledger-migration-"));
		const workspace = join(directory, "workspace");
		const data = join(directory, "data");
		await mkdir(workspace);
		try {
			const ledger = await ReviewLedger.open(workspace, data);
			const fixture = {
				version: 3,
				revision: 7,
				workspace: { root: workspace, name: "workspace" },
				notes: [oldComment("draft")],
				effectiveInstructions: "",
				selectedTarget: "codex",
				updatedAt: "2026-07-24T00:00:00.000Z"
			};
			await writeFile(ledger.location.stateFile, JSON.stringify(fixture));
			await expect(ledger.read()).resolves.toMatchObject({
				version: 4,
				revision: 7,
				comments: [{ id: "draft", status: "open" }]
			});
			const persisted = JSON.parse(await readFile(ledger.location.stateFile, "utf8"));
			expect(persisted.version).toBe(4);
			expect(persisted.comments[0]).toMatchObject({ id: "draft", status: "open" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function oldComment(status: string) {
	return {
		id: status,
		version: 3,
		body: `Request ${status}`,
		kind: "test",
		status,
		anchorState: "orphaned",
		resolution: {
			client: "agent",
			summary: `Completed ${status}`,
			changedFiles: [`src/${status}.ts`],
			verification: "tests passed",
			blockedReason: `Missing requirement for ${status}`,
			updatedAt: "2026-07-24T01:00:00.000Z"
		},
		createdAt: "2026-07-24T00:00:00.000Z",
		updatedAt: "2026-07-24T01:00:00.000Z"
	};
}
