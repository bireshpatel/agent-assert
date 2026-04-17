/**
 * framework/AgentAssert.ts
 * 
 * THE ASSERTION LIBRARY — the public API your tests use
 * 
 * This is the class you import in every test file. It provides
 * three categories of assertions:
 * 
 * 1. TOOL ASSERTIONS — what tools were called, with what parameters
 * 2. CONTRACT ASSERTIONS — does the output satisfy a behavior contract
 * 3. BOUNDARY ASSERTIONS — did the agent stay within defined limits
 * 
 * DESIGN PHILOSOPHY:
 * Every method returns a detailed result object (MatchResult) with:
 * - matched: boolean — did the assertion pass?
 * - confidence: number — how confident are we? (0-1)
 * - details: string[] — exactly what passed and what failed
 * 
 * Your test code decides what to do with this result:
 * 
 *   // Strict: must pass with high confidence (failure message includes formatResult)
 *   const result = AgentAssert.toolWasInvoked(trace, 'file-reader');
 *   AgentAssert.expectMatched(result, 'file-reader should be invoked');
 *   expect(result.confidence, 'confidence should exceed threshold').toBeGreaterThan(0.9);
 * 
 *   // Lenient: just needs to pass
 *   const result = AgentAssert.satisfiesContract(output, contract);
 *   AgentAssert.expectMatched(result, 'output should satisfy contract');
 * 
 *   // Debugging: log details when test fails
 *   if (!result.matched) console.log(result.details.join('\n'));
 * 
 * HOW TO EXTEND:
 * Add new assertion methods here. Follow the pattern:
 * 1. Accept AgentTrace or AgentOutput as input
 * 2. Return MatchResult
 * 3. Provide detailed reasons in the details array
 * 4. Never throw — let the test framework handle failures
 */

import { expect } from '@playwright/test';
import { AgentTrace, ContractDefinition, MatchResult } from '../agent/types.js';
import { NonDeterministicMatcher } from './NonDeterministicMatcher.js';

export class AgentAssert {

  /**
   * ASSERTION 1: Was a specific tool invoked?
   * 
   * Checks the agent's trace for a tool_call step matching the given name.
   * Optionally validates the parameters passed to the tool.
   * 
   * WHY THIS MATTERS:
   * Traditional tests check output values. Agent tests check DECISIONS.
   * "Did the agent decide to read the file?" is a different question than
   * "Did the agent return the right summary?" Both matter.
   * 
   * @param trace - The agent's execution trace
   * @param toolName - Expected tool name (e.g., 'file-reader')
   * @param paramMatchers - Optional: regex patterns to match against tool parameters.
   *                        Keys are parameter names, values are regex patterns.
   *                        Example: { path: /.*\.log$/ } verifies the agent
   *                        passed a .log file path to the tool.
   * 
   * EXAMPLE:
   *   // Assert file-reader was called with a .log file
   *   AgentAssert.toolWasInvoked(trace, 'file-reader', { filePath: /.*\.log$/ });
   * 
   *   // Assert api-caller was called with a Jira URL
   *   AgentAssert.toolWasInvoked(trace, 'api-caller', { url: /jira/ });
   */
  static toolWasInvoked(
    trace: AgentTrace,
    toolName: string,
    paramMatchers?: Record<string, RegExp>
  ): MatchResult {
    const details: string[] = [];

    // Find all tool_call steps for this tool
    const toolCalls = trace.steps.filter(
      step => step.type === 'tool_call' && step.toolName === toolName
    );

    if (toolCalls.length === 0) {
      // Tool was never called. List what WAS called for debugging.
      const calledTools = trace.steps
        .filter(s => s.type === 'tool_call')
        .map(s => s.toolName)
        .filter(Boolean);

      details.push(`FAIL: tool "${toolName}" was never invoked`);
      details.push(`Tools that WERE invoked: [${[...new Set(calledTools)].join(', ')}]`);

      return { matched: false, confidence: 0, details };
    }

    details.push(`PASS: tool "${toolName}" was invoked ${toolCalls.length} time(s)`);

    // If no param matchers, we're done — tool was called, that's enough
    if (!paramMatchers) {
      return { matched: true, confidence: 1.0, details };
    }

    // Check parameter matchers against each invocation.
    // At least ONE invocation must match ALL param patterns.
    let bestMatchScore = 0;
    let bestMatchDetails: string[] = [];

    for (const call of toolCalls) {
      const input = call.toolInput || {};
      let matchedParams = 0;
      const totalParams = Object.keys(paramMatchers).length;
      const callDetails: string[] = [];

      for (const [paramName, pattern] of Object.entries(paramMatchers)) {
        const paramValue = String(input[paramName] || '');
        if (pattern.test(paramValue)) {
          matchedParams++;
          callDetails.push(`  PASS: param "${paramName}" = "${paramValue}" matches ${pattern}`);
        } else {
          callDetails.push(`  FAIL: param "${paramName}" = "${paramValue}" does not match ${pattern}`);
        }
      }

      const score = totalParams > 0 ? matchedParams / totalParams : 1.0;
      if (score > bestMatchScore) {
        bestMatchScore = score;
        bestMatchDetails = callDetails;
      }
    }

    details.push(...bestMatchDetails);

    return {
      matched: bestMatchScore === 1.0,
      confidence: bestMatchScore,
      details,
    };
  }

  /**
   * ASSERTION 2: Does the output satisfy a behavior contract?
   * 
   * This is where the NonDeterministicMatcher does its work.
   * Instead of checking exact values, we check semantic rules.
   * 
   * @param output - The agent's structured output (AgentOutput)
   * @param contract - The behavior contract to evaluate against
   * @param minConfidence - Minimum confidence score to consider it a match.
   *                        Default 0.5. Raise for stricter tests.
   * 
   * EXAMPLE:
   *   // Standard assertion
   *   const result = AgentAssert.satisfiesContract(
   *     trace.output,
   *     BehaviorContract.SUMMARIZATION
   *   );
   *   expect(result.matched).toBe(true);
   * 
   *   // Strict assertion (require 80% confidence)
   *   const result = AgentAssert.satisfiesContract(
   *     trace.output,
   *     BehaviorContract.SUMMARIZATION,
   *     0.8
   *   );
   */
  static satisfiesContract(
    output: unknown,
    contract: ContractDefinition,
    minConfidence: number = 0.5
  ): MatchResult {
    const result = NonDeterministicMatcher.evaluate(output, contract);

    // Override the matched flag based on minConfidence
    return {
      ...result,
      matched: result.matched && result.confidence >= minConfidence,
      details: [
        `Contract: ${contract.name}`,
        `Required confidence: ${(minConfidence * 100).toFixed(0)}%`,
        `Actual confidence: ${(result.confidence * 100).toFixed(0)}%`,
        ...result.details,
      ],
    };
  }

  /**
   * ASSERTION 3: Did the agent stay within its allowed boundaries?
   * 
   * Checks that the agent ONLY used tools from the allowed list.
   * This is the hallucination/scope guard — if the agent tries to
   * call a tool it shouldn't, this catches it.
   * 
   * @param trace - The agent's execution trace
   * @param allowedTools - List of tool names the agent is permitted to use
   * 
   * WHY THIS MATTERS:
   * LLMs can hallucinate tool calls. An agent might decide to call
   * a "database-query" tool that doesn't exist, or call "api-caller"
   * when the task only requires "file-reader". This assertion catches
   * both scenarios:
   * - Tool calls to non-existent tools (the registry would reject these,
   *   but the trace still records the attempt)
   * - Tool calls to real but out-of-scope tools
   * 
   * EXAMPLE:
   *   // Only file-reader should be called for a file-reading task
   *   const result = AgentAssert.boundaryNotViolated(trace, ['file-reader']);
   *   expect(result.matched).toBe(true);
   */
  static boundaryNotViolated(
    trace: AgentTrace,
    allowedTools: string[]
  ): MatchResult {
    const details: string[] = [];
    const violations: string[] = [];

    const toolCalls = trace.steps.filter(s => s.type === 'tool_call');

    for (const call of toolCalls) {
      const toolName = call.toolName || 'unknown';
      if (allowedTools.includes(toolName)) {
        details.push(`PASS: tool "${toolName}" is within allowed boundary`);
      } else {
        violations.push(toolName);
        details.push(`FAIL: tool "${toolName}" is NOT in allowed list [${allowedTools.join(', ')}]`);
      }
    }

    if (toolCalls.length === 0) {
      details.push('INFO: No tool calls were made (agent may have answered directly)');
    }

    const matched = violations.length === 0;
    const confidence = toolCalls.length > 0
      ? (toolCalls.length - violations.length) / toolCalls.length
      : 1.0;

    return { matched, confidence, details };
  }

  /**
   * ASSERTION 4: Did the agent follow a valid multi-step trace?
   * 
   * Verifies that the agent's execution steps follow an expected
   * sequence. You define the expected sequence as an array of
   * step types and optional tool names. The matcher checks that
   * these steps appear IN ORDER (but not necessarily consecutively —
   * there can be other steps in between).
   * 
   * @param trace - The agent's execution trace
   * @param expectedSequence - Array of expected steps in order
   * 
   * EXAMPLE:
   *   // Agent should: reason → call file-reader → reason → call api-caller → output
   *   AgentAssert.traceFollowsSequence(trace, [
   *     { type: 'tool_call', toolName: 'file-reader' },
   *     { type: 'tool_call', toolName: 'api-caller' },
   *   ]);
   * 
   * WHY "IN ORDER BUT NOT CONSECUTIVE":
   * The agent might insert reasoning steps between tool calls.
   * We care about the ORDER of tool calls, not about the
   * reasoning steps in between.
   */
  static traceFollowsSequence(
    trace: AgentTrace,
    expectedSequence: Array<{ type: string; toolName?: string }>
  ): MatchResult {
    const details: string[] = [];
    let seqIndex = 0;

    for (const step of trace.steps) {
      if (seqIndex >= expectedSequence.length) break;

      const expected = expectedSequence[seqIndex];
      const typeMatches = step.type === expected.type;
      const toolMatches = !expected.toolName || step.toolName === expected.toolName;

      if (typeMatches && toolMatches) {
        details.push(
          `PASS: step ${seqIndex + 1} found — ` +
          `type="${step.type}"${step.toolName ? ` tool="${step.toolName}"` : ''}`
        );
        seqIndex++;
      }
    }

    const matched = seqIndex >= expectedSequence.length;
    const confidence = expectedSequence.length > 0
      ? seqIndex / expectedSequence.length
      : 1.0;

    if (!matched) {
      details.push(
        `FAIL: only ${seqIndex}/${expectedSequence.length} expected steps found in trace. ` +
        `Missing from step ${seqIndex + 1}: type="${expectedSequence[seqIndex]?.type}" ` +
        `tool="${expectedSequence[seqIndex]?.toolName || 'any'}"`
      );
    }

    return { matched, confidence, details };
  }

  /**
   * ASSERTION 5: Was the tool call count within expected range?
   * 
   * Simple but important. An agent that makes 15 tool calls for a
   * simple file read is broken. An agent that makes 0 tool calls
   * for a task that requires tools is also broken.
   * 
   * @param trace - The agent's execution trace
   * @param min - Minimum expected tool calls (inclusive)
   * @param max - Maximum expected tool calls (inclusive)
   */
  static toolCallCountInRange(
    trace: AgentTrace,
    min: number,
    max: number
  ): MatchResult {
    const count = trace.metadata.toolCallCount;
    const matched = count >= min && count <= max;

    return {
      matched,
      confidence: matched ? 1.0 : 0.0,
      details: [
        `Tool call count: ${count} (expected: ${min}-${max})`,
        matched ? 'PASS' : `FAIL: ${count < min ? 'too few' : 'too many'} tool calls`,
      ],
    };
  }

  /**
   * UTILITY: Pretty-print a MatchResult for debugging.
   * Call this in your test's error handler to see exactly
   * what went wrong.
   * 
   * EXAMPLE:
   *   const result = AgentAssert.satisfiesContract(output, contract);
   *   if (!result.matched) {
   *     console.log(AgentAssert.formatResult(result));
   *   }
   */
  static formatResult(result: MatchResult, debugHint?: string): string {
    const header = result.matched
      ? `✅ PASSED (confidence: ${(result.confidence * 100).toFixed(1)}%)`
      : `❌ FAILED (confidence: ${(result.confidence * 100).toFixed(1)}%)`;

    const lines = [
      header,
      '─'.repeat(50),
      ...result.details.map(d => `  ${d}`),
      '─'.repeat(50),
    ];
    if (debugHint?.trim()) {
      lines.push(`  Debug: ${debugHint.trim()}`);
    }
    return lines.join('\n');
  }

  /**
   * Assert `result.matched === true` with Playwright, embedding {@link formatResult} in the failure message.
   */
  static expectMatched(result: MatchResult, context: string): void {
    expect(result.matched, `${context}\n${AgentAssert.formatResult(result)}`).toBe(true);
  }

  /**
   * Assert `result.matched === false` with Playwright, embedding {@link formatResult} in the failure message.
   */
  static expectNotMatched(result: MatchResult, context: string): void {
    expect(result.matched, `${context}\n${AgentAssert.formatResult(result)}`).toBe(false);
  }
}
