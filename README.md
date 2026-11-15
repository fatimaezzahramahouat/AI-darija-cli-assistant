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
```

On Windows without `npm link` permissions, replace the last line with:

```powershell
node bin/index.js "Show the current Git branch"
```

Pick **Execute Command** from the menu to run the generated command, or **Copy to Clipboard** to keep it for later.

## Features

- Saves an OpenAI (`sk-`) or Groq (`gsk_`) API key with `conf` in the OS user config directory, and falls back to `OPENAI_API_KEY` or `GROQ_API_KEY`. The provider is detected from the key prefix.
- Detects the operating system and asks the model for a command that fits that shell.
- Returns structured JSON: `command`, `explanation`, `risk_level`, `requires_confirmation`.
- Explains the command in the same language as the request.
- Interactive menu: execute, copy to the clipboard, or cancel.
- Runs commands that resolve to an executable directly with `spawn` and an argument array, without a shell.
- On Windows, routes `.cmd`, `.bat`, and `.ps1` shims such as `npm`, `npx`, and `yarn` through PowerShell, because Node cannot launch them without a shell.
- Sends pipes, globs, PowerShell cmdlets, and shell builtins to PowerShell or `/bin/sh` only after validation and explicit confirmation.
- Strips `OPENAI_API_KEY` and `GROQ_API_KEY` from the child process environment.
- Masks secrets in success and error output.

## Requirements

- Node.js 18 or newer
- An OpenAI key (`sk-...`) or a Groq key (`gsk_...`)
- Git or Docker on `PATH` when you ask for those tools

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

Both providers speak the OpenAI chat-completions protocol. Save whichever key you have — the prefix selects the provider and endpoint:

| Key | Provider | Default model | Endpoint |
| --- | --- | --- | --- |
| `sk-...` | OpenAI | `gpt-4o-mini` | `api.openai.com/v1` |
| `gsk_...` | Groq | `openai/gpt-oss-120b` | `api.groq.com/openai/v1` |

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

# every request
export OPENAI_MODEL=gpt-4o-mini
export GROQ_MODEL=llama-3.3-70b-versatile
```

`OPENAI_TIMEOUT_MS` defaults to 30000 and is clamped between 5 and 120 seconds. `DARIJA_BASE_URL` points the client at an OpenAI-compatible proxy instead of the provider default.

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

## Test the CLI

```bash
node bin/index.js --help
darija config
darija "Show the current Git branch"
darija "Chno hiya branch li ana fiha daba?"
darija "Show all Docker containers"
```

Choose **Cancel** the first time if you only want to inspect the generated command. Use a Git repository or a running Docker engine when you execute those examples.

With a Groq key saved, the same commands run against Groq; `darija config` reports `Provider Groq` and the model in use.

## Project layout

```text
darija-cli/
├── bin/
│   └── index.js
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

## License

MIT
