import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE_NAME = 'generated_script';

export function scriptExtension(platform) {
  return platform === 'win32' ? '.ps1' : '.sh';
}

export function scriptPathFor(directory, platform) {
  const extension = scriptExtension(platform);
  const first = path.join(directory, `${BASE_NAME}${extension}`);
  if (!existsSync(first)) return first;
  for (let index = 2; index <= 99; index += 1) {
    const candidate = path.join(directory, `${BASE_NAME}-${index}${extension}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(directory, `${BASE_NAME}-${Date.now()}${extension}`);
}

export function ensureShebang(script, platform) {
  if (platform === 'win32' || script.startsWith('#!')) return script;
  return `#!/usr/bin/env bash\n${script}`;
}

export function saveScript(file, script) {
  const content = script.endsWith('\n') ? script : `${script}\n`;
  writeFileSync(file, content, { encoding: 'utf8', mode: 0o644 });
  return file;
}

export function scriptRunner(file, platform, powerShellExecutable) {
  if (platform === 'win32') {
    return {
      file: powerShellExecutable,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file],
      display: `powershell -ExecutionPolicy Bypass -File ${path.basename(file)}`,
    };
  }
  return {
    file: '/bin/bash',
    args: [file],
    display: `bash ${path.basename(file)}`,
  };
}
