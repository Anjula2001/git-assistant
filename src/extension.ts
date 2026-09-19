import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

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

            if (action === "Commit") {
              vscode.window.showInformationMessage(
                `IBE Commit: Commit created successfully.\n${finalCommitMessage}`
              );
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

            vscode.window.showInformationMessage(
              `IBE Commit: Commit & Push successful.\n${finalCommitMessage}`
            );
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
    .status-msg {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .error-msg {
      font-size: 12px;
      color: var(--vscode-errorForeground, #f48771);
    }
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
    <div class="buttons">
      <button id="btn-commit" class="btn-primary">Commit</button>
      <button id="btn-commit-push" class="btn-secondary">Commit &amp; Push</button>
      <button id="btn-regenerate" class="btn-secondary">Regenerate</button>
      <span id="status" class="status-msg" style="display: none;">Generating...</span>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const textarea = document.getElementById('commit-message');
    const reasonBox = document.getElementById('reason-box');
    const reasonText = document.getElementById('reason-text');
    const btnCommit = document.getElementById('btn-commit');
    const btnCommitPush = document.getElementById('btn-commit-push');
    const btnRegenerate = document.getElementById('btn-regenerate');
    const statusEl = document.getElementById('status');

    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    btnCommit.addEventListener('click', () => {
      vscode.postMessage({ action: 'Commit', message: textarea.value });
    });

    btnCommitPush.addEventListener('click', () => {
      vscode.postMessage({ action: 'Commit & Push', message: textarea.value });
    });

    btnRegenerate.addEventListener('click', () => {
      btnCommit.disabled = true;
      btnCommitPush.disabled = true;
      btnRegenerate.disabled = true;
      btnRegenerate.textContent = "Generating...";
      statusEl.textContent = "Generating new suggestion with AI...";
      statusEl.className = "status-msg";
      statusEl.style.display = "inline";

      vscode.postMessage({ action: 'Regenerate' });
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
        panel.dispose();
        resolve({ action: data.action, message: finalMessage });
      } else if (data.action === "Regenerate") {
        try {
          const result = await onRegenerate();
          panel.webview.postMessage({
            command: "updateSuggestion",
            message: result.message,
            reason: result.reason,
          });
        } catch (error) {
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
      if (!resolved) {
        resolve(undefined);
      }
    });
  });
}

export function deactivate() {}