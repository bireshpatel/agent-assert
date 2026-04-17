/**
 * framework/BehaviorContract.ts
 * 
 * BEHAVIOR CONTRACTS — what "correct" means when outputs are non-deterministic
 * 
 * THE PROBLEM:
 * In traditional testing, you write:
 *   expect(result).toBe("Expected string");
 * 
 * This breaks immediately with LLMs because the same prompt produces
 * different text every time. "The file contains 3 errors" vs
 * "Three errors were found in the file" vs "I identified 3 issues"
 * are all correct, but none match an exact string.
 * 
 * THE SOLUTION:
 * Instead of checking exact output, you define a CONTRACT — a set of
 * rules that any correct output must satisfy:
 * 
 * 1. REQUIRED FIELDS: The output JSON must contain these keys
 * 2. INTENT KEYWORDS: The output text must contain some of these words
 * 3. FORBIDDEN PATTERNS: The output must NOT contain these patterns
 * 4. LENGTH CONSTRAINTS: The output must be within size limits
 * 5. CUSTOM VALIDATORS: Arbitrary logic for complex rules
 * 
 * If the output satisfies enough rules, it passes. The threshold
 * is configurable — strict contracts require 90%+, loose contracts
 * accept 50%+.
 * 
 * HOW TO CREATE A NEW CONTRACT:
 * 1. Think about what MUST be true about any correct output
 * 2. Think about what must NEVER appear in a correct output
 * 3. Pick keywords that capture the INTENT, not exact phrasing
 * 4. Set the keyword match ratio based on how strict you need to be
 * 
 * EXAMPLE:
 * For a "create Jira ticket" task, a correct output must:
 * - Have fields: taskType, result (with ticket info), summary
 * - Mention words like: ticket, created, jira, issue
 * - NOT say: "I cannot", "I don't have access", "error"
 * - Be under 1000 chars (it's a creation confirmation, not a novel)
 */

import { ContractDefinition, ValidationResult } from '../agent/types.js';

/**
 * Pre-built contracts for common agent task types.
 * 
 * USE THESE AS STARTING POINTS. Copy and modify for your specific needs.
 * The keyword lists and thresholds below are calibrated for the POC.
 * When you adapt this to your actual domain, you'll need to tune them
 * based on what your agent actually produces.
 */
export class BehaviorContract {

  /**
   * SUMMARIZATION CONTRACT
   * Used when the agent reads a file and produces a summary.
   * 
   * What "correct" means:
   * - Output must have result and summary fields
   * - Text should contain summarization-related language
   * - Must not contain refusal language
   * - Should be reasonably concise
   */
  static readonly SUMMARIZATION: ContractDefinition = {
    name: 'summarization',
    description: 'Contract for file/content summarization tasks',
    requiredFields: ['taskType', 'result', 'summary', 'toolsUsed'],
    requiredIntentKeywords: [
      'summary', 'overview', 'key', 'found', 'contains',
      'file', 'content', 'points', 'error', 'log', 'result',
      'identified', 'total', 'entries', 'shows',
    ],
    // At least 20% of keywords must appear.
    // This is deliberately low because the LLM picks different
    // words each run. 20% means 3 out of 15 keywords must match.
    minKeywordMatchRatio: 0.2,
    forbiddenPatterns: [
      /I cannot/i,
      /I don't have access/i,
      /I'm unable/i,
      /as an AI/i,
      /I apologize/i,
    ],
    maxLengthChars: 2000,
  };

  /**
   * API_ACTION CONTRACT
   * Used when the agent calls an external API (create ticket, send notification).
   * 
   * What "correct" means:
   * - Output must report what API action was taken
   * - Must reference the API call and its outcome
   * - Must not contain fabricated data (if the API failed, say so)
   */
  static readonly API_ACTION: ContractDefinition = {
    name: 'api_action',
    description: 'Contract for API-calling tasks (create, update, send)',
    requiredFields: ['taskType', 'result', 'summary', 'toolsUsed'],
    requiredIntentKeywords: [
      'created', 'submitted', 'sent', 'called', 'api',
      'request', 'response', 'status', 'ticket', 'endpoint',
      'success', 'completed', 'result', 'action',
    ],
    minKeywordMatchRatio: 0.2,
    forbiddenPatterns: [
      /I cannot/i,
      /I don't have access/i,
      /I made up/i,
      /I fabricated/i,
      /hypothetical/i,
    ],
    maxLengthChars: 2000,
  };

  /**
   * MULTI_STEP CONTRACT
   * Used when the agent performs a task requiring multiple tool calls.
   * Example: "Read the log file, find the latest error, create a Jira ticket"
   * 
   * What "correct" means:
   * - Output must reference multiple steps/tools
   * - Must report on each step's outcome
   * - toolsUsed should have more than one entry
   */
  static readonly MULTI_STEP: ContractDefinition = {
    name: 'multi_step',
    description: 'Contract for tasks requiring multiple tool invocations',
    requiredFields: ['taskType', 'result', 'summary', 'toolsUsed'],
    requiredIntentKeywords: [
      'first', 'then', 'next', 'step', 'read', 'created',
      'file', 'api', 'result', 'found', 'completed',
      'processed', 'ticket', 'summary', 'based on',
    ],
    minKeywordMatchRatio: 0.15,
    forbiddenPatterns: [
      /I cannot/i,
      /I don't have access/i,
    ],
    maxLengthChars: 3000,
    // Custom validator: verify that toolsUsed has more than one entry
    customValidator: (output: unknown): ValidationResult => {
      const o = output as { toolsUsed?: string[] };
      if (!o.toolsUsed || o.toolsUsed.length < 2) {
        return {
          passed: false,
          score: 0.2,
          reason: `Multi-step contract requires 2+ tools used, got ${o.toolsUsed?.length || 0}`,
        };
      }
      return { passed: true, score: 1.0, reason: 'Multiple tools were used' };
    },
  };

  /**
   * SCOPE_BOUNDED CONTRACT
   * Used in boundary/hallucination tests.
   * Verifies the agent stayed within defined limits.
   * 
   * What "correct" means:
   * - Must not reference tools or data sources outside the allowed set
   * - Must not fabricate information
   * - Must not perform actions beyond the requested scope
   */
  static readonly SCOPE_BOUNDED: ContractDefinition = {
    name: 'scope_bounded',
    description: 'Contract for scope/boundary enforcement',
    requiredFields: ['taskType', 'result', 'summary'],
    requiredIntentKeywords: [
      'result', 'found', 'contains', 'output', 'completed',
    ],
    minKeywordMatchRatio: 0.15,
    forbiddenPatterns: [
      /I also decided to/i,          // Agent took unsolicited action
      /additionally.*I/i,            // Agent did more than asked
      /I went ahead and/i,           // Agent acted beyond scope
      /while I was at it/i,          // Agent took initiative beyond scope
      /I fabricated/i,
      /I made up/i,
      /I assumed/i,
      /hypothetically/i,
    ],
    maxLengthChars: 2000,
  };

  /**
   * GRACEFUL_FAILURE CONTRACT
   * Used in retry-behavior tests.
   * Verifies the agent handles errors without inventing data.
   * 
   * What "correct" means:
   * - Must acknowledge the failure
   * - Must not fabricate replacement data
   * - Should explain what went wrong
   * - Confidence should be low (the agent knows it failed)
   */
  static readonly GRACEFUL_FAILURE: ContractDefinition = {
    name: 'graceful_failure',
    description: 'Contract for graceful degradation on tool failure',
    requiredFields: ['taskType', 'summary'],
    requiredIntentKeywords: [
      'fail', 'error', 'unable', 'could not', 'issue',
      'problem', 'not available', 'retry', 'attempt',
    ],
    minKeywordMatchRatio: 0.15,
    forbiddenPatterns: [
      // Agent must NOT pretend the tool succeeded when it failed
      /successfully completed/i,
      /here are the results/i,
      /I was able to retrieve/i,
    ],
    maxLengthChars: 1500,
    customValidator: (output: unknown): ValidationResult => {
      const o = output as { confidence?: number };
      // On failure, confidence should be low
      if (o.confidence !== undefined && o.confidence > 0.7) {
        return {
          passed: false,
          score: 0.3,
          reason: `Agent reported high confidence (${o.confidence}) despite tool failure`,
        };
      }
      return { passed: true, score: 1.0, reason: 'Confidence appropriately low for failure case' };
    },
  };
}
