/**
 * framework/NonDeterministicMatcher.ts
 * 
 * THE KEY INNOVATION — assertion logic for non-deterministic outputs
 * 
 * WHY THIS EXISTS:
 * ────────────────
 * Traditional test matchers are binary: the output either equals the
 * expected value or it doesn't. This is useless for LLM outputs because:
 * 
 * - Same prompt → different wording every time
 * - Same intent → different structure every time
 * - Same facts → different ordering every time
 * 
 * The NonDeterministicMatcher evaluates outputs against INTENT CONTRACTS
 * rather than exact values. It returns a CONFIDENCE SCORE (0-1) instead
 * of a binary pass/fail.
 * 
 * HOW IT WORKS (three evaluation layers):
 * ─────────────────────────────────────────
 * 
 * LAYER 1: STRUCTURAL VALIDATION
 * Does the output have the required fields? Is it valid JSON?
 * Is it within length limits? This is deterministic — it either
 * passes or doesn't.
 * 
 * LAYER 2: SEMANTIC KEYWORD MATCHING
 * Does the output text contain enough intent-related keywords?
 * This is fuzzy — we count how many keywords appear and compare
 * against a threshold. The keyword list is intentionally broad
 * to accommodate phrasing variation.
 * 
 * LAYER 3: FORBIDDEN PATTERN DETECTION
 * Does the output contain anything it shouldn't? Hallucination
 * markers, refusal language, fabricated data indicators.
 * Any match here FAILS the output regardless of other scores.
 * 
 * OPTIONAL LAYER 4: CUSTOM VALIDATION
 * Contract-specific logic that can't be expressed as keywords
 * or patterns. Example: "toolsUsed must have 2+ entries."
 * 
 * THE SCORING MODEL:
 * ──────────────────
 * Each layer produces a score from 0 to 1.
 * The final confidence is the WEIGHTED AVERAGE:
 * - Structural: 40% weight (must have right shape)
 * - Semantic:   35% weight (must express right intent)
 * - Forbidden:  25% weight (must not contain bad patterns)
 * 
 * If a custom validator exists, it replaces 10% of the semantic weight.
 * 
 * WHY THESE WEIGHTS:
 * Structure matters most because a broken JSON or missing field is
 * unambiguously wrong. Semantics is next because keyword absence
 * might just mean different phrasing. Forbidden patterns are weighted
 * lowest because a single accidental match shouldn't tank the score —
 * but they DO cause a hard failure if matched.
 * 
 * HOW TO TUNE:
 * If your tests are too flaky (passing sometimes, failing sometimes),
 * you have two knobs:
 * 1. Lower the minKeywordMatchRatio in the contract
 * 2. Add more keywords to the contract (broader coverage)
 * 3. Lower the confidence threshold in your test assertion
 * 
 * If your tests are too permissive (passing when they shouldn't),
 * do the opposite. Add more forbidden patterns. Raise thresholds.
 */

import { ContractDefinition, MatchResult, ValidationResult } from '../agent/types.js';

export class NonDeterministicMatcher {

  /**
   * Evaluate an output against a behavior contract.
   * This is the main entry point. Every assertion in AgentAssert
   * calls this method.
   * 
   * @param output - The agent's output (AgentOutput object)
   * @param contract - The behavior contract to evaluate against
   * @returns MatchResult with confidence score and details
   * 
   * EXAMPLE USAGE:
   *   const result = NonDeterministicMatcher.evaluate(trace.output, BehaviorContract.SUMMARIZATION);
   *   expect(result.confidence).toBeGreaterThan(0.7);
   */
  static evaluate(output: unknown, contract: ContractDefinition): MatchResult {
    const details: string[] = [];
    const scores: { weight: number; score: number; label: string }[] = [];

    // ── LAYER 1: STRUCTURAL VALIDATION ──────────────────
    const structuralResult = this.checkStructure(output, contract);
    scores.push({ weight: 0.40, score: structuralResult.score, label: 'structural' });
    details.push(...structuralResult.details);

    // ── LAYER 2: SEMANTIC KEYWORD MATCHING ──────────────
    const semanticResult = this.checkSemantics(output, contract);
    const semanticWeight = contract.customValidator ? 0.25 : 0.35;
    scores.push({ weight: semanticWeight, score: semanticResult.score, label: 'semantic' });
    details.push(...semanticResult.details);

    // ── LAYER 3: FORBIDDEN PATTERN DETECTION ────────────
    const forbiddenResult = this.checkForbiddenPatterns(output, contract);
    scores.push({ weight: 0.25, score: forbiddenResult.score, label: 'forbidden' });
    details.push(...forbiddenResult.details);

    // ── OPTIONAL LAYER 4: CUSTOM VALIDATION ─────────────
    if (contract.customValidator) {
      const customResult = contract.customValidator(output);
      scores.push({ weight: 0.10, score: customResult.score, label: 'custom' });
      details.push(`[custom] ${customResult.reason}`);
    }

    // ── COMPUTE WEIGHTED CONFIDENCE ─────────────────────
    const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
    const confidence = scores.reduce((sum, s) => sum + (s.weight * s.score), 0) / totalWeight;

    // Hard failure: if any forbidden pattern was found, override to fail
    const hasForbiddenViolation = forbiddenResult.score < 1.0;

    return {
      matched: !hasForbiddenViolation && confidence >= 0.5,
      confidence: hasForbiddenViolation ? Math.min(confidence, 0.3) : confidence,
      details,
    };
  }

  /**
   * LAYER 1: Check if output has the required structure.
   * 
   * This is the simplest check — does the output object have
   * the fields the contract requires?
   * 
   * WHY 40% WEIGHT:
   * If the output doesn't even have the right fields, nothing
   * else matters. A summarization that's missing the 'summary'
   * field is fundamentally broken regardless of what the text says.
   */
  private static checkStructure(
    output: unknown,
    contract: ContractDefinition
  ): { score: number; details: string[] } {
    const details: string[] = [];

    if (typeof output !== 'object' || output === null) {
      details.push('[structural] FAIL: output is not an object');
      return { score: 0, details };
    }

    const obj = output as Record<string, unknown>;
    let presentCount = 0;

    for (const field of contract.requiredFields) {
      if (field in obj && obj[field] !== undefined && obj[field] !== null) {
        presentCount++;
        details.push(`[structural] PASS: field "${field}" present`);
      } else {
        details.push(`[structural] FAIL: field "${field}" missing`);
      }
    }

    // Check length constraint if specified
    if (contract.maxLengthChars) {
      const outputStr = JSON.stringify(output);
      if (outputStr.length > contract.maxLengthChars) {
        details.push(
          `[structural] FAIL: output length ${outputStr.length} exceeds max ${contract.maxLengthChars}`
        );
        // Don't count this as a field failure — it's a soft constraint
      } else {
        details.push(`[structural] PASS: output length ${outputStr.length} within limit`);
      }
    }

    const score = contract.requiredFields.length > 0
      ? presentCount / contract.requiredFields.length
      : 1.0;

    return { score, details };
  }

  /**
   * LAYER 2: Check if output text contains enough intent keywords.
   * 
   * HOW THIS WORKS:
   * 1. Serialize the entire output to a string (JSON.stringify)
   * 2. Check each keyword in the contract's requiredIntentKeywords
   * 3. Count how many keywords appear (case-insensitive)
   * 4. Compare the match ratio against minKeywordMatchRatio
   * 
   * WHY STRINGIFY THE WHOLE OBJECT:
   * Keywords might appear in any field — the summary, the result,
   * the taskType. By stringifying everything, we search everywhere
   * at once. This is intentionally permissive.
   * 
   * WHY CASE-INSENSITIVE:
   * "Summary" and "summary" and "SUMMARY" are the same intent.
   * Don't fail a test because the LLM capitalized differently.
   */
  private static checkSemantics(
    output: unknown,
    contract: ContractDefinition
  ): { score: number; details: string[] } {
    const details: string[] = [];
    const outputStr = JSON.stringify(output).toLowerCase();

    let matchCount = 0;
    const matchedKeywords: string[] = [];
    const missedKeywords: string[] = [];

    for (const keyword of contract.requiredIntentKeywords) {
      if (outputStr.includes(keyword.toLowerCase())) {
        matchCount++;
        matchedKeywords.push(keyword);
      } else {
        missedKeywords.push(keyword);
      }
    }

    const ratio = contract.requiredIntentKeywords.length > 0
      ? matchCount / contract.requiredIntentKeywords.length
      : 1.0;

    const passed = ratio >= contract.minKeywordMatchRatio;

    details.push(
      `[semantic] ${passed ? 'PASS' : 'FAIL'}: ` +
      `${matchCount}/${contract.requiredIntentKeywords.length} keywords matched ` +
      `(${(ratio * 100).toFixed(0)}%, threshold: ${(contract.minKeywordMatchRatio * 100).toFixed(0)}%)`
    );
    details.push(`[semantic] Matched: [${matchedKeywords.join(', ')}]`);
    if (missedKeywords.length > 0 && missedKeywords.length <= 10) {
      details.push(`[semantic] Missed: [${missedKeywords.join(', ')}]`);
    }

    // Score is the ratio itself, clamped to 0-1
    return { score: Math.min(ratio / contract.minKeywordMatchRatio, 1.0), details };
  }

  /**
   * LAYER 3: Check that no forbidden patterns appear in the output.
   * 
   * CRITICAL BEHAVIOR: This is the STRICTEST check.
   * If ANY forbidden pattern matches, the score drops to 0.
   * This is intentional — forbidden patterns represent hard failures:
   * - "I cannot" → the agent refused the task
   * - "I fabricated" → the agent hallucinated and admitted it
   * - "I don't have access" → the agent couldn't use the tools
   * 
   * These are not "slightly wrong" — they're categorically wrong.
   * No amount of correct keywords should compensate for a refusal.
   */
  private static checkForbiddenPatterns(
    output: unknown,
    contract: ContractDefinition
  ): { score: number; details: string[] } {
    const details: string[] = [];
    const outputStr = JSON.stringify(output);

    let violations = 0;

    for (const pattern of contract.forbiddenPatterns) {
      if (pattern.test(outputStr)) {
        violations++;
        details.push(`[forbidden] FAIL: pattern ${pattern} matched in output`);
      }
    }

    if (violations === 0) {
      details.push(`[forbidden] PASS: no forbidden patterns detected`);
    }

    // Binary: any violation → score 0
    return { score: violations > 0 ? 0 : 1.0, details };
  }

  /**
   * UTILITY: Check if a specific string appears in the output,
   * with fuzzy matching support.
   * 
   * USE THIS WHEN:
   * You need a one-off check that doesn't fit into a full contract.
   * Example: "Does the output mention the file name 'test-results.log'?"
   * 
   * @param output - The output to check (any type, gets stringified)
   * @param target - The string to look for
   * @param fuzzy - If true, splits target into words and checks each independently.
   *                "test results log" matches if any two of those words appear.
   * @param fuzzyThreshold - What fraction of target words must appear (0-1)
   */
  static containsIntent(
    output: unknown,
    target: string,
    fuzzy: boolean = false,
    fuzzyThreshold: number = 0.5
  ): MatchResult {
    const outputStr = JSON.stringify(output).toLowerCase();
    const targetLower = target.toLowerCase();

    if (!fuzzy) {
      const found = outputStr.includes(targetLower);
      return {
        matched: found,
        confidence: found ? 1.0 : 0.0,
        details: [found
          ? `Found "${target}" in output`
          : `"${target}" not found in output`
        ],
      };
    }

    // Fuzzy: check individual words
    const words = targetLower.split(/\s+/).filter(w => w.length > 2);
    let matchCount = 0;
    for (const word of words) {
      if (outputStr.includes(word)) matchCount++;
    }

    const ratio = words.length > 0 ? matchCount / words.length : 0;
    return {
      matched: ratio >= fuzzyThreshold,
      confidence: ratio,
      details: [`Fuzzy match: ${matchCount}/${words.length} words found (${(ratio * 100).toFixed(0)}%)`],
    };
  }
}
