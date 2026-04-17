/**
 * tests/behavioral/tool-invocation.spec.ts
 * 
 * PATTERN 2 (partial) + PATTERN 3: MULTI-STEP TRACE VERIFICATION
 * ────────────────────────────────────────────────────────────────
 * Tests whether tools are called with correct parameters AND
 * whether multi-step tasks follow a valid execution path.
 * 
 * WHY TRACE VERIFICATION IS NOVEL:
 * In Selenium/Playwright browser testing, you check page state:
 *   expect(page.locator('.title')).toHaveText('Dashboard');
 * 
 * There's no concept of "did the application take the right
 * intermediate steps to arrive at this state?"
 * 
 * Agent testing DOES check intermediate steps, because:
 * 1. The agent might arrive at the right answer via a wrong path
 *    (e.g., reading the wrong file but guessing the right summary)
 * 2. The path reveals whether the agent understood the task
 * 3. Multi-step tasks have ordering dependencies
 *    (you must read the file BEFORE creating a ticket from its contents)
 */

import { test, expect } from '@playwright/test';
import { AgentAssert } from '../../framework/AgentAssert.js';
import {
  createTestAgent,
  registerAgentTraceForDiagnostics,
  setupFixtureFiles,
  teardownFixtureFiles,
} from '../fixtures/setup.js';
import { MULTI_STEP_PROMPTS, API_CALL_PROMPTS } from '../fixtures/prompts.js';

test.beforeAll(async () => {
  await setupFixtureFiles();
});

test.afterAll(async () => {
  await teardownFixtureFiles();
});

test.describe('Tool Invocation & Multi-Step Traces', () => {

  /**
   * TEST 2A: API caller receives correct method and URL pattern
   * 
   * When the agent creates a Jira ticket, it should use POST method
   * and include "jira" in the URL. The exact URL might vary
   * (the LLM might construct different URLs), but these patterns
   * must be present.
   */
  test('api-caller receives correct HTTP method for ticket creation', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(API_CALL_PROMPTS.create);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Check that the API call used POST (creating a ticket)
    const apiCalls = trace.steps.filter(
      s => s.type === 'tool_call' && s.toolName === 'api-caller'
    );

    expect(apiCalls.length, 'trace should include at least one api-caller step').toBeGreaterThan(0);

    // At least one API call should use POST method
    const hasPost = apiCalls.some(
      call => (call.toolInput?.method as string)?.toUpperCase() === 'POST'
    );

    // Log what methods were actually used for debugging
    const methods = apiCalls.map(c => c.toolInput?.method);
    console.log('HTTP methods used:', methods);

    expect(hasPost, 'at least one api-caller call should use POST').toBe(true);
  });

  /**
   * TEST 2B: Tool call count is within expected range
   * 
   * A simple file-read task should require exactly 1 tool call.
   * If the agent calls 5 tools for a simple file read, something
   * is wrong — it's either retrying unnecessarily or calling
   * unrelated tools.
   */
  test('simple task uses expected number of tool calls', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run('Read the file at logs/test-results.log.');
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.toolCallCountInRange(trace, 1, 2);
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(result, 'simple read task should use 1–2 tool calls');
  });

  /**
   * TEST 3A: Multi-step task follows correct tool sequence
   * 
   * THE MULTI-STEP TRACE PATTERN:
   * "Read the test results and create a Jira ticket for the worst failure"
   * 
   * Expected sequence:
   * 1. Agent calls file-reader (to read the test results)
   * 2. Agent calls api-caller (to create the Jira ticket)
   * 
   * The order matters — you can't create a ticket for a failure
   * you haven't read yet. The trace must show file-reader BEFORE api-caller.
   */
  test('multi-step task calls tools in correct order', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(MULTI_STEP_PROMPTS.fileToTicket);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Verify the sequence: file-reader first, then api-caller
    const result = AgentAssert.traceFollowsSequence(trace, [
      { type: 'tool_call', toolName: 'file-reader' },
      { type: 'tool_call', toolName: 'api-caller' },
    ]);
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(
      result,
      'trace should show file-reader then api-caller in order'
    );
  });

  /**
   * TEST 3B: Multi-step task uses at least 2 tools
   * 
   * Complementary check — the multi-step prompt requires both tools.
   * If only 1 tool was called, the agent didn't complete the task.
   */
  test('multi-step task invokes multiple tools', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(MULTI_STEP_PROMPTS.fileToTicket);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.toolCallCountInRange(trace, 2, 4);
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(result, 'multi-step flow should use 2–4 tool calls');
  });

  /**
   * TEST 3C: File-reader tool receives correct path in multi-step flow
   * 
   * Even in a multi-step flow, the file path must be correct.
   * The agent shouldn't guess a different file path just because
   * the overall task is more complex.
   */
  test('multi-step task passes correct file path', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(MULTI_STEP_PROMPTS.fileToTicket);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.toolWasInvoked(trace, 'file-reader', {
      filePath: /test-results\.log/,
    });
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(
      result,
      'multi-step flow should pass correct file path to file-reader'
    );
  });
});
