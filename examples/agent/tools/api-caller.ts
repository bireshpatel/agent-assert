/**
 * examples/agent/tools/api-caller.ts
 * 
 * MCP TOOL #2: API Caller
 * 
 * WHAT THIS DOES:
 * Makes HTTP requests to APIs and returns structured responses.
 * In this POC, it operates in MOCK MODE by default — it doesn't
 * hit real APIs. It returns canned responses based on the URL pattern.
 * 
 * WHY MOCK BY DEFAULT:
 * 1. Tests must be deterministic. Real APIs return different data each time.
 * 2. Tests must be fast. Real API calls add seconds of latency.
 * 3. Tests must be isolated. You don't want test runs creating real Jira tickets.
 * 4. You control the failure modes. You can simulate 500 errors, timeouts, etc.
 * 
 * THE MOCK RESPONSES MAP:
 * The mockResponses parameter lets you define URL → response mappings.
 * In tests, you inject exactly the responses you need.
 * In production, you swap useMock to false and it hits real endpoints.
 * 
 * HOW TO EXTEND:
 * - Add authentication header support (Bearer token, API key)
 * - Add request body support for POST/PUT
 * - Add response caching for idempotent GET requests
 * - Add rate limiting awareness (return retry-after headers)
 * - Connect to your actual Jira/ServiceNow/Datadog APIs
 */

import { ToolDefinition, ToolResult } from '../../../framework/types.js';

/**
 * Configuration for the API caller.
 * 
 * @param useMock - When true, returns canned responses. When false, hits real URLs.
 * @param mockResponses - Map of URL patterns to canned responses.
 *                        Keys are regex patterns matched against the requested URL.
 * @param defaultTimeoutMs - How long to wait before timing out a real API call.
 */
export interface ApiCallerConfig {
  useMock: boolean;
  mockResponses?: Map<string, MockResponse>;
  defaultTimeoutMs?: number;
}

export interface MockResponse {
  status: number;
  body: unknown;
  delayMs?: number;   // Simulate network latency
}

export function createApiCallerTool(config: ApiCallerConfig): ToolDefinition {
  return {
    name: 'api-caller',

    description:
      'Makes HTTP API requests to external services. Use this tool when the task ' +
      'requires fetching data from or sending data to a web API, such as creating ' +
      'a Jira ticket, querying a monitoring dashboard, or fetching deployment status. ' +
      'Do NOT use this for reading local files — use file-reader instead.',

    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full API URL to call (e.g., "https://api.jira.com/rest/api/3/issue")',
        },
        method: {
          type: 'string',
          description: 'HTTP method',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          default: 'GET',
        },
        body: {
          type: 'object',
          description: 'Request body for POST/PUT/PATCH requests. Must be a JSON object.',
        },
        headers: {
          type: 'object',
          description: 'Additional HTTP headers as key-value pairs.',
        },
      },
      required: ['url', 'method'],
    },

    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      const url = input.url as string;
      const method = (input.method as string) || 'GET';
      const body = input.body as Record<string, unknown> | undefined;

      // ── MOCK MODE ──────────────────────────────────────
      // In tests, we never hit real APIs. We match the URL against
      // our mock map and return the canned response.
      if (config.useMock) {
        return handleMockRequest(url, method, body, config.mockResponses);
      }

      // ── REAL MODE ──────────────────────────────────────
      // Production path. Actually makes the HTTP call.
      // You'd enable this when running the agent for real.
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          config.defaultTimeoutMs || 10_000
        );

        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(input.headers as Record<string, string> || {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const responseBody = await response.json();

        return {
          success: response.ok,
          data: {
            status: response.status,
            body: responseBody,
          },
          error: response.ok ? undefined : `API returned status ${response.status}`,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          success: false,
          data: null,
          error: `API call failed: ${message}`,
        };
      }
    },
  };
}

/**
 * Handles a mock request by matching the URL against registered patterns.
 * 
 * HOW URL MATCHING WORKS:
 * Each key in mockResponses is treated as a substring match against the URL.
 * This is intentionally simple. In a real testing framework, you might use
 * regex or path patterns (like MSW does). But for this POC, substring
 * matching is sufficient and easier to debug.
 * 
 * If no mock matches, the tool returns a 404 response.
 * This is important — it means your tests can verify that the agent
 * handles "endpoint not found" gracefully.
 */
async function handleMockRequest(
  url: string,
  method: string,
  body: Record<string, unknown> | undefined,
  mockResponses?: Map<string, MockResponse>
): Promise<ToolResult> {
  if (!mockResponses) {
    return {
      success: false,
      data: null,
      error: 'Mock mode enabled but no mock responses configured',
    };
  }

  // Find first matching mock response
  for (const [pattern, mockResponse] of mockResponses) {
    if (url.includes(pattern)) {
      // Simulate network latency if configured
      if (mockResponse.delayMs) {
        await new Promise(resolve => setTimeout(resolve, mockResponse.delayMs));
      }

      const isSuccess = mockResponse.status >= 200 && mockResponse.status < 300;

      return {
        success: isSuccess,
        data: {
          status: mockResponse.status,
          body: mockResponse.body,
          requestMethod: method,
          requestBody: body,
        },
        error: isSuccess ? undefined : `API returned status ${mockResponse.status}`,
      };
    }
  }

  // No mock matched — return 404
  return {
    success: false,
    data: { status: 404, body: { error: 'Not found' } },
    error: `No mock response configured for URL: ${url}`,
  };
}
