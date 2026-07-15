export const enum AiReviewCommand {
	OpenReviewPanel = "aireview.openReviewPanel",
	AddReviewNote = "aireview.addReviewNote",
	OpenSettings = "aireview.openSettings",
	CreateComment = "aireview.comment.create",
	EditComment = "aireview.comment.edit",
	SaveComment = "aireview.comment.save",
	CancelCommentEdit = "aireview.comment.cancelEdit",
	DeleteComment = "aireview.comment.delete",
	ResolveComment = "aireview.comment.resolve",
	ReopenComment = "aireview.comment.reopen",
	ReviewViewFocus = "aireview.reviewView.focus",
	ReviewViewOpen = "aireview.reviewView.open",
	CodexOpenSidebar = "chatgpt.openSidebar",
	CodexNewChat = "chatgpt.newChat",
	CopilotCliOpenInCopilotCli = "github.copilot.cli.openInCopilotCLI"
}

export interface CommandArgumentTypeMapping {
	[AiReviewCommand.OpenReviewPanel]: [];
	[AiReviewCommand.AddReviewNote]: [];
	[AiReviewCommand.OpenSettings]: [];
	[AiReviewCommand.CreateComment]: [reply: unknown];
	[AiReviewCommand.EditComment]: [comment: unknown];
	[AiReviewCommand.SaveComment]: [comment: unknown];
	[AiReviewCommand.CancelCommentEdit]: [comment: unknown];
	[AiReviewCommand.DeleteComment]: [value: unknown];
	[AiReviewCommand.ResolveComment]: [thread: unknown];
	[AiReviewCommand.ReopenComment]: [thread: unknown];
	[AiReviewCommand.ReviewViewFocus]: [];
	[AiReviewCommand.ReviewViewOpen]: [];
	[AiReviewCommand.CodexOpenSidebar]: [];
	[AiReviewCommand.CodexNewChat]: [];
	[AiReviewCommand.CopilotCliOpenInCopilotCli]: [];
}

export interface CommandResultTypeMapping {
	[AiReviewCommand.OpenReviewPanel]: void;
	[AiReviewCommand.AddReviewNote]: void;
	[AiReviewCommand.OpenSettings]: void;
	[AiReviewCommand.CreateComment]: void;
	[AiReviewCommand.EditComment]: void;
	[AiReviewCommand.SaveComment]: void;
	[AiReviewCommand.CancelCommentEdit]: void;
	[AiReviewCommand.DeleteComment]: void;
	[AiReviewCommand.ResolveComment]: void;
	[AiReviewCommand.ReopenComment]: void;
	[AiReviewCommand.ReviewViewFocus]: void;
	[AiReviewCommand.ReviewViewOpen]: void;
	[AiReviewCommand.CodexOpenSidebar]: void;
	[AiReviewCommand.CodexNewChat]: void;
	[AiReviewCommand.CopilotCliOpenInCopilotCli]: void;
}

export type CommandId = keyof CommandArgumentTypeMapping & keyof CommandResultTypeMapping;
export type CommandArguments<TCommand extends CommandId> = CommandArgumentTypeMapping[TCommand];
export type CommandResult<TCommand extends CommandId> = CommandResultTypeMapping[TCommand];
export type CommandWithoutArguments = {
	[TCommand in CommandId]: CommandArguments<TCommand> extends [] ? TCommand : never;
}[CommandId];
export type CommandCallback<TCommand extends CommandId> = (
	...args: CommandArguments<TCommand>
) => CommandResult<TCommand> | Thenable<CommandResult<TCommand>>;
