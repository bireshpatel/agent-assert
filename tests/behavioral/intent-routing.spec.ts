/**
 * tests/behavioral/intent-routing.spec.ts
 * 
 * PATTERN 1: TOOL INVOCATION ASSERTION
 * ────────────────────────────────────────
 * Tests whether the agent selects the RIGHT tool for a given intent.
 * 
 * WHY THIS IS NOVEL:
 * Traditional testing checks return values:
 *   expect(result).toEqual(expected);
 * 
 * Agent testing checks DECISIONS:
 *   "Given this prompt, did the agent decide to call file-reader?"
 *   "Did it pass the correct file path?"
 *   "Did it NOT call api-caller?"
 * 
 * The output might be fine even when the wrong tool was called
 * (the LLM can hallucinate plausible-looking file contents).
 * Checking tool selection catches this.
 * 
 * WHAT THE TRACE LOOKS LIKE:
 * When the agent processes "Read logs/test-results.log":
 * 
 *   steps: [
 *     { type: 'reasoning', content: 'I need to read a file...' },
 *     { type: 'tool_call', toolName: 'file-reader', toolInput: { filePath: 'logs/test-results.log' } },
 *     { type: 'tool_result', toolName: 'file-reader', toolOutput: { success: true, data: {...} } },
 *     { type: 'reasoning', content: 'The file contains test results...' },
 *   ]
 * 
 * This test asserts on steps[1] — the tool_call step.
 */

import { test, expect } from '@playwright/test';
import { AgentAssert } from '../../framework/AgentAssert.js';
import {
  createTestAgent,
  registerAgentTraceForDiagnostics,
  setupFixtureFiles,
  teardownFixtureFiles,
} from '../fixtures/setup.js';
import { FILE_READ_PROMPTS, API_CALL_PROMPTS } from '../fixtures/prompts.js';

// Setup/teardown fixture files for the entire suite
test.beforeAll(async () => {
  await setupFixtureFiles();
});

test.afterAll(async () => {
  await teardownFixtureFiles();
});

test.describe('Intent Routing — Tool Selection', () => {

  /**
   * TEST 1A: Direct file-read request → file-reader tool
   * 
   * The most straightforward case. Prompt explicitly says "read the file."
   * If the agent fails this, the tool description is broken.
   */
  test('routes file-read intent to file-reader tool', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.direct);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Assert the tool was called
    const result = AgentAssert.toolWasInvoked(trace, 'file-reader');
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(result, 'file-reader should be invoked for direct file-read prompt');
  });

  /**
   * TEST 1B: File-read request with correct parameters
   * 
   * Not just "was file-reader called?" but "was it called
   * with the right file path?"
   * 
   * The paramMatcher uses a regex: /test-results\.log/
   * This checks that the agent extracted the file path from
   * the natural language prompt and passed it correctly.
   */
  test('passes correct file path to file-reader tool', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.direct);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Assert the tool was called with the correct path parameter
    const result = AgentAssert.toolWasInvoked(trace, 'file-reader', {
      filePath: /test-results\.log/,
    });
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(
      result,
      'file-reader should be invoked with path matching test-results.log'
    );
    expect(result.confidence, 'param match confidence should be high').toBeGreaterThan(0.9);
  });

  /**
   * TEST 1C: API-call request → api-caller tool
   * 
   * Verifies intent routing works for the OTHER tool too.
   * The prompt asks to create a Jira ticket — this should
   * trigger api-caller, NOT file-reader.
   */
  test('routes API-call intent to api-caller tool', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(API_CALL_PROMPTS.create);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.toolWasInvoked(trace, 'api-caller');
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(result, 'api-caller should be invoked for Jira ticket prompt');
  });

  /**
   * TEST 1D: File-read intent does NOT trigger api-caller
   * 
   * NEGATIVE ASSERTION: Verify the agent did NOT call a tool
   * it shouldn't have. This catches over-eager agents that
   * call every available tool regardless of the prompt.
   */
  test('file-read intent does not trigger api-caller', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.direct);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Assert api-caller was NOT called
    const result = AgentAssert.toolWasInvoked(trace, 'api-caller');

    AgentAssert.expectNotMatched(
      result,
      'api-caller should not be invoked for a file-read-only prompt'
    );
  });

  /**
   * TEST 1E: Indirect phrasing still routes correctly
   * 
   * The prompt doesn't say "read the file" — it says
   * "I need to know what happened in the latest test run."
   * The file path is mentioned but the instruction is implicit.
   * 
   * This tests whether the agent understands INTENT, not just keywords.
   */
  test('routes indirect file-read request correctly', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.indirect);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.toolWasInvoked(trace, 'file-reader', {
      filePath: /test-results\.log/,
    });
    console.log(AgentAssert.formatResult(result));

    AgentAssert.expectMatched(
      result,
      'indirect file-read prompt should still route to file-reader with correct path'
    );
  });
});
