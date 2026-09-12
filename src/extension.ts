import * as vscode from "vscode";

import { buildCommitPrompt } from "./ai/prompts";
import { generateCommitSuggestion } from "./ai/service";

const SECRET_KEY = "ibe-commit.openai-api-key";

export function activate(context: vscode.ExtensionContext) {
  // --------------------------------
  // Configure OpenAI API Key
  // --------------------------------

  const configureApiKey = vscode.commands.registerCommand(
    "git-assistant.configureApiKey",
    async () => {
      console.log("IBE: Configure API Key command started.");

      const apiKey = await vscode.window.showInputBox({
        prompt: "Enter your OpenAI API key",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-...",
      });

      if (!apiKey) {
        vscode.window.showWarningMessage(
          "IBE Commit: API key was not provided."
        );
        return;
      }

      await context.secrets.store(
        SECRET_KEY,
        apiKey.trim()
      );

      console.log("IBE: API key saved securely.");

      vscode.window.showInformationMessage(
        "IBE Commit: OpenAI API key saved securely."
      );
    }
  );

  // --------------------------------
  // Main IBE Commit Command
  // --------------------------------

  const disposable = vscode.commands.registerCommand(
    "git-assistant.hello",
    async () => {
      try {
        // --------------------------------
        // Get VS Code Git Extension
        // --------------------------------

        const gitExtension =
          vscode.extensions.getExtension("vscode.git");

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

        // --------------------------------
        // Select Correct Repository
        // --------------------------------

        const workspaceFolder =
          vscode.workspace.workspaceFolders?.[0];

        if (!workspaceFolder) {
          vscode.window.showWarningMessage(
            "IBE Commit: No workspace folder found."
          );
          return;
        }

        const workspacePath =
          workspaceFolder.uri.fsPath;

        const repository = git.repositories
          .filter(
            (repo: { rootUri: vscode.Uri }) => {
              const repoPath =
                repo.rootUri.fsPath;

              return (
                workspacePath === repoPath ||
                workspacePath.startsWith(
                  `${repoPath}/`
                )
              );
            }
          )
          .sort(
            (
              a: { rootUri: vscode.Uri },
              b: { rootUri: vscode.Uri }
            ) =>
              b.rootUri.fsPath.length -
              a.rootUri.fsPath.length
          )[0];

        if (!repository) {
          vscode.window.showWarningMessage(
            "IBE Commit: No Git repository found for this workspace."
          );
          return;
        }

        console.log("IBE REPOSITORY:");
        console.log(
          repository.rootUri.fsPath
        );

        // --------------------------------
        // 1. Git Status
        // --------------------------------

        const changes =
          repository.state.workingTreeChanges;

        console.log("IBE ALL CHANGES:");

        console.log(
          changes.map(
            (change: { uri: vscode.Uri }) =>
              change.uri.fsPath
          )
        );

        // --------------------------------
        // Remove Irrelevant Files
        // --------------------------------

        const relevantChanges =
          changes.filter(
            (change: { uri: vscode.Uri }) => {
              const filePath =
                change.uri.fsPath;

              return (
                !filePath.includes("/.git/") &&
                !filePath.endsWith(".DS_Store") &&
                !filePath.includes("/.idea/")
              );
            }
          );

        if (relevantChanges.length === 0) {
          vscode.window.showInformationMessage(
            "IBE Commit: No relevant changes detected."
          );
          return;
        }

        // --------------------------------
        // 2. Git Diff
        // --------------------------------

        const rawDiff =
          await repository.diff();

        // Get absolute paths of relevant files

        const relevantFilePaths =
          new Set(
            relevantChanges.map(
              (change: { uri: vscode.Uri }) =>
                change.uri.fsPath
            )
          );

        // Split diff into individual file sections

        const diffParts =
          rawDiff.split(/^diff --git /m);

        // Keep only relevant file diffs

        const filteredDiff =
          diffParts
            .filter((part: string) => {
              if (!part.trim()) {
                return false;
              }

              const firstLine =
                part.split("\n")[0];

              const match =
                firstLine.match(
                  /^a\/(.+) b\/(.+)$/
                );

              if (!match) {
                return false;
              }

              const filePath = match[2];

              const absolutePath =
                vscode.Uri.joinPath(
                  repository.rootUri,
                  filePath
                ).fsPath;

              return relevantFilePaths.has(
                absolutePath
              );
            })
            .map(
              (part: string) =>
                `diff --git ${part}`
            )
            .join("");

        // --------------------------------
        // 3. Git History
        // Temporarily disabled
        // --------------------------------

        const history: never[] = [];

        // --------------------------------
        // 4. Build Change Context
        // --------------------------------

        const changeContext = {
          files: relevantChanges.map(
            (change: { uri: vscode.Uri }) =>
              change.uri.fsPath
          ),

          diff: filteredDiff,

          recentCommits: history,
        };

        console.log(
          "IBE CHANGE CONTEXT:"
        );

        console.log(changeContext);

        // --------------------------------
        // 5. Build AI Prompt
        // --------------------------------

        const prompt =
          buildCommitPrompt(
            changeContext
          );

        console.log("IBE AI PROMPT:");
        console.log(prompt);

        // --------------------------------
        // 6. Generate AI Suggestion
        // --------------------------------

        const rawSuggestion =
          await generateCommitSuggestion(
            prompt,
            context
          );

        console.log(
          "IBE RAW AI SUGGESTION:"
        );

        console.log(rawSuggestion);

        // --------------------------------
        // Parse AI JSON
        // --------------------------------

        let suggestion: {
          type: string;
          message: string;
          reason: string;
        };

        try {
          suggestion =
            JSON.parse(rawSuggestion);
        } catch (error) {
          vscode.window.showErrorMessage(
            "IBE Commit: AI returned invalid JSON."
          );

          console.error(
            "IBE AI JSON PARSE ERROR:",
            error
          );

          return;
        }

        // --------------------------------
        // Validate AI Response
        // --------------------------------

        if (
          !suggestion.type ||
          !suggestion.message ||
          !suggestion.reason
        ) {
          vscode.window.showErrorMessage(
            "IBE Commit: AI response is missing required fields."
          );

          return;
        }

        console.log("IBE COMMIT TYPE:");
        console.log(suggestion.type);

        console.log("IBE COMMIT MESSAGE:");
        console.log(suggestion.message);

        console.log("IBE COMMIT REASON:");
        console.log(suggestion.reason);

        // --------------------------------
        // 7. User Review
        // --------------------------------

        const action =
          await vscode.window.showInformationMessage(
            `AI Suggestion\n\n${suggestion.type}: ${suggestion.message}\n\nReason: ${suggestion.reason}`,
            "Commit",
            "Commit & Push"
          );

        console.log(
          "IBE SELECTED ACTION:"
        );

        console.log(action);

        // --------------------------------
        // 8. Commit
        // --------------------------------

        if (action === "Commit") {
          try {
            const filesToStage =
              relevantChanges.map(
                (
                  change: {
                    uri: vscode.Uri;
                  }
                ) => change.uri.fsPath
              );

            console.log(
              "IBE FILES TO STAGE:"
            );

            console.log(filesToStage);

            await repository.add(
              filesToStage
            );

            console.log(
              "IBE FILES STAGED."
            );

            await repository.commit(
              suggestion.message
            );

            vscode.window.showInformationMessage(
              `IBE Commit: Commit created successfully.\n${suggestion.message}`
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `IBE Commit: Commit failed. ${String(
                error
              )}`
            );
          }

          return;
        }

        // --------------------------------
        // 9. Commit & Push
        // --------------------------------

        if (action === "Commit & Push") {
          try {
            const filesToStage =
              relevantChanges.map(
                (
                  change: {
                    uri: vscode.Uri;
                  }
                ) => change.uri.fsPath
              );

            console.log(
              "IBE FILES TO STAGE:"
            );

            console.log(filesToStage);

            // Stage relevant files

            await repository.add(
              filesToStage
            );

            console.log(
              "IBE FILES STAGED."
            );

            // Commit

            await repository.commit(
              suggestion.message
            );

            console.log(
              "IBE COMMIT CREATED."
            );

            // Push

            try {
              await repository.push();
            } catch (error) {
              const errorText =
                String(error);

              if (
                errorText.includes(
                  "NoUpstreamBranch"
                )
              ) {
                const branchName =
                  repository.state.HEAD?.name;

                if (!branchName) {
                  throw new Error(
                    "Unable to determine current branch."
                  );
                }

                console.log(
                  `IBE: No upstream branch. Setting origin/${branchName}`
                );

                await repository.push(
                  "origin",
                  branchName,
                  true
                );
              } else {
                throw error;
              }
            }

            console.log(
              "IBE PUSH COMPLETED."
            );

            vscode.window.showInformationMessage(
              `IBE Commit: Commit & Push successful.\n${suggestion.message}`
            );
          } catch (error) {
            vscode.window.showErrorMessage(
              `IBE Commit: Commit & Push failed. ${String(
                error
              )}`
            );
          }

          return;
        }
      } catch (error) {
        console.error(
          "IBE COMMIT ERROR:",
          error
        );

        vscode.window.showErrorMessage(
          `IBE Commit: Unexpected error. ${String(
            error
          )}`
        );
      }
    }
  );

  // --------------------------------
  // Register Commands
  // --------------------------------

  context.subscriptions.push(
    disposable,
    configureApiKey
  );
}

export function deactivate() {}