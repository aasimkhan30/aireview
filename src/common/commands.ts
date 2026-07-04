export const enum AiReviewCommand {
	OpenReviewPanel = "aireview.openReviewPanel",
	ReviewViewFocus = "aireview.reviewView.focus",
	ReviewViewOpen = "aireview.reviewView.open",
	CodexOpenSidebar = "chatgpt.openSidebar",
	CodexNewChat = "chatgpt.newChat",
	CopilotCliOpenInCopilotCli = "github.copilot.cli.openInCopilotCLI"
}

export interface CommandArgumentTypeMapping {
	[AiReviewCommand.OpenReviewPanel]: [];
	[AiReviewCommand.ReviewViewFocus]: [];
	[AiReviewCommand.ReviewViewOpen]: [];
	[AiReviewCommand.CodexOpenSidebar]: [];
	[AiReviewCommand.CodexNewChat]: [];
}

export interface CommandResultTypeMapping {
	[AiReviewCommand.OpenReviewPanel]: void;
	[AiReviewCommand.ReviewViewFocus]: void;
	[AiReviewCommand.ReviewViewOpen]: void;
	[AiReviewCommand.CodexOpenSidebar]: void;
	[AiReviewCommand.CodexNewChat]: void;
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
