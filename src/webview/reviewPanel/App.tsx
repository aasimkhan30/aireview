import * as React from "react";
import { FileText, MessageSquare, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import { type ReviewNote, type ReviewPanelStateEnvelope, ReviewRpc } from "../../common/reviewProtocol";
import { shouldAcceptStateEnvelope } from "../../common/webviewProtocol";
import { usePersistedWebviewState } from "../usePersistedWebviewState";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";

export interface AppProps {
	readonly connection: MessageConnection;
}

interface ReviewUiStateV1 {
	readonly version: 1;
	readonly draft: string;
}

type RemoteReviewState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly envelope: ReviewPanelStateEnvelope }
	| { readonly status: "error"; readonly message: string };

type RemoteReviewAction =
	| { readonly type: "received"; readonly envelope: ReviewPanelStateEnvelope }
	| { readonly type: "failed"; readonly error: unknown };

export function App({ connection }: AppProps) {
	const [remoteState, dispatchRemoteState] = React.useReducer(reduceRemoteReviewState, { status: "loading" });
	const [uiState, setUiState] = usePersistedWebviewState(normalizeReviewUiState);
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		let disposed = false;
		const stateChanged = connection.onNotification(ReviewRpc.stateChanged, (envelope) => {
			if (disposed) {
				return;
			}
			dispatchRemoteState({ type: "received", envelope });
		});

		void connection
			.sendRequest(ReviewRpc.getState)
			.then((envelope) => {
				if (!disposed) {
					dispatchRemoteState({ type: "received", envelope });
				}
			})
			.catch((error) => {
				if (!disposed) {
					dispatchRemoteState({ type: "failed", error });
				}
			});

		return () => {
			disposed = true;
			stateChanged.dispose();
		};
	}, [connection]);

	const state = remoteState.status === "ready" ? remoteState.envelope.value : undefined;
	const draft = uiState.draft;
	const activeFile = state?.workspace.activeFile;
	const canSubmit = draft.trim().length > 0 && !busy;

	function setDraft(draft: string): void {
		setUiState((current) => ({ ...current, draft }));
	}

	async function refresh(): Promise<void> {
		dispatchRemoteState({ type: "received", envelope: await connection.sendRequest(ReviewRpc.getState) });
	}

	async function addNote(): Promise<void> {
		if (!canSubmit) {
			return;
		}

		setBusy(true);
		try {
			const envelope = await connection.sendRequest(ReviewRpc.addNote, { body: draft });
			dispatchRemoteState({ type: "received", envelope });
			setDraft("");
		} finally {
			setBusy(false);
		}
	}

	async function deleteNote(id: string): Promise<void> {
		const envelope = await connection.sendRequest(ReviewRpc.deleteNote, { id });
		dispatchRemoteState({ type: "received", envelope });
	}

	return (
		<main className="app-shell">
			<header className="topbar">
				<div className="topbar__title">
					<MessageSquare aria-hidden="true" size={18} />
					<h1>AI Review</h1>
				</div>
				<Button variant="ghost" size="icon" aria-label="Refresh" onClick={() => void refresh()}>
					<RefreshCw aria-hidden="true" size={16} />
				</Button>
			</header>
			{remoteState.status === "error" ? (
				<div className="empty-state" role="alert">
					Unable to load review state: {remoteState.message}
				</div>
			) : undefined}

			<section className="workspace-strip" aria-label="Workspace">
				<div>
					<div className="label">Workspace</div>
					<div className="value">{state?.workspace.name ?? "Loading"}</div>
				</div>
				<div>
					<div className="label">Branch</div>
					<div className="value">{state?.workspace.branch ?? "Unknown"}</div>
				</div>
				<div>
					<div className="label">Active file</div>
					<div className="value value--truncate">{activeFile?.filePath ?? "None"}</div>
				</div>
			</section>

			<div className="content-grid">
				<section className="section" aria-label="Draft">
					<div className="section__header">
						<h2>Draft note</h2>
						{activeFile ? (
							<Badge variant="muted">{formatSelection(activeFile.selection?.startLine)}</Badge>
						) : undefined}
					</div>
					<Textarea
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder="Exact edit request"
						rows={8}
					/>
					<div className="section__footer">
						<Button onClick={() => void addNote()} disabled={!canSubmit}>
							<Plus aria-hidden="true" size={16} />
							Add note
						</Button>
					</div>
				</section>

				<section className="section" aria-label="Agent target">
					<div className="section__header">
						<h2>Agent target</h2>
					</div>
					<div className="target-list">
						{state?.agentTargets.map((target) => (
							<div className="target-row" key={target.id}>
								<div>
									<div className="target-row__label">{target.label}</div>
									<div className="target-row__detail">{target.detail}</div>
								</div>
								<Badge variant={target.available ? "success" : "muted"}>
									{target.available ? "Available" : "Pending"}
								</Badge>
							</div>
						))}
					</div>
					<div className="section__footer">
						<Button disabled>
							<Send aria-hidden="true" size={16} />
							Send bundle
						</Button>
					</div>
				</section>
			</div>

			<section className="notes-section" aria-label="Review notes">
				<div className="section__header">
					<h2>Review notes</h2>
					<Badge>{state?.notes.length ?? 0}</Badge>
				</div>
				<div className="notes-list">
					{state?.notes.length ? (
						state.notes.map((note) => (
							<Card key={note.id}>
								<CardHeader>
									<CardTitle>
										<FileText aria-hidden="true" size={16} />
										<span>{note.filePath ?? "Current context"}</span>
									</CardTitle>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Delete note"
										onClick={() => void deleteNote(note.id)}
									>
										<Trash2 aria-hidden="true" size={15} />
									</Button>
								</CardHeader>
								<CardContent>
									<p>{note.body}</p>
									<div className="note-meta">{formatNoteLocation(note)}</div>
								</CardContent>
							</Card>
						))
					) : (
						<div className="empty-state">No review notes</div>
					)}
				</div>
			</section>
		</main>
	);
}

function reduceRemoteReviewState(state: RemoteReviewState, action: RemoteReviewAction): RemoteReviewState {
	if (action.type === "failed") {
		return state.status === "ready" ? state : { status: "error", message: getErrorMessage(action.error) };
	}

	if (state.status === "ready" && !shouldAcceptStateEnvelope(state.envelope, action.envelope)) {
		return state;
	}

	return { status: "ready", envelope: action.envelope };
}

function normalizeReviewUiState(value: unknown): ReviewUiStateV1 {
	if (value && typeof value === "object") {
		const state = value as Partial<ReviewUiStateV1>;
		if (state.version === 1 && typeof state.draft === "string") {
			return { version: 1, draft: state.draft };
		}
	}

	return { version: 1, draft: "" };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

function formatSelection(line: number | undefined): string {
	return line ? `Line ${line}` : "Selection";
}

function formatNoteLocation(note: ReviewNote): string {
	const date = new Date(note.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (note.line) {
		return `Line ${note.line} · ${date}`;
	}

	return date;
}
