import { spawn } from 'node:child_process';

import { childEnvironment } from './env.js';

export const MAX_DIFF_CHARS = 12_000;

export function runGit(args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: childEnvironment({ GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      reject(error?.code === 'ENOENT' ? new Error('git is not installed or not on PATH.') : error);
    });
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function readStagedChanges(cwd = process.cwd()) {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], { cwd });
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    throw new Error('This folder is not a Git working tree.');
  }

  const stat = await runGit(['--no-pager', 'diff', '--cached', '--stat', '--no-color'], { cwd });
  const diff = await runGit(
    ['--no-pager', 'diff', '--cached', '--no-color', '--no-ext-diff', '--unified=3'],
    { cwd },
  );
  if (stat.code !== 0 || diff.code !== 0) {
    throw new Error((diff.stderr || stat.stderr || 'git diff --cached failed.').trim());
  }

  return {
    stat: stat.stdout.trim(),
    diff: diff.stdout,
    staged: Boolean(diff.stdout.trim()),
    truncated: diff.stdout.length > MAX_DIFF_CHARS,
  };
}
