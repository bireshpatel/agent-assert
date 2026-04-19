/**
 * examples/agent/agent.ts
 *
 * Demo agent — reference system under test for this POC (not the assertion library).
 *
 * WHAT IT DOES:
 * 1. Takes a natural language task from the user
 * 2. Sends it to an LLM (Anthropic, OpenAI, or Ollama-compatible) along with available tool definitions
 * 3. The model responds with either a final answer or a request to call a tool
 * 4. If a tool is requested, the agent executes the tool and sends the result back
 * 5. This loop continues until the model produces a final answer
 * 6. The agent records EVERY step in a trace (AgentTrace)
 *
 * Provider selection: set `AgentConfig.provider`, or `LLM_PROVIDER=anthropic|openai|ollama`.
 * Keys: `ANTHROPIC_API_KEY` (Anthropic), `OPENAI_API_KEY` (OpenAI cloud or Ollama dummy).
 * Local Ollama: `LLM_PROVIDER=ollama` or `LLM_PROVIDER=openai` with `OPENAI_BASE_URL`
 * (e.g. `http://127.0.0.1:11434/v1`). See `.env.example`.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ToolUnion } from '@anthropic-ai/sdk/resources/messages/messages.js';
import OpenAI from 'openai';
import { ToolRegistry } from './tools/registry.js';
import {
  AgentTrace,
  AgentOutput,
  TraceStep,
  ToolResult,
} from '../../framework/types.js';

/** Which vendor API backs the agent. `ollama` uses the OpenAI SDK against a local Ollama server. */
export type LlmProvider = 'anthropic' | 'openai' | 'ollama';

/**
 * Configuration for the agent.
 *
 * @param provider - `anthropic`, `openai`, or `ollama` (local). Defaults from `LLM_PROVIDER` or `'anthropic'`.
 * @param apiKey - API key for the chosen provider. Falls back to env. For Ollama / local OpenAI-compatible URLs, a placeholder like `ollama` is used if unset.
 * @param baseURL - OpenAI client only: custom API base (e.g. Ollama `http://127.0.0.1:11434/v1`). Env: `OPENAI_BASE_URL` or `OLLAMA_BASE_URL`.
 * @param model - Model id for the provider (e.g. Claude, `gpt-4o`, `qwen3.5:latest`).
 * @param maxToolRounds - Safety cap on tool-calling iterations.
 * @param systemPrompt - System instructions for the agent.
 */
export interface AgentConfig {
  provider?: LlmProvider;
  apiKey?: string;
  /** OpenAI-compatible API base URL (Ollama, LM Studio, etc.). */
  baseURL?: string;
  model?: string;
  maxToolRounds?: number;
  systemPrompt?: string;
}

// Type alias for the tool_use content block from Anthropic's API
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// Type alias for text content block
interface TextBlock {
  type: 'text';
  text: string;
}

type ContentBlock = ToolUseBlock | TextBlock;

const OLLAMA_OPENAI_BASE_DEFAULT = 'http://127.0.0.1:11434/v1';

type ResolvedAgentConfig = {
  provider: LlmProvider;
  apiKey: string;
  /** Set when using OpenAI SDK with a non-default base (Ollama, etc.). */
  baseURL?: string;
  model: string;
  maxToolRounds: number;
  systemPrompt: string;
};

function resolveProviderFromEnv(): LlmProvider | undefined {
  const v = process.env.LLM_PROVIDER?.toLowerCase();
  if (v === 'openai' || v === 'anthropic' || v === 'ollama') return v;
  return undefined;
}

function resolveOpenAIBaseURL(
  provider: LlmProvider,
  config: AgentConfig
): string | undefined {
  const fromConfig = config.baseURL?.trim();
  if (provider === 'ollama') {
    const fromEnv =
      process.env.OPENAI_BASE_URL?.trim() ||
      process.env.OLLAMA_BASE_URL?.trim();
    return fromConfig || fromEnv || OLLAMA_OPENAI_BASE_DEFAULT;
  }
  // `openai` = OpenAI API (or Azure/custom via OPENAI_BASE_URL only).
  // Do not fall back to OLLAMA_BASE_URL — a stale shell OLLAMA_BASE_URL would
  // send traffic to Ollama while LLM_PROVIDER=openai, mixing providers in traces.
  const fromEnv = process.env.OPENAI_BASE_URL?.trim();
  return fromConfig || fromEnv || undefined;
}

function resolveAgentConfig(config: AgentConfig): ResolvedAgentConfig {
  const provider: LlmProvider =
    config.provider ?? resolveProviderFromEnv() ?? 'anthropic';

  const baseURL =
    provider === 'openai' || provider === 'ollama'
      ? resolveOpenAIBaseURL(provider, config)
      : undefined;

  let apiKey =
    config.apiKey ??
    (provider === 'openai' || provider === 'ollama'
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY) ??
    '';

  if ((provider === 'openai' || provider === 'ollama') && !apiKey && baseURL) {
    apiKey = 'ollama';
  }

  const defaultModel =
    provider === 'openai'
      ? 'gpt-4o'
      : provider === 'ollama'
        ? 'llama3:latest'
        : 'claude-sonnet-4-20250514';

  return {
    provider,
    apiKey,
    baseURL,
    model: config.model ?? defaultModel,
    maxToolRounds: config.maxToolRounds ?? 10,
    systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  };
}

export class Agent {
  private registry: ToolRegistry;
  private config: ResolvedAgentConfig;
  private anthropicClient: Anthropic | undefined;
  private openaiClient: OpenAI | undefined;

  constructor(registry: ToolRegistry, config: AgentConfig = {}) {
    this.registry = registry;
    this.config = resolveAgentConfig(config);

    if (this.config.provider === 'anthropic') {
      this.anthropicClient = new Anthropic({ apiKey: this.config.apiKey });
    } else {
      this.openaiClient = new OpenAI({
        apiKey: this.config.apiKey,
        ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
      });
    }
  }

  /**
   * Run the agent on a natural language task.
   */
  async run(userPrompt: string): Promise<AgentTrace> {
    if (this.config.provider === 'openai' || this.config.provider === 'ollama') {
      return this.runWithOpenAI(userPrompt);
    }
    return this.runWithAnthropic(userPrompt);
  }

  private async runWithAnthropic(userPrompt: string): Promise<AgentTrace> {
    const client = this.anthropicClient!;
    const startTime = Date.now();
    const steps: TraceStep[] = [];
    let retryCount = 0;
    let toolCallCount = 0;

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];

    let currentRound = 0;

    while (currentRound < this.config.maxToolRounds) {
      currentRound++;

      const response = await client.messages.create({
        model: this.config.model,
        max_tokens: 4096,
        system: this.config.systemPrompt,
        tools: this.registry.toAnthropicTools() as ToolUnion[],
        messages,
      });

      const toolUseBlocks: ToolUseBlock[] = [];

      for (const block of response.content as ContentBlock[]) {
        if (block.type === 'text') {
          steps.push({
            type: 'reasoning',
            content: block.text,
            timestamp: Date.now(),
          });
        } else if (block.type === 'tool_use') {
          toolUseBlocks.push(block);
        }
      }

      if (response.stop_reason === 'end_turn' && toolUseBlocks.length === 0) {
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        steps.push({
          type: 'tool_call',
          toolName: toolUse.name,
          toolInput: toolUse.input,
          timestamp: Date.now(),
        });

        toolCallCount++;

        const result: ToolResult = await this.registry.execute(
          toolUse.name,
          toolUse.input
        );

        if (!result.success) {
          retryCount++;
        }

        steps.push({
          type: 'tool_result',
          toolName: toolUse.name,
          toolOutput: result,
          timestamp: Date.now(),
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({
        role: 'assistant',
        content: response.content,
      });
      messages.push({
        role: 'user',
        content: toolResults,
      });

      if (response.stop_reason === 'end_turn') {
        break;
      }
    }

    return this.finalizeTrace(
      userPrompt,
      steps,
      startTime,
      toolCallCount,
      retryCount
    );
  }

  private async runWithOpenAI(userPrompt: string): Promise<AgentTrace> {
    const client = this.openaiClient!;
    const startTime = Date.now();
    const steps: TraceStep[] = [];
    let retryCount = 0;
    let toolCallCount = 0;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.config.systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    let currentRound = 0;

    while (currentRound < this.config.maxToolRounds) {
      currentRound++;

      const response = await client.chat.completions.create({
        model: this.config.model,
        max_tokens: 4096,
        messages,
        tools: this.registry.toOpenAITools(),
        tool_choice: 'auto',
      });

      const choice = response.choices[0];
      const msg = choice?.message;
      if (!msg) break;

      if (msg.content) {
        steps.push({
          type: 'reasoning',
          content: msg.content,
          timestamp: Date.now(),
        });
      }

      const toolCalls = msg.tool_calls ?? [];

      if (toolCalls.length === 0) {
        break;
      }

      messages.push(msg);

      for (const tc of toolCalls) {
        if (tc.type !== 'function') continue;

        const name = tc.function.name;
        let input: Record<string, unknown> = {};
        try {
          input = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          input = {};
        }

        steps.push({
          type: 'tool_call',
          toolName: name,
          toolInput: input,
          timestamp: Date.now(),
        });

        toolCallCount++;

        const result = await this.registry.execute(name, input);

        if (!result.success) {
          retryCount++;
        }

        steps.push({
          type: 'tool_result',
          toolName: name,
          toolOutput: result,
          timestamp: Date.now(),
        });

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }
    }

    return this.finalizeTrace(
      userPrompt,
      steps,
      startTime,
      toolCallCount,
      retryCount
    );
  }

  private finalizeTrace(
    userPrompt: string,
    steps: TraceStep[],
    startTime: number,
    toolCallCount: number,
    retryCount: number
  ): AgentTrace {
    const lastTextStep = [...steps].reverse().find(s => s.type === 'reasoning');
    const rawOutput = lastTextStep?.content || '';

    const output = this.parseOutput(rawOutput, steps);

    steps.push({
      type: 'output',
      content: JSON.stringify(output),
      timestamp: Date.now(),
    });

    return {
      input: userPrompt,
      steps,
      output,
      metadata: {
        model: this.config.model,
        provider: this.config.provider,
        durationMs: Date.now() - startTime,
        toolCallCount,
        retryCount,
      },
    };
  }

  /**
   * Parse the LLM's raw text output into a structured AgentOutput.
   */
  private parseOutput(rawText: string, steps: TraceStep[]): AgentOutput {
    const jsonMatch =
      rawText.match(/```json\s*([\s\S]*?)\s*```/) || rawText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      try {
        const jsonStr = jsonMatch[1] || jsonMatch[0];
        const parsed = JSON.parse(jsonStr);
        return {
          taskType: parsed.taskType || 'unknown',
          result: parsed.result || parsed,
          toolsUsed: Array.isArray(parsed.toolsUsed)
            ? parsed.toolsUsed
            : this.extractToolsFromTrace(steps),
          confidence: this.normalizeConfidence(parsed.confidence),
          summary:
            typeof parsed.summary === 'string'
              ? parsed.summary
              : rawText.slice(0, 200),
        };
      } catch {
        // JSON parsing failed — fall through to fallback
      }
    }

    return {
      taskType: 'unknown',
      result: rawText,
      toolsUsed: this.extractToolsFromTrace(steps),
      confidence: 0.3,
      summary: rawText.slice(0, 200),
    };
  }

  /**
   * Coerce model-provided confidence to a number in [0, 1].
   * Models sometimes emit strings ("%0.9", "85%") or malformed JSON leaves garbage.
   */
  private normalizeConfidence(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1 && value <= 100) return Math.min(1, value / 100);
      return Math.min(1, Math.max(0, value));
    }
    if (typeof value === 'string') {
      const s = value.trim().replace(/%/g, ' ');
      const m = s.match(/-?\d+(?:\.\d+)?/);
      if (m) {
        let n = parseFloat(m[0]);
        if (Number.isFinite(n)) {
          if (n > 1 && n <= 100) n = n / 100;
          return Math.min(1, Math.max(0, n));
        }
      }
    }
    return 0.5;
  }

  private extractToolsFromTrace(steps: TraceStep[]): string[] {
    const tools = new Set<string>();
    for (const step of steps) {
      if (step.type === 'tool_call' && step.toolName) {
        tools.add(step.toolName);
      }
    }
    return Array.from(tools);
  }
}

const DEFAULT_SYSTEM_PROMPT = `You are a task-execution agent. You have access to tools and must use them to complete the user's request.

RULES:
1. Analyze the user's request and determine which tools are needed.
2. Call the appropriate tools with correct parameters.
3. Use ONLY the tools that are relevant to the task. Do not call tools unnecessarily.
4. If a tool call fails, report the failure clearly. Do not invent data to replace a failed tool call.
5. Stay strictly within the scope of the user's request. Do not perform additional actions beyond what was asked.

RESPONSE FORMAT:
After completing the task, respond with ONLY a JSON object (no markdown fencing, no additional text):
{
  "taskType": "summarization" | "api_call" | "file_read" | "multi_step" | "unknown",
  "result": <the actual result of the task>,
  "toolsUsed": ["tool-name-1", "tool-name-2"],
  "confidence": 0.0 to 1.0,
  "summary": "Brief human-readable summary of what was done"
}`;
