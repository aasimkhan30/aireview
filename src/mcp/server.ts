#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { ReviewNote, ReviewNoteStatus, ReviewResolution } from "../common/reviewProtocol";
import { getDefaultAiReviewDataDirectory, ReviewLedger } from "../review/reviewLedger";

const serverVersion = "0.0.1";
const options = readOptions(process.argv.slice(2));
const clientName = options.client ?? process.env.AIREVIEW_CLIENT ?? "MCP agent";

const server = new McpServer(
	{ name: "aireview", version: serverVersion },
	{
		instructions:
			"AI Review exposes code annotations for the current workspace. Use these tools only when the user explicitly asks for AI Review or mentions aireview. Read open notes with the aireview tool, edit code using the client's normal coding tools, run appropriate verification, then report every note as addressed or blocked. Addressed notes still require human acceptance."
	}
);

const workspaceSchema = z
	.object({
		workspaceRoot: z.string().min(1).optional().describe("Workspace root; defaults to the configured root or cwd")
	})
	.strict();

server.registerTool(
	"aireview",
	{
		title: "AI Review annotations",
		description:
			"Read the open AI Review annotations and overall instructions for this workspace. Invoke only when the user explicitly asks for AI Review or references #aireview.",
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
	"claim_review_notes",
	{
		title: "Claim AI Review notes",
		description: "Mark open AI Review notes as in progress before implementing them.",
		inputSchema: workspaceSchema.extend({ noteIds: z.array(z.string().min(1)).optional() }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, noteIds }) => {
		const ledger = await getLedger(workspaceRoot);
		const now = new Date().toISOString();
		const state = await ledger.mutate((current) => ({
			...current,
			notes: current.notes.map((note) =>
				isSelected(note, noteIds) && isActionable(note.status)
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
		noteId: z.string().min(1),
		summary: z.string().min(1).max(10_000),
		changedFiles: z.array(z.string().min(1)).max(200).default([]),
		verification: z.string().max(10_000).optional()
	})
	.strict();

server.registerTool(
	"report_notes_addressed",
	{
		title: "Report AI Review notes addressed",
		description:
			"Report one or more annotations as addressed after making the requested code changes and verifying them. This does not resolve the notes; a human accepts them in AI Review.",
		inputSchema: workspaceSchema.extend({ results: z.array(addressedResultSchema).min(1).max(100) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, results }) => {
		const ledger = await getLedger(workspaceRoot);
		const resultById = new Map(results.map((result) => [result.noteId, result]));
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

const blockedResultSchema = z.object({ noteId: z.string().min(1), reason: z.string().min(1).max(10_000) }).strict();

server.registerTool(
	"report_notes_blocked",
	{
		title: "Report AI Review notes blocked",
		description: "Report annotations that could not be implemented and explain the blocking condition.",
		inputSchema: workspaceSchema.extend({ results: z.array(blockedResultSchema).min(1).max(100) }),
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot, results }) => {
		const ledger = await getLedger(workspaceRoot);
		const resultById = new Map(results.map((result) => [result.noteId, result]));
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
		title: "Get AI Review status",
		description: "Return counts and outcomes for the current AI Review workspace.",
		inputSchema: workspaceSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
	},
	async ({ workspaceRoot }) => {
		const state = await (await getLedger(workspaceRoot)).read();
		return textResult(JSON.stringify({ revision: state.revision, ...summarizeState(state.notes) }, undefined, 2));
	}
);

server.registerResource(
	"open-reviews",
	"aireview://reviews/open",
	{
		title: "Open AI Review annotations",
		description: "Open review notes for the current workspace",
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
	"review-note",
	new ResourceTemplate("aireview://reviews/{noteId}", { list: undefined }),
	{ title: "AI Review annotation", description: "A single AI Review note", mimeType: "application/json" },
	async (uri, variables) => {
		const state = await (await getLedger()).read();
		const note = state.notes.find((candidate) => candidate.id === String(variables.noteId));
		return resourceResult(uri, JSON.stringify(note ?? { error: "Review note not found" }, undefined, 2));
	}
);

server.registerPrompt(
	"fix_review",
	{
		title: "Fix AI Review annotations",
		description: "Implement all open AI Review annotations and report each outcome"
	},
	async () => ({
		messages: [
			{
				role: "user",
				content: {
					type: "text",
					text: "Use the aireview tool to read all open annotations. Claim them, implement each requested change with your normal coding tools, run relevant verification, and report every note as addressed or blocked. Do not resolve notes; human acceptance happens in the AI Review extension."
				}
			}
		]
	})
);

async function getLedger(workspaceRoot?: string): Promise<ReviewLedger> {
	return ReviewLedger.open(
		await resolveWorkspaceRoot(workspaceRoot),
		options.dataDirectory ?? getDefaultAiReviewDataDirectory()
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

function formatReviewContext(notes: readonly ReviewNote[], state: Awaited<ReturnType<ReviewLedger["read"]>>): string {
	return JSON.stringify(
		{
			workspace: state.workspace,
			revision: state.revision,
			overallInstructions: state.effectiveInstructions,
			noteCount: notes.length,
			notes
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

function isSelected(note: ReviewNote, noteIds: readonly string[] | undefined): boolean {
	return !noteIds || noteIds.length === 0 || noteIds.includes(note.id);
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
	console.error(`AI Review MCP ${serverVersion} running for ${pathToFileURL(options.workspace ?? process.cwd())}`);
}

process.on("SIGINT", () => {
	void server.close().finally(() => process.exit(0));
});

void main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
