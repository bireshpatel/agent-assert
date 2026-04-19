/**
 * playwright.config.ts
 * 
 * WHY PLAYWRIGHT FOR AGENT TESTING?
 * ----------------------------------
 * This is a deliberate, non-obvious architectural choice. Here's why:
 * 
 * 1. FIXTURE SYSTEM: Playwright's test.extend() lets you inject agent instances,
 *    mock tools, and trace collectors per-test — cleaner than Jest's beforeEach.
 * 
 * 2. PARALLEL ISOLATION: Each test worker gets its own process. LLM calls are
 *    expensive and slow; parallelism cuts suite time dramatically.
 * 
 * 3. RETRIES WITH REPORTING: LLM outputs are non-deterministic. Playwright's
 *    built-in retry + trace capture means you can re-run flaky assertions and
 *    keep evidence of every attempt.
 * 
 * 4. RICH HTML REPORTS: Out of the box. No extra tooling. This matters when
 *    you're presenting results to stakeholders who don't read terminal output.
 * 
 * 5. TIMEOUT CONTROL: LLM calls can hang. Playwright's per-test, per-suite,
 *    and global timeouts are more granular than Jest's.
 * 
 * 6. FUTURE-PROOF: When you later need to test agents that operate in a browser
 *    (e.g., web-browsing agents), you already have the infrastructure.
 */

import { defineConfig } from '@playwright/test';
import { applyLlmVarsFromDotEnv } from './tests/env-llm.js';

/** Loads LLM + API keys from `.env` into `process.env` (see tests/env-llm.ts). */
applyLlmVarsFromDotEnv();

/** Label for the HTML report header: provider + resolved model (aligned with agent defaults). */
function htmlReportTitle(): string {
  const p = process.env.LLM_PROVIDER?.toLowerCase();
  const provider: 'anthropic' | 'openai' | 'ollama' =
    p === 'openai' || p === 'anthropic' || p === 'ollama' ? p : 'anthropic';
  const defaultModel =
    provider === 'openai'
      ? 'gpt-4o'
      : provider === 'ollama'
        ? 'llama3.2:3b'
        : 'claude-sonnet-4-20250514';
  const model = process.env.LLM_MODEL?.trim() || defaultModel;
  return `Playwright report · LLM: ${provider} · ${model}`;
}

export default defineConfig({
  // Where Playwright looks for test files
  testDir: './tests',

  // Match files ending in .spec.ts
  testMatch: '**/*.spec.ts',

  // Default cap; behavioral project overrides for LLM + tool runs (see projects below).
  timeout: 45_000,

  // NON-DETERMINISM STRATEGY: Retry each failed test once.
  // LLM outputs vary between runs. A test might fail once due to
  // phrasing variation but pass on retry. If it fails twice,
  // the assertion contract is genuinely broken, not just unlucky.
  retries: 1,

  // Run tests in parallel across 3 workers.
  // Each worker is a separate process — no shared state contamination.
  // Tune this based on your API rate limits.
  workers: 3,

  // Use Playwright's built-in HTML reporter for visual test results.
  reporter: [
    [
      'html',
      {
        open: 'never',
        title: htmlReportTitle(),
      },
    ],
    ['list'],
  ],

  // Global settings that apply to all tests
  use: {
    // Agent LLM runs are not browser traces; the bulky trace .zip is off.
    // On failure, tests attach `agent-diagnostics.txt` (see tests/fixtures/setup.ts).
    trace: 'off',
  },

  // Organize tests into named projects for selective execution.
  // Run just behavioral tests: npx playwright test --project=behavioral
  // Run just boundary tests: npx playwright test --project=boundary
  projects: [
    {
      name: 'behavioral',
      testDir: './tests/behavioral',
      // Local LLMs on CPU (e.g. Ollama in CI) often need >60s per test; multi-round runs add more.
      timeout: 120_000,
    },
    {
      name: 'boundary',
      testDir: './tests/boundary',
      timeout: 45_000,
    },
  ],
});
