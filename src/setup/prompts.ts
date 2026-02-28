import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl: ReturnType<typeof createInterface> | null = null;

export function getRL(): ReturnType<typeof createInterface> {
  if (!rl) {
    rl = createInterface({ input: stdin, output: stdout });
  }
  return rl;
}

export function closeRL(): void {
  rl?.close();
  rl = null;
}

export async function askText(prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await getRL().question(`${prompt}${suffix}: `)).trim();
  return answer || defaultValue || '';
}

export async function askYesNo(prompt: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await getRL().question(`${prompt} ${hint}: `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

export async function askChoice(prompt: string, choices: string[]): Promise<string> {
  console.log(`\n${prompt}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}) ${choices[i]}`);
  }
  const answer = (await getRL().question('  Choice: ')).trim();
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < choices.length) return choices[idx];
  // Try matching by text
  const match = choices.find(c => c.toLowerCase().startsWith(answer.toLowerCase()));
  return match ?? choices[0];
}

export function printHeader(text: string): void {
  const line = '='.repeat(text.length + 4);
  console.log(`\n${line}\n  ${text}\n${line}\n`);
}

export function printStep(step: number, total: number, text: string): void {
  console.log(`\n--- Step ${step}/${total}: ${text} ---\n`);
}

export function printSuccess(text: string): void {
  console.log(`  [OK] ${text}`);
}

export function printWarning(text: string): void {
  console.log(`  [WARN] ${text}`);
}

export function printError(text: string): void {
  console.log(`  [FAIL] ${text}`);
}

export function printInfo(text: string): void {
  console.log(`  ${text}`);
}

export function printPass(text: string): void {
  console.log(`  [PASS] ${text}`);
}
