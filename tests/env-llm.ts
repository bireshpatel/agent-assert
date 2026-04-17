/**
 * Shared env loading for Playwright config and test workers.
 *
 * Selected keys from `.env` are applied to `process.env` so tests see the same
 * values as your file without relying on the shell. `.env` wins over existing
 * env for these keys (avoids stale IDE exports for LLM vars).
 *
 * Includes API keys because Node does not load `.env` automatically — without
 * this, `OPENAI_API_KEY` in `.env` would never reach `process.env` and OpenAI
 * returns 401.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOTENV_KEYS = new Set([
  'LLM_PROVIDER',
  'LLM_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
]);

export function applyLlmVarsFromDotEnv(): void {
  const envPath = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!DOTENV_KEYS.has(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
