import chalk from 'chalk';

const SHELL_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'function', 'select', 'time', 'export', 'readonly', 'declare',
  'local', 'return', 'exit', 'set', 'unset', 'source', 'trap', 'shift', 'break',
  'continue', 'printf', 'echo', 'cd', 'sudo', 'git', 'docker', 'npm', 'npx',
  'node', 'pnpm', 'yarn', 'curl', 'wget', 'grep', 'sed', 'awk', 'cat', 'head',
  'tail', 'chmod', 'chown', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'find',
  'xargs', 'test', 'true', 'false', 'read',
].join('|');

const SHELL_TOKENS = new RegExp(
  [
    '(#[^\\n]*)',
    "('(?:[^'\\\\]|\\\\.)*')",
    '("(?:\\\\.|[^"\\\\])*")',
    '(\\$\\{[^}]+\\}|\\$[A-Za-z_][A-Za-z0-9_]*|\\$[0-9@#?$!*-])',
    `\\b(?:${SHELL_KEYWORDS})\\b`,
  ].join('|'),
  'gm',
);

const POWERSHELL_KEYWORDS = [
  'if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch',
  'function', 'param', 'return', 'throw', 'try', 'catch', 'finally', 'begin',
  'process', 'end', 'break', 'continue', 'filter', 'class', 'enum', 'using',
].join('|');

const POWERSHELL_TOKENS = new RegExp(
  [
    '(<#[\\s\\S]*?#>)',
    '(#[^\\n]*)',
    "('(?:[^']|'')*')",
    '("(?:\\\\.|[^"\\\\])*")',
    '(\\$\\{[^}]+\\}|\\$[A-Za-z_][A-Za-z0-9_:]*)',
    `\\b(?:${POWERSHELL_KEYWORDS})\\b`,
    '(\\b(?:Get|Set|New|Remove|Start|Stop|Restart|Select|Where|ForEach|Out|Invoke|Import|Export|Clear|Copy|Move|Test|Format|ConvertTo|ConvertFrom|Write|Add|Enable|Disable|Update|Wait|Measure|Sort|Group|Resolve|Split|Join|Push|Pop|Enter|Exit|Show|Read|Receive|Send|Rename|Register|Unregister)-[A-Za-z]+\\b)',
  ].join('|'),
  'gmi',
);

function paintShell(match, comment, single, double, variable) {
  if (comment) return chalk.dim(match);
  if (single || double) return chalk.green(match);
  if (variable) return chalk.yellow(match);
  return chalk.magenta(match);
}

function paintPowerShell(match, block, comment, single, double, variable) {
  if (block || comment) return chalk.dim(match);
  if (single || double) return chalk.green(match);
  if (variable) return chalk.yellow(match);
  return chalk.cyan(match);
}

export function highlightScript(script, platform = process.platform) {
  const text = String(script ?? '');
  if (platform === 'win32') return text.replace(POWERSHELL_TOKENS, paintPowerShell);
  return text.replace(SHELL_TOKENS, paintShell);
}
