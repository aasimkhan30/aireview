export const enum RequestChangesCommand {
	OpenReviewPanel = "requestchanges.openReviewPanel",
	AddReviewComment = "requestchanges.addReviewComment",
	OpenSettings = "requestchanges.openSettings",
	CreateComment = "requestchanges.comment.create",
	EditComment = "requestchanges.comment.edit",
	SaveComment = "requestchanges.comment.save",
	CancelCommentEdit = "requestchanges.comment.cancelEdit",
	DeleteComment = "requestchanges.comment.delete",
	ResolveComment = "requestchanges.comment.resolve",
	ReopenComment = "requestchanges.comment.reopen",
	ReviewViewFocus = "requestchanges.reviewView.focus",
	ReviewViewOpen = "requestchanges.reviewView.open",
	CodexOpenSidebar = "chatgpt.openSidebar",
	CodexNewChat = "chatgpt.newChat",
	CopilotCliOpenInCopilotCli = "github.copilot.cli.openInCopilotCLI"
}

export interface CommandArgumentTypeMapping {
	[RequestChangesCommand.OpenReviewPanel]: [];
	[RequestChangesCommand.AddReviewComment]: [];
	[RequestChangesCommand.OpenSettings]: [];
	[RequestChangesCommand.CreateComment]: [reply: unknown];
	[RequestChangesCommand.EditComment]: [comment: unknown];
	[RequestChangesCommand.SaveComment]: [comment: unknown];
	[RequestChangesCommand.CancelCommentEdit]: [comment: unknown];
	[RequestChangesCommand.DeleteComment]: [value: unknown];
	[RequestChangesCommand.ResolveComment]: [thread: unknown];
	[RequestChangesCommand.ReopenComment]: [thread: unknown];
	[RequestChangesCommand.ReviewViewFocus]: [];
	[RequestChangesCommand.ReviewViewOpen]: [];
	[RequestChangesCommand.CodexOpenSidebar]: [];
	[RequestChangesCommand.CodexNewChat]: [];
	[RequestChangesCommand.CopilotCliOpenInCopilotCli]: [];
}

export interface CommandResultTypeMapping {
	[RequestChangesCommand.OpenReviewPanel]: void;
	[RequestChangesCommand.AddReviewComment]: void;
	[RequestChangesCommand.OpenSettings]: void;
	[RequestChangesCommand.CreateComment]: void;
	[RequestChangesCommand.EditComment]: void;
	[RequestChangesCommand.SaveComment]: void;
	[RequestChangesCommand.CancelCommentEdit]: void;
	[RequestChangesCommand.DeleteComment]: void;
	[RequestChangesCommand.ResolveComment]: void;
	[RequestChangesCommand.ReopenComment]: void;
	[RequestChangesCommand.ReviewViewFocus]: void;
	[RequestChangesCommand.ReviewViewOpen]: void;
	[RequestChangesCommand.CodexOpenSidebar]: void;
	[RequestChangesCommand.CodexNewChat]: void;
	[RequestChangesCommand.CopilotCliOpenInCopilotCli]: void;
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
