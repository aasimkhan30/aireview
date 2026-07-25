#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ReviewCommentStatus } from "../common/reviewProtocol";
import { createReviewCommentRequests } from "../review/reviewBundle";
import { getDefaultRequestChangesDataDirectory, ReviewLedger } from "../review/reviewLedger";
import {
	claimReviewComments,
	completeReviewComments,
	recoverExpiredReviewClaims,
	type ClaimReviewCommentResult,
	type CompleteReviewCommentResult
} from "../review/reviewWorkflow";

declare const __REQUEST_CHANGES_VERSION__: string;

const serverVersion = __REQUEST_CHANGES_VERSION__;
const options = readOptions(process.argv.slice(2));
const clientName = options.client ?? process.env.REQUEST_CHANGES_CLIENT ?? "MCP agent";

const server = new McpServer(
	{ name: "requestchanges", version: serverVersion },
	{
		instructions:
			"Request Changes exposes one-shot human review comments. Read open comments, claim only the exact IDs and versions you will process, perform the work, and complete each claimed comment exactly once as resolved or unresolved. A terminal comment never becomes active again. After completing the selected comments, send the user a concise summary of each result."
	}
);

const workspaceSchema = z
	.object({
		workspaceRoot: z.string().min(1).optional().describe("Workspace root; defaults to the configured root or cwd")
	})
	.strict();

server.registerTool(
	"requestchanges",
	{
		title: "Request Changes review comments",
		description:
			"Read open review comments and overall instructions for agent-written code in this workspace. Working and terminal comments are excluded.",
		inputSchema: workspaceSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot }) => {
		const ledger = await getLedger(workspaceRoot);
		const state = await recoverExpiredClaims(ledger);
		return textResult(formatReviewContext(state));
	}
);

const claimInputSchema = z
	.object({
		commentId: z.string().min(1),
		expectedVersion: z.number().int().positive()
	})
	.strict();

server.registerTool(
	"claim_review_comments",
	{
		title: "Claim review comments",
		description:
			"Claim explicit open review comment IDs and versions before processing them. Omitted or empty selections are rejected.",
		inputSchema: workspaceSchema.extend({ comments: z.array(claimInputSchema).min(1).max(100) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
	},
	async ({ workspaceRoot, comments }) => {
		const ledger = await getLedger(workspaceRoot);
		let results: readonly ClaimReviewCommentResult[] = [];
		await ledger.mutate((current) => {
			const outcome = claimReviewComments(current, comments, clientName);
			results = outcome.results;
			return outcome.state;
		});
		return textResult(JSON.stringify({ results }, undefined, 2));
	}
);

const resolvedCompletionSchema = z
	.object({
		commentId: z.string().min(1),
		expectedVersion: z.number().int().positive(),
		claimToken: z.string().min(1),
		outcome: z.literal("resolved"),
		summary: z.string().min(1).max(10_000),
		changedFiles: z.array(z.string().min(1)).max(200).default([]),
		verification: z.string().max(10_000).optional(),
		limitations: z.string().max(10_000).optional()
	})
	.strict();

const unresolvedCompletionSchema = z
	.object({
		commentId: z.string().min(1),
		expectedVersion: z.number().int().positive(),
		claimToken: z.string().min(1),
		outcome: z.literal("unresolved"),
		reason: z.enum([
			"missing_requirement",
			"missing_resource",
			"missing_permission",
			"target_unavailable",
			"unsafe_change",
			"environment_failure"
		]),
		explanation: z.string().min(1).max(10_000),
		suggestedNewComment: z.string().max(10_000).optional()
	})
	.strict();

server.registerTool(
	"complete_review_comments",
	{
		title: "Complete review comments",
		description: "Report exactly one terminal resolved or unresolved result for each claimed review comment.",
		inputSchema: workspaceSchema.extend({
			results: z
				.array(z.discriminatedUnion("outcome", [resolvedCompletionSchema, unresolvedCompletionSchema]))
				.min(1)
				.max(100)
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, results: completionInputs }) => {
		const ledger = await getLedger(workspaceRoot);
		let results: readonly CompleteReviewCommentResult[] = [];
		await ledger.mutate((current) => {
			const outcome = completeReviewComments(current, completionInputs, clientName);
			results = outcome.results;
			return outcome.state;
		});
		return textResult(JSON.stringify({ results }, undefined, 2));
	}
);

server.registerTool(
	"get_review_status",
	{
		title: "Get review status",
		description: "Return counts for review comments in the current workspace.",
		inputSchema: workspaceSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot }) => {
		const ledger = await getLedger(workspaceRoot);
		const state = await recoverExpiredClaims(ledger);
		return textResult(
			JSON.stringify({ revision: state.revision, ...summarizeState(state.comments) }, undefined, 2)
		);
	}
);

server.registerResource(
	"open-review-comments",
	"requestchanges://comments/open",
	{
		title: "Open review comments",
		description: "Open review comments for agent-written code in the current workspace",
		mimeType: "application/json"
	},
	async (uri) => {
		const state = await recoverExpiredClaims(await getLedger());
		return resourceResult(uri, formatReviewContext(state));
	}
);

server.registerResource(
	"review-comment",
	new ResourceTemplate("requestchanges://comments/{commentId}", { list: undefined }),
	{ title: "Review comment", description: "A single Request Changes review comment", mimeType: "application/json" },
	async (uri, variables) => {
		const state = await recoverExpiredClaims(await getLedger());
		const comment = state.comments.find((candidate) => candidate.id === String(variables.commentId));
		return resourceResult(uri, JSON.stringify(comment ?? { error: "Review comment not found" }, undefined, 2));
	}
);

server.registerPrompt(
	"resolve_review_comments",
	{
		title: "Resolve review comments",
		description: "Process open comments and report one terminal result for each claimed comment"
	},
	async () => ({
		messages: [
			{
				role: "user",
				content: {
					type: "text",
					text: "Use the requestchanges tool to read open review comments. Claim only the exact IDs and versions you will process, perform each request with your normal coding tools, run relevant verification, and complete every claimed comment exactly once as resolved or unresolved. Do not process comments that were not selected for this task. Finish with a concise summary of each individual comment and its result."
				}
			}
		]
	})
);

async function recoverExpiredClaims(ledger: ReviewLedger) {
	const current = await ledger.read();
	const recovered = recoverExpiredReviewClaims(current);
	return recovered.recoveredCount ? ledger.mutate((latest) => recoverExpiredReviewClaims(latest).state) : current;
}

async function getLedger(workspaceRoot?: string): Promise<ReviewLedger> {
	return ReviewLedger.open(
		await resolveWorkspaceRoot(workspaceRoot),
		options.dataDirectory ?? getDefaultRequestChangesDataDirectory()
	);
}

async function resolveWorkspaceRoot(requested?: string): Promise<string> {
	const roots = await getClientRoots();
	if (requested) {
		const normalized = resolve(requested);
		if (roots.length > 0 && !roots.some((root) => resolve(root) === normalized)) {
			throw new Error("The requested workspace root is not exposed by this MCP client");
		}
		return normalized;
	}
	return options.workspace ?? process.env.CLAUDE_PROJECT_DIR ?? roots[0] ?? process.cwd();
}

async function getClientRoots(): Promise<string[]> {
	try {
		const result = await server.server.listRoots();
		return result.roots.flatMap((root) => {
			try {
				const uri = new URL(root.uri);
				return uri.protocol === "file:" ? [fileURLToPath(uri)] : [];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

function formatReviewContext(state: Awaited<ReturnType<ReviewLedger["read"]>>): string {
	const comments = state.comments.filter((comment) => comment.status === "open");
	return JSON.stringify(
		{
			workspace: state.workspace,
			revision: state.revision,
			overallInstructions: state.effectiveInstructions,
			commentCount: comments.length,
			comments: createReviewCommentRequests(comments)
		},
		undefined,
		2
	);
}

function summarizeState(
	comments: Awaited<ReturnType<ReviewLedger["read"]>>["comments"]
): Record<ReviewCommentStatus | "total", number> {
	const summary: Record<ReviewCommentStatus | "total", number> = {
		total: comments.length,
		open: 0,
		in_progress: 0,
		resolved: 0,
		unresolved: 0
	};
	for (const comment of comments) {
		summary[comment.status] += 1;
	}
	return summary;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }] };
}

function resourceResult(uri: URL, text: string) {
	return { contents: [{ uri: uri.toString(), mimeType: "application/json", text }] };
}

function readOptions(args: readonly string[]): { workspace?: string; dataDirectory?: string; client?: string } {
	const result: { workspace?: string; dataDirectory?: string; client?: string } = {};
	for (let index = 0; index < args.length; index += 1) {
		const value = args[index + 1];
		switch (args[index]) {
			case "--workspace":
				result.workspace = value;
				index += 1;
				break;
			case "--data-dir":
				result.dataDirectory = value;
				index += 1;
				break;
			case "--client":
				result.client = value;
				index += 1;
				break;
		}
	}
	return result;
}

async function main(): Promise<void> {
	if (process.argv.includes("--print-config")) {
		process.stdout.write(
			`${JSON.stringify({ version: serverVersion, workspace: options.workspace, dataDirectory: options.dataDirectory })}\n`
		);
		return;
	}
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(
		`Request Changes MCP ${serverVersion} running for ${pathToFileURL(options.workspace ?? process.cwd())}`
	);
}

process.on("SIGINT", () => {
	void server.close().finally(() => process.exit(0));
});

void main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
