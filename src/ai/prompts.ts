export function buildCommitPrompt(context: {
  files: string[];
  diff: string;
  recentCommits: Array<{
    message: string;
    authorName?: string;
  }>;
}): string {
  return `
You are a Git commit message assistant.

Analyze the provided Git changes and generate a concise, accurate commit message.

Rules:
- Understand the actual code changes from the diff.
- Use the changed file list as supporting context.
- Use recent commit history to understand the project's commit style.
- Do not invent changes that are not present in the diff.
- Choose the most appropriate Conventional Commit type.
- Keep the commit message concise.
- Use imperative mood.
- Return only valid JSON.

Expected JSON format:
{
  "type": "feat | fix | refactor | docs | test | chore | style | perf | build | ci",
  "message": "short imperative commit message",
  "reason": "brief explanation of why this type and message were chosen"
}

Changed files:
${context.files.join("\n")}

Git diff:
${context.diff}

Recent commits:
${context.recentCommits
    .map((commit) => `- ${commit.message}`)
    .join("\n")}
`;
}