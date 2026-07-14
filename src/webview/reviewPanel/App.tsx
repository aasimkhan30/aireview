import * as React from "react";
import { FileText, MessageSquare, Plus, RefreshCw, Send, Trash2 } from "lucide-react";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import { type ReviewNote, type ReviewPanelState, ReviewRpc } from "../../common/reviewProtocol";
import { createReviewPanelConnection } from "./rpc";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Textarea } from "./components/ui/textarea";

export function App() {
	const [connection, setConnection] = React.useState<MessageConnection | undefined>();
	const [state, setState] = React.useState<ReviewPanelState | undefined>();
	const [draft, setDraft] = React.useState("");
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		let disposed = false;
		const nextConnection = createReviewPanelConnection();
		nextConnection.onNotification(ReviewRpc.stateChanged, (nextState: ReviewPanelState) => {
			if (disposed) {
				return;
			}
			setState(nextState);
		});
		nextConnection.listen();
		// The connection is an external resource created and disposed with this effect.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setConnection(nextConnection);

		void nextConnection
			.sendRequest<ReviewPanelState>(ReviewRpc.getState)
			.then((nextState) => {
				if (!disposed) {
					setState(nextState);
				}
			})
			.catch((error) => {
				if (!disposed) {
					console.error("Failed to load review panel state", error);
				}
			});

		return () => {
			disposed = true;
			nextConnection.dispose();
		};
	}, []);

	const activeFile = state?.workspace.activeFile;
	const canSubmit = draft.trim().length > 0 && Boolean(connection) && !busy;

	async function refresh(): Promise<void> {
		if (!connection) {
			return;
		}

		setState(await connection.sendRequest<ReviewPanelState>(ReviewRpc.getState));
	}

	async function addNote(): Promise<void> {
		if (!connection || !canSubmit) {
			return;
		}

		setBusy(true);
		try {
			await connection.sendRequest<ReviewNote>(ReviewRpc.addNote, { body: draft });
			setDraft("");
		} finally {
			setBusy(false);
		}
	}

	async function deleteNote(id: string): Promise<void> {
		if (!connection) {
			return;
		}

		await connection.sendRequest<boolean>(ReviewRpc.deleteNote, { id });
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
