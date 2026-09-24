import * as vscode from "vscode";

import Groq from "groq-sdk";

const SECRET_KEY = "ibe-commit.groq-api-key";

export async function generateCommitSuggestion(
  prompt: string,
  context: vscode.ExtensionContext
): Promise<string> {
  let apiKey = await context.secrets.get(SECRET_KEY);

  if (!apiKey) {
    const action = await vscode.window.showInformationMessage(
      "IBE Commit needs a free Groq API key to generate commit messages.",
      "Enter API Key",
      "Get Free API Key"
    );

    if (action === "Get Free API Key") {
      await vscode.env.openExternal(
        vscode.Uri.parse("https://console.groq.com/keys")
      );

      return generateCommitSuggestion(prompt, context);
    }

    if (action !== "Enter API Key") {
      throw new Error("Groq API key is required.");
    }

    apiKey = await vscode.window.showInputBox({
      prompt: "Enter your Groq API key (get one free at console.groq.com/keys)",
      password: true,
      ignoreFocusOut: true,
      placeHolder: "gsk_...",
    });

    if (!apiKey) {
      throw new Error("Groq API key is required.");
    }

    await context.secrets.store(SECRET_KEY, apiKey);
  }

  const client = new Groq({ apiKey });

  const response = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
  });

  return response.choices[0]?.message?.content ?? "";
}