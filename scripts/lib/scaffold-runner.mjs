import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCAFFOLD_SCRIPT = path.join(__dirname, '..', 'scaffold-bot.mjs');

export function runScaffoldBot(clientSlug) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCAFFOLD_SCRIPT, `--client=${clientSlug}`], { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`scaffold-bot.mjs exited ${code}`));
    });
  });
}
