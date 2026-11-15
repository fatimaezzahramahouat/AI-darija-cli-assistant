#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import chalk from 'chalk';
import clipboard from 'clipboardy';
import { Command } from 'commander';
import Conf from 'conf';
import inquirer from 'inquirer';
import OpenAI from 'openai';
import ora from 'ora';

import {
  capturePathFor,
  installHook,
  powerShellHook,
  powerShellProfilePath,
  readCapture,
} from '../src/session.js';
import { printBanner, riskLabel, SPINNER_TEXT } from '../src/ui.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const API_TIMEOUT_MS = readTimeout();
const RISK_RANK = { low: 0, medium: 1, high: 2 };

const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    keyPattern: /^sk-[A-Za-z0-9_-]+$/,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    keyEnv: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    keyPattern: /^gsk_[A-Za-z0-9_-]+$/,
  },
};

const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'shell_command',
    description: 'One OS-specific shell, Git, or Docker command for a natural-language request.',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string' },
        explanation: { type: 'string' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        requires_confirmation: { type: 'boolean' },
      },
      required: ['command', 'explanation', 'risk_level', 'requires_confirmation'],
    },
  },
};

const EXPLAIN_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'command_explanation',
    description: 'A line-by-line explanation of one shell command in Moroccan Darija.',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        overview: { type: 'string' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' },
              explanation: { type: 'string' },
            },
            required: ['code', 'explanation'],
          },
        },
      },
      required: ['overview', 'lines'],
    },
  },
};

const FIX_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'command_fix',
    description: 'A Darija diagnosis and one safe fix command for a failed shell command.',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        diagnosis: { type: 'string' },
        command: { type: 'string' },
        explanation: { type: 'string' },
        risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
        requires_confirmation: { type: 'boolean' },
      },
      required: ['diagnosis', 'command', 'explanation', 'risk_level', 'requires_confirmation'],
    },
  },
};

const READ_ONLY_SIMPLE = new Set([
  'ls', 'dir', 'pwd', 'whoami', 'uname', 'cat', 'type', 'head', 'tail', 'wc',
  'which', 'where', 'echo', 'printenv',
  'get-location', 'get-childitem', 'get-content', 'get-date', 'get-command',
  'get-process', 'get-service', 'get-item', 'get-itemproperty', 'get-module',
  'get-help', 'test-path', 'resolve-path',
]);

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'describe', 'rev-parse', 'ls-files',
  'ls-tree', 'ls-remote', 'shortlog', 'whatchanged', 'grep', 'merge-base',
  'name-rev', 'count-objects', 'fsck', 'verify-commit', 'verify-tag',
]);

const GIT_BRANCH_LIST_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-l', '--list',
  '--show-current', '--contains', '--no-contains', '--merged', '--no-merged',
  '--omit-empty', '--no-color', '--ignore-case', '-i', '-q', '--quiet',
]);

const GIT_TAG_LIST_FLAGS = new Set([
  '-l', '--list', '-n', '--contains', '--no-contains', '--merged', '--no-merged',
  '--omit-empty', '--ignore-case', '-i', '-q', '--quiet',
]);

const DOCKER_READ_COMMANDS = new Set([
  'ps', 'images', 'info', 'inspect', 'logs', 'top', 'port', 'history', 'version',
]);

const DOCKER_READ_GROUPS = new Map([
  ['container', new Set(['ls', 'ps', 'inspect', 'logs', 'top', 'port'])],
  ['image', new Set(['ls', 'inspect', 'history'])],
  ['volume', new Set(['ls', 'inspect'])],
  ['network', new Set(['ls', 'inspect'])],
  ['context', new Set(['ls', 'show', 'inspect'])],
  ['system', new Set(['info', 'df'])],
  ['compose', new Set(['ps', 'config', 'logs', 'images', 'top', 'ls', 'version'])],
]);

const WINDOWS_SCRIPT_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1', '.vbs']);
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'pwsh', 'powershell', 'powershell.exe',
  'cmd', 'cmd.exe', 'cscript', 'cscript.exe', 'wscript', 'wscript.exe',
]);

const HIGH_RISK_RULES = [
  { reason: 'recursive delete', pattern: /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\b)/i },
  { reason: 'recursive delete', pattern: /\bRemove-Item\b[^\n]*\s-Recurse\b/i },
  { reason: 'recursive delete', pattern: /\b(?:del|erase)\s+\/[sq]/i },
  { reason: 'recursive delete', pattern: /\b(?:rmdir|rd)\s+\/s\b/i },
  { reason: 'hard reset', pattern: /\bgit\s+reset\s+--hard\b/i },
  { reason: 'git clean', pattern: /\bgit\s+clean\b[^\n]*(?:\s-[a-zA-Z]*f[a-zA-Z]*\b|\s--force\b)/i },
  { reason: 'force push', pattern: /\bgit\s+push\b[^\n]*--force(?:-with-lease)?\b/i },
  { reason: 'force push', pattern: /\bgit\s+push\b[^\n]*(?:^|\s)-f(?:\s|$)/i },
  { reason: 'deleting a branch', pattern: /\bgit\s+branch\b[^\n]*(?:\s-[a-zA-Z]*d\b|\s--delete\b)/i },
  { reason: 'deleting a tag', pattern: /\bgit\s+tag\b[^\n]*(?:\s-[a-zA-Z]*d\b|\s--delete\b)/i },
  { reason: 'deleting a remote branch', pattern: /\bgit\s+push\b[^\n]*(?:\s--(?:delete|prune|mirror)\b|\s-d\b|\s:[^\s:])/i },
  { reason: 'discarding local changes', pattern: /\bgit\s+restore\b/i },
  { reason: 'discarding local changes', pattern: /\bgit\s+checkout\b[^\n]*(?:\s-f\b|\s--force\b|\s--(?:\s|$)|\.\s*$)/i },
  { reason: 'discarding local changes', pattern: /\bgit\s+switch\b[^\n]*(?:\s-f\b|--discard-changes)\b/i },
  { reason: 'dropping stashed work', pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i },
  { reason: 'rewriting repository history', pattern: /\bgit\s+(?:filter-branch|filter-repo)\b/i },
  { reason: 'Docker deletion or prune', pattern: /\bdocker\s+(?:volume\s+(?:rm|prune)|system\s+prune|container\s+prune|image\s+prune|network\s+prune|builder\s+prune|container\s+rm|image\s+rm|rm|rmi)\b/i },
  { reason: 'deleting Docker volumes', pattern: /\bdocker(?:-compose|\s+compose)\s+(?:down|rm)\b[^\n]*(?:^|\s)(?:-v|--volumes)(?:\s|$)/i },
  { reason: 'stopping a process', pattern: /\b(?:kill|pkill|killall|taskkill|Stop-Process)\b/i },
  { reason: 'power control', pattern: /\b(?:shutdown|reboot|halt|poweroff|Restart-Computer|Stop-Computer)\b/i },
  { reason: 'world-writable permissions', pattern: /\bchmod\s+-R\s+0?777\b/i },
  { reason: 'registry deletion', pattern: /\breg(?:\.exe)?\s+delete\b/i },
  { reason: 'destroying file contents', pattern: /\b(?:truncate|shred)\b/i },
  { reason: 'dropping a database object', pattern: /\bdrop\s+(?:database|table)\b/i },
  { reason: 'disk formatting', pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|diskpart|format(?:\.com)?)\b/i },
  { reason: 'raw disk copy', pattern: /\bdd\b/i },
];

const CRITICAL_RM_TARGETS = [
  /^\/+\*?$/,
  /^~\/?\*?$/,
  /^\$\{?HOME\}?\/?\*?$/,
  /^%USERPROFILE%\\?\*?$/i,
  /^[A-Za-z]:\\{0,2}\*?$/,
  /^\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|sys|System|usr|var|Volumes|Applications|Library|Users)\/?\*?$/,
  /^C:\\(?:Windows|Program Files|Program Files \(x86\))\\{0,2}\*?$/i,
];

const UNIX_BUILTINS = new Set([
  '.', 'alias', 'bg', 'bind', 'break', 'builtin', 'cd', 'command', 'continue', 'declare',
  'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'fc', 'fg', 'getopts',
  'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'logout', 'popd', 'printf',
  'pushd', 'pwd', 'read', 'readonly', 'return', 'set', 'shift', 'shopt', 'source', 'suspend',
  'test', 'times', 'trap', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait',
]);

const CMD_BUILTINS = new Set([
  'assoc', 'call', 'cd', 'chdir', 'cls', 'color', 'copy', 'date', 'del', 'dir', 'echo',
  'erase', 'ftype', 'md', 'mkdir', 'mklink', 'move', 'path', 'popd', 'prompt', 'pushd',
  'rd', 'ren', 'rename', 'rmdir', 'set', 'start', 'time', 'title', 'type', 'ver', 'vol',
]);

let storeInstance;
let activeChild = null;
let cancelled = false;
let interrupted = false;

class ResponseParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ResponseParseError';
    this.isParseError = true;
  }
}

function readTimeout() {
  const parsed = Number(process.env.OPENAI_TIMEOUT_MS ?? 30_000);
  if (!Number.isFinite(parsed)) return 30_000;
  return Math.min(120_000, Math.max(5_000, parsed));
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryPath = path.resolve(entry);
    const ownPath = fileURLToPath(import.meta.url);
    if (entryPath === ownPath) return true;
    return realpathSync(entryPath) === realpathSync(ownPath);
  } catch {
    return false;
  }
}

export function redact(text, secret = '') {
  let output = String(text ?? '');
  if (secret) output = output.split(secret).join('[redacted]');
  return output
    .replace(/sk-[A-Za-z0-9_-]{4,}/g, 'sk-[redacted]')
    .replace(/gsk_[A-Za-z0-9_-]{4,}/g, 'gsk_[redacted]');
}

export function sanitizeTerminal(text) {
  return String(text ?? '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}

export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length < 8) return '••••';
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

function getStore() {
  if (!storeInstance) {
    storeInstance = new Conf({
      projectName: 'darija-cli',
      projectSuffix: '',
      configFileMode: 0o600,
      schema: {
        apiKey: {
          type: 'string',
          minLength: 20,
          maxLength: 300,
        },
        provider: { type: 'string' },
        openaiApiKey: {
          type: 'string',
          minLength: 20,
          maxLength: 300,
        },
      },
    });
  }
  return storeInstance;
}

function providerForKey(value) {
  const key = String(value ?? '').trim();
  if (PROVIDERS.groq.keyPattern.test(key)) return 'groq';
  if (PROVIDERS.openai.keyPattern.test(key)) return 'openai';
  return null;
}

function validateApiKey(value) {
  const key = String(value ?? '').trim();
  if (!key) return 'Provide an API key with --key.';
  if (/\s/.test(key)) return 'An API key cannot contain spaces.';
  if (key.length < 20 || key.length > 300) return 'That value does not look like an API key.';
  if (!providerForKey(key)) return 'An API key starts with sk- (OpenAI) or gsk_ (Groq).';
  return '';
}

export function resolveApiKey(env = process.env, store = getStore()) {
  const saved = store.get('apiKey');
  if (typeof saved === 'string' && saved.trim()) {
    const key = saved.trim();
    return { key, provider: providerForKey(key) ?? store.get('provider') ?? 'openai', source: 'saved key' };
  }
  const legacy = store.get('openaiApiKey');
  if (typeof legacy === 'string' && legacy.trim()) {
    const key = legacy.trim();
    return { key, provider: providerForKey(key) ?? 'openai', source: 'saved key' };
  }
  const preferred = env.DARIJA_PROVIDER?.trim().toLowerCase();
  const order = PROVIDERS[preferred] ? [preferred, ...Object.keys(PROVIDERS).filter((id) => id !== preferred)] : Object.keys(PROVIDERS);
  for (const id of order) {
    const fromEnv = env[PROVIDERS[id].keyEnv]?.trim();
    if (fromEnv) return { key: fromEnv, provider: id, source: PROVIDERS[id].keyEnv };
  }
  return null;
}

function environmentProfile() {
  const platform = os.platform();
  if (platform === 'win32') {
    return {
      platform,
      osName: 'Windows',
      shell: 'PowerShell',
      guidance: [
        'Generate Windows PowerShell commands.',
        'Use git, docker, npm, and node when the request is about those tools.',
        'Use PowerShell cmdlets for files, processes, services, and the registry.',
        'Do not emit bash builtins, sudo, grep, awk, sed, or /dev paths.',
      ].join(' '),
    };
  }
  if (platform === 'darwin') {
    const shellName = process.env.SHELL?.split('/').pop();
    const shell = shellName === 'zsh' || shellName === 'bash' ? shellName : 'zsh';
    return {
      platform,
      osName: 'macOS',
      shell,
      guidance: [
        'Generate POSIX commands that work in zsh and bash.',
        'Use git, docker, npm, and node when the request is about those tools.',
        'Do not emit PowerShell cmdlets, cmd.exe syntax, or Windows drive paths.',
      ].join(' '),
    };
  }
  if (platform === 'linux') {
    return {
      platform,
      osName: 'Linux',
      shell: 'bash',
      guidance: [
        'Generate bash-compatible POSIX commands.',
        'Use git, docker, npm, and node when the request is about those tools.',
        'Do not emit PowerShell cmdlets, cmd.exe syntax, or macOS-only tools such as pbcopy.',
      ].join(' '),
    };
  }
  return null;
}

function systemPrompt(profile) {
  return [
    'You convert a natural-language request into exactly one shell, Git, or Docker command.',
    'The user may write Moroccan Darija (Arabic script or Latin Arabizi), French, or English.',
    'Write explanation in the same language and script as the request, in one or two short sentences.',
    'The command itself must be an executable command, not a translation and not markdown.',
    `Operating system: ${profile.osName}.`,
    `Shell: ${profile.shell}.`,
    `Platform id: ${profile.platform}.`,
    profile.guidance,
    'Return one line only. Do not chain unrelated commands.',
    'Set risk_level to low for read-only inspection, medium for ordinary local changes, and high for deletion, reset, prune, force push, killing processes, or anything hard to undo.',
    'Set requires_confirmation to true for every command that changes files, git state, containers, or processes, and always when risk_level is high.',
    'If the request asks to attack another machine, steal credentials, install malware, or bypass security, return an empty command and explain the refusal in the user language.',
    'Local administration of this computer, including inspecting git or stopping a local process the user owns, is in scope.',
    'Never include an API key, token, or secret in the command or the explanation.',
    'Respond with one JSON object that has command, explanation, risk_level, and requires_confirmation.',
  ].join('\n');
}

function explainPrompt(profile) {
  return [
    'You explain terminal commands to a Moroccan developer.',
    'Write every explanation in plain Moroccan Darija using Latin script (Arabizi), keeping technical terms and code fragments as they are.',
    `The commands run on ${profile.osName} in ${profile.shell}.`,
    'Split the command into meaningful segments: the program, each flag, each argument, pipes, redirects, and chained commands.',
    'For each segment, give the exact code fragment and one short Darija sentence describing what it does.',
    'Write the overview in one or two short Darija sentences.',
    'Never suggest running anything, never add markdown, and never invent flags that are not in the command.',
    'Respond with one JSON object that has overview and lines, where each line has code and explanation.',
  ].join('\n');
}

function fixPrompt(profile) {
  return [
    'You are a senior Moroccan developer helping diagnose a failed terminal command.',
    'You receive the command, its exit code, the working directory, the shell, and the captured error output.',
    `The commands run on ${profile.osName} in ${profile.shell}.`,
    'Explain the most likely cause in plain Moroccan Darija using Latin script (Arabizi), keeping technical terms as they are.',
    'Propose exactly one safe, non-interactive fix command for the same operating system and shell, or an empty command when no command can fix it.',
    'Never propose destructive actions, force pushes, recursive deletes, or unrelated chained commands.',
    'Set risk_level and requires_confirmation exactly as a careful engineer would.',
    'Respond with one JSON object that has diagnosis, command, explanation, risk_level, and requires_confirmation.',
  ].join('\n');
}

export function validateCommandString(command) {
  if (typeof command !== 'string') return 'The command is missing.';
  const trimmed = command.trim();
  if (!trimmed) return 'The command is empty.';
  if (trimmed.length > 2000) return 'The command is too long to run safely.';
  if (/[\u0000-\u001F\u007F-\u009F]/.test(trimmed)) return 'The command contains control characters.';
  if (/[\u202A-\u202E\u2066-\u2069\u200B-\u200F\uFEFF]/.test(trimmed)) {
    return 'The command contains hidden or bidirectional characters.';
  }
  if (/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/.test(trimmed)) {
    return 'The command contains unusual space characters.';
  }
  if (hasUnbalancedQuotes(trimmed)) return 'The command has unbalanced quotes.';
  return '';
}

function hasUnbalancedQuotes(input) {
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '\\' && quote === '"') {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
  }
  return quote !== null;
}

function shellWords(input) {
  const tokens = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens.map((token) => token.trim()).filter(Boolean);
}

function unquote(token) {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function scannedForm(command) {
  return command.normalize('NFKC');
}

function blockedReason(command) {
  const scanned = scannedForm(command);
  if (/:\(\)\s*\{/.test(scanned)) return 'fork bomb';
  if (/(?:^|\s)-(?:enc|encodedcommand)\b/i.test(scanned)) return 'encoded command that hides its contents';
  if (/\b(?:curl|wget|Invoke-WebRequest|iwr|irm)\b[^\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i.test(scanned)) {
    return 'downloading a script and executing it';
  }
  if (/\b(?:Invoke-Expression|iex)\b/i.test(scanned) && /\b(?:http|Invoke-WebRequest|iwr|curl|wget|DownloadString)\b/i.test(scanned)) {
    return 'downloading a script and executing it';
  }
  if (/\bmkfs(?:\.[a-z0-9]+)?\b/i.test(scanned) || /\bdiskpart\b/i.test(scanned)) {
    return 'disk partitioning or formatting';
  }
  if (/\bformat(?:\.com)?\s+[A-Za-z]:/i.test(scanned)) return 'formatting a drive';
  if (/\bdd\b[^\n]*\bof=\/dev\/(?:sd|nvme|mmcblk|disk|hd|rdisk)/i.test(scanned)) {
    return 'raw write to a disk device';
  }
  if (/\bcipher\s+\/w\b/i.test(scanned) || /\bbcdedit\b/i.test(scanned)) {
    return 'destructive system configuration';
  }
  const targets = recursiveDeleteTargets(scanned);
  if (targets?.some((target) => CRITICAL_RM_TARGETS.some((pattern) => pattern.test(target)))) {
    return 'recursive delete of a drive, system directory, or home directory';
  }
  if (/\bRemove-Item\b/i.test(scanned) && /-Recurse\b/i.test(scanned)) {
    const words = shellWords(scanned).map(unquote);
    if (words.some((word) => CRITICAL_RM_TARGETS.some((pattern) => pattern.test(word)))) {
      return 'recursive delete of a drive, system directory, or home directory';
    }
  }
  return '';
}

function recursiveDeleteTargets(command) {
  const match = command.match(/\brm\s+(.+)$/i);
  if (!match) return null;
  const parts = shellWords(match[1]).map(unquote);
  let recursive = false;
  const targets = [];
  for (const part of parts) {
    if (part === '--') continue;
    if (part.startsWith('-')) {
      if (part === '--recursive' || /^-.*r/i.test(part)) recursive = true;
      continue;
    }
    targets.push(part);
  }
  return recursive ? targets : null;
}

function highRiskReason(command) {
  const scanned = scannedForm(command);
  const match = HIGH_RISK_RULES.find((rule) => rule.pattern.test(scanned));
  return match?.reason ?? '';
}

function commandName(executable) {
  const base = executable.split(/[\\/]/).pop() || executable;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1|com)$/i, '');
}

function isVersionQuery(args) {
  return args.length === 1 && /^(?:--version|-v|version)$/i.test(args[0]);
}

function isReadOnlyGit(args) {
  if (isVersionQuery(args)) return true;

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path'].includes(arg)) {
      index += 2;
      continue;
    }
    if (['--no-pager', '--paginate', '-P', '--no-replace-objects', '--bare', '--literal-pathspecs'].includes(arg)) {
      index += 1;
      continue;
    }
    if (/^--(?:git-dir|work-tree|namespace|config-env|exec-path)=/.test(arg)) {
      index += 1;
      continue;
    }
    break;
  }

  const subcommand = (args[index] || '').toLowerCase();
  const rest = args.slice(index + 1);
  if (!subcommand) return false;

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return !rest.some((arg) => /^--output(?:=|\b)/i.test(arg));
  }
  if (subcommand === 'branch') {
    return rest.every((arg) => GIT_BRANCH_LIST_FLAGS.has(arg) || /^--(?:contains|sort|format|points-at|color|column)=/.test(arg));
  }
  if (subcommand === 'tag') {
    return rest.every((arg) => GIT_TAG_LIST_FLAGS.has(arg) || /^--(?:contains|sort|format|points-at|color|column)=/.test(arg) || /^-n\d*$/.test(arg));
  }
  if (subcommand === 'remote') {
    if (rest.length === 0) return true;
    if (rest.every((arg) => /^(?:-v|--verbose)$/.test(arg))) return true;
    return /^(?:show|get-url)$/.test(rest[0]);
  }
  if (subcommand === 'stash') return /^(?:list|show)$/.test(rest[0] || '');
  if (subcommand === 'config') return /^(?:--get|--get-all|--get-regexp|--list|-l)$/.test(rest[0] || '');
  if (subcommand === 'worktree') return /^list$/.test(rest[0] || '');
  if (subcommand === 'submodule') return /^(?:status|summary)$/.test(rest[0] || '');
  return false;
}

function isReadOnlyDocker(args) {
  if (isVersionQuery(args)) return true;
  const group = (args[0] || '').toLowerCase();
  if (!group) return false;
  if (DOCKER_READ_COMMANDS.has(group)) return true;
  const subcommands = DOCKER_READ_GROUPS.get(group);
  return Boolean(subcommands?.has((args[1] || '').toLowerCase()));
}

function isReadOnlyNpm(args) {
  if (isVersionQuery(args)) return true;
  const subcommand = (args[0] || '').toLowerCase();
  if (['ls', 'list', 'outdated', 'view', 'show', 'root', 'why', 'explain', 'search'].includes(subcommand)) {
    return true;
  }
  if (subcommand === 'config') return /^(?:get|list)$/.test((args[1] || '').toLowerCase());
  return false;
}

function isReadOnlyCommand(command) {
  const scanned = scannedForm(command).trim();
  if (/[;&]|&&|\|\||[<>`]|\$\(/.test(scanned)) return false;
  if (scanned.includes('|')) return false;

  const words = shellWords(scanned).map(unquote);
  if (words.length === 0) return false;
  const [executable, ...args] = words;
  const name = commandName(executable);
  if (name === 'git') return isReadOnlyGit(args);
  if (name === 'docker') return isReadOnlyDocker(args);
  if (name === 'npm') return isReadOnlyNpm(args);
  if (name === 'node') return isVersionQuery(args);
  return READ_ONLY_SIMPLE.has(name);
}

export function classifyCommand(command, modelAssessment = {}) {
  const problem = validateCommandString(command);
  if (problem) {
    return {
      ok: false,
      problem,
      blocked: false,
      risk_level: 'high',
      requires_confirmation: true,
      reason: problem,
    };
  }

  const block = blockedReason(command);
  if (block) {
    return {
      ok: true,
      blocked: true,
      risk_level: 'high',
      requires_confirmation: true,
      reason: block,
    };
  }

  const destructive = highRiskReason(command);
  const readOnly = isReadOnlyCommand(command);
  let risk = readOnly ? 'low' : 'medium';
  if (destructive) risk = 'high';
  const modelRisk = RISK_RANK[modelAssessment.risk_level] === undefined ? 'medium' : modelAssessment.risk_level;
  if (RISK_RANK[modelRisk] > RISK_RANK[risk]) risk = modelRisk;

  return {
    ok: true,
    blocked: false,
    risk_level: risk,
    requires_confirmation: risk !== 'low' || modelAssessment.requires_confirmation === true,
    reason: destructive || (risk === 'low' ? 'read-only' : 'changes local state'),
  };
}

function needsInterpreter(executable, platform) {
  const name = unquote(executable).toLowerCase();
  if (!name || name.startsWith('-')) return true;
  if (/^[a-z_][a-z0-9_]*=/i.test(name)) return true;
  if (/^(?:get|set|new|remove|start|stop|restart|select|where|foreach|out|invoke|import|export|clear|copy|move|test|format|convertto|convertfrom|write|add|enable|disable|update|wait|measure|sort|group|resolve|split|join|push|pop|enter|exit|show)-[a-z]/i.test(name)) {
    return true;
  }
  if (platform === 'win32' && CMD_BUILTINS.has(name)) return true;
  if (platform !== 'win32' && UNIX_BUILTINS.has(name)) return true;
  return false;
}

export function tokenizeCommand(input, platform = process.platform) {
  const tokens = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && quote === '"') {
        const next = input[index + 1];
        if (next === undefined) return null;
        current += next;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    if ('|&;<>`$()#*?[]'.includes(char)) return null;
    if (char === '~' && platform !== 'win32') return null;
    if (char === '\\') {
      if (platform === 'win32') {
        current += char;
        continue;
      }
      return null;
    }
    current += char;
  }

  if (current) tokens.push(current);
  if (quote || tokens.length === 0) return null;
  if (needsInterpreter(tokens[0], platform)) return null;
  return tokens;
}

function powershellExecutable() {
  const root = process.env.SystemRoot || process.env.windir;
  if (root) {
    const candidate = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function windowsSpawnsDirectly(executable) {
  const extension = path.extname(executable).toLowerCase();
  if (extension) return extension === '.exe' || extension === '.com';
  if (/[\\/]/.test(executable)) {
    if (existsSync(`${executable}.exe`) || existsSync(`${executable}.com`)) return true;
    return ![...WINDOWS_SCRIPT_EXTENSIONS].some((ext) => existsSync(`${executable}${ext}`));
  }

  const extensions = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);
  const directories = (process.env.PATH || '')
    .split(path.delimiter)
    .map((item) => item.replace(/^"|"$/g, ''))
    .filter(Boolean);

  let scriptShim = false;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`);
      if (!existsSync(candidate)) continue;
      if (WINDOWS_SCRIPT_EXTENSIONS.has(extension.toLowerCase())) {
        scriptShim = true;
        continue;
      }
      return true;
    }
  }
  return !scriptShim;
}

function shellPlan(command, platform) {
  if (platform === 'win32') {
    return {
      mode: 'shell',
      shellLike: true,
      file: powershellExecutable(),
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
      command,
    };
  }
  return {
    mode: 'shell',
    shellLike: true,
    file: '/bin/sh',
    args: ['-c', command],
    command,
  };
}

export function executionPlan(command, platform = process.platform) {
  const trimmed = command.trim();
  const tokens = tokenizeCommand(trimmed, platform);
  if (tokens && !(platform === 'win32' && !windowsSpawnsDirectly(tokens[0]))) {
    const shellLike = INTERPRETERS.has(commandName(tokens[0]));
    return { mode: 'execFile', shellLike, file: tokens[0], args: tokens.slice(1), command: trimmed };
  }
  return shellPlan(trimmed, platform);
}

export function describePlan(plan) {
  if (plan.mode === 'execFile') {
    if (plan.shellLike) {
      return `Runs ${plan.file} with separate arguments; that program executes the command text itself.`;
    }
    return `Runs ${plan.file} with separate arguments and no shell.`;
  }
  if (plan.file.toLowerCase().includes('powershell')) {
    return 'Runs in PowerShell as one confirmed command.';
  }
  return 'Runs in /bin/sh as one confirmed command.';
}

function childEnvironment() {
  const env = { ...process.env };
  for (const provider of Object.values(PROVIDERS)) delete env[provider.keyEnv];
  return env;
}

function stopChild(child, force = false) {
  if (!child?.pid) return;
  try {
    child.kill(force ? 'SIGKILL' : 'SIGINT');
  } catch {
    // The child has already exited.
  }
}

export function runPlannedCommand(command, platform = process.platform) {
  const problem = validateCommandString(command);
  if (problem) return Promise.reject(new Error(problem));
  const block = blockedReason(command);
  if (block) return Promise.reject(new Error(`Refusing to run this command (${block}).`));

  const plan = executionPlan(command, platform);
  return new Promise((resolve, reject) => {
    let settled = false;
    interrupted = false;
    const child = spawn(plan.file, plan.args, {
      stdio: 'inherit',
      windowsHide: true,
      shell: false,
      env: childEnvironment(),
    });
    activeChild = child;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = null;
      handler(value);
    };

    child.once('error', (error) => {
      if (error?.code === 'ENOENT') {
        finish(reject, new Error(`Could not find ${plan.file}. Install it and make sure it is on PATH.`));
        return;
      }
      finish(reject, error);
    });

    child.once('close', (code, signal) => {
      const stopped = interrupted || signal === 'SIGINT' || signal === 'SIGTERM';
      finish(resolve, stopped ? 130 : (code ?? 1));
    });
  });
}

function extractJson(text) {
  const trimmed = String(text ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function readRisk(value) {
  const risk = typeof value.risk_level === 'string' ? value.risk_level.toLowerCase() : '';
  if (!['low', 'medium', 'high'].includes(risk)) {
    throw new ResponseParseError('The model returned an invalid risk_level.');
  }
  if (typeof value.requires_confirmation !== 'boolean') {
    throw new ResponseParseError('The model returned an invalid requires_confirmation value.');
  }
  return { risk, requires_confirmation: value.requires_confirmation };
}

function normalizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponseParseError('The model response was not a JSON object.');
  }
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const explanation = typeof value.explanation === 'string'
    ? sanitizeTerminal(value.explanation).replace(/\s+/g, ' ').trim()
    : '';
  const { risk, requires_confirmation } = readRisk(value);
  if (!explanation) throw new ResponseParseError('The model omitted the explanation.');
  if (explanation.length > 1200) throw new ResponseParseError('The explanation was too long.');
  if (command) {
    const problem = validateCommandString(command);
    if (problem) throw new ResponseParseError(problem);
  }
  return {
    command,
    explanation,
    risk_level: risk,
    requires_confirmation,
  };
}

function normalizeExplanation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponseParseError('The model response was not a JSON object.');
  }
  const overview = typeof value.overview === 'string'
    ? sanitizeTerminal(value.overview).replace(/\s+/g, ' ').trim()
    : '';
  if (!overview) throw new ResponseParseError('The model omitted the overview.');
  if (overview.length > 600) throw new ResponseParseError('The overview was too long.');
  const lines = Array.isArray(value.lines) ? value.lines.slice(0, 15) : [];
  const parsed = lines
    .map((line) => ({
      code: typeof line?.code === 'string' ? sanitizeTerminal(line.code).trim() : '',
      explanation: typeof line?.explanation === 'string'
        ? sanitizeTerminal(line.explanation).replace(/\s+/g, ' ').trim()
        : '',
    }))
    .filter((line) => line.code && line.explanation);
  if (!parsed.length) throw new ResponseParseError('The model returned no explanation lines.');
  if (parsed.some((line) => line.code.length > 300 || line.explanation.length > 500)) {
    throw new ResponseParseError('One explanation line was too long.');
  }
  return { overview, lines: parsed };
}

function normalizeFix(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResponseParseError('The model response was not a JSON object.');
  }
  const diagnosis = typeof value.diagnosis === 'string'
    ? sanitizeTerminal(value.diagnosis).replace(/\s+/g, ' ').trim()
    : '';
  if (!diagnosis) throw new ResponseParseError('The model omitted the diagnosis.');
  if (diagnosis.length > 800) throw new ResponseParseError('The diagnosis was too long.');
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  const explanation = typeof value.explanation === 'string'
    ? sanitizeTerminal(value.explanation).replace(/\s+/g, ' ').trim()
    : '';
  const { risk, requires_confirmation } = readRisk(value);
  if (!explanation) throw new ResponseParseError('The model omitted the explanation.');
  if (explanation.length > 1200) throw new ResponseParseError('The explanation was too long.');
  if (command) {
    const problem = validateCommandString(command);
    if (problem) throw new ResponseParseError(problem);
  }
  return {
    diagnosis,
    command,
    explanation,
    risk_level: risk,
    requires_confirmation,
  };
}

function schemaUnsupported(error) {
  if (error?.status !== 400) return false;
  return /response_format|json_schema|structured/i.test(String(error.message ?? ''));
}

const RETRY_HINT = 'The previous response was invalid. Return only one valid JSON object that matches the requested fields.';

async function requestCompletion(client, model, messages, responseFormat, normalize, maxTokens = 700) {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages,
    response_format: responseFormat,
  });
  const message = completion.choices?.[0]?.message;
  if (message?.refusal) {
    throw new Error(String(message.refusal).trim() || 'The model refused the request.');
  }
  if (!message?.content) throw new ResponseParseError('The model returned an empty response.');
  try {
    return normalize(JSON.parse(extractJson(message.content)));
  } catch (error) {
    if (error instanceof ResponseParseError) throw error;
    if (error instanceof SyntaxError) throw new ResponseParseError('The model returned malformed JSON.');
    throw error;
  }
}

async function requestStructured(client, model, messages, { responseFormat, normalize, maxTokens = 700 }) {
  let format = responseFormat;
  let conversation = messages;
  let hinted = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await requestCompletion(client, model, conversation, format, normalize, maxTokens);
    } catch (error) {
      if (format.type === 'json_schema' && schemaUnsupported(error)) {
        format = { type: 'json_object' };
        continue;
      }
      if (error?.isParseError && !hinted) {
        hinted = true;
        conversation = [...conversation, { role: 'user', content: RETRY_HINT }];
        continue;
      }
      throw error;
    }
  }
  throw new ResponseParseError('The model could not produce a valid response.');
}

function createClient(apiKey, provider) {
  return new OpenAI({
    apiKey,
    baseURL: process.env.DARIJA_BASE_URL?.trim() || provider.baseURL,
    timeout: API_TIMEOUT_MS,
    maxRetries: 0,
  });
}

async function generateCommand(query, apiKey, profile, model, provider) {
  const messages = [
    { role: 'system', content: systemPrompt(profile) },
    {
      role: 'user',
      content: `Operating system: ${profile.osName}\nShell: ${profile.shell}\nRequest: ${query}`,
    },
  ];
  return requestStructured(createClient(apiKey, provider), model, messages, {
    responseFormat: RESPONSE_FORMAT,
    normalize: normalizePayload,
    maxTokens: 700,
  });
}

async function explainCommand(command, apiKey, profile, model, provider) {
  const messages = [
    { role: 'system', content: explainPrompt(profile) },
    { role: 'user', content: `Command: ${command}` },
  ];
  return requestStructured(createClient(apiKey, provider), model, messages, {
    responseFormat: EXPLAIN_FORMAT,
    normalize: normalizeExplanation,
    maxTokens: 900,
  });
}

async function suggestFix(captured, apiKey, profile, model, provider) {
  const errorText = captured.error ? sanitizeTerminal(captured.error) : '(no error output was captured)';
  const messages = [
    { role: 'system', content: fixPrompt(profile) },
    {
      role: 'user',
      content: [
        `Command: ${captured.command || '(unknown)'}`,
        `Exit code: ${captured.exitCode ?? 'unknown'}`,
        `Working directory: ${captured.cwd || '(unknown)'}`,
        `Shell: ${captured.shell}`,
        'Error output:',
        errorText,
      ].join('\n'),
    },
  ];
  return requestStructured(createClient(apiKey, provider), model, messages, {
    responseFormat: FIX_FORMAT,
    normalize: normalizeFix,
    maxTokens: 900,
  });
}

function formatApiError(error, apiKey, provider) {
  const label = provider?.label ?? 'API';
  const keyEnv = provider?.keyEnv ?? 'OPENAI_API_KEY';
  const modelEnv = provider?.modelEnv ?? 'OPENAI_MODEL';
  const status = error?.status;
  const code = error?.code ?? error?.error?.code;
  if (code === 'insufficient_quota') {
    return `${label} reports no available quota for this account. Add credits or check the billing page.`;
  }
  if (status === 401) return `${label} rejected the API key. Check darija config or ${keyEnv}.`;
  if (status === 429) return `${label} rate limit reached. Wait a moment and try again.`;
  if (status === 404) return `That model was not found. Set ${modelEnv} to a model your account can use.`;
  if (status === 403) return `${label} refused this request. The key may lack access to that model.`;
  if (error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') {
    return `The ${label} request timed out after ${API_TIMEOUT_MS}ms.`;
  }
  if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET') {
    return `Could not reach the ${label} API. Check the network connection.`;
  }
  return sanitizeTerminal(redact(error?.message || `The ${label} request failed.`, apiKey));
}

function printProposal(payload, verdict, plan, profile, model, providerLabel) {
  console.log('');
  console.log(chalk.bold('Command'));
  console.log(chalk.cyan(`  ${payload.command}`));
  console.log('');
  console.log(chalk.bold('Explanation'));
  console.log(`  ${sanitizeTerminal(payload.explanation)}`);
  console.log('');
  console.log(chalk.bold('Risk'));
  console.log(`  ${riskLabel(verdict.risk_level)} ${chalk.dim(`· ${verdict.reason}`)}`);
  console.log(chalk.dim(`  ${profile.osName} · ${profile.shell} · ${sanitizeTerminal(providerLabel)} ${sanitizeTerminal(model)}`));
  console.log(chalk.dim(`  ${describePlan(plan)}`));
  if (verdict.blocked) {
    console.log(chalk.red('\nThis command is blocked and will not be executed.'));
  }
}

function installSignalHandlers() {
  process.on('SIGINT', () => {
    if (activeChild) {
      if (interrupted) {
        stopChild(activeChild, true);
        process.exit(130);
      }
      interrupted = true;
      stopChild(activeChild);
      return;
    }
    if (cancelled) return;
    cancelled = true;
    console.log(chalk.yellow('\nCancelled. Nothing was executed.'));
    process.exit(130);
  });

  process.on('SIGTERM', () => {
    if (activeChild) {
      interrupted = true;
      stopChild(activeChild);
      return;
    }
    process.exit(143);
  });
}

async function ask(questions) {
  const pending = inquirer.prompt(questions);
  const ui = pending.ui;
  if (ui?.rl) {
    ui.rl.removeListener('SIGINT', ui.onForceClose);
    ui.rl.on('SIGINT', () => {
      try {
        ui.close();
      } catch {
        // The prompt was already closed.
      }
      if (!cancelled) {
        cancelled = true;
        console.log(chalk.yellow('\nCancelled. Nothing was executed.'));
      }
      process.exit(130);
    });
  }
  return pending;
}

async function promptAction(verdict) {
  const choices = [];
  if (!verdict.blocked) {
    choices.push({ name: '🚀 Execute Command', value: 'execute' });
  }
  choices.push(
    { name: '📋 Copy to Clipboard', value: 'copy' },
    { name: '❌ Cancel', value: 'cancel' },
  );

  try {
    const answer = await ask([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices,
        pageSize: choices.length,
      },
    ]);
    return answer.action;
  } catch (error) {
    if (cancelled) return 'cancel';
    throw error;
  }
}

async function confirmExecution(verdict) {
  if (verdict.risk_level === 'high') {
    console.log(chalk.red.bold('\nAdditional confirmation'));
    console.log(chalk.red(`This is a high-risk command (${verdict.reason}).`));
    const answer = await ask([
      {
        type: 'input',
        name: 'typed',
        message: 'Type execute to run it:',
      },
    ]);
    return answer.typed.trim().toLowerCase() === 'execute';
  }

  const answer = await ask([
    {
      type: 'confirm',
      name: 'ok',
      default: false,
      message: 'Run this command?',
    },
  ]);
  return answer.ok === true;
}

async function copyCommand(command, apiKey) {
  try {
    await clipboard.write(command);
    console.log(chalk.green('Copied the command to the clipboard.'));
  } catch (error) {
    console.error(chalk.red(sanitizeTerminal(redact(error?.message || 'Could not copy to the clipboard.', apiKey))));
    process.exitCode = 1;
  }
}

async function handleAction(action, payload, verdict, apiKey) {
  if (action === 'copy') {
    await copyCommand(payload.command, apiKey);
    return;
  }
  if (action !== 'execute' || verdict.blocked) {
    console.log(chalk.yellow('Cancelled. Nothing was executed.'));
    return;
  }

  const plan = executionPlan(payload.command);
  const needsConfirm = verdict.requires_confirmation || verdict.risk_level !== 'low' || plan.shellLike;
  if (needsConfirm) {
    const confirmed = await confirmExecution(verdict);
    if (!confirmed) {
      console.log(chalk.yellow('Cancelled. Nothing was executed.'));
      return;
    }
  }

  const latest = classifyCommand(payload.command, payload);
  if (latest.blocked || !latest.ok) {
    console.error(chalk.red(`Refusing to run this command (${latest.reason}).`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.dim('\nRunning...\n'));
  const code = await runPlannedCommand(payload.command);
  if (code === 130) {
    console.log(chalk.yellow('\nInterrupted. The command was stopped.'));
    process.exitCode = 130;
    return;
  }
  if (code === 0) {
    console.log(chalk.green('\nCommand finished successfully.'));
    return;
  }
  console.error(chalk.red(`\nCommand exited with code ${code}.`));
  process.exitCode = code || 1;
}

function loadProviderSession() {
  let resolved;
  try {
    resolved = resolveApiKey();
  } catch (error) {
    console.error(chalk.red('Could not read the saved configuration.'));
    console.error(chalk.dim(sanitizeTerminal(redact(error?.message || 'The configuration file may be damaged.'))));
    console.error(chalk.dim('Fix or remove the file, run darija config --key <API_KEY>, or set OPENAI_API_KEY or GROQ_API_KEY.'));
    process.exitCode = 1;
    return null;
  }
  if (!resolved) {
    console.error(chalk.red('No API key is configured.'));
    console.error(chalk.dim('Save one with darija config --key <API_KEY>, or set OPENAI_API_KEY or GROQ_API_KEY.'));
    process.exitCode = 1;
    return null;
  }
  return { resolved, provider: PROVIDERS[resolved.provider] ?? PROVIDERS.openai };
}

function selectedModel(provider, options = {}) {
  return options.model || process.env[provider.modelEnv]?.trim() || provider.defaultModel;
}

function printExplanation(command, result, providerLabel, model) {
  console.log('');
  console.log(chalk.bold('Command'));
  console.log(chalk.cyan(`  ${sanitizeTerminal(command)}`));
  console.log('');
  console.log(chalk.bold('Chra7 b darija'));
  console.log(`  ${result.overview}`);
  console.log('');
  for (const line of result.lines) {
    console.log(`  ${chalk.cyan(line.code)}`);
    console.log(`    ${chalk.dim('↳')} ${line.explanation}`);
  }
  console.log(chalk.dim(`\n  ${providerLabel} ${sanitizeTerminal(model)}`));
}

function printDiagnosis(captured, result, providerLabel, model) {
  console.log('');
  if (captured.command) {
    console.log(chalk.bold('Last command'));
    console.log(chalk.cyan(`  ${sanitizeTerminal(captured.command)}`));
    console.log('');
  }
  if (captured.error) {
    const preview = sanitizeTerminal(captured.error).split('\n').slice(0, 12);
    console.log(chalk.bold('Error'));
    console.log(chalk.dim(preview.map((line) => `  ${line}`).join('\n')));
    console.log('');
  }
  console.log(chalk.bold('Tachkhis b darija'));
  console.log(`  ${result.diagnosis}`);
  console.log(chalk.dim(`  ${providerLabel} ${sanitizeTerminal(model)}`));
  if (!result.command) {
    console.log(chalk.yellow('\nMa l9itch commande dyal l-fix.'));
  }
}

async function runExplain(parts) {
  const command = parts.join(' ').trim();
  if (!command) {
    console.error(chalk.red('Give me a command to explain, for example: darija chra7 "git reset --hard"'));
    process.exitCode = 1;
    return;
  }

  const profile = environmentProfile();
  if (!profile) {
    console.error(chalk.red(`Unsupported operating system: ${os.platform()}. darija supports Windows, Linux, and macOS.`));
    process.exitCode = 1;
    return;
  }

  const problem = validateCommandString(command);
  if (problem) {
    console.error(chalk.red(problem));
    process.exitCode = 1;
    return;
  }

  const session = loadProviderSession();
  if (!session) return;
  const { resolved, provider } = session;
  const model = selectedModel(provider);

  printBanner();
  console.log(chalk.bold.cyan('darija chra7') + chalk.dim(`  ${profile.osName} · ${profile.shell} · ${provider.label}`));
  const spinner = ora({ text: SPINNER_TEXT, color: 'cyan' }).start();

  let result;
  try {
    result = await explainCommand(command, resolved.key, profile, model, provider);
    spinner.succeed('Chra7 wajed');
  } catch (error) {
    spinner.fail('Could not explain the command');
    console.error(chalk.red(formatApiError(error, resolved.key, provider)));
    process.exitCode = 1;
    return;
  }

  printExplanation(command, result, provider.label, model);
}

async function runFix(parts) {
  const profile = environmentProfile();
  if (!profile) {
    console.error(chalk.red(`Unsupported operating system: ${os.platform()}. darija supports Windows, Linux, and macOS.`));
    process.exitCode = 1;
    return;
  }

  const inline = parts.join(' ').trim();
  const captured = inline
    ? { command: '', error: inline, exitCode: null, cwd: process.cwd(), shell: profile.shell, capturedAt: null }
    : readCapture(capturePathFor(getStore().path));

  if (!captured) {
    console.log(chalk.yellow('Ma3ndich error output dyal commande lakhira.'));
    console.log(chalk.dim('Install the shell hook once: darija hook --install'));
    console.log(chalk.dim('Or paste the error: darija 3ta9 "npm ERR! ..."'));
    process.exitCode = 1;
    return;
  }

  const session = loadProviderSession();
  if (!session) return;
  const { resolved, provider } = session;
  const model = selectedModel(provider);

  printBanner();
  console.log(chalk.bold.cyan('darija 3ta9') + chalk.dim(`  ${profile.osName} · ${profile.shell} · ${provider.label}`));
  const spinner = ora({ text: SPINNER_TEXT, color: 'cyan' }).start();

  let result;
  try {
    result = await suggestFix(captured, resolved.key, profile, model, provider);
    spinner.succeed('Tachkhis wajed');
  } catch (error) {
    spinner.fail('Could not diagnose the failure');
    console.error(chalk.red(formatApiError(error, resolved.key, provider)));
    process.exitCode = 1;
    return;
  }

  printDiagnosis(captured, result, provider.label, model);
  if (!result.command) return;

  const verdict = classifyCommand(result.command, result);
  if (!verdict.ok) {
    console.error(chalk.red(verdict.problem));
    process.exitCode = 1;
    return;
  }
  printProposal(result, verdict, executionPlan(result.command, profile.platform), profile, model, provider.label);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(chalk.yellow('\nAn interactive terminal is required before anything can run. Nothing was executed.'));
    return;
  }

  const action = await promptAction(verdict);
  await handleAction(action, result, verdict, resolved.key);
}

async function runHook(options) {
  const capturePath = capturePathFor(getStore().path);
  if (process.platform !== 'win32') {
    console.log(chalk.yellow('Automatic capture is implemented for Windows PowerShell.'));
    console.log(chalk.dim('On macOS or Linux, paste the error instead: darija 3ta9 "error text"'));
    return;
  }

  if (!options.install) {
    console.log(chalk.bold('Add this block to your PowerShell profile') + chalk.dim(' (notepad $PROFILE):'));
    console.log('');
    console.log(powerShellHook(capturePath));
    console.log('');
    console.log(chalk.dim('Or install it automatically: darija hook --install'));
    console.log(chalk.dim(`Captured state file: ${capturePath}`));
    return;
  }

  try {
    const profilePath = await powerShellProfilePath(powershellExecutable());
    installHook(profilePath, capturePath);
    console.log(chalk.green(`Hook installed in ${sanitizeTerminal(profilePath)}.`));
    console.log(chalk.dim('Restart PowerShell or run: . $PROFILE'));
  } catch (error) {
    console.error(chalk.red(sanitizeTerminal(error?.message || 'Could not install the hook.')));
    process.exitCode = 1;
  }
}

async function runQuery(words, options) {
  const query = words.join(' ').trim();
  if (!query) {
    program.outputHelp();
    return;
  }

  const profile = environmentProfile();
  if (!profile) {
    console.error(chalk.red(`Unsupported operating system: ${os.platform()}. darija supports Windows, Linux, and macOS.`));
    process.exitCode = 1;
    return;
  }

  const session = loadProviderSession();
  if (!session) return;
  const { resolved, provider } = session;
  const model = selectedModel(provider, options);

  printBanner();
  console.log(chalk.bold.cyan('darija') + chalk.dim(`  ${profile.osName} · ${profile.shell} · ${provider.label}`));
  const spinner = ora({ text: SPINNER_TEXT, color: 'cyan' }).start();

  let payload;
  try {
    payload = await generateCommand(query, resolved.key, profile, model, provider);
    spinner.succeed('Command ready');
  } catch (error) {
    spinner.fail('Could not generate a command');
    console.error(chalk.red(formatApiError(error, resolved.key, provider)));
    process.exitCode = 1;
    return;
  }

  if (!payload.command) {
    console.log('');
    console.log(sanitizeTerminal(payload.explanation));
    console.log(chalk.yellow('\nNo command was generated.'));
    return;
  }

  const verdict = classifyCommand(payload.command, payload);
  if (!verdict.ok) {
    console.error(chalk.red(verdict.problem));
    process.exitCode = 1;
    return;
  }

  const plan = executionPlan(payload.command, profile.platform);
  printProposal(payload, verdict, plan, profile, model, provider.label);

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(chalk.yellow('\nAn interactive terminal is required before anything can run. Nothing was executed.'));
    return;
  }

  const action = await promptAction(verdict);
  await handleAction(action, payload, verdict, resolved.key);
}

function runConfig(options) {
  try {
    configure(options);
  } catch (error) {
    console.error(chalk.red(sanitizeTerminal(redact(error?.message || 'Could not read or write the configuration.', options.key || ''))));
    process.exitCode = 1;
  }
}

function configure(options) {
  if (options.key && options.clear) {
    console.error(chalk.red('Use either --key or --clear, not both.'));
    process.exitCode = 1;
    return;
  }

  const store = getStore();
  if (options.clear) {
    store.delete('apiKey');
    store.delete('openaiApiKey');
    store.delete('provider');
    console.log(chalk.green('Removed the saved API key.'));
    return;
  }

  if (options.key) {
    const problem = validateApiKey(options.key);
    if (problem) {
      console.error(chalk.red(problem));
      process.exitCode = 1;
      return;
    }
    const key = options.key.trim();
    const provider = providerForKey(key);
    try {
      store.set('apiKey', key);
      store.set('provider', provider);
    } catch (error) {
      console.error(chalk.red(redact(error?.message || 'Could not save the API key.', key)));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Saved the ${PROVIDERS[provider].label} API key (${maskSecret(key)}).`));
    console.log(chalk.dim(sanitizeTerminal(store.path)));
    return;
  }

  const saved = store.get('apiKey') ?? store.get('openaiApiKey');
  const active = resolveApiKey();
  const envSummary = Object.values(PROVIDERS)
    .map((provider) => {
      const value = process.env[provider.keyEnv]?.trim();
      return `${provider.keyEnv}: ${value ? maskSecret(value) : 'not set'}`;
    })
    .join(' · ');
  const activeProvider = active ? PROVIDERS[active.provider] : null;
  const activeModel = activeProvider
    ? (process.env[activeProvider.modelEnv]?.trim() || activeProvider.defaultModel)
    : 'none';
  console.log(`${chalk.bold('Provider')}   ${activeProvider ? activeProvider.label : chalk.dim('none')}`);
  console.log(`${chalk.bold('Saved key')}  ${typeof saved === 'string' && saved ? maskSecret(saved) : chalk.dim('not set')}`);
  console.log(`${chalk.bold('Env key')}    ${envSummary}`);
  console.log(`${chalk.bold('Active')}     ${active ? `${active.source} (${maskSecret(active.key)})` : chalk.red('none')}`);
  console.log(`${chalk.bold('Model')}      ${sanitizeTerminal(activeModel)}`);
  console.log(`${chalk.bold('File')}       ${chalk.dim(sanitizeTerminal(store.path))}`);
}

const program = new Command();

program
  .name('darija')
  .description('Turn Moroccan Darija, French, or English into an OS-specific shell, Git, or Docker command.')
  .version(packageJson.version)
  .showHelpAfterError()
  .option('-m, --model <name>', 'Model name (defaults to the provider default, or OPENAI_MODEL / GROQ_MODEL)')
  .argument('[request...]', 'Natural-language request')
  .action(async (request, options) => {
    await runQuery(request, options);
  })
  .addHelpText('after', `
Examples:
  darija config --key sk-...   (OpenAI)
  darija config --key gsk_...  (Groq)
  darija "Chno hiya branch li ana fiha daba?"
  darija "Create a new Git branch called feature/auth"
  darija chra7 "git reset --hard HEAD~1"
  darija 3ta9
  darija hook --install
`);

program
  .command('config')
  .description('Save, inspect, or remove the local OpenAI or Groq API key')
  .option('-k, --key <apiKey>', 'Save an OpenAI (sk-) or Groq (gsk_) API key in the user config directory')
  .option('--clear', 'Delete the saved API key')
  .action(runConfig);

program
  .command('chra7')
  .description('Explain a shell command line by line in Moroccan Darija')
  .argument('<command...>', 'Command to explain, quoted')
  .action(async (command) => {
    await runExplain(command);
  });

program
  .command('3ta9')
  .description('Diagnose the last failed command and propose a safe fix in Darija')
  .argument('[error...]', 'Error output to diagnose when the shell hook is not installed')
  .action(async (errorText) => {
    await runFix(errorText);
  });

program
  .command('hook')
  .description('Print or install the PowerShell hook that lets 3ta9 see the last error')
  .option('--install', 'Append the hook to your PowerShell profile')
  .action(async (hookOptions) => {
    await runHook(hookOptions);
  });

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    console.error('darija requires Node.js 18 or newer.');
    process.exit(1);
  }
  installSignalHandlers();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (cancelled) return;
    if (error?.name === 'ExitPromptError' || error?.name === 'AbortPromptError' || /force closed/i.test(error?.message || '')) {
      console.log(chalk.yellow('\nCancelled. Nothing was executed.'));
      process.exitCode = 130;
      return;
    }
    console.error(chalk.red(sanitizeTerminal(redact(error?.message || 'Unexpected error.'))));
    process.exitCode = 1;
  }
}

if (invokedDirectly()) {
  await main();
}
