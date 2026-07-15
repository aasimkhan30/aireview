import * as React from "react";
import { Check, Copy, Eye, FileText, MessageSquare, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import type {
	ReviewBundlePreview,
	ReviewNote,
	ReviewNoteKind,
	ReviewPanelStateEnvelope
} from "../../common/reviewProtocol";
import { ReviewRpc } from "../../common/reviewProtocol";
import { shouldAcceptStateEnvelope } from "../../common/webviewProtocol";
import type { WebviewDiagnostics } from "../webviewDiagnostics";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";

export interface AppProps {
	readonly connection: MessageConnection;
	readonly diagnostics: WebviewDiagnostics;
}

type RemoteReviewState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly envelope: ReviewPanelStateEnvelope }
	| { readonly status: "error"; readonly message: string };

type RemoteReviewAction =
	| { readonly type: "received"; readonly envelope: ReviewPanelStateEnvelope }
	| { readonly type: "failed"; readonly error: unknown };

interface EditingNote {
	readonly id: string;
	readonly body: string;
	readonly kind: ReviewNoteKind;
}

export function App({ connection, diagnostics }: AppProps) {
	const [remoteState, dispatchRemoteState] = React.useReducer(reduceRemoteReviewState, { status: "loading" });
	const [editing, setEditing] = React.useState<EditingNote>();
	const [preview, setPreview] = React.useState<ReviewBundlePreview>();
	const [busy, setBusy] = React.useState<string>();
	const [message, setMessage] = React.useState<string>();
	const previewRef = React.useRef<HTMLElement>(null);
	const previewButtonRef = React.useRef<HTMLButtonElement>(null);

	React.useEffect(() => {
		let disposed = false;
		const stateChanged = connection.onNotification(ReviewRpc.stateChanged, (envelope) => {
			if (!disposed) {
				diagnostics.debug("state.changed", diagnosticStateData(envelope));
				dispatchRemoteState({ type: "received", envelope });
			}
		});
		const operation = diagnostics.startOperation("state.load");
		void connection
			.sendRequest(ReviewRpc.getState)
			.then((envelope) => {
				operation.complete(diagnosticStateData(envelope));
				if (!disposed) {
					dispatchRemoteState({ type: "received", envelope });
				}
			})
			.catch((error) => {
				operation.fail(error);
				if (!disposed) {
					dispatchRemoteState({ type: "failed", error });
				}
			});
		return () => {
			disposed = true;
			stateChanged.dispose();
		};
	}, [connection, diagnostics]);

	React.useEffect(() => {
		if (preview) {
			previewRef.current?.focus();
		}
	}, [preview]);

	const state = remoteState.status === "ready" ? remoteState.envelope.value : undefined;
	const groupedNotes = React.useMemo(() => groupNotes(state?.notes ?? []), [state?.notes]);
	const actionableCount = state?.notes.filter((note) => isActionableStatus(note.status)).length ?? 0;

	async function runOperation<T>(
		name: Parameters<WebviewDiagnostics["startOperation"]>[0],
		request: () => Promise<T>,
		onSuccess?: (result: T) => void
	): Promise<T | undefined> {
		setBusy(name);
		setMessage(undefined);
		const operation = diagnostics.startOperation(name);
		try {
			const result = await request();
			operation.complete(isStateEnvelope(result) ? diagnosticStateData(result) : undefined);
			onSuccess?.(result);
			return result;
		} catch (error) {
			operation.fail(error);
			setMessage(getErrorMessage(error));
			return undefined;
		} finally {
			setBusy(undefined);
		}
	}

	async function refresh(): Promise<void> {
		await runOperation("state.refresh", () => connection.sendRequest(ReviewRpc.getState), receiveState);
	}

	async function startAnnotation(): Promise<void> {
		await runOperation("annotation.start", () => connection.sendRequest(ReviewRpc.startAnnotation));
	}

	async function revealNote(id: string): Promise<void> {
		await runOperation("note.reveal", () => connection.sendRequest(ReviewRpc.revealNote, { id }));
	}

	async function deleteNote(id: string): Promise<void> {
		await runOperation("note.delete", () => connection.sendRequest(ReviewRpc.deleteNote, { id }), receiveState);
	}

	async function saveNote(): Promise<void> {
		if (!editing?.body.trim()) {
			return;
		}
		await runOperation(
			"note.update",
			() =>
				connection.sendRequest(ReviewRpc.updateNote, {
					id: editing.id,
					body: editing.body,
					kind: editing.kind
				}),
			(result) => {
				receiveState(result);
				setEditing(undefined);
			}
		);
	}

	async function toggleResolved(note: ReviewNote): Promise<void> {
		await runOperation(
			"note.update",
			() =>
				connection.sendRequest(ReviewRpc.updateNote, {
					id: note.id,
					status: note.status === "resolved" ? "draft" : "resolved"
				}),
			receiveState
		);
	}

	async function previewBundle(): Promise<void> {
		await runOperation("bundle.preview", () => connection.sendRequest(ReviewRpc.previewBundle), setPreview);
	}

	async function copyBundle(): Promise<void> {
		await runOperation("bundle.copy", () =>
			connection.sendRequest(ReviewRpc.copyBundle).then((result) => {
				setMessage(result.message);
				return result;
			})
		);
	}

	function closePreview(): void {
		setPreview(undefined);
		requestAnimationFrame(() => previewButtonRef.current?.focus());
	}

	function receiveState(envelope: ReviewPanelStateEnvelope): void {
		dispatchRemoteState({ type: "received", envelope });
	}

	return (
		<main className="app-shell" aria-busy={Boolean(busy)}>
			<header className="review-header">
				<div className="review-header__identity">
					<MessageSquare aria-hidden="true" size={17} />
					<div>
						<h1>Review draft</h1>
						<div className="review-header__meta">
							{state?.workspace.name ?? "Loading"}
							{state?.workspace.branch ? ` · ${state.workspace.branch}` : ""}
						</div>
					</div>
				</div>
				<div className="review-header__actions">
					<Badge aria-label={`${actionableCount} open review ${actionableCount === 1 ? "note" : "notes"}`}>
						{actionableCount}
					</Badge>
					<Button
						ref={previewButtonRef}
						variant="ghost"
						size="icon"
						aria-label="Preview review bundle"
						aria-controls="review-bundle-preview"
						aria-expanded={Boolean(preview)}
						title="Preview review bundle"
						onClick={() => void previewBundle()}
						disabled={actionableCount === 0 || Boolean(busy)}
					>
						<Eye aria-hidden="true" size={15} />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Copy review bundle to clipboard"
						title="Copy review bundle"
						onClick={() => void copyBundle()}
						disabled={actionableCount === 0 || Boolean(busy)}
					>
						<Copy aria-hidden="true" size={15} />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Refresh review notes"
						title="Refresh review notes"
						onClick={() => void refresh()}
						disabled={Boolean(busy)}
					>
						<RefreshCw aria-hidden="true" size={15} />
					</Button>
				</div>
			</header>
			{busy ? (
				<div className="sr-only" role="status" aria-live="polite">
					Updating AI Review.
				</div>
			) : undefined}

			{remoteState.status === "error" ? (
				<div className="message message--error" role="alert">
					Unable to load review state: {remoteState.message}
				</div>
			) : undefined}
			{message ? (
				<div className="message" role="status" aria-live="polite">
					{message}
				</div>
			) : undefined}

			<Button
				className="add-selection"
				variant="secondary"
				onClick={() => void startAnnotation()}
				disabled={Boolean(busy)}
			>
				<Plus aria-hidden="true" size={15} />
				Add note from editor selection
			</Button>

			<section className="review-notes" aria-label="Review notes">
				{groupedNotes.length === 0 ? (
					<div className="empty-state">
						<strong>No review notes yet</strong>
						<span>Select code in the editor, then choose “AI Review: Add Note to Selection.”</span>
					</div>
				) : (
					groupedNotes.map(([filePath, notes]) => (
						<section
							className="file-group"
							aria-label={`${filePath}, ${notes.length} notes`}
							key={filePath}
						>
							<header className="file-group__header">
								<FileText aria-hidden="true" size={14} />
								<span title={filePath}>{filePath}</span>
								<Badge variant="muted">{notes.length}</Badge>
							</header>
							<div className="file-group__notes">
								{notes.map((note) => (
									<article
										className={`note-card note-card--${note.status}`}
										aria-label={`${formatKind(note.kind)} note, ${formatStatus(note.status)}, ${formatNoteLocation(note)}`}
										key={note.id}
									>
										{editing?.id === note.id ? (
											<div className="note-editor">
												<label className="sr-only" htmlFor={`note-kind-${note.id}`}>
													Note type
												</label>
												<select
													id={`note-kind-${note.id}`}
													value={editing.kind}
													onChange={(event) =>
														setEditing({
															...editing,
															kind: event.target.value as ReviewNoteKind
														})
													}
												>
													<option value="change">Change</option>
													<option value="question">Question</option>
													<option value="explain">Explain</option>
													<option value="test">Add test</option>
												</select>
												<label className="sr-only" htmlFor={`note-body-${note.id}`}>
													Review note
												</label>
												<Textarea
													id={`note-body-${note.id}`}
													value={editing.body}
													onChange={(event) =>
														setEditing({ ...editing, body: event.target.value })
													}
													onKeyDown={(event) => {
														if (event.key === "Escape") {
															event.preventDefault();
															setEditing(undefined);
														} else if (
															event.key === "Enter" &&
															(event.metaKey || event.ctrlKey)
														) {
															event.preventDefault();
															void saveNote();
														}
													}}
													aria-describedby={`note-shortcuts-${note.id}`}
													aria-keyshortcuts="Control+Enter Meta+Enter Escape"
													autoFocus
													rows={4}
												/>
												<span className="sr-only" id={`note-shortcuts-${note.id}`}>
													Press Control or Command plus Enter to save. Press Escape to cancel.
												</span>
												<div className="note-editor__actions">
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setEditing(undefined)}
													>
														<X aria-hidden="true" size={13} /> Cancel
													</Button>
													<Button
														size="sm"
														onClick={() => void saveNote()}
														disabled={!editing.body.trim()}
													>
														<Check aria-hidden="true" size={13} /> Save
													</Button>
												</div>
											</div>
										) : (
											<>
												<div className="note-card__meta">
													<span>{formatNoteLocation(note)}</span>
													<div className="note-card__badges">
														<Badge variant="muted">{formatStatus(note.status)}</Badge>
														<Badge
															variant={
																note.anchorState === "orphaned" ? "muted" : undefined
															}
														>
															{formatKind(note.kind)}
														</Badge>
													</div>
												</div>
												<p>{note.body}</p>
												{note.resolution ? (
													<div className="note-resolution">
														<strong>{formatStatus(note.status)}</strong>
														{note.resolution.summary ?? note.resolution.blockedReason}
														{note.resolution.verification ? (
															<span>Verified: {note.resolution.verification}</span>
														) : undefined}
													</div>
												) : undefined}
												<div className="note-card__actions">
													<Button
														variant="ghost"
														size="sm"
														onClick={() => void revealNote(note.id)}
														disabled={!note.anchor || note.anchorState === "orphaned"}
														aria-label={`Reveal ${noteSummary(note)} in editor`}
													>
														<Eye aria-hidden="true" size={13} /> Reveal
													</Button>
													<Button
														variant="ghost"
														size="icon"
														aria-label={`Edit ${noteSummary(note)}`}
														title="Edit note"
														onClick={() =>
															setEditing({
																id: note.id,
																body: note.body,
																kind: note.kind
															})
														}
													>
														<Pencil aria-hidden="true" size={13} />
													</Button>
													<Button
														variant="ghost"
														size="icon"
														aria-label={
															note.status === "resolved"
																? `Reopen ${noteSummary(note)}`
																: `Resolve ${noteSummary(note)}`
														}
														title={
															note.status === "resolved" ? "Reopen note" : "Resolve note"
														}
														onClick={() => void toggleResolved(note)}
													>
														<Check aria-hidden="true" size={13} />
													</Button>
													<Button
														variant="ghost"
														size="icon"
														aria-label={`Delete ${noteSummary(note)}`}
														title="Delete note"
														onClick={() => void deleteNote(note.id)}
													>
														<Trash2 aria-hidden="true" size={13} />
													</Button>
												</div>
											</>
										)}
									</article>
								))}
							</div>
						</section>
					))
				)}
			</section>

			{preview ? (
				<section
					className="bundle-preview"
					id="review-bundle-preview"
					aria-labelledby="review-bundle-preview-title"
					ref={previewRef}
					tabIndex={-1}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							closePreview();
						}
					}}
				>
					<header>
						<div>
							<strong id="review-bundle-preview-title">Bundle preview</strong>
							<span>
								{preview.noteCount} notes · {preview.fileCount} files
								{preview.orphanedCount ? ` · ${preview.orphanedCount} orphaned` : ""}
							</span>
						</div>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Close preview"
							title="Close preview"
							onClick={closePreview}
						>
							<X aria-hidden="true" size={14} />
						</Button>
					</header>
					<pre aria-label="Review bundle contents" tabIndex={0}>
						{preview.markdown}
					</pre>
				</section>
			) : undefined}
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

function groupNotes(notes: readonly ReviewNote[]): [string, ReviewNote[]][] {
	const groups = new Map<string, ReviewNote[]>();
	for (const note of notes) {
		const filePath = note.anchor?.filePath ?? "Unattached notes";
		const group = groups.get(filePath) ?? [];
		group.push(note);
		groups.set(filePath, group);
	}
	return [...groups.entries()];
}

function formatNoteLocation(note: ReviewNote): string {
	if (!note.anchor || note.anchorState === "orphaned") {
		return "Location unavailable";
	}
	const range = note.anchor.range;
	const lines =
		range.startLine === range.endLine ? `Line ${range.startLine}` : `Lines ${range.startLine}–${range.endLine}`;
	return note.anchorState === "moved" ? `${lines} · moved` : lines;
}

function formatKind(kind: ReviewNoteKind): string {
	return { change: "Change", question: "Question", explain: "Explain", test: "Test" }[kind];
}

function formatStatus(status: ReviewNote["status"]): string {
	return {
		draft: "Open",
		in_progress: "In progress",
		addressed: "Addressed",
		blocked: "Blocked",
		resolved: "Resolved"
	}[status];
}

function isActionableStatus(status: ReviewNote["status"]): boolean {
	return status === "draft" || status === "in_progress" || status === "blocked";
}

function noteSummary(note: ReviewNote): string {
	const summary = note.body.replace(/\s+/g, " ").trim();
	return `note “${summary.length > 60 ? `${summary.slice(0, 57)}…` : summary}”`;
}

function isStateEnvelope(value: unknown): value is ReviewPanelStateEnvelope {
	return Boolean(
		value && typeof value === "object" && "sourceId" in value && "revision" in value && "value" in value
	);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Unknown error";
}

function diagnosticStateData(envelope: ReviewPanelStateEnvelope) {
	return {
		revision: envelope.revision,
		noteCount: envelope.value.notes.length,
		hasActiveFile: envelope.value.workspace.activeFile !== undefined
	};
}
