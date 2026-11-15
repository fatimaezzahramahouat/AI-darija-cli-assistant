import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MARKER_START = '# >>> darija-cli hook >>>';
const MARKER_END = '# <<< darija-cli hook <<<';
const MAX_ERROR_CHARS = 4000;

export function capturePathFor(configPath) {
  return path.join(path.dirname(configPath), 'last-error.json');
}

function textValue(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export function readCapture(file) {
  try {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const captured = {
      command: textValue(raw.command, 500),
      error: textValue(raw.error, MAX_ERROR_CHARS),
      exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
      cwd: textValue(raw.cwd, 500),
      shell: textValue(raw.shell, 40) || 'PowerShell',
      capturedAt: Number.isFinite(raw.timestamp) ? raw.timestamp * 1000 : null,
    };
    const failed = captured.exitCode !== 0 || Boolean(captured.error);
    if (!captured.command && !captured.error) return null;
    if (!failed) return null;
    return captured;
  } catch {
    return null;
  }
}

export function powerShellHook(captureFile) {
  const target = captureFile.replace(/'/g, "''");
  return [
    MARKER_START,
    `$global:__darijaCapture = '${target}'`,
    'if (-not $global:__darijaInnerPrompt) { $global:__darijaInnerPrompt = $function:prompt }',
    'function global:prompt {',
    '  $darijaOk = $?',
    '  $darijaNative = $LASTEXITCODE',
    '  $darijaError = ""',
    '  if ($global:Error.Count -gt 0) { $darijaError = try { [string]($global:Error[0] | Out-String) } catch { "" } }',
    '  $darijaCommand = ""',
    '  try {',
    '    $darijaLast = Get-History -Count 1 -ErrorAction Stop',
    '    if ($darijaLast) {',
    '      $darijaCommand = [string]$darijaLast.CommandLine',
    '      if ($darijaLast.ExecutionStatus -ne "Completed") { $darijaOk = $false }',
    '    }',
    '  } catch {}',
    '  $darijaExit = 0',
    '  if (-not $darijaOk) {',
    '    $darijaExit = if ($null -ne $darijaNative -and [int]$darijaNative -ne 0) { [int]$darijaNative } else { 1 }',
    '  } else { $darijaError = "" }',
    '  $darijaState = [ordered]@{',
    '    command = $darijaCommand',
    '    error = ($darijaError -replace "\\s+$", "")',
    '    exitCode = $darijaExit',
    '    cwd = (Get-Location).Path',
    '    shell = "PowerShell"',
    '    timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()',
    '  }',
    '  try { [IO.File]::WriteAllText($global:__darijaCapture, ($darijaState | ConvertTo-Json -Compress)) } catch {}',
    '  & $global:__darijaInnerPrompt',
    '}',
    MARKER_END,
  ].join('\n');
}

export function installHook(profilePath, captureFile) {
  const snippet = powerShellHook(captureFile);
  mkdirSync(path.dirname(profilePath), { recursive: true });
  const current = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
  const start = current.indexOf(MARKER_START);
  const end = current.indexOf(MARKER_END, start === -1 ? 0 : start);
  const next = start !== -1 && end !== -1
    ? `${current.slice(0, start)}${snippet}${current.slice(end + MARKER_END.length)}`
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${snippet}\n`;
  writeFileSync(profilePath, next, 'utf8');
  return profilePath;
}

export function powerShellProfilePath(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE'], {
      windowsHide: true,
      shell: false,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      const profile = output.trim();
      if (code === 0 && profile) resolve(profile);
      else reject(new Error('Could not locate the PowerShell profile.'));
    });
  });
}
