# darija-cli

`darija-cli` is a terminal assistant for Moroccan Darija, French, and English. It turns a natural-language request into one Windows, Linux, or macOS command for the shell, Git, or Docker, then asks you what to do with it.

Nothing runs until you choose **Execute Command**. Destructive commands need a second confirmation. A small set of catastrophic commands is refused outright.

## Quick start

```bash
npm install
npm link

# OpenAI
darija config --key sk-...
# or Groq
darija config --key gsk_...

darija "Show the current Git branch"

# or run fully local with Ollama, no key needed
darija --local "Show the current Git branch"
```

On Windows without `npm link` permissions, replace the last line with:

```powershell
node bin/index.js "Show the current Git branch"
```

Pick **Execute Command** from the menu to run the generated command, or **Copy to Clipboard** to keep it for later.

## Explain a command: `chra7`

```bash
darija chra7 "git reset --hard HEAD~1"
darija chra7 "docker run --rm -it -p 3000:3000 node:20"
```

The command is broken into its program, flags, arguments, and pipes, and every part is explained in plain Moroccan Darija (Latin script). Nothing is executed.

## Fix the last failure: `3ta9`

```bash
darija 3ta9                      # reads the last failure captured by the shell hook
darija 3ta9 "npm ERR! code ENOENT"   # or paste the error text
```

`3ta9` sends the failing command and its error output to the model, prints a diagnosis in Darija, and proposes exactly one safe fix. The fix goes through the same risk check, confirmation menu, and execution path as a generated command. If the last command succeeded, there is nothing to fix.

Automatic capture needs the shell hook, which reads the last command, its error, and its exit code when the prompt is drawn:

```powershell
darija hook --install     # appends the hook to your PowerShell profile
darija hook               # print the snippet instead
```

Open a new PowerShell window after installing. The hook writes `last-error.json` next to the `darija` config file and only stores a failure when the last command failed. On macOS and Linux the hook is PowerShell-only; use the inline form, `darija 3ta9 "…error…"`.

## Write a commit message: `darija commit`

```bash
git add src/auth.ts
darija commit
```

`commit` reads `git diff --cached` (never the whole working tree), sends the staged summary and diff to the model, and prints a Conventional Commits message such as:

```text
feat(auth): refresh expired tokens before retrying

Reuse the stored refresh token when the access token expires.
```

If nothing is staged, it tells you to run `git add` first. After the message is shown, it asks before running `git commit -m "<message>"`. The message is passed as a single argument with `spawn`, so no shell quoting or injection is involved. Large diffs are truncated for the request; the file list and the message stay accurate.

## Generate a script: `darija script`

```bash
darija script "Back up every .env file in this repo into backups/"
darija script "Prune old Docker images and print the freed space"
```

The model writes a complete multi-line script for the current OS, the script is printed with syntax highlighting, and it is saved next to you:

- Windows: `generated_script.ps1`
- macOS and Linux: `generated_script.sh`, with a `#!/usr/bin/env bash` shebang

Existing files are never overwritten: the next name is `generated_script-2.ps1` (and so on). After saving, `darija` shows the risk level and asks before executing the file through PowerShell (`-ExecutionPolicy Bypass -File`) or `bash`. Catastrophic content such as a recursive delete of a drive or system directory is refused and the file is not written at all.

## Run fully local: `--local`

```bash
darija --local "Show the current Git branch"
darija --local -m qwen2.5-coder "Write a script that lists large files"
darija commit --local
```

`-l, --local` sends every request to a local Ollama server at `http://localhost:11434/v1` instead of OpenAI or Groq. No API key is needed. The default model is `llama3`; pick another with `--model`/`-m` or `OLLAMA_MODEL`, for example `qwen2.5-coder`, `qwen2.5:7b`, or anything you pulled with `ollama pull`. Set `DARIJA_OLLAMA_URL` to use a different host or port, and start the server with `ollama serve`. Local requests default to a 120-second timeout because CPU inference is slower than an API call.

The flag works before or after a subcommand: `darija --local chra7 "git status"` and `darija chra7 "git status" --local` are equivalent.

## Terminal UI

- An ASCII `DARIJA` banner is printed on start when output is a terminal.
- While the model works, a spinner shows `AI kayfker... 🧠`.
- Risk levels are colour-coded: 🟢 green `LOW`/safe, 🟡 yellow `MEDIUM`, 🔴 red `HIGH`/dangerous.

## Features

- Saves an OpenAI (`sk-`) or Groq (`gsk_`) API key with `conf` in the OS user config directory, and falls back to `OPENAI_API_KEY` or `GROQ_API_KEY`. The provider is detected from the key prefix.
- `--local` routes any request to a local Ollama server with no API key.
- Detects the operating system and asks the model for a command that fits that shell.
- Returns structured JSON: `command`, `explanation`, `risk_level`, `requires_confirmation`.
- Explains the command in the same language as the request.
- Writes Conventional Commits messages from the staged diff (`darija commit`).
- Generates, highlights, saves, and optionally runs multi-line scripts (`darija script`).
- Interactive menu: execute, copy to the clipboard, or cancel.
- Runs commands that resolve to an executable directly with `spawn` and an argument array, without a shell.
- On Windows, routes `.cmd`, `.bat`, and `.ps1` shims such as `npm`, `npx`, and `yarn` through PowerShell, because Node cannot launch them without a shell.
- Sends pipes, globs, PowerShell cmdlets, and shell builtins to PowerShell or `/bin/sh` only after validation and explicit confirmation.
- Strips `OPENAI_API_KEY` and `GROQ_API_KEY` from the child process environment.
- Masks secrets in success and error output.

## Requirements

- Node.js 18 or newer
- An OpenAI key (`sk-...`), a Groq key (`gsk_...`), or a local Ollama server
- `git` on `PATH` for `darija commit`, and Git or Docker when you ask for those tools

## Install

```bash
mkdir darija-cli
cd darija-cli
npm init -y
npm install commander chalk ora inquirer conf openai clipboardy
```

Create these files (they are already in this repository):

- `package.json` — ESM package (`"type": "module"`) and the `darija` bin entry
- `bin/index.js` — CLI implementation, with a Node shebang
- `src/` — UI, capture, Git, script, and highlighting helpers
- `.gitignore`
- `README.md`

Replace the `package.json` created by `npm init -y` with the one from this project so the `bin` field and `"type": "module"` are present.

On macOS and Linux, mark the executable and link it onto your `PATH`:

```bash
chmod +x bin/index.js
npm link
```

On Windows, `chmod` is unnecessary. `npm link` writes a `darija.cmd` shim:

```powershell
npm link
darija --help
```

If `npm link` is blocked by permissions, run the CLI from the project directory:

```bash
node bin/index.js --help
```

You can also install it into the global npm prefix:

```bash
npm install -g .
```

## Configure the API key

All providers speak the OpenAI chat-completions protocol. Save whichever key you have — the prefix selects the provider and endpoint. Ollama needs no key and is selected with `--local`:

| Key | Provider | Default model | Endpoint |
| --- | --- | --- | --- |
| `sk-...` | OpenAI | `gpt-4o-mini` | `api.openai.com/v1` |
| `gsk_...` | Groq | `openai/gpt-oss-120b` | `api.groq.com/openai/v1` |
| none, `--local` | Ollama | `llama3` | `localhost:11434/v1` |

The saved key wins over environment variables.

```bash
darija config --key sk-your-key     # OpenAI
darija config --key gsk_your_key    # Groq
darija config                       # provider, masked key, source, model, path
darija config --clear
```

Or, without saving a key:

```bash
# macOS and Linux
export OPENAI_API_KEY=sk-your-key
export GROQ_API_KEY=gsk_your_key

# Windows PowerShell
$env:OPENAI_API_KEY = "sk-your-key"
$env:GROQ_API_KEY = "gsk_your_key"
```

If both environment keys are set, `OPENAI_API_KEY` wins; set `DARIJA_PROVIDER=groq` to prefer Groq.

`darija config` prints a masked key (`sk-…ab12`), the active provider and model, which source is active, and the config file path. The full key is never printed.

Optional model override:

```bash
# one request
darija --model gpt-4o-mini "Show the current Git branch"
darija --model llama-3.3-70b-versatile "Show the current Git branch"
darija --local --model qwen2.5-coder "Show the current Git branch"

# every request
export OPENAI_MODEL=gpt-4o-mini
export GROQ_MODEL=llama-3.3-70b-versatile
export OLLAMA_MODEL=qwen2.5-coder
```

`OPENAI_TIMEOUT_MS` defaults to 30000 and is clamped between 5 and 120 seconds; local Ollama requests use 120 seconds unless you set it. `DARIJA_BASE_URL` points the remote client at an OpenAI-compatible proxy instead of the provider default, and `DARIJA_OLLAMA_URL` changes the local endpoint.

## Use

```bash
darija "Create a new Git branch called feature/auth"
darija "Chno hiya branch li ana fiha daba?"
darija "Show all Docker containers"
darija "Supprimer les branches Git locales fusionnées"
darija "Install all project dependencies"
darija "Find and kill the process running on port 3000"
```

After the command and explanation are printed:

```text
? What would you like to do?
❯ 🚀 Execute Command
  📋 Copy to Clipboard
  ❌ Cancel
```

- **Execute Command** runs the command and streams its output. High-risk commands ask you to type `execute`. Other state-changing commands, and anything that must go through a shell, ask for a yes/no confirmation that defaults to no.
- **Copy to Clipboard** copies the exact command with `clipboardy`.
- **Cancel** exits without running anything.

Only strict read-only commands (for example `git status`, `git branch --show-current`, `docker ps`, `ls`, `Get-Process`) skip the second confirmation. If the model claims a command is safe but local checks disagree, the higher local risk wins.

Ctrl+C cancels a prompt. During execution it signals the child process, prints `Interrupted. The command was stopped.`, and exits with code 130.

## How a command is executed

1. `os.platform()` selects Windows PowerShell, macOS zsh/bash, or Linux bash. Other platforms stop with an error.
2. The model must return the four JSON fields. The provider default (`gpt-4o-mini` for OpenAI, `openai/gpt-oss-120b` for Groq) is called with strict structured outputs. If an account or model rejects that format, the CLI retries once with JSON object mode, then retries once if the body is malformed.
3. Local checks raise the risk level above the model's claim when the command deletes files, branches, or tags, resets or cleans a repository, rewrites history, prunes Docker resources, force-pushes, drops stashed work, or stops a process.
4. These shapes are refused even if you confirm them: fork bombs, encoded PowerShell, piping a download into a shell, disk format tools, raw writes to disk devices, and recursive deletes of `/`, a drive root, a system directory, or the home directory.
5. A command with no pipes, globs, or shell syntax runs through `spawn(file, args)` with `shell: false`. PowerShell cmdlets, shell builtins, and Windows `.cmd`/`.bat`/`.ps1` shims use `powershell.exe -NoProfile -NonInteractive -Command` or `/bin/sh -c`, passing the command as one argument. Shell execution always requires confirmation.

The key is stored by `conf` as JSON in the user config directory (mode `0600` where the operating system honors it). It is not encrypted, because an encryption key shipped inside the CLI would not be a secret. Do not commit the config file or put a key in the repository.

`commit` and `script` use extra safeguards:

- The commit message is passed to `git commit -m` as one element of an argument array with `shell: false`, so the message is never parsed by a shell.
- A generated script is written to its own file and then run through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File generated_script.ps1` or `/bin/bash generated_script.sh`. `-ExecutionPolicy Bypass` is required for an unsigned local script that PowerShell would otherwise refuse to load.
- Scripts whose content matches the catastrophic rules (fork bomb, download-and-execute, disk formatting, recursive delete of a drive or system directory) are shown but not saved and cannot be executed.
- Generated scripts and commit messages are always displayed before the confirmation prompt. Nothing is executed without an explicit yes.

## Test the CLI

```bash
node bin/index.js --help
darija config
darija "Show the current Git branch"
darija "Chno hiya branch li ana fiha daba?"
darija "Show all Docker containers"
darija chra7 "git reset --hard HEAD~1"
darija 3ta9 "bash: npm: command not found"
darija --local "Show the current Git branch"
darija commit
darija script "Print the ten largest files in this folder"
```

Choose **Cancel** the first time if you only want to inspect the generated command. Use a Git repository or a running Docker engine when you execute those examples, and run `git add` before trying `darija commit`.

With a Groq key saved, the same commands run against Groq; `darija config` reports `Provider Groq` and the model in use. With `--local`, requests go to Ollama and no key is needed.

## Project layout

```text
darija-cli/
├── bin/
│   └── index.js        # commands, prompts, execution, safety checks
├── src/
│   ├── ui.js           # banner, spinner text, risk colours
│   ├── session.js      # last-error capture file and PowerShell hook
│   ├── git.js          # staged diff reader and git runner
│   ├── script.js       # script file naming, saving, interpreter
│   ├── highlight.js    # bash and PowerShell syntax highlighting
│   └── env.js          # child environment without API keys
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

## License

MIT
