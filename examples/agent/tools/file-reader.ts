/**
 * examples/agent/tools/file-reader.ts
 * 
 * MCP TOOL #1: File Reader
 * 
 * WHAT THIS DOES:
 * Reads a file from disk and returns its contents. Simple.
 * 
 * WHY IT EXISTS IN THIS POC:
 * The tool itself is boring on purpose. The interesting part is:
 * 1. The agent must DECIDE to use this tool (intent-routing test)
 * 2. The agent must pass CORRECT parameters (tool-invocation test)
 * 3. The tool can FAIL, and the agent must handle it (retry-behavior test)
 * 4. The agent must NOT use this tool when the task doesn't need files
 *    (hallucination-guard / boundary test)
 * 
 * MCP COMPATIBILITY:
 * This tool's interface follows the MCP tool schema:
 * - name: unique identifier
 * - description: what the LLM reads to decide whether to use it
 * - inputSchema: JSON Schema defining the parameters
 * - execute: the function that runs
 * 
 * When you connect this to a real MCP server, you replace `execute`
 * with the MCP transport layer (stdio or SSE). The schema stays the same.
 * 
 * HOW TO EXTEND:
 * - Add file type detection (return different formats for .json vs .csv vs .log)
 * - Add glob pattern support for reading multiple files
 * - Add line range filtering (read lines 50-100 of a file)
 * - Add encoding detection for non-UTF8 files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolDefinition, ToolResult } from '../../../framework/types.js';

/** Small / weak models sometimes omit `filePath` or use snake_case — normalize before resolve(). */
function pickFilePath(input: Record<string, unknown>): string | undefined {
  const raw = input.filePath ?? input.file_path ?? input.path;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw != null && typeof raw !== 'object') return String(raw).trim() || undefined;
  return undefined;
}

/**
 * Creates a file-reader tool instance.
 * 
 * WHY A FACTORY FUNCTION INSTEAD OF A PLAIN OBJECT?
 * Because in tests, you need to:
 * 1. Inject a custom basePath (point to test fixtures instead of real files)
 * 2. Swap the execute function with a mock/spy
 * 3. Simulate failures by providing a failing execute function
 * 
 * A factory function lets you configure all of this at creation time.
 * 
 * @param basePath - Root directory the tool can read from.
 *                   In production: your actual file system.
 *                   In tests: a temp directory with fixture files.
 */
export function createFileReaderTool(basePath: string = '/tmp/agent-files'): ToolDefinition {
  return {
    name: 'file-reader',

    // This description is CRITICAL. The LLM reads this text to decide
    // whether to call this tool. If the description is vague, the agent
    // will misroute tasks. If it's too broad, the agent will use this
    // tool when it shouldn't.
    description:
      'Reads the contents of a file from the local filesystem. ' +
      'Use this tool when the task requires reading, analyzing, or summarizing ' +
      'the contents of a specific file. Supports text files including .log, ' +
      '.txt, .json, .csv, and .md files. Do NOT use this for fetching data ' +
      'from APIs or web URLs.',

    // JSON Schema that tells the LLM what parameters this tool accepts.
    // The LLM generates a JSON object matching this schema when it
    // decides to call the tool.
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Relative path to the file to read (e.g., "logs/test-results.log")',
        },
        encoding: {
          type: 'string',
          description: 'File encoding. Defaults to utf-8.',
          enum: ['utf-8', 'ascii', 'latin1'],
          default: 'utf-8',
        },
      },
      required: ['filePath'],
    },

    /**
     * The actual execution logic.
     * 
     * SECURITY NOTE: In a real system, you MUST validate the filePath
     * to prevent path traversal attacks. An LLM could be tricked
     * (via prompt injection) into reading sensitive files like
     * /etc/passwd or ../../secrets.env.
     * 
     * The path.resolve + startsWith check below prevents this.
     */
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const filePath = pickFilePath(input);
      if (!filePath) {
        return {
          success: false,
          data: null,
          error:
            'Missing file path. Pass filePath as a string (e.g. "logs/test-results.log").',
        };
      }

      const encoding = (input.encoding as BufferEncoding) || 'utf-8';

      // SECURITY: Resolve the full path and verify it's within basePath.
      // Without this check, a prompt injection could make the agent
      // read files outside the allowed directory.
      const fullPath = path.resolve(basePath, filePath);
      if (!fullPath.startsWith(path.resolve(basePath))) {
        return {
          success: false,
          data: null,
          error: `Access denied: path "${filePath}" is outside the allowed directory`,
        };
      }

      try {
        const content = await fs.readFile(fullPath, { encoding });
        const stats = await fs.stat(fullPath);

        return {
          success: true,
          data: {
            content,
            filePath,
            sizeBytes: stats.size,
            lastModified: stats.mtime.toISOString(),
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          success: false,
          data: null,
          error: `Failed to read file "${filePath}": ${message}`,
        };
      }
    },
  };
}
