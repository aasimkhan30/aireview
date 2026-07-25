import * as React from "react";
import {
	Check,
	ChevronRight,
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
import {
	reviewIntentPresentation,
	reviewStatusPresentation,
	type ReviewComment,
	type ReviewCommentIntent,
	type ReviewCommentsPreview,
	type ReviewPanelStateEnvelope
} from "../../common/reviewProtocol";
import { ReviewRpc } from "../../common/reviewProtocol";
import { shouldAcceptStateEnvelope } from "../../common/webviewProtocol";
import { reconcileSelectedCommentIds } from "../../review/reviewSelection";
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

interface EditingComment {
	readonly id: string;
	readonly version: number;
	readonly body: string;
	readonly intent: ReviewCommentIntent;
}

interface ReviewWebviewState {
	readonly showResolved: boolean;
	readonly selectedCommentIds: readonly string[];
	readonly selectionInitialized: boolean;
}

export function App({ connection, diagnostics }: AppProps) {
	const [remoteState, dispatchRemoteState] = React.useReducer(reduceRemoteReviewState, {
		status: "loading"
	});
	const [editing, setEditing] = React.useState<EditingComment>();
	const [preview, setPreview] = React.useState<ReviewCommentsPreview>();
	const [busy, setBusy] = React.useState<string>();
	const [message, setMessage] = React.useState<string>();
	const [confirmClearResolved, setConfirmClearResolved] = React.useState(false);
	const [webviewState, setWebviewState] = usePersistedWebviewState(normalizeWebviewState);
	const knownOpenIds = React.useRef<Set<string> | undefined>(undefined);
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
	const openComments = React.useMemo(
		() => (state?.comments ?? []).filter((comment) => comment.status === "open"),
		[state?.comments]
	);
	const workingComments = React.useMemo(
		() => (state?.comments ?? []).filter((comment) => comment.status === "in_progress"),
		[state?.comments]
	);
	const unresolvedComments = React.useMemo(
		() => (state?.comments ?? []).filter((comment) => comment.status === "unresolved"),
		[state?.comments]
	);
	const resolvedComments = React.useMemo(
		() => (state?.comments ?? []).filter((comment) => comment.status === "resolved"),
		[state?.comments]
	);
	const selectedIds = React.useMemo(
		() => new Set(webviewState.selectedCommentIds),
		[webviewState.selectedCommentIds]
	);
	const selectedOpenIds = openComments.filter((comment) => selectedIds.has(comment.id)).map((comment) => comment.id);

	React.useEffect(() => {
		if (!state) {
			return;
		}
		const currentOpenIds = new Set(
			state.comments.filter((comment) => comment.status === "open").map((comment) => comment.id)
		);
		setWebviewState((current) => {
			const previousOpenIds = knownOpenIds.current;
			const selectedCommentIds = reconcileSelectedCommentIds(
				current.selectedCommentIds,
				[...currentOpenIds],
				previousOpenIds,
				current.selectionInitialized
			);
			if (current.selectionInitialized && arraysEqual(selectedCommentIds, current.selectedCommentIds)) {
				return current;
			}
			return { ...current, selectionInitialized: true, selectedCommentIds };
		});
		knownOpenIds.current = currentOpenIds;
	}, [setWebviewState, state]);

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

	async function revealComment(id: string): Promise<void> {
		await runOperation("comment.reveal", () => connection.sendRequest(ReviewRpc.revealComment, { id }));
	}

	async function deleteComment(id: string): Promise<void> {
		await runOperation(
			"comment.delete",
			() => connection.sendRequest(ReviewRpc.deleteComment, { id }),
			receiveState
		);
	}

	async function saveComment(): Promise<void> {
		if (!editing?.body.trim()) {
			return;
		}
		await runOperation(
			"comment.edit",
			() =>
				connection.sendRequest(ReviewRpc.editOpenComment, {
					id: editing.id,
					expectedVersion: editing.version,
					body: editing.body,
					intent: editing.intent
				}),
			(result) => {
				receiveState(result);
				setEditing(undefined);
			}
		);
	}

	async function clearResolvedComments(): Promise<void> {
		await runOperation(
			"comments.clearResolved",
			() => connection.sendRequest(ReviewRpc.clearResolvedComments),
			(result) => {
				receiveState(result.state);
				setConfirmClearResolved(false);
				setWebviewState((current) => ({ ...current, showResolved: false }));
				setMessage(
					`Cleared ${result.clearedCount} resolved ${result.clearedCount === 1 ? "comment" : "comments"}.`
				);
			}
		);
	}

	async function previewComments(): Promise<void> {
		await runOperation(
			"comments.preview",
			() =>
				connection.sendRequest(ReviewRpc.previewComments, {
					commentIds: selectedOpenIds
				}),
			setPreview
		);
	}

	async function copyComments(): Promise<void> {
		await runOperation("comments.copy", () =>
			connection.sendRequest(ReviewRpc.copyComments, { commentIds: selectedOpenIds }).then((result) => {
				setMessage(result.message);
				return result;
			})
		);
	}

	function toggleSelection(id: string): void {
		setWebviewState((current) => ({
			...current,
			selectedCommentIds: current.selectedCommentIds.includes(id)
				? current.selectedCommentIds.filter((candidate) => candidate !== id)
				: [...current.selectedCommentIds, id]
		}));
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
					<Badge aria-label={`${openComments.length} open review comments`}>{openComments.length}</Badge>
					<Button
						ref={previewButtonRef}
						variant="ghost"
						size="icon"
						aria-label="Preview selected comments"
						title="Preview selected comments"
						onClick={() => void previewComments()}
						disabled={selectedOpenIds.length === 0 || Boolean(busy)}
					>
						<Eye aria-hidden="true" size={15} />
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

			<div className="review-sections">
				<StatusSection
					title="Open"
					comments={openComments}
					toolbar={
						openComments.length ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={() =>
									setWebviewState((current) => ({
										...current,
										selectedCommentIds:
											selectedOpenIds.length === openComments.length
												? []
												: openComments.map((comment) => comment.id)
									}))
								}
							>
								{selectedOpenIds.length === openComments.length ? "Clear selection" : "Select all"}
							</Button>
						) : undefined
					}
					empty={
						state ? (
							<div className="empty-state">
								<MessageSquarePlus className="empty-state__icon" aria-hidden="true" size={28} />
								<strong>No open review comments</strong>
								<span>Select code and add a review comment.</span>
							</div>
						) : undefined
					}
				>
					<CommentGroups
						comments={openComments}
						editing={editing}
						selectedIds={selectedIds}
						onToggleSelection={toggleSelection}
						setEditing={setEditing}
						onSave={() => void saveComment()}
						onReveal={(id) => void revealComment(id)}
						onDelete={(id) => void deleteComment(id)}
					/>
					{openComments.length ? (
						<div className="primary-copy-action">
							<Button
								onClick={() => void copyComments()}
								disabled={selectedOpenIds.length === 0 || Boolean(busy)}
							>
								<Copy aria-hidden="true" size={14} /> Copy {selectedOpenIds.length}{" "}
								{selectedOpenIds.length === 1 ? "comment" : "comments"} for AI
							</Button>
						</div>
					) : undefined}
				</StatusSection>

				{workingComments.length ? (
					<StatusSection title="Working" comments={workingComments}>
						<CommentGroups
							comments={workingComments}
							editing={editing}
							selectedIds={selectedIds}
							onToggleSelection={toggleSelection}
							setEditing={setEditing}
							onSave={() => void saveComment()}
							onReveal={(id) => void revealComment(id)}
							onDelete={(id) => void deleteComment(id)}
						/>
					</StatusSection>
				) : undefined}

				{unresolvedComments.length ? (
					<StatusSection title="Couldn’t resolve" comments={unresolvedComments}>
						<CommentGroups
							comments={unresolvedComments}
							editing={editing}
							selectedIds={selectedIds}
							onToggleSelection={toggleSelection}
							setEditing={setEditing}
							onSave={() => void saveComment()}
							onReveal={(id) => void revealComment(id)}
							onDelete={(id) => void deleteComment(id)}
						/>
					</StatusSection>
				) : undefined}

				{resolvedComments.length ? (
					<StatusSection
						title="Resolved"
						comments={resolvedComments}
						collapsed={!webviewState.showResolved}
						onToggleCollapsed={() =>
							setWebviewState((current) => ({
								...current,
								showResolved: !current.showResolved
							}))
						}
						toolbar={
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setConfirmClearResolved(true)}
								disabled={Boolean(busy)}
							>
								<Trash2 aria-hidden="true" size={13} /> Clear resolved
							</Button>
						}
					>
						{confirmClearResolved ? (
							<div className="resolved-confirmation" role="alert">
								<span>
									Remove {resolvedComments.length} resolved{" "}
									{resolvedComments.length === 1 ? "comment" : "comments"} from this workspace?
									<br />
									This permanently removes their comments and AI results.
								</span>
								<div>
									<Button variant="ghost" size="sm" onClick={() => setConfirmClearResolved(false)}>
										Cancel
									</Button>
									<Button
										variant="destructive"
										size="sm"
										onClick={() => void clearResolvedComments()}
									>
										Clear {resolvedComments.length}
									</Button>
								</div>
							</div>
						) : undefined}
						<CommentGroups
							comments={resolvedComments}
							editing={editing}
							selectedIds={selectedIds}
							onToggleSelection={toggleSelection}
							setEditing={setEditing}
							onSave={() => void saveComment()}
							onReveal={(id) => void revealComment(id)}
							onDelete={(id) => void deleteComment(id)}
						/>
					</StatusSection>
				) : undefined}
			</div>

			{preview ? (
				<section
					className="comments-preview"
					id="selected-comments-preview"
					aria-labelledby="selected-comments-preview-title"
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
							<strong id="selected-comments-preview-title">Selected comments preview</strong>
							<span>
								{preview.commentCount} comments · {preview.fileCount} files
								{preview.needsReattachmentCount
									? ` · ${preview.needsReattachmentCount} need reattachment`
									: ""}
							</span>
						</div>
						<Button variant="ghost" size="icon" aria-label="Close preview" onClick={closePreview}>
							<X aria-hidden="true" size={14} />
						</Button>
					</header>
					<pre aria-label="Selected comments contents" tabIndex={0}>
						{preview.markdown}
					</pre>
				</section>
			) : undefined}
		</main>
	);
}

interface StatusSectionProps {
	readonly title: string;
	readonly comments: readonly ReviewComment[];
	readonly toolbar?: React.ReactNode;
	readonly empty?: React.ReactNode;
	readonly collapsed?: boolean;
	readonly onToggleCollapsed?: () => void;
	readonly children?: React.ReactNode;
}

function StatusSection({
	title,
	comments,
	toolbar,
	empty,
	collapsed = false,
	onToggleCollapsed,
	children
}: StatusSectionProps) {
	return (
		<section className="status-section" aria-label={`${title} review comments`}>
			<header className="status-section__header">
				{onToggleCollapsed ? (
					<Button
						variant="ghost"
						size="sm"
						className="status-section__toggle"
						aria-expanded={!collapsed}
						onClick={onToggleCollapsed}
					>
						<ChevronRight
							className={!collapsed ? "status-section__chevron--expanded" : undefined}
							aria-hidden="true"
							size={14}
						/>
						{title.toUpperCase()} · {comments.length}
					</Button>
				) : (
					<strong>
						{title.toUpperCase()} · {comments.length}
					</strong>
				)}
				{toolbar}
			</header>
			{collapsed ? undefined : comments.length ? children : empty}
		</section>
	);
}

interface CommentGroupsProps {
	readonly comments: readonly ReviewComment[];
	readonly editing: EditingComment | undefined;
	readonly selectedIds: ReadonlySet<string>;
	readonly onToggleSelection: (id: string) => void;
	readonly setEditing: React.Dispatch<React.SetStateAction<EditingComment | undefined>>;
	readonly onSave: () => void;
	readonly onReveal: (id: string) => void;
	readonly onDelete: (id: string) => void;
}

function CommentGroups({
	comments,
	editing,
	selectedIds,
	onToggleSelection,
	setEditing,
	onSave,
	onReveal,
	onDelete
}: CommentGroupsProps) {
	return groupComments(comments).map(([filePath, fileComments]) => (
		<section className="file-group" key={filePath}>
			<header className="file-group__header">
				<FileText aria-hidden="true" size={14} />
				<span title={filePath}>{filePath}</span>
				<Badge variant="muted">{fileComments.length}</Badge>
			</header>
			<div className="file-group__comments">
				{fileComments.map((comment) => (
					<article
						className={`comment-card comment-card--${comment.status}`}
						aria-label={`${reviewIntentPresentation[comment.intent].label} comment, ${
							reviewStatusPresentation[comment.status].label
						}, ${formatCommentLocation(comment)}`}
						key={comment.id}
					>
						{editing?.id === comment.id ? (
							<div className="comment-editor">
								<select
									aria-label="Comment intent"
									value={editing.intent}
									onChange={(event) =>
										setEditing({
											...editing,
											intent: event.target.value as ReviewCommentIntent
										})
									}
								>
									{Object.entries(reviewIntentPresentation).map(([intent, presentation]) => (
										<option key={intent} value={intent}>
											{presentation.label}
										</option>
									))}
								</select>
								<Textarea
									aria-label="Review comment"
									value={editing.body}
									onChange={(event) => setEditing({ ...editing, body: event.target.value })}
									onKeyDown={(event) => {
										if (event.key === "Escape") {
											setEditing(undefined);
										} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
											event.preventDefault();
											onSave();
										}
									}}
									autoFocus
									rows={4}
								/>
								<div className="comment-editor__actions">
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
								<div className="comment-card__heading">
									{comment.status === "open" ? (
										<input
											type="checkbox"
											checked={selectedIds.has(comment.id)}
											onChange={() => onToggleSelection(comment.id)}
											aria-label={`Select ${commentSummary(comment)} for AI`}
										/>
									) : undefined}
									<div>
										<strong>{reviewIntentPresentation[comment.intent].label}</strong>
										<span>{formatCommentLocation(comment)}</span>
									</div>
								</div>
								<p>{comment.body}</p>
								{comment.status === "in_progress" ? (
									<div className="comment-result">An AI agent is working on this comment.</div>
								) : undefined}
								{comment.result ? <ResultCard comment={comment} /> : undefined}
								<div className="comment-card__actions">
									<Button
										variant="ghost"
										size="icon"
										onClick={() => onReveal(comment.id)}
										disabled={!comment.anchor || comment.anchorState === "orphaned"}
										aria-label={`Reveal ${commentSummary(comment)} in editor`}
										title="Reveal in editor"
									>
										<Eye aria-hidden="true" size={13} />
									</Button>
									{comment.status === "open" ? (
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Edit ${commentSummary(comment)}`}
											title="Edit comment"
											onClick={() =>
												setEditing({
													id: comment.id,
													version: comment.version,
													body: comment.body,
													intent: comment.intent
												})
											}
										>
											<Pencil aria-hidden="true" size={13} />
										</Button>
									) : undefined}
									{comment.status !== "in_progress" ? (
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Delete ${commentSummary(comment)}`}
											title="Delete comment"
											onClick={() => onDelete(comment.id)}
										>
											<Trash2 aria-hidden="true" size={13} />
										</Button>
									) : undefined}
								</div>
							</>
						)}
					</article>
				))}
			</div>
		</section>
	));
}

function ResultCard({ comment }: { readonly comment: ReviewComment }) {
	const result = comment.result!;
	if (result.outcome === "unresolved") {
		return (
			<div className="comment-result">
				<strong>Couldn’t resolve</strong>
				<span>{result.explanation}</span>
				{result.suggestedNewComment ? (
					<>
						<strong>Suggested new comment</strong>
						<span>“{result.suggestedNewComment}”</span>
					</>
				) : undefined}
			</div>
		);
	}
	return (
		<div className="comment-result">
			<strong>Resolved by {result.client}</strong>
			<span>{result.summary}</span>
			{result.changedFiles.length ? (
				<>
					<strong>Changed files</strong>
					<ul>
						{result.changedFiles.map((file) => (
							<li key={file}>{file}</li>
						))}
					</ul>
				</>
			) : undefined}
			{result.verification ? (
				<>
					<strong>Verification</strong>
					<span>{result.verification}</span>
				</>
			) : undefined}
			{result.limitations ? (
				<>
					<strong>Limitations</strong>
					<span>{result.limitations}</span>
				</>
			) : undefined}
		</div>
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

function groupComments(comments: readonly ReviewComment[]): [string, ReviewComment[]][] {
	const groups = new Map<string, ReviewComment[]>();
	for (const comment of comments) {
		const filePath = comment.anchor?.filePath ?? "Needs reattachment";
		const group = groups.get(filePath) ?? [];
		group.push(comment);
		groups.set(filePath, group);
	}
	return [...groups.entries()];
}

function formatCommentLocation(comment: ReviewComment): string {
	if (!comment.anchor || comment.anchorState === "orphaned") {
		return "Needs reattachment";
	}
	const range = comment.anchor.range;
	const lines =
		range.startLine === range.endLine ? `Line ${range.startLine}` : `Lines ${range.startLine}–${range.endLine}`;
	return comment.anchorState === "moved" ? `${lines} · moved` : lines;
}

function commentSummary(comment: ReviewComment): string {
	const summary = comment.body.replace(/\s+/g, " ").trim();
	return `comment “${summary.length > 60 ? `${summary.slice(0, 57)}…` : summary}”`;
}

function normalizeWebviewState(value: unknown): ReviewWebviewState {
	if (value === true || value === false) {
		return { showResolved: value, selectedCommentIds: [], selectionInitialized: false };
	}
	if (!value || typeof value !== "object") {
		return { showResolved: false, selectedCommentIds: [], selectionInitialized: false };
	}
	const state = value as Partial<ReviewWebviewState>;
	return {
		showResolved: state.showResolved === true,
		selectedCommentIds: Array.isArray(state.selectedCommentIds)
			? state.selectedCommentIds.filter((id): id is string => typeof id === "string")
			: [],
		selectionInitialized: state.selectionInitialized === true
	};
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
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
		commentCount: envelope.value.comments.length,
		hasActiveFile: envelope.value.workspace.activeFile !== undefined
	};
}
