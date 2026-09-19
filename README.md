# IBE Commit

<p align="center">
  <img src="resources/icon.png" alt="IBE Commit Logo" width="128" height="128" />
</p>

<p align="center">
  <strong>AI-Powered Git Commit & Push Assistant for VS Code</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=ibe-commit.ibe-commit"><img src="https://img.shields.io/badge/VS_Code_Marketplace-IBE_Commit-blue?logo=visualstudiocode" alt="Marketplace" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  <img src="https://img.shields.io/badge/version-0.0.3-blueviolet.svg" alt="Version" />
</p>

---

**IBE Commit** is an intelligent VS Code extension that streamlines your Git workflow. It analyzes your workspace changes, inspects file diffs, understands your repository's recent commit conventions, and generates clean, context-aware commit messages using OpenAI—ready to review, edit, commit, and push with a single click.

---

## ✨ Features

- 🤖 **Context-Aware AI Generation**: Analyzes staged/unstaged changes, git diffs, and recent commit history to produce accurate, high-quality conventional commit messages.
- 📝 **Dedicated Review & Edit Panel**: Interactive webview directly in the VS Code Activity Bar allows you to inspect, edit, or regenerate messages before applying them.
- 🚀 **Commit & Push in One Click**: Choose to apply the commit locally or commit and push directly to your remote repository.
- 🛡️ **Safe Undo & Revert**: Accidental commit? Safely undo the last commit with built-in safety checks (clean working tree, matching HEAD, detached HEAD guards) and customizable revert messages.
- 🔒 **Secure API Key Storage**: Stored securely using VS Code's native `SecretStorage` API—your credentials never touch configuration files or code.
- 🎨 **Polished VS Code Experience**: Native Activity Bar integration, Source Control (SCM) title action, smooth loading states, and seamless theme support (Dark & Light).

---

## 🚀 Getting Started

### 1. Installation

Install **IBE Commit** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=ibe-commit.ibe-commit) or install from the Extensions panel in VS Code (`Ctrl+Shift+X` or `Cmd+Shift+X`) by searching for `IBE Commit`.

### 2. Configure Your OpenAI API Key

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run:
   ```text
   IBE Commit: Configure OpenAI API Key
   ```
3. Enter your OpenAI API key (starts with `sk-...`). It will be saved securely in VS Code's encrypted Secret Storage.

---

## 🛠️ How to Use

1. **Make Changes**: Edit or stage your code in any Git-tracked project.
2. **Open IBE Commit**: Click the **IBE Commit** icon in the Activity Bar or click the icon in the Source Control (SCM) title bar.
3. **Generate**: Click **Generate Commit Message**.
4. **Review & Apply**:
   - Review the generated summary and description.
   - Edit the message directly in the textarea if needed.
   - Click **Commit** to commit locally, or **Commit & Push** to push to your remote branch.
   - Click **Regenerate** if you want a different suggestion.
5. **Undo (if needed)**: Click **Undo Last Commit** to initiate a safe Git revert flow with customizable revert messages.

---

## ⌨️ Extension Commands

| Command | Title | Description |
| :--- | :--- | :--- |
| `git-assistant.hello` | **IBE Commit: Hello** | Opens the IBE Commit sidebar panel. |
| `git-assistant.configureApiKey` | **IBE Commit: Configure OpenAI API Key** | Prompts to securely save or update your OpenAI API key. |

---

## 📋 Requirements

- **VS Code**: Version `1.90.0` or higher.
- **Git**: Installed and available in your system path.
- **OpenAI API Key**: Required for AI message generation (`gpt-4o-mini` or compatible models).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
