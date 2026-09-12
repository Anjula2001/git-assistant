import * as vscode from "vscode";

import OpenAI from "openai";

const SECRET_KEY = "ibe-commit.openai-api-key";

export async function generateCommitSuggestion(
  prompt: string,
  context: vscode.ExtensionContext
): Promise<string> {
  let apiKey = await context.secrets.get(SECRET_KEY);

  if (!apiKey) {
    const action = await vscode.window.showInformationMessage(
      "IBE Commit needs an OpenAI API key to generate commit messages.",
      "Enter API Key",
      "Get API Key"
    );

    if (action === "Get API Key") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://platform.openai.com/api-keys")
      );

      return generateCommitSuggestion(prompt, context);
    }

    if (action !== "Enter API Key") {
      throw new Error("OpenAI API key is required.");
    }

    apiKey = await vscode.window.showInputBox({
      prompt: "Enter your OpenAI API key",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "sk-...",
    });

    if (!apiKey) {
      throw new Error("OpenAI API key is required.");
    }

    await context.secrets.store(SECRET_KEY, apiKey);
  }

  const client = new OpenAI({
    apiKey,
  });

  const response = await client.responses.create({
    model: "gpt-5.6-luna",
    input: prompt,
  });

  return response.output_text;
}