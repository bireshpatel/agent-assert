/**
 * Reusable assertion helpers and types (this POC’s “library” surface).
 */

export type {
  AgentOutput,
  AgentTrace,
  ContractDefinition,
  MatchResult,
  ToolDefinition,
  ToolResult,
  TraceStep,
  ValidationResult,
} from './types.js';

export { AgentAssert } from './AgentAssert.js';
export { BehaviorContract } from './BehaviorContract.js';
export { HeuristicContractMatcher } from './HeuristicContractMatcher.js';
