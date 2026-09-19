export interface ChangeSummary {
  totalFiles: number;
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
}

export interface ChangeContext {
  files: string[];
  diff: string;
  recentCommits: string[];
  summary?: ChangeSummary;
}

export function buildCommitPrompt(context: ChangeContext): string {
  const fileList =
    context.files.length > 0
      ? context.files.map((file) => `- ${file}`).join("\n")
      : "(No changed files detected)";

  const recentCommitsList =
    context.recentCommits && context.recentCommits.length > 0
      ? context.recentCommits
          .map((commit: any) => `- ${typeof commit === "string" ? commit : commit.message}`)
          .join("\n")
      : "(No previous commits found - initial commit)";

  const summaryLine = context.summary
    ? `Change summary:
- Total: ${context.summary.totalFiles} file(s) (${context.summary.modified} modified, ${context.summary.added} added, ${context.summary.deleted} deleted, ${context.summary.renamed} renamed)
`
    : "";

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
${summaryLine}
Changed files:
${fileList}

Git diff:
${context.diff}

Recent commits:
${recentCommitsList}
`;
}