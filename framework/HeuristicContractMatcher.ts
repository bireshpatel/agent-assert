/**
 * framework/HeuristicContractMatcher.ts
 *
 * HEURISTIC CONTRACT EVALUATION — for LLM outputs that vary in wording
 *
 * WHAT THIS IS (honest scope):
 * ────────────────────────────
 * This is **not** deep semantic understanding. It does **not** embed text,
 * call an LLM-as-judge, or parse meaning the way a human does. It applies
 * **cheap, deterministic heuristics**:
 *
 * - Required fields present (structural)
 * - Substring / bag-of-words overlap with a keyword list (“intent keywords”)
 * - **Regex** forbidden patterns
 * - Optional custom validator
 *
 * The numeric **confidence** is a **weighted average of those heuristic
 * scores** — a tuning aid and ranking signal, not a calibrated probability
 * of semantic correctness. Treat it accordingly in assertions.
 *
 * WHY IT STILL EXISTS:
 * ────────────────────
 * Exact `expect(output).toBe("...")` fails on every LLM run. Rules based on
 * fields + keyword coverage + forbidden phrases often **do** catch wrong
 * behavior cheaply. But phrasing that is **semantically equivalent** can
 * still miss keywords (e.g. “unable to locate the file” vs “file not found”)
 * unless your keyword lists and thresholds cover those variants — or you
 * add synonyms / move to embeddings / LLM grading (see README).
 *
 * LAYERS (implementation):
 * ─────────────────────────
 * 1. STRUCTURE — required fields, optional length
 * 2. KEYWORDS — case-insensitive substring checks; ratio vs `minKeywordMatchRatio`
 * 3. FORBIDDEN — regex matches → hard failure path
 * 4. CUSTOM — contract-supplied validator (optional)
 *
 * SCORING WEIGHTS: structural 40%, keyword 35% (or 25% + custom 10% if set),
 * forbidden 25%. Forbidden violations force a failed match regardless of headline confidence.
 */

import { ContractDefinition, MatchResult } from './types.js';

export class HeuristicContractMatcher {
  /**
   * Evaluate an output against a behavior contract using the heuristic layers above.
   *
   * @example
   *   const result = HeuristicContractMatcher.evaluate(trace.output, BehaviorContract.SUMMARIZATION);
   */
  static evaluate(output: unknown, contract: ContractDefinition): MatchResult {
    const details: string[] = [];
    const scores: { weight: number; score: number; label: string }[] = [];

    const structuralResult = this.checkStructure(output, contract);
    scores.push({ weight: 0.4, score: structuralResult.score, label: 'structural' });
    details.push(...structuralResult.details);

    const keywordResult = this.checkKeywordOverlap(output, contract);
    const keywordWeight = contract.customValidator ? 0.25 : 0.35;
    scores.push({ weight: keywordWeight, score: keywordResult.score, label: 'keywords' });
    details.push(...keywordResult.details);

    const forbiddenResult = this.checkForbiddenPatterns(output, contract);
    scores.push({ weight: 0.25, score: forbiddenResult.score, label: 'forbidden' });
    details.push(...forbiddenResult.details);

    if (contract.customValidator) {
      const customResult = contract.customValidator(output);
      scores.push({ weight: 0.1, score: customResult.score, label: 'custom' });
      details.push(`[custom] ${customResult.reason}`);
    }

    const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
    const confidence =
      scores.reduce((sum, s) => sum + s.weight * s.score, 0) / totalWeight;

    const hasForbiddenViolation = forbiddenResult.score < 1.0;

    return {
      matched: !hasForbiddenViolation && confidence >= 0.5,
      confidence: hasForbiddenViolation ? Math.min(confidence, 0.3) : confidence,
      details,
    };
  }

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

    if (contract.maxLengthChars) {
      const outputStr = JSON.stringify(output);
      if (outputStr.length > contract.maxLengthChars) {
        details.push(
          `[structural] FAIL: output length ${outputStr.length} exceeds max ${contract.maxLengthChars}`
        );
      } else {
        details.push(`[structural] PASS: output length ${outputStr.length} within limit`);
      }
    }

    const score =
      contract.requiredFields.length > 0
        ? presentCount / contract.requiredFields.length
        : 1.0;

    return { score, details };
  }

  /**
   * Keyword layer: case-insensitive substring presence against `requiredIntentKeywords`.
   * Not synonym-aware; expand keywords or lower thresholds if tests are brittle.
   */
  private static checkKeywordOverlap(
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

    const ratio =
      contract.requiredIntentKeywords.length > 0
        ? matchCount / contract.requiredIntentKeywords.length
        : 1.0;

    const passed = ratio >= contract.minKeywordMatchRatio;

    details.push(
      `[keywords] ${passed ? 'PASS' : 'FAIL'}: ` +
        `${matchCount}/${contract.requiredIntentKeywords.length} keywords matched ` +
        `(${(ratio * 100).toFixed(0)}%, threshold: ${(contract.minKeywordMatchRatio * 100).toFixed(0)}%)`
    );
    details.push(`[keywords] Matched: [${matchedKeywords.join(', ')}]`);
    if (missedKeywords.length > 0 && missedKeywords.length <= 10) {
      details.push(`[keywords] Missed: [${missedKeywords.join(', ')}]`);
    }

    return {
      score: Math.min(ratio / contract.minKeywordMatchRatio, 1.0),
      details,
    };
  }

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

    return { score: violations > 0 ? 0 : 1.0, details };
  }

  /**
   * Substring search, or word-level overlap when `fuzzy` is true (still heuristic, not NLP).
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
        details: [
          found ? `Found "${target}" in output` : `"${target}" not found in output`,
        ],
      };
    }

    const words = targetLower.split(/\s+/).filter(w => w.length > 2);
    let matchCount = 0;
    for (const word of words) {
      if (outputStr.includes(word)) matchCount++;
    }

    const ratio = words.length > 0 ? matchCount / words.length : 0;
    return {
      matched: ratio >= fuzzyThreshold,
      confidence: ratio,
      details: [
        `Fuzzy word overlap: ${matchCount}/${words.length} words found (${(ratio * 100).toFixed(0)}%)`,
      ],
    };
  }
}
