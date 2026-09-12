import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand(
    "git-assistant.hello",
    async () => {
      const gitExtension = vscode.extensions.getExtension("vscode.git");

      if (!gitExtension) {
        vscode.window.showErrorMessage(
          "Git extension is not available."
        );
        return;
      }

      const git = gitExtension.exports.getAPI(1);

      if (git.repositories.length === 0) {
        vscode.window.showWarningMessage(
          "IBE Commit: No Git repository found."
        );
        return;
      }

      const repository = git.repositories[0];

      const changes = repository.state.workingTreeChanges;

      const diff = await repository.diff();

        console.log("IBE COMMIT DIFF:");
        console.log(diff);

      const fileNames = changes
        .map((change: { uri: vscode.Uri }) => change.uri.fsPath)
        .join("\n");

      vscode.window.showInformationMessage(
        `IBE Commit: ${changes.length} changed file(s)\n${fileNames}`
      );
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}