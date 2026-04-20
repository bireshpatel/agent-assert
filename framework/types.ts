/**
 * framework/types.ts
 *
 * Public types for the assertion helpers (`AgentAssert`, contracts, traces).
 * The demo agent under `examples/agent/` imports these same types so traces
 * and contracts stay aligned — this file is not part of the example SUT.
 *
 * `AgentTrace` is what assertions operate on: tool decisions and structured output.
 */

// ─────────────────────────────────────────────
// TOOL DEFINITIONS (used by demo agent + registry)
// ─────────────────────────────────────────────

/**
 * Describes a tool the agent can call. Maps directly to
 * Anthropic's tool_use schema (and by extension, MCP protocol).
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: string;
}

// ─────────────────────────────────────────────
// AGENT TRACE
// ─────────────────────────────────────────────

export interface TraceStep {
  type: 'tool_call' | 'tool_result' | 'reasoning' | 'output';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  content?: string;
  timestamp: number;
}

export interface AgentTrace {
  input: string;
  steps: TraceStep[];
  output: AgentOutput;
  metadata: {
    model: string;
    provider?: 'anthropic' | 'openai' | 'ollama';
    durationMs: number;
    toolCallCount: number;
    retryCount: number;
  };
}

export interface AgentOutput {
  taskType: string;
  result: unknown;
  toolsUsed: string[];
  confidence: number;
  summary: string;
}

// ─────────────────────────────────────────────
// BEHAVIOR CONTRACTS
// ─────────────────────────────────────────────

export interface ContractDefinition {
  name: string;
  description: string;
  requiredFields: string[];
  requiredIntentKeywords: string[];
  minKeywordMatchRatio: number;
  forbiddenPatterns: RegExp[];
  maxLengthChars?: number;
  customValidator?: (output: unknown) => ValidationResult;
}

export interface ValidationResult {
  passed: boolean;
  score: number;
  reason: string;
}

export interface MatchResult {
  matched: boolean;
  confidence: number;
  details: string[];
}
