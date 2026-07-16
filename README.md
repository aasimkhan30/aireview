# Request Changes

Request Changes is a VS Code extension for reviewing agent-written code before you accept it. It gives you a pull-request-style review workflow inside your editor: select code, leave inline comments, and ask your coding agent to make the requested changes.

Use it when an agent has produced code that is close, but still needs human review, follow-up questions, explanations, or tests.

## What you can do

- Leave review comments directly on selected code in VS Code.
- Track comments in the **Review Comments** sidebar, grouped by file and status.
- Mark comments as **Change**, **Question**, **Explain**, or **Add Test**.
- Send open review comments back to Codex, Claude Code, GitHub Copilot CLI, or GitHub Copilot in VS Code.
- Keep comments visible until you decide the agent's response is acceptable.
- Resolve, reopen, or clear comments without losing track of the review.

## How to use Request Changes

1. Open the workspace that contains the code you want to review.

2. Review the code your agent wrote.

3. Select the exact code that needs feedback.

4. Add a review comment.

    Run **Request Changes: Add Review Comment to Selection** from the Command Palette, right-click the selected code, or use the editor comment gutter.

5. Write the feedback you want the agent to handle.

    New comments default to **Change**. You can also mark a comment as **Question**, **Explain**, or **Add Test**.

6. Open the **Review Comments** view.

    The sidebar groups comments by file and shows whether each comment is Open, In progress, Addressed, Blocked, or Resolved.

7. Connect your coding agent.

    Run **Request Changes: Open Settings**, or use the gear icon in the **Review Comments** view. Install the integration for the agent you want to use at Workspace or User scope when an install option is shown.

8. Ask the agent to address your review comments.

    Request Changes is explicit: agents only read comments when you ask them to use Request Changes or `#requestchanges`.

9. Review the agent's response.

    Agents report each comment as **Addressed** or **Blocked** and summarize what happened. Addressed comments still need human review.

10. Resolve comments when you accept the result.

    Agents do not resolve comments for you. Final acceptance stays with the person reviewing the code.

## Product tour

### Review agent-written code at a glance

Comments stay grouped by file while their Open, In progress, Addressed, and Blocked states make review progress easy to scan.

![Request Changes sidebar with review comments grouped by file and status](docs/images/review-comments-overview.png)

### Keep reviews attached to code

Native VS Code comment threads keep each request or question beside the exact code under review.

![VS Code editor showing Change and Question review comments attached to selected TypeScript lines](docs/images/inline-review-comments.png)

### Resolve without losing history

Resolved comments remain visible in the editor and in a dedicated sidebar section until you decide to clear them.

![VS Code editor showing a resolved Request Changes comment attached to TypeScript code](docs/images/resolved-editor-comment.png)

![Resolved comments accordion with grouped comments and Reopen and Clear resolved actions](docs/images/resolved-comments-panel.png)

### Connect your coding agent

Use the settings panel to configure instructions and connect Request Changes to supported agents.

![Request Changes settings with overall instructions and MCP installation controls for coding agents](docs/images/mcp-integration-settings.png)

## Using Request Changes with agents

Open **Request Changes: Open Settings** from the Command Palette, or use the gear icon in the **Review Comments** view. The settings panel shows the integrations Request Changes can manage, where each integration is installed, and example prompts for using it.

You can add default instructions in settings. For example, tell agents to run a specific test command, preserve a public API, or explain any blocked comments.

### Codex

1. In **Request Changes: Open Settings**, install Request Changes for Codex.

    Use Workspace scope for the current repository, or User scope for every repository.

2. Restart Codex and open the reviewed repository.

3. Run `/mcp` and confirm that `requestchanges` is listed and enabled.

4. Ask Codex:

    `Use the requestchanges MCP server to read all open review comments, implement them, run relevant tests, report each comment as addressed or blocked, and finish with a concise summary of each comment.`

### Claude Code

1. In **Request Changes: Open Settings**, install Request Changes for Claude Code.

2. Start a new Claude Code session in the reviewed workspace.

3. Run the MCP prompt:

    `/mcp__requestchanges__address_review_comments`

### GitHub Copilot CLI

1. In **Request Changes: Open Settings**, install Request Changes for GitHub Copilot CLI.

2. Start a new Copilot CLI session in the reviewed workspace.

3. Ask Copilot CLI:

    `Use the requestchanges MCP server to fix the open review comments, then summarize each comment and whether it was addressed or blocked.`

### GitHub Copilot in VS Code

1. Open Copilot Chat in Agent mode for the reviewed workspace.

2. Ask Copilot:

    `Fix the open comments with #requestchanges, then summarize each comment when done.`

Request Changes registers this integration directly with VS Code, so there is no manual MCP install step for GitHub Copilot in VS Code.

### Other MCP-compatible agents

Request Changes currently manages setup for Codex, Claude Code, GitHub Copilot CLI, and GitHub Copilot in VS Code. Other MCP-compatible agents may work if they support stdio MCP servers.

1. Open **Request Changes: Open Settings**.

2. Note the bundled MCP server location and private data location shown in the settings panel.

3. Configure your MCP client to run the Request Changes server with Node.

4. Ask the agent to use the `requestchanges` MCP server to read open review comments, address them, report each comment as addressed or blocked, and summarize each comment when done.

For unmanaged agents, exact configuration depends on that agent's MCP client settings.

## Comment types

New comments default to **Change**. To choose a type while writing a comment, start the comment with one of these directives:

- `#requestchanges:change`
- `#requestchanges:question`
- `#requestchanges:explain`
- `#requestchanges:addTest`

The directive is removed when the comment is saved. You can also change a comment's type later from the **Review Comments** view.

## Privacy and data

Review comments are stored locally as private user data, not as repository files. The extension stores review data under your operating system's application data location:

- macOS: `~/Library/Application Support/Request Changes`
- Windows: `%LOCALAPPDATA%/Request Changes`
- Linux: `$XDG_STATE_HOME/request-changes` or `~/.local/state/request-changes`

Request Changes only sends review comments to an agent when you explicitly ask that agent to use Request Changes.

## Troubleshooting

If an agent cannot see your comments, open **Request Changes: Open Settings** and confirm that the integration for that agent is installed and enabled at the scope you expect.

If comments are not where you expect after editing a file, open the file in VS Code. Request Changes keeps anchors with surrounding context so comments can be reattached when code moves. If a selection was deleted or cannot be matched safely, the comment is kept as an orphaned comment instead of being silently discarded.

For local development, architecture, publishing, and diagnostics details, see [development.md](development.md).
