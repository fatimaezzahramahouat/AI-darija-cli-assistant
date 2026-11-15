import chalk from 'chalk';

export const SPINNER_TEXT = 'AI kayfker... 🧠';

const BANNER = [
  '██████╗  █████╗ ██████╗ ██╗          ██╗ █████╗ ',
  '██╔══██╗██╔══██╗██╔══██╗██║          ██║██╔══██╗',
  '██║  ██║███████║██████╔╝██║          ██║███████║',
  '██║  ██║██╔══██║██╔══██╗██║     ██   ██║██╔══██║',
  '██████╔╝██║  ██║██║  ██║██║     ╚█████╔╝██║  ██║',
  '╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝      ╚════╝ ╚═╝  ╚═╝',
];

const RISK_STYLE = {
  low: (text) => chalk.green(text),
  medium: (text) => chalk.yellow(text),
  high: (text) => chalk.red.bold(text),
};

const RISK_ICON = { low: '🟢', medium: '🟡', high: '🔴' };

export function printBanner(stream = process.stdout) {
  if (!stream.isTTY) return;
  console.log(chalk.cyan(BANNER.join('\n')));
  console.log(chalk.dim('  Darija · Français · English · one command at a time\n'));
}

export function riskLabel(level) {
  const paint = RISK_STYLE[level] ?? chalk.white;
  return `${RISK_ICON[level] ?? ''} ${paint(String(level).toUpperCase())}`.trim();
}
