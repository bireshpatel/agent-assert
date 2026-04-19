/**
 * agent/types.ts
 * 
 * ARCHITECTURE ROLE: Shared type definitions.
 * Every component in the system imports from here.
 * If you change a type here, the compiler tells you every file that breaks.
 * 
 * KEY DESIGN DECISION: The AgentTrace type is the backbone of the entire
 * testing framework. Every assertion method in AgentAssert operates on
 * traces, not on raw outputs. This is what makes the framework work —
 * you're testing the agent's BEHAVIOR (what tools it chose, what params
 * it passed, what path it took), not just its final answer.
 */

// ─────────────────────────────────────────────
// TOOL DEFINITIONS
// ─────────────────────────────────────────────

/**
 * Describes a tool the agent can call. Maps directly to
 * Anthropic's tool_use schema (and by extension, MCP protocol).
 * 
 * The `execute` function is what actually runs when the agent
 * decides to use this tool. In production, this calls real services.
 * In tests, you swap it with a mock.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema for the tool's parameters
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * What a tool returns after execution.
 * `success` flag is critical — the retry-behavior tests
 * check how the agent responds when success=false.
 */
export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

// ─────────────────────────────────────────────
// AGENT TRACE (the core testing data structure)
// ─────────────────────────────────────────────

/**
 * A single step in the agent's execution.
 * 
 * WHY THIS MATTERS:
 * Traditional testing checks input → output.
 * Agent testing checks input → [decision₁, decision₂, ... decisionₙ] → output.
 * 
 * Each TraceStep records ONE decision the agent made:
 * - 'tool_call': Agent decided to invoke a specific tool with specific params
 * - 'tool_result': The tool returned data (or failed)
 * - 'reasoning': Agent's internal reasoning (from Claude's response text)
 * - 'output': Agent's final answer
 * 
 * The sequence of steps IS the agent's behavior. Your tests assert
 * against this sequence, not against the final string.
 */
export interface TraceStep {
  type: 'tool_call' | 'tool_result' | 'reasoning' | 'output';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  content?: string;
  timestamp: number;
}

/**
 * Complete record of an agent run.
 * This is what every test receives. This is what every assertion inspects.
 * 
 * EXTENDING THIS:
 * When you adapt this framework for other domains, you might add:
 * - `tokenUsage: { prompt: number, completion: number }` for cost tracking
 * - `parentTraceId: string` for multi-agent orchestration testing
 * - `guardrailResults: GuardrailCheck[]` for safety testing
 */
export interface AgentTrace {
  input: string;                  // The original natural language prompt
  steps: TraceStep[];             // Ordered list of everything the agent did
  output: AgentOutput;            // The final structured result
  metadata: {
    model: string;                // Which LLM model was used
    /** Which API was used (`anthropic`, `openai`, or `ollama`). Omitted in older traces. */
    provider?: 'anthropic' | 'openai' | 'ollama';
    durationMs: number;           // Total wall-clock time
    toolCallCount: number;        // How many tools were invoked
    retryCount: number;           // How many retries happened
  };
}

/**
 * The structured output the agent returns.
 * 
 * WHY STRUCTURED AND NOT JUST A STRING:
 * If the agent returns free text, you can't reliably assert on it.
 * By forcing structured output, you can check:
 * - Did the agent produce the right type of result?
 * - Did it include all required fields?
 * - Are the values within expected ranges?
 * 
 * The `toolsUsed` array is particularly important — it's the
 * agent's self-report of which tools it called. Your tests
 * cross-reference this against the actual trace to catch lies.
 */
export interface AgentOutput {
  taskType: string;               // Classification of what the agent did
  result: unknown;                // The actual payload (varies by task)
  toolsUsed: string[];            // Which tools the agent reports using
  confidence: number;             // 0-1 confidence score
  summary: string;                // Human-readable summary
}

// ─────────────────────────────────────────────
// BEHAVIOR CONTRACTS
// ─────────────────────────────────────────────

/**
 * Defines what "correct" means for a specific type of agent output.
 * This replaces exact string matching with **heuristic rules** (fields, keywords, regex).
 * It is not synonym-level or LLM-judge semantics — see HeuristicContractMatcher.
 *
 * EXAMPLE:
 * For a SUMMARIZATION contract:
 * - requiredFields: ['summary', 'sourceFile']
 * - requiredIntentKeywords: ['summary', 'key points', 'overview']
 * - maxLengthChars: 500
 * - forbiddenPatterns: [/I don't know/, /I cannot/]
 *
 * HeuristicContractMatcher evaluates output against these rules and returns a
 * weighted score (`confidence`), not a calibrated semantic probability.
 */
export interface ContractDefinition {
  name: string;
  description: string;
  requiredFields: string[];                // Fields that MUST exist in output
  requiredIntentKeywords: string[];        // At least N of these must appear
  minKeywordMatchRatio: number;            // What fraction of keywords must match (0-1)
  forbiddenPatterns: RegExp[];             // Patterns that must NOT appear
  maxLengthChars?: number;                 // Optional length constraint
  customValidator?: (output: unknown) => ValidationResult;  // Escape hatch for complex rules
}

export interface ValidationResult {
  passed: boolean;
  score: number;        // 0-1 confidence
  reason: string;       // Human-readable explanation of why it passed/failed
}

/**
 * What HeuristicContractMatcher (and similar assertions) return.
 *
 * `confidence` is a heuristic aggregate (structure + keyword overlap + patterns),
 * not a model of true semantic alignment. Use thresholds as tuning knobs.
 *
 * `details` lists structural, keyword, forbidden, and custom lines for debugging.
 */
export interface MatchResult {
  matched: boolean;
  confidence: number;
  details: string[];     // List of what passed and what failed
}
