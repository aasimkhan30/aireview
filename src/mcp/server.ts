#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ReviewNote, ReviewNoteStatus, ReviewResolution } from "../common/reviewProtocol";
import { getDefaultRequestChangesDataDirectory, ReviewLedger } from "../review/reviewLedger";

declare const __REQUEST_CHANGES_VERSION__: string;

const serverVersion = __REQUEST_CHANGES_VERSION__;
const options = readOptions(process.argv.slice(2));
const clientName = options.client ?? process.env.REQUEST_CHANGES_CLIENT ?? "MCP agent";

const server = new McpServer(
	{ name: "requestchanges", version: serverVersion },
	{
		instructions:
			"Request Changes exposes human review comments on agent-written code. Use these tools only when the user explicitly asks for Request Changes or mentions requestchanges. Read open comments with the requestchanges tool, edit code using the client's normal coding tools, run appropriate verification, then report every comment as addressed or blocked. Addressed comments still require human acceptance."
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
			"Read open review comments and overall instructions for agent-written code in this workspace. Invoke only when the user explicitly asks for Request Changes or references #requestchanges.",
		inputSchema: workspaceSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot }) => {
		const state = await (await getLedger(workspaceRoot)).read();
		return textResult(
			formatReviewContext(
				state.notes.filter((note) => isActionable(note.status)),
				state
			)
		);
	}
);

server.registerTool(
	"claim_review_comments",
	{
		title: "Claim review comments",
		description: "Mark open review comments as in progress before addressing them.",
		inputSchema: workspaceSchema.extend({ commentIds: z.array(z.string().min(1)).optional() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, commentIds }) => {
		const ledger = await getLedger(workspaceRoot);
		const now = new Date().toISOString();
		const state = await ledger.mutate((current) => ({
			...current,
			notes: current.notes.map((note) =>
				isSelected(note, commentIds) && isActionable(note.status)
					? {
							...note,
							status: "in_progress",
							resolution: { client: clientName, changedFiles: [], updatedAt: now },
							updatedAt: now
						}
					: note
			)
		}));
		return textResult(JSON.stringify(summarizeState(state.notes), undefined, 2));
	}
);

const addressedResultSchema = z
	.object({
		commentId: z.string().min(1),
		summary: z.string().min(1).max(10_000),
		changedFiles: z.array(z.string().min(1)).max(200).default([]),
		verification: z.string().max(10_000).optional()
	})
	.strict();

server.registerTool(
	"report_comments_addressed",
	{
		title: "Report review comments addressed",
		description:
			"Report review comments as addressed after making and verifying the requested code changes. This does not resolve the comments; a human accepts them in Request Changes.",
		inputSchema: workspaceSchema.extend({ results: z.array(addressedResultSchema).min(1).max(100) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, results }) => {
		const ledger = await getLedger(workspaceRoot);
		const resultById = new Map(results.map((result) => [result.commentId, result]));
		const now = new Date().toISOString();
		const state = await ledger.mutate((current) => ({
			...current,
			notes: current.notes.map((note) => {
				const result = resultById.get(note.id);
				if (!result) {
					return note;
				}
				const resolution: ReviewResolution = {
					client: clientName,
					summary: result.summary,
					changedFiles: result.changedFiles,
					verification: result.verification,
					updatedAt: now
				};
				return { ...note, status: "addressed", resolution, updatedAt: now };
			})
		}));
		return textResult(JSON.stringify(summarizeState(state.notes), undefined, 2));
	}
);

const blockedResultSchema = z.object({ commentId: z.string().min(1), reason: z.string().min(1).max(10_000) }).strict();

server.registerTool(
	"report_comments_blocked",
	{
		title: "Report review comments blocked",
		description: "Report review comments that could not be addressed and explain the blocking condition.",
		inputSchema: workspaceSchema.extend({ results: z.array(blockedResultSchema).min(1).max(100) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, results }) => {
		const ledger = await getLedger(workspaceRoot);
		const resultById = new Map(results.map((result) => [result.commentId, result]));
		const now = new Date().toISOString();
		const state = await ledger.mutate((current) => ({
			...current,
			notes: current.notes.map((note) => {
				const result = resultById.get(note.id);
				return result
					? {
							...note,
							status: "blocked",
							resolution: {
								client: clientName,
								changedFiles: [],
								blockedReason: result.reason,
								updatedAt: now
							},
							updatedAt: now
						}
					: note;
			})
		}));
		return textResult(JSON.stringify(summarizeState(state.notes), undefined, 2));
	}
);

server.registerTool(
	"get_review_status",
	{
		title: "Get review status",
		description: "Return counts and outcomes for review comments in the current workspace.",
		inputSchema: workspaceSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot }) => {
		const state = await (await getLedger(workspaceRoot)).read();
		return textResult(JSON.stringify({ revision: state.revision, ...summarizeState(state.notes) }, undefined, 2));
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
		const state = await (await getLedger()).read();
		return resourceResult(
			uri,
			formatReviewContext(
				state.notes.filter((note) => isActionable(note.status)),
				state
			)
		);
	}
);

server.registerResource(
	"review-comment",
	new ResourceTemplate("requestchanges://comments/{commentId}", { list: undefined }),
	{ title: "Review comment", description: "A single Request Changes review comment", mimeType: "application/json" },
	async (uri, variables) => {
		const state = await (await getLedger()).read();
		const note = state.notes.find((candidate) => candidate.id === String(variables.commentId));
		return resourceResult(uri, JSON.stringify(note ?? { error: "Review comment not found" }, undefined, 2));
	}
);

server.registerPrompt(
	"address_review_comments",
	{
		title: "Address review comments",
		description: "Implement all requested changes and report the outcome of each review comment"
	},
	async () => ({
		messages: [
			{
				role: "user",
				content: {
					type: "text",
					text: "Use the requestchanges tool to read all open review comments. Claim them, implement each requested change with your normal coding tools, run relevant verification, and report every comment as addressed or blocked. Do not resolve comments; human acceptance happens in the Request Changes extension."
				}
			}
		]
	})
);

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

function formatReviewContext(
	comments: readonly ReviewNote[],
	state: Awaited<ReturnType<ReviewLedger["read"]>>
): string {
	return JSON.stringify(
		{
			workspace: state.workspace,
			revision: state.revision,
			overallInstructions: state.effectiveInstructions,
			commentCount: comments.length,
			comments
		},
		undefined,
		2
	);
}

function summarizeState(notes: readonly ReviewNote[]): Record<ReviewNoteStatus | "total", number> {
	const summary: Record<ReviewNoteStatus | "total", number> = {
		total: notes.length,
		draft: 0,
		in_progress: 0,
		addressed: 0,
		blocked: 0,
		resolved: 0
	};
	for (const note of notes) {
		summary[note.status] += 1;
	}
	return summary;
}

function isSelected(note: ReviewNote, commentIds: readonly string[] | undefined): boolean {
	return !commentIds || commentIds.length === 0 || commentIds.includes(note.id);
}

function isActionable(status: ReviewNoteStatus): boolean {
	return status === "draft" || status === "in_progress" || status === "blocked";
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
