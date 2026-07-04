import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const openReviewPanel = vscode.commands.registerCommand("aireview.openReviewPanel", () => {
    vscode.window.showInformationMessage("AI Review Router is ready.");
  });

  context.subscriptions.push(openReviewPanel);
}

export function deactivate(): void {}
