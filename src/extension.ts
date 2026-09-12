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

      // --------------------------------
      // 1. Git Status
      // --------------------------------

      const changes = repository.state.workingTreeChanges;

      // Remove irrelevant files
      const relevantChanges = changes.filter(
        (change: { uri: vscode.Uri }) => {
          const filePath = change.uri.fsPath;

          return (
            !filePath.includes("/.git/") &&
            !filePath.endsWith(".DS_Store") &&
            !filePath.includes("/.idea/")
          );
        }
      );

      // --------------------------------
      // 2. Git Diff
      // --------------------------------

      const rawDiff = await repository.diff();

      // Get absolute paths of relevant files
      const relevantFilePaths = new Set(
        relevantChanges.map(
          (change: { uri: vscode.Uri }) => change.uri.fsPath
        )
      );

      // Split diff into individual file sections
      const diffParts = rawDiff.split(/^diff --git /m);

      // Keep only relevant file diffs
      const filteredDiff = diffParts
        .filter((part: string) => {
          if (!part.trim()) {
            return false;
          }

          const firstLine = part.split("\n")[0];

          const match = firstLine.match(/^a\/(.+) b\/(.+)$/);

          if (!match) {
            return false;
          }

          const filePath = match[2];

          const absolutePath = vscode.Uri.joinPath(
            repository.rootUri,
            filePath
          ).fsPath;

          return relevantFilePaths.has(absolutePath);
        })
        .map((part: string) => `diff --git ${part}`)
        .join("");

      // --------------------------------
      // 3. Git History
      // --------------------------------

      const history = await repository.log(5);

      // --------------------------------
      // 4. Build Change Context
      // --------------------------------

      const changeContext = {
        files: relevantChanges.map(
          (change: { uri: vscode.Uri }) => change.uri.fsPath
        ),

        diff: filteredDiff,

        recentCommits: history,
      };

      // --------------------------------
      // Debug Output
      // --------------------------------

      console.log("IBE CHANGE CONTEXT:");
      console.log(changeContext);

      // --------------------------------
      // User Notification
      // --------------------------------

      const fileNames = relevantChanges
        .map(
          (change: { uri: vscode.Uri }) => change.uri.fsPath
        )
        .join("\n");

      vscode.window.showInformationMessage(
        `IBE Commit: ${relevantChanges.length} relevant file(s)\n${fileNames}`
      );
    }
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}