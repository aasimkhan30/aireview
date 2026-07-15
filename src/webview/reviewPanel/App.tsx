import * as React from "react";
import {
	Check,
	ChevronRight,
	CircleCheckBig,
	Copy,
	Eye,
	FileText,
	MessageSquare,
	MessageSquarePlus,
	Pencil,
	RefreshCw,
	Trash2,
	X
} from "lucide-react";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import type {
	ReviewBundlePreview,
	ReviewNote,
	ReviewNoteKind,
	ReviewPanelStateEnvelope
} from "../../common/reviewProtocol";
import { ReviewRpc } from "../../common/reviewProtocol";
import { shouldAcceptStateEnvelope } from "../../common/webviewProtocol";
import { usePersistedWebviewState } from "../usePersistedWebviewState";
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
	const [confirmClearResolved, setConfirmClearResolved] = React.useState(false);
	const [showResolved, setShowResolved] = usePersistedWebviewState((value) => value === true);
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
	const activeGroupedNotes = React.useMemo(
		() => groupNotes((state?.notes ?? []).filter((note) => note.status !== "resolved")),
		[state?.notes]
	);
	const resolvedGroupedNotes = React.useMemo(
		() => groupNotes((state?.notes ?? []).filter((note) => note.status === "resolved")),
		[state?.notes]
	);
	const resolvedCount = resolvedGroupedNotes.reduce((count, [, notes]) => count + notes.length, 0);
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
		const resolving = note.status !== "resolved";
		await runOperation(
			"note.update",
			() =>
				connection.sendRequest(ReviewRpc.updateNote, {
					id: note.id,
					status: note.status === "resolved" ? "draft" : "resolved"
				}),
			(result) => {
				receiveState(result);
				setMessage(
					resolving
						? "Comment resolved and moved to resolved comments."
						: "Comment reopened and moved to active comments."
				);
			}
		);
	}

	async function clearResolvedNotes(): Promise<void> {
		const resolvedIds = state?.notes.filter((note) => note.status === "resolved").map((note) => note.id) ?? [];
		if (resolvedIds.length === 0) {
			return;
		}
		await runOperation(
			"note.delete",
			async () => {
				let result: ReviewPanelStateEnvelope | undefined;
				for (const id of resolvedIds) {
					result = await connection.sendRequest(ReviewRpc.deleteNote, { id });
				}
				if (!result) {
					throw new Error("No resolved comments were available to clear.");
				}
				return result;
			},
			(result) => {
				receiveState(result);
				setConfirmClearResolved(false);
				setShowResolved(false);
				setMessage(
					`${resolvedIds.length} resolved ${resolvedIds.length === 1 ? "comment" : "comments"} permanently deleted.`
				);
			}
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
						<h1>Review comments</h1>
						<div className="review-header__meta">
							{state?.workspace.name ?? "Loading"}
							{state?.workspace.branch ? ` · ${state.workspace.branch}` : ""}
						</div>
					</div>
				</div>
				<div className="review-header__actions">
					<Badge
						aria-label={`${actionableCount} open review ${actionableCount === 1 ? "comment" : "comments"}`}
					>
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
						aria-label="Refresh review comments"
						title="Refresh review comments"
						onClick={() => void refresh()}
						disabled={Boolean(busy)}
					>
						<RefreshCw aria-hidden="true" size={15} />
					</Button>
				</div>
			</header>
			{busy ? (
				<div className="sr-only" role="status" aria-live="polite">
					Updating Request Changes.
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

			<section className="review-notes" aria-label="Active review comments">
				{activeGroupedNotes.length === 0 ? (
					<div className="empty-state">
						{resolvedCount ? (
							<CircleCheckBig
								className="empty-state__icon empty-state__icon--success"
								aria-hidden="true"
								size={28}
							/>
						) : (
							<MessageSquarePlus className="empty-state__icon" aria-hidden="true" size={28} />
						)}
						<strong>{resolvedCount ? "No active review comments" : "No review comments yet"}</strong>
						<span>
							{resolvedCount
								? `${resolvedCount} resolved ${resolvedCount === 1 ? "comment is" : "comments are"} available below.`
								: "Select code, then use the comment-add button above or right-click and choose Add Review Comment."}
						</span>
					</div>
				) : (
					<ReviewNoteGroups
						groups={activeGroupedNotes}
						editing={editing}
						setEditing={setEditing}
						onSave={() => void saveNote()}
						onReveal={(id) => void revealNote(id)}
						onToggleResolved={(note) => void toggleResolved(note)}
						onDelete={(id) => void deleteNote(id)}
					/>
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
								{preview.noteCount} comments · {preview.fileCount} files
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

			{resolvedCount ? (
				<section className="resolved-notes" aria-label="Resolved review comments">
					<div className="resolved-notes__toolbar">
						<Button
							className="resolved-notes__toggle"
							variant="ghost"
							size="sm"
							aria-expanded={showResolved}
							aria-controls="resolved-review-comments"
							onClick={() => setShowResolved((visible) => !visible)}
						>
							<ChevronRight
								className={showResolved ? "resolved-notes__chevron--expanded" : undefined}
								aria-hidden="true"
								size={14}
							/>
							<span>{showResolved ? "Hide resolved" : "Show resolved"}</span>
							<Badge variant="muted">{resolvedCount}</Badge>
						</Button>
						<Button
							className="resolved-notes__clear"
							variant="ghost"
							size="sm"
							aria-label={`Clear ${resolvedCount} resolved ${resolvedCount === 1 ? "comment" : "comments"}`}
							onClick={() => setConfirmClearResolved(true)}
							disabled={Boolean(busy)}
						>
							<Trash2 aria-hidden="true" size={13} /> Clear resolved
						</Button>
					</div>
					{confirmClearResolved ? (
						<div className="resolved-notes__confirmation" role="alert">
							<span>
								Permanently delete {resolvedCount} resolved{" "}
								{resolvedCount === 1 ? "comment" : "comments"}?
							</span>
							<div>
								<Button variant="ghost" size="sm" onClick={() => setConfirmClearResolved(false)}>
									Cancel
								</Button>
								<Button
									variant="destructive"
									size="sm"
									onClick={() => void clearResolvedNotes()}
									disabled={Boolean(busy)}
								>
									Delete {resolvedCount}
								</Button>
							</div>
						</div>
					) : undefined}
					{showResolved ? (
						<div className="resolved-notes__content" id="resolved-review-comments">
							<ReviewNoteGroups
								groups={resolvedGroupedNotes}
								editing={editing}
								setEditing={setEditing}
								onSave={() => void saveNote()}
								onReveal={(id) => void revealNote(id)}
								onToggleResolved={(note) => void toggleResolved(note)}
								onDelete={(id) => void deleteNote(id)}
							/>
						</div>
					) : undefined}
				</section>
			) : undefined}
		</main>
	);
}

interface ReviewNoteGroupsProps {
	readonly groups: readonly [string, ReviewNote[]][];
	readonly editing: EditingNote | undefined;
	readonly setEditing: React.Dispatch<React.SetStateAction<EditingNote | undefined>>;
	readonly onSave: () => void;
	readonly onReveal: (id: string) => void;
	readonly onToggleResolved: (note: ReviewNote) => void;
	readonly onDelete: (id: string) => void;
}

function ReviewNoteGroups({
	groups,
	editing,
	setEditing,
	onSave,
	onReveal,
	onToggleResolved,
	onDelete
}: ReviewNoteGroupsProps) {
	return groups.map(([filePath, notes]) => (
		<section
			className="file-group"
			aria-label={`${filePath}, ${notes.length} ${notes.length === 1 ? "comment" : "comments"}`}
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
						aria-label={`${formatKind(note.kind)} comment, ${formatStatus(note.status)}, ${formatNoteLocation(note)}`}
						key={note.id}
					>
						{editing?.id === note.id ? (
							<div className="note-editor">
								<label className="sr-only" htmlFor={`note-kind-${note.id}`}>
									Comment type
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
									Review comment
								</label>
								<Textarea
									id={`note-body-${note.id}`}
									value={editing.body}
									onChange={(event) => setEditing({ ...editing, body: event.target.value })}
									onKeyDown={(event) => {
										if (event.key === "Escape") {
											event.preventDefault();
											setEditing(undefined);
										} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
											event.preventDefault();
											onSave();
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
									<Button variant="ghost" size="sm" onClick={() => setEditing(undefined)}>
										<X aria-hidden="true" size={13} /> Cancel
									</Button>
									<Button size="sm" onClick={onSave} disabled={!editing.body.trim()}>
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
										<Badge variant={note.anchorState === "orphaned" ? "muted" : undefined}>
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
										size="icon"
										onClick={() => onReveal(note.id)}
										disabled={!note.anchor || note.anchorState === "orphaned"}
										aria-label={`Reveal ${noteSummary(note)} in editor`}
										title="Reveal note in editor"
									>
										<Eye aria-hidden="true" size={13} />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Edit ${noteSummary(note)}`}
										title="Edit note"
										onClick={() => setEditing({ id: note.id, body: note.body, kind: note.kind })}
									>
										<Pencil aria-hidden="true" size={13} />
									</Button>
									<Button
										variant="ghost"
										size="sm"
										aria-label={
											note.status === "resolved"
												? `Reopen ${noteSummary(note)}`
												: `Resolve ${noteSummary(note)}`
										}
										title={note.status === "resolved" ? "Reopen note" : "Resolve note"}
										onClick={() => onToggleResolved(note)}
									>
										{note.status === "resolved" ? "Reopen" : "Resolve"}
									</Button>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Delete ${noteSummary(note)}`}
										title="Delete note"
										onClick={() => onDelete(note.id)}
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
	));
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
		const filePath = note.anchor?.filePath ?? "Unattached comments";
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
