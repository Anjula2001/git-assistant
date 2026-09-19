import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as cp from "child_process";

import { buildCommitPrompt } from "./ai/prompts";
import { generateCommitSuggestion } from "./ai/service";

const SECRET_KEY = "ibe-commit.openai-api-key";

interface LastIbeCommit {
  hash: string;
  message: string;
  wasPushed: boolean;
  repoPath: string;
}

let lastIbeCommit: LastIbeCommit | undefined;

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
  // Register Activity Bar View Provider
  // --------------------------------

  const activityBarProvider = new IbeCommitViewProvider();
  let isGenerating = false;

  // --------------------------------
  // Main IBE Commit Command
  // --------------------------------

  const disposable = vscode.commands.registerCommand(
    "git-assistant.hello",
    async () => {
      if (isGenerating) {
        vscode.window.showInformationMessage(
          "IBE Commit: Generation is already in progress."
        );
        return;
      }

      isGenerating = true;
      activityBarProvider.setLoading(true);

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

        let repository = null;

        const activeUri =
          vscode.window.activeTextEditor?.document.uri;

        if (activeUri) {
          repository = git.getRepository(activeUri);
        }

        if (!repository) {
          const workspaceFolder =
            vscode.workspace.workspaceFolders?.[0];

          if (workspaceFolder) {
            const workspacePath =
              workspaceFolder.uri.fsPath;

            repository = git.repositories
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
          }
        }

        if (!repository && git.repositories.length === 1) {
          repository = git.repositories[0];
        }

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

        let rawDiff = "";
        try {
          rawDiff = (await repository.diff()) || "";
        } catch (error) {
          console.warn("IBE: Unable to retrieve raw diff:", error);
          rawDiff = "";
        }

        // Get absolute paths of relevant files (including originalUri for renames)

        const relevantFilePaths = new Set<string>();
        for (const change of relevantChanges) {
          relevantFilePaths.add(change.uri.fsPath);
          if ((change as any).originalUri?.fsPath) {
            relevantFilePaths.add((change as any).originalUri.fsPath);
          }
        }

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

              const pathA = match[1].replace(/^"|"$/g, "");
              const pathB = match[2].replace(/^"|"$/g, "");

              const absA = vscode.Uri.joinPath(
                repository.rootUri,
                pathA
              ).fsPath;
              const absB = vscode.Uri.joinPath(
                repository.rootUri,
                pathB
              ).fsPath;

              return (
                relevantFilePaths.has(absA) ||
                relevantFilePaths.has(absB)
              );
            })
            .map(
              (part: string) =>
                `diff --git ${part}`
            )
            .join("");

        const MAX_DIFF_LENGTH = 8000;
        let processedDiff = filteredDiff.trim();
        if (!processedDiff) {
          processedDiff =
            "(No text diff available. Changes may include untracked new files, empty files, or file metadata changes)";
        } else if (processedDiff.length > MAX_DIFF_LENGTH) {
          processedDiff =
            processedDiff.slice(0, MAX_DIFF_LENGTH) +
            "\n\n... [Diff truncated: showing first 8,000 characters to keep prompt within limits] ...";
        }

        // --------------------------------
        // 3. Git History
        // --------------------------------

        let history: any[] = [];
        try {
          history = (await repository.log({ maxEntries: 5 })) || [];
        } catch (error) {
          console.log("IBE: No commit history found (repository may have no commits yet).");
          history = [];
        }

        const recentCommits = (history || [])
          .slice(0, 5)
          .map(
            (commit: { message: string }) => commit.message
          );

          console.log("IBE GIT HISTORY:");
          console.log(history);

          console.log("IBE FIRST HISTORY ITEM:");
          console.log(history[0]);

        // --------------------------------
        // 4. Build Change Context
        // --------------------------------

        const analyzedFiles: Array<{
          display: string;
          status: "added" | "modified" | "deleted" | "renamed";
        }> = relevantChanges.map(
          (change: { uri: vscode.Uri; originalUri?: vscode.Uri; status?: number }) => {
            const rootPath = repository.rootUri.fsPath;
            const uri = change.uri;
            const originalUri = change.originalUri;
            const relPath =
              path.relative(rootPath, uri.fsPath).replace(/\\/g, "/") ||
              uri.fsPath;

            if (originalUri && originalUri.fsPath !== uri.fsPath) {
              const origRelPath =
                path.relative(rootPath, originalUri.fsPath).replace(/\\/g, "/") ||
                originalUri.fsPath;
              return {
                display: `${origRelPath} -> ${relPath} (renamed)`,
                status: "renamed" as const,
              };
            }

            if (
              change.status === 2 ||
              change.status === 6 ||
              !fs.existsSync(uri.fsPath)
            ) {
              return {
                display: `${relPath} (deleted)`,
                status: "deleted" as const,
              };
            }

            if (
              change.status === 1 ||
              change.status === 7 ||
              change.status === 9
            ) {
              return {
                display: `${relPath} (added)`,
                status: "added" as const,
              };
            }

            return {
              display: `${relPath} (modified)`,
              status: "modified" as const,
            };
          }
        );

        const summary = {
          totalFiles: analyzedFiles.length,
          modified: analyzedFiles.filter((f) => f.status === "modified").length,
          added: analyzedFiles.filter((f) => f.status === "added").length,
          deleted: analyzedFiles.filter((f) => f.status === "deleted").length,
          renamed: analyzedFiles.filter((f) => f.status === "renamed").length,
        };

        const changeContext = {
          files: analyzedFiles.map((f) => f.display),
          diff: processedDiff,
          recentCommits: recentCommits,
          summary: summary,
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
          suggestion = parseSuggestionJson(rawSuggestion);
        } catch (error) {
          vscode.window.showErrorMessage(
            `IBE Commit: AI returned invalid JSON. ${String(error)}`
          );

          console.error(
            "IBE AI JSON PARSE ERROR:",
            error
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
        // 7. User Review & Edit Message
        // --------------------------------

        const formatMessage = (type: string, msg: string) =>
          msg.toLowerCase().startsWith(type.toLowerCase())
            ? msg
            : `${type}: ${msg}`;

        const initialCommitMessage = formatMessage(
          suggestion.type,
          suggestion.message
        );

        const onRegenerate = async (): Promise<{
          message: string;
          reason: string;
        }> => {
          console.log("IBE: Regenerating suggestion...");
          const newRaw = await generateCommitSuggestion(prompt, context);
          console.log("IBE REGENERATED RAW:", newRaw);
          const newSuggestion = parseSuggestionJson(newRaw);
          return {
            message: formatMessage(newSuggestion.type, newSuggestion.message),
            reason: newSuggestion.reason,
          };
        };

        isGenerating = false;
        activityBarProvider.setLoading(false);

        const reviewResult = await promptForCommitMessageWithWebview(
          initialCommitMessage,
          suggestion.reason,
          onRegenerate
        );

        if (!reviewResult) {
          console.log("IBE: User cancelled review.");
          return;
        }

        const { action, message: finalCommitMessage } = reviewResult;

        console.log("IBE SELECTED ACTION:");
        console.log(action);

        console.log("IBE FINAL COMMIT MESSAGE:");
        console.log(finalCommitMessage);

        // --------------------------------
        // 8. Commit & Optional Push
        // --------------------------------

        if (action === "Commit" || action === "Commit & Push") {
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

            // Commit with the edited message
            await repository.commit(
              finalCommitMessage
            );

            console.log(
              "IBE COMMIT CREATED."
            );

            const createdCommitHash =
              repository.state.HEAD?.commit ||
              (await repository.log({ maxEntries: 1 }))[0]?.hash ||
              "";

            lastIbeCommit = {
              hash: createdCommitHash,
              message: finalCommitMessage,
              wasPushed: false,
              repoPath: repository.rootUri.fsPath,
            };

            console.log(
              "IBE LAST COMMIT TRACKED:"
            );
            console.log(lastIbeCommit);

            const checkUndoSafety = async (): Promise<boolean> => {
              if (!lastIbeCommit || !lastIbeCommit.hash) {
                vscode.window.showWarningMessage(
                  "IBE Commit: No tracked commit available to undo."
                );
                return false;
              }

              if (
                !repository ||
                repository.rootUri.fsPath !== lastIbeCommit.repoPath ||
                !fs.existsSync(lastIbeCommit.repoPath)
              ) {
                vscode.window.showWarningMessage(
                  "IBE Commit: The tracked repository no longer exists or does not match the active repository."
                );
                return false;
              }

              if (typeof repository.status === "function") {
                try {
                  await repository.status();
                } catch {
                  // ignore
                }
              }

              const headCommit =
                repository.state.HEAD?.commit ||
                (await repository.log({ maxEntries: 1 }))[0]?.hash ||
                "";

              if (!headCommit || headCommit !== lastIbeCommit.hash) {
                vscode.window.showWarningMessage(
                  "IBE Commit: Current HEAD commit does not match the tracked commit. Undo cannot be performed."
                );
                return false;
              }

              const workingTreeChanges =
                repository.state.workingTreeChanges || [];
              if (workingTreeChanges.length > 0) {
                vscode.window.showWarningMessage(
                  "IBE Commit: Cannot undo commit because there are uncommitted working-tree changes. Please clean or stash them first."
                );
                return false;
              }

              const indexChanges =
                repository.state.indexChanges || [];
              if (indexChanges.length > 0) {
                vscode.window.showWarningMessage(
                  "IBE Commit: Cannot undo commit because there are staged changes. Please unstage or commit them first."
                );
                return false;
              }

              return true;
            };

            const handleUndoSelection = async (
              selection: string | undefined
            ) => {
              if (selection !== "Undo Last Commit") {
                return;
              }

              const isSafeInitial = await checkUndoSafety();
              if (!isSafeInitial || !lastIbeCommit) {
                return;
              }

              const commitHash = lastIbeCommit.hash;
              const originalMessage = lastIbeCommit.message;
              const defaultRevertMessage = `Revert "${
                originalMessage.trim().split("\n")[0]
              }"`;

              await promptForUndoReviewWithWebview(
                originalMessage,
                defaultRevertMessage,
                async (action, editedRevertMessage): Promise<boolean> => {
                  const isSafeBeforeRevert = await checkUndoSafety();
                  if (!isSafeBeforeRevert) {
                    return false;
                  }

                  try {
                    await new Promise<void>((resolve, reject) => {
                      cp.execFile(
                        "git",
                        ["revert", "--no-commit", commitHash],
                        { cwd: repository.rootUri.fsPath },
                        (error, stdout, stderr) => {
                          if (error) {
                            const errorDetails = (
                              stderr ||
                              stdout ||
                              error.message
                            ).trim();
                            reject(new Error(errorDetails));
                          } else {
                            resolve();
                          }
                        }
                      );
                    });
                  } catch (revertError) {
                    const errorMsg =
                      revertError instanceof Error
                        ? revertError.message
                        : String(revertError);
                    vscode.window.showErrorMessage(
                      `IBE Commit: Git revert failed: ${errorMsg}`
                    );
                    throw revertError;
                  }

                  try {
                    await repository.commit(editedRevertMessage);
                  } catch (commitError) {
                    const errorMsg =
                      commitError instanceof Error
                        ? commitError.message
                        : String(commitError);
                    vscode.window.showErrorMessage(
                      `IBE Commit: Revert commit failed: ${errorMsg}`
                    );
                    throw commitError;
                  }

                  if (typeof repository.status === "function") {
                    try {
                      await repository.status();
                    } catch {
                      // ignore
                    }
                  }

                  if (action === "Revert & Push") {
                    if (
                      !repository.state.remotes ||
                      repository.state.remotes.length === 0
                    ) {
                      vscode.window.showWarningMessage(
                        `IBE Commit: Revert commit created, but push was skipped because no remote repository is configured.\n${editedRevertMessage}`
                      );
                    } else {
                      const currentBranch = repository.state.HEAD?.name;
                      if (!currentBranch) {
                        vscode.window.showWarningMessage(
                          `IBE Commit: Revert commit created, but push was skipped because the repository is in a detached HEAD state. Please checkout a branch before pushing.\n${editedRevertMessage}`
                        );
                      } else {
                        try {
                          await repository.push();
                        } catch (pushError) {
                          const errorText = String(pushError).toLowerCase();
                          const isNoUpstream =
                            errorText.includes("noupstreambranch") ||
                            errorText.includes("no upstream") ||
                            (pushError as any)?.gitErrorCode ===
                              "NoUpstreamBranch";

                          if (isNoUpstream) {
                            console.log(
                              `IBE: No upstream branch. Setting origin/${currentBranch}`
                            );
                            await repository.push(
                              "origin",
                              currentBranch,
                              true
                            );
                          } else {
                            const errorMsg =
                              pushError instanceof Error
                                ? pushError.message
                                : String(pushError);
                            vscode.window.showErrorMessage(
                              `IBE Commit: Push failed: ${errorMsg}`
                            );
                            throw pushError;
                          }
                        }
                      }
                    }
                  }

                  lastIbeCommit = undefined;

                  if (action === "Revert & Push") {
                    vscode.window.showInformationMessage(
                      `IBE Commit: Revert & Push successful.\n${editedRevertMessage}`
                    );
                  } else {
                    vscode.window.showInformationMessage(
                      `IBE Commit: Revert commit created successfully.\n${editedRevertMessage}`
                    );
                  }

                  return true;
                }
              );
            };

            if (action === "Commit") {
              vscode.window
                .showInformationMessage(
                  `IBE Commit: Commit created successfully.\n${finalCommitMessage}`,
                  "Undo Last Commit"
                )
                .then(handleUndoSelection);
              return;
            }

            // Push (for "Commit & Push")
            if (!repository.state.remotes || repository.state.remotes.length === 0) {
              vscode.window.showWarningMessage(
                `IBE Commit: Commit created successfully, but push was skipped because no remote repository is configured.\n${finalCommitMessage}`
              );
              return;
            }

            const currentBranch = repository.state.HEAD?.name;
            if (!currentBranch) {
              vscode.window.showWarningMessage(
                `IBE Commit: Commit created successfully, but push was skipped because the repository is in a detached HEAD state. Please checkout a branch before pushing.\n${finalCommitMessage}`
              );
              return;
            }

            try {
              await repository.push();
            } catch (error) {
              const errorText = String(error).toLowerCase();
              const isNoUpstream =
                errorText.includes("noupstreambranch") ||
                errorText.includes("no upstream") ||
                (error as any)?.gitErrorCode === "NoUpstreamBranch";

              if (isNoUpstream) {
                console.log(
                  `IBE: No upstream branch. Setting origin/${currentBranch}`
                );

                await repository.push(
                  "origin",
                  currentBranch,
                  true
                );
              } else {
                throw error;
              }
            }

            console.log(
              "IBE PUSH COMPLETED."
            );

            if (lastIbeCommit) {
              lastIbeCommit.wasPushed = true;
            }

            vscode.window
              .showInformationMessage(
                `IBE Commit: Commit & Push successful.\n${finalCommitMessage}`,
                "Undo Last Commit"
              )
              .then(handleUndoSelection);
          } catch (error) {
            vscode.window.showErrorMessage(
              `IBE Commit: ${action} failed. ${String(
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

        const errorMessage = String(error);
        if (errorMessage.includes("OpenAI API key is required")) {
          vscode.window.showWarningMessage(
            "IBE Commit: OpenAI API key is required to generate commit suggestions."
          );
        } else {
          vscode.window.showErrorMessage(
            `IBE Commit: Unexpected error. ${errorMessage}`
          );
        }
      } finally {
        if (isGenerating) {
          isGenerating = false;
          activityBarProvider.setLoading(false);
        }
      }
    }
  );

  // --------------------------------
  // Register Commands & Views
  // --------------------------------

  context.subscriptions.push(
    disposable,
    configureApiKey,
    vscode.window.registerWebviewViewProvider(
      "ibe-commit.view",
      activityBarProvider
    )
  );
}

function parseSuggestionJson(rawSuggestion: string): {
  type: string;
  message: string;
  reason: string;
} {
  let cleaned = (rawSuggestion || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  const parsed = JSON.parse(cleaned);

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.type ||
    !parsed.message ||
    !parsed.reason
  ) {
    throw new Error(
      "AI response is missing required fields (type, message, reason)."
    );
  }

  const type = String(parsed.type).trim();
  const message = String(parsed.message).trim();
  const reason = String(parsed.reason).trim();

  if (!type || !message || !reason) {
    throw new Error("AI response contains empty required fields.");
  }

  return { type, message, reason };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const COMMON_REVIEW_CSS = `
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 24px;
      margin: 0;
      max-width: 680px;
    }
    .container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
      color: var(--vscode-titleBar-activeForeground, var(--vscode-foreground));
    }
    .reason-box {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      background-color: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.1));
      border-left: 3px solid var(--vscode-textBlockQuote-border, #007acc);
      padding: 8px 12px;
      border-radius: 2px;
    }
    .field-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 90px;
      padding: 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-input-foreground);
      background-color: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px;
      resize: vertical;
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    .buttons {
      display: flex;
      gap: 10px;
      margin-top: 4px;
      align-items: center;
    }
    button {
      padding: 7px 16px;
      font-size: 13px;
      border-radius: 3px;
      cursor: pointer;
      font-weight: 500;
      border: 1px solid var(--vscode-button-border, transparent);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      color: var(--vscode-button-foreground);
      background-color: var(--vscode-button-background);
    }
    .btn-primary:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      color: var(--vscode-button-secondaryForeground);
      background-color: var(--vscode-button-secondaryBackground);
    }
    .btn-secondary:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    .btn-cancel {
      color: var(--vscode-foreground);
      background-color: transparent;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
    }
    .btn-cancel:hover:not(:disabled) {
      background-color: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    }
    textarea.has-error {
      border-color: var(--vscode-inputValidation-errorBorder, #be1100);
      outline: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .validation-error {
      font-size: 12px;
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground, #f48771));
      background-color: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
      padding: 6px 10px;
      border-radius: 3px;
    }
    .status-msg {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .error-msg {
      font-size: 12px;
      color: var(--vscode-errorForeground, #f48771);
    }
`;

function promptForCommitMessageWithWebview(
  initialMessage: string,
  reason: string,
  onRegenerate: () => Promise<{ message: string; reason: string }>
): Promise<{ action: "Commit" | "Commit & Push"; message: string } | undefined> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      "ibeCommitReview",
      "IBE Commit: Review Message",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      }
    );

    let resolved = false;

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IBE Commit Review</title>
  <style>
${COMMON_REVIEW_CSS}
  </style>
</head>
<body>
  <div class="container">
    <h2>IBE Commit: Review &amp; Edit Commit Message</h2>
    <div id="reason-box" class="reason-box" style="${reason ? "" : "display: none;"}">
      <strong>Reason:</strong> <span id="reason-text">${escapeHtml(reason || "")}</span>
    </div>
    <label class="field-label" for="commit-message">Commit Message</label>
    <textarea id="commit-message" placeholder="Enter commit message...">${escapeHtml(initialMessage)}</textarea>
    <div id="validation-error" class="validation-error" style="display: none;"></div>
    <div class="buttons">
      <button id="btn-commit" class="btn-primary">Commit</button>
      <button id="btn-commit-push" class="btn-secondary">Commit &amp; Push</button>
      <button id="btn-regenerate" class="btn-secondary">Regenerate</button>
      <button id="btn-cancel" class="btn-cancel">Cancel</button>
      <span id="status" class="status-msg" style="display: none;">Generating...</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('commit-message');
    const validationError = document.getElementById('validation-error');
    const reasonBox = document.getElementById('reason-box');
    const reasonText = document.getElementById('reason-text');
    const btnCommit = document.getElementById('btn-commit');
    const btnCommitPush = document.getElementById('btn-commit-push');
    const btnRegenerate = document.getElementById('btn-regenerate');
    const btnCancel = document.getElementById('btn-cancel');
    const statusEl = document.getElementById('status');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    function validateMessage() {
      const val = textarea.value.trim();
      if (!val) {
        validationError.textContent = "Commit message cannot be empty.";
        validationError.style.display = "block";
        textarea.classList.add("has-error");
        textarea.focus();
        return false;
      }
      validationError.style.display = "none";
      textarea.classList.remove("has-error");
      return true;
    }

    textarea.addEventListener('input', () => {
      if (textarea.value.trim().length > 0) {
        validationError.style.display = "none";
        textarea.classList.remove("has-error");
      }
    });

    btnCommit.addEventListener('click', () => {
      if (!validateMessage()) {
        vscode.postMessage({ action: 'Commit', message: '' });
        return;
      }
      vscode.postMessage({ action: 'Commit', message: textarea.value });
    });

    btnCommitPush.addEventListener('click', () => {
      if (!validateMessage()) {
        vscode.postMessage({ action: 'Commit & Push', message: '' });
        return;
      }
      vscode.postMessage({ action: 'Commit & Push', message: textarea.value });
    });

    btnRegenerate.addEventListener('click', () => {
      validationError.style.display = "none";
      textarea.classList.remove("has-error");

      btnCommit.disabled = true;
      btnCommitPush.disabled = true;
      btnRegenerate.disabled = true;
      btnRegenerate.textContent = "Generating...";
      statusEl.textContent = "Generating new suggestion with AI...";
      statusEl.className = "status-msg";
      statusEl.style.display = "inline";

      vscode.postMessage({ action: 'Regenerate' });
    });

    btnCancel.addEventListener('click', () => {
      vscode.postMessage({ action: 'Cancel' });
    });

    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!btnCommit.disabled) {
          btnCommit.click();
        }
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.command === 'updateSuggestion') {
        textarea.value = msg.message;
        validationError.style.display = "none";
        textarea.classList.remove("has-error");

        if (reasonBox && reasonText && msg.reason) {
          reasonText.textContent = msg.reason;
          reasonBox.style.display = "block";
        }
        btnCommit.disabled = false;
        btnCommitPush.disabled = false;
        btnRegenerate.disabled = false;
        btnRegenerate.textContent = "Regenerate";
        statusEl.style.display = "none";
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      } else if (msg.command === 'regenerationFailed') {
        btnCommit.disabled = false;
        btnCommitPush.disabled = false;
        btnRegenerate.disabled = false;
        btnRegenerate.textContent = "Regenerate";
        statusEl.textContent = msg.error || "Regeneration failed.";
        statusEl.className = "error-msg";
        statusEl.style.display = "inline";
        textarea.focus();
      }
    });
  </script>
</body>
</html>`;

    let isDisposed = false;

    panel.webview.onDidReceiveMessage(async (data) => {
      if (data.action === "Commit" || data.action === "Commit & Push") {
        const finalMessage = String(data.message || "").trim();
        if (!finalMessage) {
          vscode.window.showWarningMessage(
            "IBE Commit: Commit message cannot be empty."
          );
          return;
        }

        resolved = true;
        isDisposed = true;
        panel.dispose();
        resolve({ action: data.action, message: finalMessage });
      } else if (data.action === "Cancel") {
        resolved = true;
        isDisposed = true;
        panel.dispose();
        resolve(undefined);
      } else if (data.action === "Regenerate") {
        try {
          const result = await onRegenerate();
          if (isDisposed) {
            return;
          }
          panel.webview.postMessage({
            command: "updateSuggestion",
            message: result.message,
            reason: result.reason,
          });
        } catch (error) {
          if (isDisposed) {
            return;
          }
          const errMsg = String(error);
          console.error("IBE REGENERATION ERROR:", error);
          vscode.window.showErrorMessage(
            `IBE Commit: Regeneration failed. ${errMsg}`
          );
          panel.webview.postMessage({
            command: "regenerationFailed",
            error: errMsg,
          });
        }
      }
    });

    panel.onDidDispose(() => {
      isDisposed = true;
      if (!resolved) {
        resolved = true;
        resolve(undefined);
      }
    });
  });
}

function promptForUndoReviewWithWebview(
  originalCommitMessage: string,
  defaultRevertMessage: string,
  onConfirm: (
    action: "Revert Commit" | "Revert & Push",
    message: string
  ) => Promise<boolean>
): Promise<void> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      "ibeCommitUndoReview",
      "IBE Commit: Undo Review",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      }
    );

    let resolved = false;
    let isDisposed = false;

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IBE Commit: Undo Review</title>
  <style>
${COMMON_REVIEW_CSS}
  </style>
</head>
<body>
  <div class="container">
    <h2>IBE Commit: Undo Review</h2>
    <div class="reason-box">
      <strong>Original Commit:</strong>
      <div style="margin-top: 4px; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace);">${escapeHtml(originalCommitMessage)}</div>
    </div>
    <label class="field-label" for="commit-message">Revert Commit Message</label>
    <textarea id="commit-message" placeholder="Enter revert commit message...">${escapeHtml(defaultRevertMessage)}</textarea>
    <div id="validation-error" class="validation-error" style="display: none;"></div>
    <div class="buttons">
      <button id="btn-revert" class="btn-primary">Revert Commit</button>
      <button id="btn-revert-push" class="btn-secondary">Revert &amp; Push</button>
      <button id="btn-cancel" class="btn-cancel">Cancel</button>
      <span id="status" class="status-msg" style="display: none;"></span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('commit-message');
    const validationError = document.getElementById('validation-error');
    const btnRevert = document.getElementById('btn-revert');
    const btnRevertPush = document.getElementById('btn-revert-push');
    const btnCancel = document.getElementById('btn-cancel');
    const statusEl = document.getElementById('status');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    function validateMessage() {
      const val = textarea.value.trim();
      if (!val) {
        validationError.textContent = "Commit message cannot be empty.";
        validationError.style.display = "block";
        textarea.classList.add("has-error");
        textarea.focus();
        return false;
      }
      validationError.style.display = "none";
      textarea.classList.remove("has-error");
      return true;
    }

    textarea.addEventListener('input', () => {
      if (textarea.value.trim().length > 0) {
        validationError.style.display = "none";
        textarea.classList.remove("has-error");
      }
    });

    function startOperation(action) {
      if (!validateMessage()) {
        return;
      }
      btnRevert.disabled = true;
      btnRevertPush.disabled = true;
      statusEl.textContent = action === 'Revert & Push' ? 'Reverting and pushing...' : 'Reverting commit...';
      statusEl.className = 'status-msg';
      statusEl.style.display = 'inline';

      vscode.postMessage({ action, message: textarea.value });
    }

    btnRevert.addEventListener('click', () => {
      startOperation('Revert Commit');
    });

    btnRevertPush.addEventListener('click', () => {
      startOperation('Revert & Push');
    });

    btnCancel.addEventListener('click', () => {
      vscode.postMessage({ action: 'Cancel' });
    });

    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!btnRevert.disabled) {
          btnRevert.click();
        }
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.command === 'operationFailed') {
        btnRevert.disabled = false;
        btnRevertPush.disabled = false;
        statusEl.textContent = msg.error || 'Operation failed.';
        statusEl.className = 'error-msg';
        statusEl.style.display = 'inline';
        textarea.focus();
      }
    });
  </script>
</body>
</html>`;

    panel.webview.onDidReceiveMessage(async (data) => {
      if (data.action === "Revert Commit" || data.action === "Revert & Push") {
        const finalMessage = String(data.message || "").trim();
        if (!finalMessage) {
          vscode.window.showWarningMessage(
            "IBE Commit: Commit message cannot be empty."
          );
          if (!isDisposed) {
            panel.webview.postMessage({
              command: "operationFailed",
              error: "Commit message cannot be empty.",
            });
          }
          return;
        }

        try {
          const success = await onConfirm(data.action, finalMessage);
          if (success) {
            resolved = true;
            isDisposed = true;
            panel.dispose();
            resolve();
          } else {
            if (!isDisposed) {
              panel.webview.postMessage({
                command: "operationFailed",
                error: "Safety check failed.",
              });
            }
          }
        } catch (error) {
          if (isDisposed) {
            return;
          }
          const errMsg = String(
            error instanceof Error ? error.message : error
          );
          panel.webview.postMessage({
            command: "operationFailed",
            error: errMsg,
          });
        }
      } else if (data.action === "Cancel") {
        resolved = true;
        isDisposed = true;
        panel.dispose();
        resolve();
      }
    });

    panel.onDidDispose(() => {
      isDisposed = true;
      if (!resolved) {
        resolved = true;
        resolve();
      }
    });
  });
}

export function deactivate() {}

class IbeCommitViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _isLoading: boolean = false;

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this._getHtmlForWebview(this._isLoading);

    webviewView.webview.onDidReceiveMessage((data) => {
      if (data.command === "generateCommit") {
        vscode.commands.executeCommand("git-assistant.hello");
      } else if (data.command === "configureApiKey") {
        vscode.commands.executeCommand("git-assistant.configureApiKey");
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
    });
  }

  public setLoading(isLoading: boolean) {
    this._isLoading = isLoading;
    if (this._view) {
      this._view.webview.postMessage({
        command: "setLoading",
        isLoading,
      });
    }
  }

  private _getHtmlForWebview(initialLoading: boolean): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IBE Commit</title>
  <style>
    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background, transparent);
      padding: 16px 12px;
      margin: 0;
      box-sizing: border-box;
    }
    .container {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .header {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    h2 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--vscode-sideBarTitle-foreground, var(--vscode-foreground));
    }
    .description {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
      margin: 0;
    }
    button {
      width: 100%;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 500;
      border-radius: 2px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      box-sizing: border-box;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      color: var(--vscode-button-foreground);
      background-color: var(--vscode-button-background);
    }
    .btn-primary:hover:not(:disabled) {
      background-color: var(--vscode-button-hoverBackground);
    }
    .btn-secondary {
      color: var(--vscode-button-secondaryForeground);
      background-color: var(--vscode-button-secondaryBackground);
    }
    .btn-secondary:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    .actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Loading UI */
    .loading-view {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 14px;
      padding: 32px 8px;
      box-sizing: border-box;
    }
    .loading-sparkle {
      font-size: 26px;
      color: var(--vscode-progressBar-background, #007acc);
      animation: sparkle-pulse 2s ease-in-out infinite;
      line-height: 1;
      user-select: none;
    }
    @keyframes sparkle-pulse {
      0%, 100% {
        opacity: 0.7;
        transform: scale(1);
      }
      50% {
        opacity: 1;
        transform: scale(1.15);
      }
    }
    .loading-title {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--vscode-foreground);
      text-align: center;
      line-height: 1.4;
    }
    .dots-container {
      display: flex;
      gap: 7px;
      align-items: center;
      justify-content: center;
      padding: 4px 0;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: var(--vscode-progressBar-background, #007acc);
      animation: dot-pulse 1.4s ease-in-out infinite both;
    }
    .dot:nth-child(1) { animation-delay: -0.32s; }
    .dot:nth-child(2) { animation-delay: -0.16s; }
    .dot:nth-child(3) { animation-delay: 0s; }
    @keyframes dot-pulse {
      0%, 80%, 100% {
        opacity: 0.25;
        transform: scale(0.75);
      }
      40% {
        opacity: 1;
        transform: scale(1.2);
      }
    }
    .loading-subtitle {
      margin: 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-align: center;
      line-height: 1.4;
    }
  </style>
</head>
<body>
  <div id="normal-view" class="container" style="${initialLoading ? 'display: none;' : 'display: flex;'}">
    <div class="header">
      <h2>IBE Commit</h2>
      <p class="description">AI-powered Git commit assistant</p>
    </div>
    <div class="actions">
      <button id="btn-generate" class="btn-primary">Generate Commit Message</button>
      <button id="btn-config" class="btn-secondary">Configure API Key</button>
    </div>
  </div>

  <div id="loading-view" class="loading-view" style="${initialLoading ? 'display: flex;' : 'display: none;'}">
    <div class="loading-sparkle">✦</div>
    <h3 class="loading-title">Generating commit<br>message...</h3>
    <div class="dots-container">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>
    <p class="loading-subtitle">Analyzing your changes</p>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const normalView = document.getElementById('normal-view');
    const loadingView = document.getElementById('loading-view');
    const btnGenerate = document.getElementById('btn-generate');
    const btnConfig = document.getElementById('btn-config');

    function setLoading(isLoading) {
      if (isLoading) {
        normalView.style.display = 'none';
        loadingView.style.display = 'flex';
        btnGenerate.disabled = true;
      } else {
        loadingView.style.display = 'none';
        normalView.style.display = 'flex';
        btnGenerate.disabled = false;
      }
    }

    btnGenerate.addEventListener('click', () => {
      setLoading(true);
      vscode.postMessage({ command: 'generateCommit' });
    });

    btnConfig.addEventListener('click', () => {
      vscode.postMessage({ command: 'configureApiKey' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.command === 'setLoading') {
        setLoading(msg.isLoading);
      }
    });
  </script>
</body>
</html>`;
  }
}