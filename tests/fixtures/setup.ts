/**
 * tests/fixtures/setup.ts
 * 
 * SHARED TEST SETUP
 * 
 * Every test file needs to:
 * 1. Create an agent with tools
 * 2. Set up mock responses
 * 3. Create fixture files on disk
 * 
 * This module does all of that in one place.
 * 
 * HOW TESTS USE THIS:
 *   import { createTestAgent, registerAgentTraceForDiagnostics, ... } from '../fixtures/setup';
 *
 *   test('my test', async ({}, testInfo) => {
 *     const agent = createTestAgent();
 *     const trace = await agent.run('some prompt');
 *     registerAgentTraceForDiagnostics(testInfo, trace);
 *     // Report: agent-run-summary.txt always; on failure + agent-diagnostics.txt + playwright-failure.txt
 *   });
 * 
 * WHY A FACTORY FUNCTION AND NOT A GLOBAL FIXTURE:
 * Each test needs its own agent instance to avoid shared state.
 * Playwright runs tests in parallel — if two tests share an agent,
 * their tool mocks and traces would collide.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { test, type TestInfo } from '@playwright/test';
import { applyLlmVarsFromDotEnv } from '../env-llm.js';
import type { AgentTrace } from '../../framework/types.js';
import { Agent, type AgentConfig } from '../../examples/agent/agent.js';
import { ToolRegistry } from '../../examples/agent/tools/registry.js';
import { createFileReaderTool } from '../../examples/agent/tools/file-reader.js';
import { createApiCallerTool, MockResponse } from '../../examples/agent/tools/api-caller.js';

applyLlmVarsFromDotEnv();

// Directory where test fixture files live
export const FIXTURE_DIR = path.join(process.cwd(), 'test-fixtures');

/** Latest agent trace for the current test (for failure attachments). Parallel-safe via testId. */
const traceForTest = new Map<string, AgentTrace>();

/**
 * Call once per test after `await agent.run(...)`.
 * The HTML report gets a compact `agent-run-summary.txt` always, and on failure
 * `agent-diagnostics.txt` + `playwright-failure.txt` for deep debugging.
 */
export function registerAgentTraceForDiagnostics(
  testInfo: TestInfo,
  trace: AgentTrace
): void {
  traceForTest.set(testInfo.testId, trace);
}

function toolCallsInOrder(trace: AgentTrace): string[] {
  return trace.steps
    .filter(s => s.type === 'tool_call' && s.toolName)
    .map(s => s.toolName as string);
}

/** Compact, readable summary for every run (pass or fail). */
function buildAgentRunSummary(trace: AgentTrace, testInfo: TestInfo): string {
  const m = trace.metadata;
  const ordered = toolCallsInOrder(trace);
  const distinct = [...new Set(ordered)];
  const summaryText = String(trace.output.summary ?? '').replace(/\s+/g, ' ').trim();

  return [
    'agent-assert — Agent run summary',
    '================================',
    `Project:  ${testInfo.project.name}`,
    `Test:     ${testInfo.title}`,
    `Result:   ${testInfo.status}`,
    `Duration: ${testInfo.duration} ms (Playwright) | LLM wall: ${m.durationMs} ms`,
    '',
    'LLM',
    `  provider : ${m.provider ?? '(see AgentConfig / .env)'}`,
    `  model    : ${m.model}`,
    `  toolCallCount (all tools): ${m.toolCallCount}`,
    `  retryCount (failed tool results in agent): ${m.retryCount}`,
    '',
    'Tool calls (chronological)',
    ordered.length
      ? ordered.map((t, i) => `  ${i + 1}. ${t}`).join('\n')
      : '  (none — model may have answered without tools)',
    '',
    'Distinct tools: ' + (distinct.length ? distinct.join(', ') : '—'),
    '',
    'Output.summary (preview)',
    summaryText
      ? `  ${summaryText.slice(0, 600)}${summaryText.length > 600 ? '…' : ''}`
      : '  (empty)',
    '',
    'Prompt (preview)',
    `  ${trace.input.slice(0, 500)}${trace.input.length > 500 ? '…' : ''}`,
    '',
    'Tip: On failure, open agent-diagnostics.txt and playwright-failure.txt in this test.',
  ].join('\n');
}

function formatPlaywrightFailureContext(testInfo: TestInfo): string {
  const err = testInfo.error;
  const lines = [
    'Playwright — failure context',
    '============================',
    `Test:     ${testInfo.title}`,
    `File:     ${testInfo.file}:${testInfo.line}`,
    `Project:  ${testInfo.project.name}`,
    `Status:   ${testInfo.status}`,
    `Duration: ${testInfo.duration} ms`,
    `Attempt:  retry #${testInfo.retry}`,
    '',
  ];
  if (err?.message) {
    lines.push('--- Error message ---', err.message, '');
  }
  if (err?.stack) {
    lines.push('--- Stack ---', err.stack);
  }
  if (!err?.message && !err?.stack) {
    lines.push('(No Error object — e.g. timeout or expect() without message.)');
  }
  lines.push(
    '',
    'Debug: compare with agent-diagnostics.txt (same test) for the LLM trace.'
  );
  return lines.join('\n');
}

/** Full trace dump when a test fails (attachments tab in HTML report). */
function formatAgentDiagnostics(trace: AgentTrace): string {
  const maxReasoning = 4_000;
  const ordered = toolCallsInOrder(trace);
  const lines: string[] = [
    'agent-assert — Full agent diagnostics (on test failure)',
    '========================================================',
    '',
    'QUICK CHECKLIST',
    '  • toolCallCount = 0 → model may have skipped tools (check provider/model).',
    '  • retryCount > 0 → at least one tool returned success: false.',
    '  • Parse errors in output → see Structured output / raw JSON at end.',
    '',
    '--- Tool call order (names only) ---',
    ordered.length ? ordered.map((t, i) => `  ${i + 1}. ${t}`).join('\n') : '  (none)',
    '',
    '--- Input ---',
    trace.input,
    '',
    '--- Metadata ---',
    JSON.stringify(trace.metadata, null, 2),
    '',
    '--- Structured output (AgentOutput) ---',
    JSON.stringify(trace.output, null, 2),
    '',
    `--- Trace steps (${trace.steps.length}, chronological) ---`,
  ];
  for (let i = 0; i < trace.steps.length; i++) {
    const s = trace.steps[i];
    lines.push('');
    lines.push(`[${i + 1}] ${s.type}${s.toolName ? ` · ${s.toolName}` : ''}`);
    if (s.content !== undefined) {
      const c = s.content;
      lines.push(
        c.length > maxReasoning
          ? `${c.slice(0, maxReasoning)}\n… (${c.length} chars total)`
          : c
      );
    }
    if (s.toolInput !== undefined) {
      lines.push(`toolInput: ${JSON.stringify(s.toolInput)}`);
    }
    if (s.toolOutput !== undefined) {
      lines.push(`toolOutput: ${JSON.stringify(s.toolOutput)}`);
    }
  }
  lines.push('');
  lines.push('--- Full trace JSON (machine-readable) ---');
  lines.push(JSON.stringify(trace, null, 2));
  return lines.join('\n');
}

test.afterEach(async ({}, testInfo) => {
  const trace = traceForTest.get(testInfo.testId);
  traceForTest.delete(testInfo.testId);
  if (!trace) return;

  const summaryBody = buildAgentRunSummary(trace, testInfo);
  await testInfo.attach('agent-run-summary.txt', {
    body: summaryBody,
    contentType: 'text/plain',
  });

  const ordered = toolCallsInOrder(trace);
  const icon = testInfo.status === 'passed' ? '✓' : testInfo.status === 'skipped' ? '○' : '✗';
  console.log(
    `[agent-assert] ${icon} ${testInfo.title}\n` +
      `  LLM: ${trace.metadata.model} (${trace.metadata.provider ?? '?'}) | ` +
      `${trace.metadata.durationMs}ms | tools: ${trace.metadata.toolCallCount} | ` +
      `chain: [${ordered.join(' → ') || '—'}]`
  );

  if (testInfo.status !== 'failed' && testInfo.status !== 'timedOut') return;

  await testInfo.attach('agent-diagnostics.txt', {
    body: formatAgentDiagnostics(trace),
    contentType: 'text/plain',
  });
  await testInfo.attach('playwright-failure.txt', {
    body: formatPlaywrightFailureContext(testInfo),
    contentType: 'text/plain',
  });
});

/**
 * Optional env-driven overrides for which LLM to use in tests.
 * - `LLM_PROVIDER=openai` + `OPENAI_API_KEY` — OpenAI cloud (default model `gpt-4o` unless `LLM_MODEL`).
 * - `LLM_PROVIDER=ollama` — local Ollama (OpenAI-compatible API); default model `llama3:latest` unless `LLM_MODEL`.
 * - `LLM_PROVIDER=openai` + `OPENAI_BASE_URL` (e.g. `http://127.0.0.1:11434/v1`) — same as Ollama without renaming provider.
 * - Default when unset: Anthropic with `claude-sonnet-4-20250514` unless `LLM_MODEL` overrides.
 */
function testAgentConfig(extra: AgentConfig = {}): AgentConfig {
  const p = process.env.LLM_PROVIDER?.toLowerCase();
  const provider =
    p === 'openai' || p === 'anthropic' || p === 'ollama' ? p : undefined;
  const cfg: AgentConfig = { ...extra };
  if (provider) cfg.provider = provider;
  const baseFromEnv =
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.OLLAMA_BASE_URL?.trim();
  if (baseFromEnv) cfg.baseURL = baseFromEnv;
  if (process.env.LLM_MODEL) {
    cfg.model = process.env.LLM_MODEL;
  } else if (!provider || provider === 'anthropic') {
    cfg.model = cfg.model ?? 'claude-sonnet-4-20250514';
  }
  return cfg;
}

/**
 * Create fixture files on disk that the file-reader tool will read.
 * Called once before the test suite runs.
 * 
 * WHAT'S IN THE FIXTURE FILE:
 * A realistic test results log with multiple entries — some passing,
 * some failing. The content is designed so that:
 * - Summarization tests can verify the agent identifies failures
 * - Boundary tests can verify the agent doesn't invent extra failures
 * - Multi-step tests can verify the agent extracts the worst failure
 */
export async function setupFixtureFiles(): Promise<void> {
  await fs.mkdir(path.join(FIXTURE_DIR, 'logs'), { recursive: true });

  // Main test results file
  const testResultsContent = `
TEST EXECUTION REPORT — 2025-01-15 14:23:00 UTC
================================================

Suite: checkout-flow
  ✓ PASS: renders checkout page (234ms)
  ✓ PASS: validates card number format (89ms)
  ✗ FAIL: processes payment submission (1203ms)
    Error: TimeoutError — payment gateway did not respond within 5000ms
    Stack: at PaymentService.submit (src/services/payment.ts:45)
  ✓ PASS: displays order confirmation (156ms)
  ✗ FAIL: handles declined card gracefully (678ms)
    Error: AssertionError — expected status "declined" but received "error"
    Stack: at CardHandler.process (src/services/card.ts:92)

Suite: user-auth
  ✓ PASS: login with valid credentials (345ms)
  ✓ PASS: blocks brute force attempts (234ms)
  ✓ PASS: refresh token rotation (189ms)

SUMMARY: 7 passed, 2 failed, 0 skipped
TOTAL TIME: 3.128s
CRITICAL FAILURE: payment gateway timeout — this blocks the release.
`.trim();

  await fs.writeFile(
    path.join(FIXTURE_DIR, 'logs', 'test-results.log'),
    testResultsContent,
    'utf-8'
  );

  // Error log for multi-step tests
  const errorLogContent = `
[2025-01-15 14:23:05] ERROR PaymentService: Gateway timeout after 5000ms
[2025-01-15 14:23:05] ERROR CardHandler: Unexpected status "error" from processor
[2025-01-15 14:22:50] WARN  RateLimiter: Request rate approaching threshold (85%)
[2025-01-15 14:22:30] INFO  TestRunner: Starting checkout-flow suite
`.trim();

  await fs.writeFile(
    path.join(FIXTURE_DIR, 'logs', 'errors.log'),
    errorLogContent,
    'utf-8'
  );
}

/**
 * Clean up fixture files after tests.
 */
export async function teardownFixtureFiles(): Promise<void> {
  try {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a standard test agent with both tools working correctly.
 * This is the "happy path" agent used by most tests.
 * 
 * MOCK API RESPONSES:
 * The api-caller tool returns canned responses for known URL patterns.
 * This keeps tests fast and deterministic.
 */
export function createTestAgent(): Agent {
  const registry = new ToolRegistry();

  // Register file-reader pointing at our fixture directory
  registry.register(createFileReaderTool(FIXTURE_DIR));

  // Register api-caller with mock responses
  const mockResponses = new Map<string, MockResponse>();

  // Jira-like response for ticket creation
  mockResponses.set('jira', {
    status: 200,
    body: {
      id: 'PROJ-456',
      key: 'PROJ-456',
      self: 'https://jira.example.com/rest/api/3/issue/PROJ-456',
      fields: {
        summary: 'Bug ticket created by agent',
        status: { name: 'Open' },
      },
    },
  });

  // Health check endpoint
  mockResponses.set('health', {
    status: 200,
    body: { status: 'healthy', uptime: '99.9%', lastDeployment: '2025-01-15T10:00:00Z' },
  });

  // Deployment status
  mockResponses.set('deployments', {
    status: 200,
    body: { version: '2.3.1', environment: 'production', status: 'deployed' },
  });

  // Alerts/monitoring endpoint
  mockResponses.set('alerts', {
    status: 200,
    body: { alertId: 'ALT-789', status: 'received', message: 'Alert logged successfully' },
  });

  registry.register(createApiCallerTool({ useMock: true, mockResponses }));

  return new Agent(registry, testAgentConfig());
}

/**
 * Create an agent where the file-reader tool ALWAYS FAILS.
 * Used by retry-behavior and failure-handling tests.
 * 
 * WHY A SEPARATE FACTORY:
 * The failing tool simulates real-world failures:
 * - File not found (disk issue)
 * - Permission denied
 * - Timeout reading large files
 * 
 * The agent should handle these gracefully — report the failure,
 * don't fabricate file contents, keep confidence low.
 */
export function createFailingFileReaderAgent(): Agent {
  const registry = new ToolRegistry();

  // Register a file-reader that always fails
  registry.register({
    name: 'file-reader',
    description: 'Reads the contents of a file from the local filesystem.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file' },
      },
      required: ['filePath'],
    },
    execute: async () => ({
      success: false,
      data: null,
      error: 'SIMULATED FAILURE: File system is unavailable — disk read error',
    }),
  });

  // API caller still works (to test partial failure scenarios)
  const mockResponses = new Map<string, MockResponse>();
  mockResponses.set('jira', {
    status: 200,
    body: { id: 'PROJ-456', key: 'PROJ-456' },
  });

  registry.register(createApiCallerTool({ useMock: true, mockResponses }));

  return new Agent(registry, testAgentConfig());
}

/**
 * Create an agent where the API caller returns 500 errors.
 * Used for API failure testing.
 */
export function createFailingApiAgent(): Agent {
  const registry = new ToolRegistry();

  // File reader works fine
  registry.register(createFileReaderTool(FIXTURE_DIR));

  // API caller returns 500 for everything
  const mockResponses = new Map<string, MockResponse>();
  mockResponses.set('jira', {
    status: 500,
    body: { error: 'Internal Server Error', message: 'Service unavailable' },
  });
  mockResponses.set('api', {
    status: 500,
    body: { error: 'Internal Server Error' },
  });

  registry.register(createApiCallerTool({ useMock: true, mockResponses }));

  return new Agent(registry, testAgentConfig());
}

/**
 * Create an agent with ONLY the file-reader tool.
 * Used for boundary tests — the agent shouldn't try to call api-caller.
 */
export function createFileOnlyAgent(): Agent {
  const registry = new ToolRegistry();
  registry.register(createFileReaderTool(FIXTURE_DIR));

  return new Agent(registry, testAgentConfig());
}
