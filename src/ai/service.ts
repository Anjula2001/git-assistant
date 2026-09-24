import * as vscode from "vscode";
import Groq from "groq-sdk";

const SECRET_KEY = "ibe-commit.groq-api-key";

// Priority list of models supported on Groq developer tier
const PREFERRED_MODELS = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3.8-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

let cachedModel: string | undefined;

export function clearModelCache(): void {
  cachedModel = undefined;
}

async function resolveModel(client: Groq): Promise<string> {
  if (cachedModel) {
    return cachedModel;
  }

  try {
    const response = await client.models.list();
    const availableIds = new Set(response.data.map((m) => m.id));
    console.log("IBE: Available Groq models:", Array.from(availableIds));

    // 1. Check preferred models in priority order
    for (const candidate of PREFERRED_MODELS) {
      if (availableIds.has(candidate)) {
        cachedModel = candidate;
        console.log(`IBE: Selected preferred Groq model: ${candidate}`);
        return candidate;
      }
    }

    // 2. Fall back to any text chat model available on the account
    const chatModel = response.data.find(
      (m) =>
        !m.id.includes("whisper") &&
        !m.id.includes("guard") &&
        !m.id.includes("orpheus") &&
        !m.id.includes("safeguard")
    );

    if (chatModel) {
      cachedModel = chatModel.id;
      console.log(`IBE: Selected dynamic Groq model: ${chatModel.id}`);
      return chatModel.id;
    }
  } catch (err) {
    console.warn("IBE: Failed to query available models from Groq API:", err);
  }

  // Default fallback if models list fails
  return "openai/gpt-oss-20b";
}

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

  async function requestCompletion(model: string): Promise<string> {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
        response_format: { type: "json_object" },
      });
      return response.choices[0]?.message?.content ?? "";
    } catch (err: any) {
      // If model does not support response_format json_object, retry without it
      if (String(err?.message || "").includes("response_format")) {
        const response = await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1024,
        });
        return response.choices[0]?.message?.content ?? "";
      }
      throw err;
    }
  }

  // Resolve best model dynamically based on what is active on this account
  let modelToUse = await resolveModel(client);

  try {
    return await requestCompletion(modelToUse);
  } catch (error: any) {
    // If the selected model failed with 404 (model not found), invalidate cache and try fallbacks
    const isModelNotFound =
      error?.status === 404 ||
      error?.code === "model_not_found" ||
      String(error?.message).includes("does not exist") ||
      String(error).includes("model_not_found");

    if (isModelNotFound) {
      console.warn(`IBE: Model ${modelToUse} not accessible. Trying fallback models...`);
      cachedModel = undefined;

      const fallbacks = PREFERRED_MODELS.filter((m) => m !== modelToUse);
      for (const fallback of fallbacks) {
        try {
          console.log(`IBE: Attempting fallback model: ${fallback}`);
          const content = await requestCompletion(fallback);
          cachedModel = fallback;
          console.log(`IBE: Fallback model ${fallback} succeeded!`);
          return content;
        } catch (fallbackError: any) {
          console.warn(`IBE: Fallback model ${fallback} failed:`, fallbackError?.message);
        }
      }
    }

    throw error;
  }
}