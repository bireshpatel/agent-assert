/**
 * examples/agent/tools/registry.ts
 * 
 * TOOL REGISTRY
 * 
 * WHY A REGISTRY:
 * The agent needs to do two things with tools:
 * 1. Tell the LLM what tools are available (schema descriptions)
 * 2. Execute a tool when the LLM requests it (by name)
 * 
 * The registry holds all registered tools and provides both capabilities.
 * 
 * IN TESTS:
 * You create a registry with only the tools relevant to that test.
 * Want to test that the agent stays within boundaries? Register only
 * the allowed tools and verify it doesn't try to call anything else.
 * 
 * HOW TO EXTEND:
 * - Add tool versioning (same tool name, different versions)
 * - Add tool middleware (logging, rate limiting, auth injection)
 * - Add dynamic tool discovery (fetch available tools from an MCP server at runtime)
 */

import type OpenAI from 'openai';
import { ToolDefinition, ToolResult } from '../../../framework/types.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * Register a tool. Overwrites if a tool with the same name exists.
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool by name. Returns undefined if not found.
   * The agent uses this to execute a tool after the LLM selects it.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Execute a tool by name with the given input.
   * Returns the tool's result, or an error if the tool doesn't exist.
   * 
   * This method is the single point where all tool calls flow through.
   * That makes it the perfect place to:
   * - Log every tool invocation (for trace building)
   * - Apply rate limiting
   * - Check permissions
   * - Inject test interceptors
   */
  async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        data: null,
        error: `Tool "${name}" is not registered. Available tools: ${this.listNames().join(', ')}`,
      };
    }
    return tool.execute(input);
  }

  /**
   * Returns tool definitions formatted for the Anthropic API's `tools` parameter.
   * 
   * This is the bridge between your internal tool definitions and the
   * Anthropic API format. The API expects:
   * {
   *   name: string,
   *   description: string,
   *   input_schema: JSONSchema
   * }
   * 
   * Your internal ToolDefinition uses `inputSchema` (camelCase).
   * This method translates to `input_schema` (snake_case) for the API.
   */
  toAnthropicTools(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  /**
   * Returns tool definitions for the OpenAI Chat Completions `tools` parameter.
   * See: https://platform.openai.com/docs/guides/function-calling
   */
  toOpenAITools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return Array.from(this.tools.values()).map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  /**
   * List all registered tool names. Used for boundary testing —
   * "did the agent only call tools from this list?"
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Check if a tool name is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get the count of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }
}
