import * as React from "react";
import {
	Check,
	CheckCircle2,
	ChevronRight,
	Copy,
	MessageSquare,
	Pencil,
	RefreshCw,
	Settings,
	Trash2
} from "lucide-react";
import type { MessageConnection } from "vscode-jsonrpc/browser";
import {
	ReviewRpc,
	reviewIntentPresentation,
	type ReviewComment,
	type ReviewCommentIntent,
	type ReviewCommentsPreview,
	type ReviewPanelStateEnvelope
} from "../../common/reviewProtocol";
import { shouldAcceptStateEnvelope } from "../../common/webviewProtocol";
import { usePersistedWebviewState } from "../usePersistedWebviewState";
import type { WebviewDiagnostics } from "../webviewDiagnostics";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { getCopyCommentIds, groupReviewComments } from "./reviewViewModel";

export interface AppProps {
	readonly connection: MessageConnection;
	readonly diagnostics: WebviewDiagnostics;
}

type ActiveView = "review" | "resolved";
type MessageTone = "info" | "error";

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
	readonly activeView: ActiveView;
}

interface StatusMessage {
	readonly text: string;
	readonly tone: MessageTone;
}

interface PreviewState extends ReviewCommentsPreview {
	readonly comments: readonly ReviewComment[];
}

export function App({ connection, diagnostics }: AppProps) {
	const [remoteState, dispatchRemoteState] = React.useReducer(reduceRemoteReviewState, {
		status: "loading"
	});
	const [webviewState, setWebviewState] = usePersistedWebviewState(normalizeWebviewState);
	const [selectionMode, setSelectionMode] = React.useState(false);
	const [selectedIds, setSelectedIds] = React.useState<readonly string[]>([]);
	const [editing, setEditing] = React.useState<EditingComment>();
	const [expandedBodies, setExpandedBodies] = React.useState<readonly string[]>([]);
	const [expandedResolved, setExpandedResolved] = React.useState<readonly string[]>([]);
	const [preview, setPreview] = React.useState<PreviewState>();
	const [showRawPreview, setShowRawPreview] = React.useState(false);
	const [busy, setBusy] = React.useState<string>();
	const [message, setMessage] = React.useState<StatusMessage>();
	const [confirmClearResolved, setConfirmClearResolved] = React.useState(false);
	const messageTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const previewRef = React.useRef<HTMLElement>(null);

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

	React.useEffect(
		() => () => {
			if (messageTimer.current) {
				clearTimeout(messageTimer.current);
			}
		},
		[]
	);

	const state = remoteState.status === "ready" ? remoteState.envelope.value : undefined;
	const groups = React.useMemo(() => groupReviewComments(state?.comments ?? []), [state?.comments]);
	const copyIds = React.useMemo(
		() => getCopyCommentIds(groups.ready, selectionMode, selectedIds),
		[groups.ready, selectedIds, selectionMode]
	);

	React.useEffect(() => {
		if (preview) {
			previewRef.current?.focus();
		}
	}, [preview]);

	React.useEffect(() => {
		function handleEscape(event: KeyboardEvent): void {
			if (event.key !== "Escape") {
				return;
			}
			if (confirmClearResolved) {
				setConfirmClearResolved(false);
			} else if (preview) {
				closePreview();
			} else if (selectionMode) {
				cancelSelection();
			} else {
				return;
			}
			event.preventDefault();
		}
		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	});

	function flashMessage(text: string, tone: MessageTone = "info"): void {
		if (messageTimer.current) {
			clearTimeout(messageTimer.current);
		}
		setMessage({ text, tone });
		messageTimer.current = setTimeout(() => setMessage(undefined), 3_000);
	}

	async function runOperation<T>(
		name: Parameters<WebviewDiagnostics["startOperation"]>[0],
		request: () => Promise<T>,
		onSuccess?: (result: T) => void
	): Promise<T | undefined> {
		setBusy(name);
		const operation = diagnostics.startOperation(name);
		try {
			const result = await request();
			operation.complete(isStateEnvelope(result) ? diagnosticStateData(result) : undefined);
			onSuccess?.(result);
			return result;
		} catch (error) {
			operation.fail(error);
			flashMessage(getErrorMessage(error), "error");
			return undefined;
		} finally {
			setBusy(undefined);
		}
	}

	async function refresh(): Promise<void> {
		await runOperation(
			"state.refresh",
			() => connection.sendRequest(ReviewRpc.getState),
			(envelope) => {
				receiveState(envelope);
				flashMessage("Review comments refreshed.");
			}
		);
	}

	async function openSettings(): Promise<void> {
		await runOperation("settings.open", () => connection.sendRequest(ReviewRpc.openSettings));
	}

	async function revealComment(id: string): Promise<void> {
		await runOperation("comment.reveal", () => connection.sendRequest(ReviewRpc.revealComment, { id }));
	}

	async function deleteComment(id: string): Promise<void> {
		await runOperation(
			"comment.delete",
			() => connection.sendRequest(ReviewRpc.deleteComment, { id }),
			(envelope) => {
				receiveState(envelope);
			}
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
			(envelope) => {
				receiveState(envelope);
				setEditing(undefined);
				flashMessage("Comment updated.");
			}
		);
	}

	async function reattachComment(comment: ReviewComment): Promise<void> {
		await runOperation(
			"comment.reattach",
			() =>
				connection.sendRequest(ReviewRpc.reattachOpenComment, {
					id: comment.id,
					expectedVersion: comment.version
				}),
			(envelope) => {
				receiveState(envelope);
				flashMessage("Comment reattached.");
			}
		);
	}

	async function createFollowUp(comment: ReviewComment): Promise<void> {
		await runOperation(
			"comment.followUp",
			() =>
				connection.sendRequest(ReviewRpc.createUnresolvedFollowUp, {
					id: comment.id,
					expectedVersion: comment.version
				}),
			(envelope) => {
				receiveState(envelope);
				flashMessage("Created a new ready comment.");
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
				flashMessage(
					`Cleared ${result.clearedCount} resolved ${result.clearedCount === 1 ? "comment" : "comments"}.`
				);
			}
		);
	}

	async function previewComments(): Promise<void> {
		if (copyIds.length === 0) {
			return;
		}
		const comments = copyIds
			.map((id) => groups.ready.find((comment) => comment.id === id))
			.filter((comment): comment is ReviewComment => Boolean(comment));
		await runOperation(
			"comments.preview",
			() => connection.sendRequest(ReviewRpc.previewComments, { commentIds: copyIds }),
			(result) => {
				setShowRawPreview(false);
				setPreview({ ...result, comments });
			}
		);
	}

	async function copyComments(commentIds: readonly string[], closeAfterCopy = false): Promise<void> {
		if (commentIds.length === 0) {
			return;
		}
		await runOperation(
			"comments.copy",
			() => connection.sendRequest(ReviewRpc.copyComments, { commentIds }),
			(result) => {
				flashMessage(result.message);
				setSelectionMode(false);
				setSelectedIds([]);
				if (closeAfterCopy) {
					setPreview(undefined);
				}
			}
		);
	}

	function enterSelection(): void {
		setSelectedIds(groups.ready.map((comment) => comment.id));
		setSelectionMode(true);
	}

	function cancelSelection(): void {
		setSelectionMode(false);
		setSelectedIds([]);
	}

	function toggleSelection(id: string): void {
		setSelectedIds((current) =>
			current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]
		);
	}

	function closePreview(): void {
		setPreview(undefined);
		setShowRawPreview(false);
	}

	function receiveState(envelope: ReviewPanelStateEnvelope): void {
		dispatchRemoteState({ type: "received", envelope });
	}

	function setActiveView(activeView: ActiveView): void {
		setWebviewState({ activeView });
	}

	return (
		<main className="app-shell" aria-busy={Boolean(busy)}>
			<h1 className="sr-only">Review comments</h1>

			<header className="workspace-header">
				<div className="workspace-header__identity" title={state?.workspace.uri}>
					<strong>{state?.workspace.name ?? "Loading"}</strong>
					{state?.workspace.branch ? <span>· {state.workspace.branch}</span> : undefined}
				</div>
				<div className="workspace-header__actions">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Refresh review comments"
						title="Refresh"
						disabled={Boolean(busy)}
						onClick={() => void refresh()}
					>
						<RefreshCw aria-hidden="true" size={14} />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Open Request Changes settings"
						title="Settings"
						disabled={Boolean(busy)}
						onClick={() => void openSettings()}
					>
						<Settings aria-hidden="true" size={14} />
					</Button>
				</div>
			</header>

			<nav className="review-tabs" aria-label="Review comment views">
				<Tab
					active={webviewState.activeView === "review"}
					label="Review"
					count={groups.reviewCount}
					onClick={() => setActiveView("review")}
				/>
				<Tab
					active={webviewState.activeView === "resolved"}
					label="Resolved"
					count={groups.resolved.length}
					onClick={() => setActiveView("resolved")}
				/>
			</nav>

			{remoteState.status === "error" ? (
				<div className="status-message status-message--error" role="alert">
					Unable to load review state: {remoteState.message}
				</div>
			) : undefined}
			{message ? (
				<div
					className={`status-message status-message--${message.tone}`}
					role={message.tone === "error" ? "alert" : "status"}
					aria-live="polite"
				>
					{message.text}
				</div>
			) : undefined}

			<div className="view-scroll">
				{webviewState.activeView === "review" ? (
					<ReviewView
						groups={groups}
						selectionMode={selectionMode}
						selectedIds={selectedIds}
						editing={editing}
						expandedBodies={expandedBodies}
						busy={Boolean(busy)}
						onEnterSelection={enterSelection}
						onCancelSelection={cancelSelection}
						onSelectAll={() => setSelectedIds(groups.ready.map((comment) => comment.id))}
						onToggleSelection={toggleSelection}
						onEdit={setEditing}
						onChangeEdit={(body) => setEditing((current) => (current ? { ...current, body } : current))}
						onChangeEditIntent={(intent) =>
							setEditing((current) => (current ? { ...current, intent } : current))
						}
						onCancelEdit={() => setEditing(undefined)}
						onSaveEdit={() => void saveComment()}
						onToggleBody={(id) => setExpandedBodies((current) => toggleId(current, id))}
						onReveal={(id) => void revealComment(id)}
						onDelete={(id) => void deleteComment(id)}
						onReattach={(comment) => void reattachComment(comment)}
						onCreateFollowUp={(comment) => void createFollowUp(comment)}
						onViewResolved={() => setActiveView("resolved")}
					/>
				) : (
					<ResolvedView
						comments={groups.resolved}
						expandedIds={expandedResolved}
						busy={Boolean(busy)}
						onToggle={(id) => setExpandedResolved((current) => toggleId(current, id))}
						onReveal={(id) => void revealComment(id)}
						onDelete={(id) => void deleteComment(id)}
						onClear={() => setConfirmClearResolved(true)}
					/>
				)}
			</div>

			{webviewState.activeView === "review" && groups.ready.length > 0 ? (
				<footer className="copy-action-bar">
					<div className="copy-action-bar__content">
						<span>{selectionMode ? `${copyIds.length} selected` : ""}</span>
						<div className="copy-action-bar__actions">
							<LinkButton
								disabled={copyIds.length === 0 || Boolean(busy)}
								onClick={() => void previewComments()}
							>
								Preview
							</LinkButton>
							<Button
								size="sm"
								disabled={copyIds.length === 0 || Boolean(busy)}
								onClick={() => void copyComments(copyIds)}
							>
								<Copy aria-hidden="true" size={13} />
								{selectionMode ? `Copy ${copyIds.length}` : `Copy all ${groups.ready.length}`}
							</Button>
						</div>
					</div>
				</footer>
			) : undefined}

			{preview ? (
				<PreviewOverlay
					preview={preview}
					showRaw={showRawPreview}
					busy={Boolean(busy)}
					overlayRef={previewRef}
					onBack={closePreview}
					onToggleRaw={() => setShowRawPreview((current) => !current)}
					onCopy={() =>
						void copyComments(
							preview.comments.map((comment) => comment.id),
							true
						)
					}
				/>
			) : undefined}

			{confirmClearResolved ? (
				<ConfirmationOverlay
					count={groups.resolved.length}
					busy={Boolean(busy)}
					onCancel={() => setConfirmClearResolved(false)}
					onConfirm={() => void clearResolvedComments()}
				/>
			) : undefined}
		</main>
	);
}

interface ReviewViewProps {
	readonly groups: ReturnType<typeof groupReviewComments>;
	readonly selectionMode: boolean;
	readonly selectedIds: readonly string[];
	readonly editing: EditingComment | undefined;
	readonly expandedBodies: readonly string[];
	readonly busy: boolean;
	readonly onEnterSelection: () => void;
	readonly onCancelSelection: () => void;
	readonly onSelectAll: () => void;
	readonly onToggleSelection: (id: string) => void;
	readonly onEdit: (editing: EditingComment) => void;
	readonly onChangeEdit: (body: string) => void;
	readonly onChangeEditIntent: (intent: ReviewCommentIntent) => void;
	readonly onCancelEdit: () => void;
	readonly onSaveEdit: () => void;
	readonly onToggleBody: (id: string) => void;
	readonly onReveal: (id: string) => void;
	readonly onDelete: (id: string) => void;
	readonly onReattach: (comment: ReviewComment) => void;
	readonly onCreateFollowUp: (comment: ReviewComment) => void;
	readonly onViewResolved: () => void;
}

function ReviewView({
	groups,
	selectionMode,
	selectedIds,
	editing,
	expandedBodies,
	busy,
	onEnterSelection,
	onCancelSelection,
	onSelectAll,
	onToggleSelection,
	onEdit,
	onChangeEdit,
	onChangeEditIntent,
	onCancelEdit,
	onSaveEdit,
	onToggleBody,
	onReveal,
	onDelete,
	onReattach,
	onCreateFollowUp,
	onViewResolved
}: ReviewViewProps) {
	if (groups.reviewCount === 0) {
		return (
			<EmptyState
				icon={<MessageSquare aria-hidden="true" size={25} />}
				title="No active review comments"
				body={
					groups.resolved.length
						? "All current comments are resolved."
						: "Select code and add a review comment to get started."
				}
				action={groups.resolved.length ? { label: "View resolved", onClick: onViewResolved } : undefined}
			/>
		);
	}

	return (
		<div className="review-content">
			{groups.ready.length ? (
				<Section
					title="Ready for agent"
					count={groups.ready.length}
					toolbar={
						selectionMode ? (
							<div className="section-links">
								<LinkButton onClick={onSelectAll}>Select all</LinkButton>
								<LinkButton onClick={onCancelSelection}>Cancel</LinkButton>
							</div>
						) : (
							<LinkButton onClick={onEnterSelection}>Choose</LinkButton>
						)
					}
				>
					{groups.ready.map((comment) => (
						<CommentCard key={comment.id}>
							{editing?.id === comment.id ? (
								<EditForm
									editing={editing}
									busy={busy}
									onChange={onChangeEdit}
									onChangeIntent={onChangeEditIntent}
									onCancel={onCancelEdit}
									onSave={onSaveEdit}
								/>
							) : (
								<div className="selectable-card">
									{selectionMode ? (
										<SelectionCheckbox
											checked={selectedIds.includes(comment.id)}
											label={`Select ${comment.body} for AI`}
											onChange={() => onToggleSelection(comment.id)}
										/>
									) : undefined}
									<div className="selectable-card__content">
										<CardHeading comment={comment} onReveal={() => onReveal(comment.id)} />
										<ClampText
											text={comment.body}
											expanded={expandedBodies.includes(comment.id)}
											onToggle={() => onToggleBody(comment.id)}
										/>
										<div className="card-actions">
											<ItemAction
												label="Edit comment"
												icon={<Pencil aria-hidden="true" size={13} />}
												disabled={busy}
												onClick={() =>
													onEdit({
														id: comment.id,
														version: comment.version,
														body: comment.body,
														intent: comment.intent
													})
												}
											/>
											<ItemAction
												label="Delete comment"
												icon={<Trash2 aria-hidden="true" size={13} />}
												danger
												disabled={busy}
												onClick={() => onDelete(comment.id)}
											/>
										</div>
									</div>
								</div>
							)}
						</CommentCard>
					))}
				</Section>
			) : undefined}

			{groups.working.length ? (
				<Section title="In progress" count={groups.working.length}>
					{groups.working.map((comment) => (
						<CommentCard key={comment.id} dimmed>
							<CardHeading
								comment={comment}
								onReveal={() => onReveal(comment.id)}
								trailing={`${comment.claim?.client ?? "AI agent"} working…`}
							/>
							<ClampText
								text={comment.body}
								expanded={expandedBodies.includes(comment.id)}
								onToggle={() => onToggleBody(comment.id)}
							/>
						</CommentCard>
					))}
				</Section>
			) : undefined}

			{groups.attention.length ? (
				<Section title="Needs attention" count={groups.attention.length}>
					{groups.attention.map((comment) =>
						comment.status === "unresolved" ? (
							<UnresolvedCard
								key={comment.id}
								comment={comment}
								busy={busy}
								onReveal={onReveal}
								onDelete={onDelete}
								onCreateFollowUp={onCreateFollowUp}
							/>
						) : editing?.id === comment.id ? (
							<CommentCard key={comment.id}>
								<EditForm
									editing={editing}
									busy={busy}
									onChange={onChangeEdit}
									onChangeIntent={onChangeEditIntent}
									onCancel={onCancelEdit}
									onSave={onSaveEdit}
								/>
							</CommentCard>
						) : (
							<OrphanedCard
								key={comment.id}
								comment={comment}
								busy={busy}
								expanded={expandedBodies.includes(comment.id)}
								onToggleBody={() => onToggleBody(comment.id)}
								onEdit={() =>
									onEdit({
										id: comment.id,
										version: comment.version,
										body: comment.body,
										intent: comment.intent
									})
								}
								onDelete={onDelete}
								onReattach={onReattach}
							/>
						)
					)}
				</Section>
			) : undefined}
		</div>
	);
}

function UnresolvedCard({
	comment,
	busy,
	onReveal,
	onDelete,
	onCreateFollowUp
}: {
	readonly comment: ReviewComment;
	readonly busy: boolean;
	readonly onReveal: (id: string) => void;
	readonly onDelete: (id: string) => void;
	readonly onCreateFollowUp: (comment: ReviewComment) => void;
}) {
	const result = comment.result?.outcome === "unresolved" ? comment.result : undefined;
	return (
		<CommentCard>
			<CardHeading comment={comment} onReveal={() => onReveal(comment.id)} trailing="Unresolved" warning />
			<p className="attention-copy">{result?.explanation ?? comment.body}</p>
			{result?.suggestedNewComment ? (
				<div className="suggestion">
					<span>Suggested next comment</span>
					<p>{result.suggestedNewComment}</p>
				</div>
			) : undefined}
			<div className="attention-actions">
				{result?.suggestedNewComment ? (
					<Button variant="secondary" size="sm" disabled={busy} onClick={() => onCreateFollowUp(comment)}>
						Create new comment
					</Button>
				) : (
					<span />
				)}
				<ItemAction
					label="Delete comment"
					icon={<Trash2 aria-hidden="true" size={13} />}
					danger
					disabled={busy}
					onClick={() => onDelete(comment.id)}
				/>
			</div>
		</CommentCard>
	);
}

function OrphanedCard({
	comment,
	busy,
	expanded,
	onToggleBody,
	onEdit,
	onDelete,
	onReattach
}: {
	readonly comment: ReviewComment;
	readonly busy: boolean;
	readonly expanded: boolean;
	readonly onToggleBody: () => void;
	readonly onEdit: () => void;
	readonly onDelete: (id: string) => void;
	readonly onReattach: (comment: ReviewComment) => void;
}) {
	return (
		<CommentCard>
			<div className="card-heading">
				<span className="intent-label intent-label--warning">Needs reattachment</span>
				<IntentLabel intent={comment.intent} />
			</div>
			<ClampText text={comment.body} expanded={expanded} onToggle={onToggleBody} />
			<p className="orphan-warning">The selected code can no longer be located safely.</p>
			<div className="attention-actions">
				<Button variant="secondary" size="sm" disabled={busy} onClick={() => onReattach(comment)}>
					Reattach
				</Button>
				<div className="card-actions">
					<ItemAction
						label="Edit comment"
						icon={<Pencil aria-hidden="true" size={13} />}
						disabled={busy}
						onClick={onEdit}
					/>
					<ItemAction
						label="Delete comment"
						icon={<Trash2 aria-hidden="true" size={13} />}
						danger
						disabled={busy}
						onClick={() => onDelete(comment.id)}
					/>
				</div>
			</div>
		</CommentCard>
	);
}

function ResolvedView({
	comments,
	expandedIds,
	busy,
	onToggle,
	onReveal,
	onDelete,
	onClear
}: {
	readonly comments: readonly ReviewComment[];
	readonly expandedIds: readonly string[];
	readonly busy: boolean;
	readonly onToggle: (id: string) => void;
	readonly onReveal: (id: string) => void;
	readonly onDelete: (id: string) => void;
	readonly onClear: () => void;
}) {
	if (comments.length === 0) {
		return (
			<EmptyState
				icon={<CheckCircle2 aria-hidden="true" size={25} />}
				title="No resolved comments yet"
				body="Completed agent results will appear here."
			/>
		);
	}
	return (
		<div className="resolved-content">
			<header className="resolved-toolbar">
				<span>Resolved · {comments.length}</span>
				<LinkButton disabled={busy} onClick={onClear}>
					Clear resolved
				</LinkButton>
			</header>
			{comments.map((comment) => {
				const result = comment.result?.outcome === "resolved" ? comment.result : undefined;
				const expanded = expandedIds.includes(comment.id);
				return (
					<CommentCard key={comment.id}>
						<div className="resolved-summary">
							<button
								type="button"
								className="resolved-summary__toggle"
								aria-expanded={expanded}
								onClick={() => onToggle(comment.id)}
							>
								<div className="card-heading">
									<span className="resolved-location">
										<Check aria-hidden="true" size={13} />
										{formatLocation(comment)}
									</span>
									<span className="resolved-summary__meta">
										<IntentLabel intent={comment.intent} />
										<ChevronRight
											aria-hidden="true"
											className={expanded ? "chevron chevron--expanded" : "chevron"}
											size={13}
										/>
									</span>
								</div>
								<strong>{result?.summary ?? comment.body}</strong>
								<span>{resolvedEvidence(result)}</span>
							</button>
							<div className="resolved-summary__actions">
								{comment.anchor && comment.anchorState !== "orphaned" ? (
									<LinkButton onClick={() => onReveal(comment.id)}>Open</LinkButton>
								) : undefined}
								<ItemAction
									label="Delete comment"
									icon={<Trash2 aria-hidden="true" size={13} />}
									danger
									disabled={busy}
									onClick={() => onDelete(comment.id)}
								/>
							</div>
						</div>
						{expanded ? (
							<div className="resolved-details">
								<Detail label="Original comment" value={comment.body} />
								<Detail label="Agent result" value={result?.summary} />
								{result?.changedFiles.length ? (
									<div className="detail">
										<span>Changed files</span>
										<ul>
											{result.changedFiles.map((file) => (
												<li key={file}>{file}</li>
											))}
										</ul>
									</div>
								) : undefined}
								<Detail label="Verification" value={result?.verification || "Not reported"} />
								<Detail label="Limitations" value={result?.limitations || "None reported"} />
							</div>
						) : undefined}
					</CommentCard>
				);
			})}
		</div>
	);
}

function PreviewOverlay({
	preview,
	showRaw,
	busy,
	overlayRef,
	onBack,
	onToggleRaw,
	onCopy
}: {
	readonly preview: PreviewState;
	readonly showRaw: boolean;
	readonly busy: boolean;
	readonly overlayRef: React.RefObject<HTMLElement | null>;
	readonly onBack: () => void;
	readonly onToggleRaw: () => void;
	readonly onCopy: () => void;
}) {
	return (
		<section className="preview-overlay" aria-labelledby="preview-title" ref={overlayRef} tabIndex={-1}>
			<header className="preview-header">
				<LinkButton onClick={onBack}>← Back</LinkButton>
				<strong id="preview-title">What will be copied</strong>
				<Button size="sm" disabled={busy} onClick={onCopy}>
					Copy
				</Button>
			</header>
			<div className="preview-counts">
				{preview.commentCount} {preview.commentCount === 1 ? "comment" : "comments"} · {preview.fileCount}{" "}
				{preview.fileCount === 1 ? "file" : "files"}
			</div>
			<div className="preview-body">
				{preview.comments.map((comment) => (
					<div className="preview-item" key={comment.id}>
						<div className="card-heading">
							<span>{formatLocation(comment)}</span>
							<IntentLabel intent={comment.intent} />
						</div>
						<p>{comment.body}</p>
					</div>
				))}
				<LinkButton onClick={onToggleRaw}>
					{showRaw ? "Hide raw instructions" : "View raw instructions"}
				</LinkButton>
				{showRaw ? <pre className="raw-preview">{preview.markdown}</pre> : undefined}
			</div>
		</section>
	);
}

function ConfirmationOverlay({
	count,
	busy,
	onCancel,
	onConfirm
}: {
	readonly count: number;
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	return (
		<div className="confirmation-backdrop" role="presentation">
			<section className="confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title">
				<strong id="clear-title">
					Clear {count} resolved {count === 1 ? "comment" : "comments"}?
				</strong>
				<p>This permanently deletes their comments and agent results. This action cannot be undone.</p>
				<div>
					<Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
						Cancel
					</Button>
					<Button variant="destructive" size="sm" disabled={busy} onClick={onConfirm}>
						Clear {count}
					</Button>
				</div>
			</section>
		</div>
	);
}

function Tab({
	active,
	label,
	count,
	onClick
}: {
	readonly active: boolean;
	readonly label: string;
	readonly count: number;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={active ? "review-tab review-tab--active" : "review-tab"}
			aria-current={active ? "page" : undefined}
			onClick={onClick}
		>
			{label} {count}
		</button>
	);
}

function Section({
	title,
	count,
	toolbar,
	children
}: {
	readonly title: string;
	readonly count: number;
	readonly toolbar?: React.ReactNode;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="comment-section" aria-label={`${title} review comments`}>
			<header className="section-header">
				<span>
					{title} <em>· {count}</em>
				</span>
				{toolbar}
			</header>
			{children}
		</section>
	);
}

function CommentCard({ children, dimmed = false }: { readonly children: React.ReactNode; readonly dimmed?: boolean }) {
	return <article className={dimmed ? "review-card review-card--dimmed" : "review-card"}>{children}</article>;
}

function CardHeading({
	comment,
	onReveal,
	trailing,
	warning = false
}: {
	readonly comment: ReviewComment;
	readonly onReveal: () => void;
	readonly trailing?: string;
	readonly warning?: boolean;
}) {
	return (
		<div className="card-heading">
			<FileLocation comment={comment} onReveal={onReveal} />
			{trailing ? (
				<span className={warning ? "intent-label intent-label--warning" : "agent-label"}>{trailing}</span>
			) : (
				<IntentLabel intent={comment.intent} />
			)}
		</div>
	);
}

function FileLocation({ comment, onReveal }: { readonly comment: ReviewComment; readonly onReveal: () => void }) {
	if (!comment.anchor || comment.anchorState === "orphaned") {
		return <span className="file-location">Needs reattachment</span>;
	}
	return (
		<button
			type="button"
			className="file-location file-location--button"
			title={comment.anchor.filePath}
			onClick={onReveal}
		>
			{formatLocation(comment)}
			{comment.anchorState === "moved" ? <em> · moved</em> : undefined}
		</button>
	);
}

function IntentLabel({ intent }: { readonly intent: ReviewCommentIntent }) {
	return <span className="intent-label">{reviewIntentPresentation[intent].label}</span>;
}

function ClampText({
	text,
	expanded,
	onToggle
}: {
	readonly text: string;
	readonly expanded: boolean;
	readonly onToggle: () => void;
}) {
	const isLong = text.length > 140 || text.split("\n").length > 3;
	return (
		<div className="clamp-text">
			<p className={expanded ? "clamp-text__copy clamp-text__copy--expanded" : "clamp-text__copy"}>{text}</p>
			{isLong ? <LinkButton onClick={onToggle}>{expanded ? "Show less" : "Show more"}</LinkButton> : undefined}
		</div>
	);
}

function EditForm({
	editing,
	busy,
	onChange,
	onChangeIntent,
	onCancel,
	onSave
}: {
	readonly editing: EditingComment;
	readonly busy: boolean;
	readonly onChange: (body: string) => void;
	readonly onChangeIntent: (intent: ReviewCommentIntent) => void;
	readonly onCancel: () => void;
	readonly onSave: () => void;
}) {
	return (
		<div className="comment-editor">
			<select
				aria-label="Comment category"
				value={editing.intent}
				onChange={(event) => onChangeIntent(event.target.value as ReviewCommentIntent)}
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
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						onCancel();
					} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						onSave();
					}
				}}
				autoFocus
				rows={4}
			/>
			<div className="editor-actions">
				<Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
				<Button size="sm" disabled={busy || !editing.body.trim()} onClick={onSave}>
					Save
				</Button>
			</div>
		</div>
	);
}

function SelectionCheckbox({
	checked,
	label,
	onChange
}: {
	readonly checked: boolean;
	readonly label: string;
	readonly onChange: () => void;
}) {
	return (
		<label className="selection-checkbox">
			<input type="checkbox" checked={checked} aria-label={label} onChange={onChange} />
			<span aria-hidden="true">{checked ? <Check size={11} /> : undefined}</span>
		</label>
	);
}

function ItemAction({
	label,
	icon,
	danger = false,
	disabled = false,
	onClick
}: {
	readonly label: string;
	readonly icon: React.ReactNode;
	readonly danger?: boolean;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={danger ? "item-action item-action--danger" : "item-action"}
			aria-label={label}
			title={label}
			disabled={disabled}
			onClick={onClick}
		>
			{icon}
		</button>
	);
}

function LinkButton({
	children,
	disabled,
	onClick
}: {
	readonly children: React.ReactNode;
	readonly disabled?: boolean;
	readonly onClick: () => void;
}) {
	return (
		<button type="button" className="link-button" disabled={disabled} onClick={onClick}>
			{children}
		</button>
	);
}

function Detail({ label, value }: { readonly label: string; readonly value: string | undefined }) {
	if (!value) {
		return undefined;
	}
	return (
		<div className="detail">
			<span>{label}</span>
			<p>{value}</p>
		</div>
	);
}

function EmptyState({
	icon,
	title,
	body,
	action
}: {
	readonly icon: React.ReactNode;
	readonly title: string;
	readonly body: string;
	readonly action?: { readonly label: string; readonly onClick: () => void };
}) {
	return (
		<div className="empty-state">
			<div className="empty-state__icon">{icon}</div>
			<strong>{title}</strong>
			<p>{body}</p>
			{action ? (
				<Button variant="secondary" size="sm" onClick={action.onClick}>
					{action.label}
				</Button>
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

function normalizeWebviewState(value: unknown): ReviewWebviewState {
	if (value === true || value === false) {
		return { activeView: value ? "resolved" : "review" };
	}
	if (!value || typeof value !== "object") {
		return { activeView: "review" };
	}
	const state = value as { readonly activeView?: unknown; readonly showResolved?: unknown };
	return {
		activeView: state.activeView === "resolved" || state.showResolved === true ? "resolved" : "review"
	};
}

function formatLocation(comment: ReviewComment): string {
	if (!comment.anchor || comment.anchorState === "orphaned") {
		return "Needs reattachment";
	}
	const fileName = comment.anchor.filePath.split("/").pop() || comment.anchor.filePath;
	return `${fileName}:${comment.anchor.range.startLine}`;
}

function resolvedEvidence(result: ReviewComment["result"]): string {
	if (!result || result.outcome !== "resolved") {
		return "Result details unavailable";
	}
	const fileCount = result.changedFiles.length;
	const changed = fileCount === 0 ? "No files changed" : `${fileCount} ${fileCount === 1 ? "file" : "files"}`;
	return result.verification ? `${changed} · Verification reported` : changed;
}

function toggleId(ids: readonly string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
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
