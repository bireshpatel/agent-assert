/**
 * tests/behavioral/output-contract.spec.ts
 * 
 * PATTERN 2: BEHAVIOR CONTRACT VALIDATION
 * ─────────────────────────────────────────
 * Tests whether the agent's output satisfies BEHAVIOR CONTRACTS (heuristic:
 * fields, keywords, forbidden patterns) rather than exact string matches.
 *
 * Core idea of this pattern in the framework:
 * 
 * THE PROBLEM WITH expect(output).toBe("..."):
 * Run 1: "The file contains 2 test failures: payment timeout and card error"
 * Run 2: "Found 2 failures in test results — a payment gateway timeout and a declined card handling issue"
 * Run 3: "Analysis of test-results.log: 2 critical errors detected"
 * 
 * All three are correct. None would pass an exact match.
 * 
 * THE SOLUTION — BEHAVIOR CONTRACTS:
 * Instead of checking the string, check that:
 * 1. The output has the right structure (required fields)
 * 2. The output expresses the right intent (keyword matching)
 * 3. The output doesn't contain red flags (forbidden patterns)
 * 4. The heuristic confidence score from HeuristicContractMatcher is above threshold
 * 
 * TUNING GUIDANCE:
 * If tests are too flaky → lower minKeywordMatchRatio or add more keywords
 * If tests are too permissive → add forbidden patterns or raise confidence threshold
 */

import { test, expect } from '@playwright/test';
import { AgentAssert } from '../../framework/AgentAssert.js';
import { BehaviorContract } from '../../framework/BehaviorContract.js';
import { HeuristicContractMatcher } from '../../framework/HeuristicContractMatcher.js';
import {
  createTestAgent,
  registerAgentTraceForDiagnostics,
  setupFixtureFiles,
  teardownFixtureFiles,
} from '../fixtures/setup.js';
import { FILE_READ_PROMPTS, API_CALL_PROMPTS, MULTI_STEP_PROMPTS } from '../fixtures/prompts.js';

test.beforeAll(async () => {
  await setupFixtureFiles();
});

test.afterAll(async () => {
  await teardownFixtureFiles();
});

test.describe('Behavior Contract Validation', () => {

  /**
   * TEST 2A: Summarization output satisfies the SUMMARIZATION contract
   * 
   * Prompt: "Read and summarize the test results file"
   * Contract: SUMMARIZATION (requires summary-related keywords,
   *           required fields, no refusal language)
   * 
   * This is the canonical example of contract-based assertion.
   * Run this test 5 times — it should pass every time despite
   * different output wording each run.
   */
  test('file summarization output satisfies SUMMARIZATION contract', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.direct);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.satisfiesContract(
      trace.output,
      BehaviorContract.SUMMARIZATION,
      0.5  // 50% confidence threshold — lenient for LLM outputs
    );

    console.log(AgentAssert.formatResult(result));
    // Log the actual output for debugging failed runs
    console.log('Agent output:', JSON.stringify(trace.output, null, 2));

    AgentAssert.expectMatched(result, 'SUMMARIZATION contract should pass');
    expect(result.confidence, 'contract confidence should exceed floor').toBeGreaterThan(0.4);
  });

  /**
   * TEST 2B: API action output satisfies the API_ACTION contract
   * 
   * When the agent creates a Jira ticket, the output should:
   * - Have the right structure (taskType, result, summary)
   * - Mention API-related keywords (created, ticket, response)
   * - Not claim it couldn't perform the action
   */
  test('API action output satisfies API_ACTION contract', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(API_CALL_PROMPTS.create);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.satisfiesContract(
      trace.output,
      BehaviorContract.API_ACTION,
      0.5
    );

    console.log(AgentAssert.formatResult(result));
    console.log('Agent output:', JSON.stringify(trace.output, null, 2));

    AgentAssert.expectMatched(result, 'API_ACTION contract should pass');
  });

  /**
   * TEST 2C: Multi-step output satisfies the MULTI_STEP contract
   * 
   * The multi-step contract has a custom validator that checks
   * toolsUsed.length >= 2. This catches agents that skip steps.
   */
  test('multi-step output satisfies MULTI_STEP contract', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(MULTI_STEP_PROMPTS.fileToTicket);
    registerAgentTraceForDiagnostics(testInfo, trace);

    const result = AgentAssert.satisfiesContract(
      trace.output,
      BehaviorContract.MULTI_STEP,
      0.4
    );

    console.log(AgentAssert.formatResult(result));
    console.log('Agent output:', JSON.stringify(trace.output, null, 2));

    AgentAssert.expectMatched(result, 'MULTI_STEP contract should pass');
  });

  /**
   * TEST 2D: Output contains intent-specific content (fuzzy match)
   * 
   * Uses HeuristicContractMatcher.containsIntent directly for a
   * targeted check: does the output mention the payment failure
   * from the fixture file?
   * 
   * Fuzzy matching splits the target into words and checks each
   * independently. "payment gateway timeout" matches if any 2 of
   * those 3 words appear in the output.
   */
  test('summarization output mentions key failures from fixture file', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.direct);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Check that the output mentions the payment failure
    const result = HeuristicContractMatcher.containsIntent(
      trace.output,
      'payment gateway timeout failure',
      true,   // fuzzy matching enabled
      0.4     // at least 40% of words must appear
    );

    console.log('Fuzzy intent match:', result);

    AgentAssert.expectMatched(
      result,
      'output should fuzzily mention payment gateway timeout failure themes'
    );
  });

  /**
   * TEST 2E: Output has valid AgentOutput structure
   * 
   * Structural check — the output must be a valid AgentOutput object
   * with all required fields. This doesn't run contract/heuristic checks — only shape.
   * 
   * If this fails, the agent's system prompt isn't working —
   * Claude isn't producing structured JSON output.
   */
  test('output has valid AgentOutput structure', async ({}, testInfo) => {
    const agent = createTestAgent();
    const trace = await agent.run(FILE_READ_PROMPTS.direct);
    registerAgentTraceForDiagnostics(testInfo, trace);

    // Check required fields exist
    expect(trace.output).toBeDefined();
    expect(trace.output.taskType).toBeDefined();
    expect(trace.output.summary).toBeDefined();
    expect(typeof trace.output.summary).toBe('string');
    expect(trace.output.toolsUsed).toBeDefined();
    expect(Array.isArray(trace.output.toolsUsed)).toBe(true);

    // Confidence should be a number between 0 and 1
    if (trace.output.confidence !== undefined) {
      expect(trace.output.confidence).toBeGreaterThanOrEqual(0);
      expect(trace.output.confidence).toBeLessThanOrEqual(1);
    }
  });
});
