# AgentAssert

**A Playwright-based testing framework for agentic AI systems with MCP-compatible tool schemas and in-process tool orchestration.**

---

## About

A working proof-of-concept that demonstrates five testing patterns for AI agents that call tools through a **`ToolRegistry`** (the same tool definitions map cleanly to Anthropic/OpenAI tool formats and to MCP-style schemas). The repo does not run a live MCP server by default; tools execute in-process so tests stay fast and deterministic. The framework introduces `NonDeterministicMatcher` — an assertion utility that evaluates LLM outputs against semantic intent contracts instead of exact string matches.

The deliberate use of Playwright (not Jest, not Vitest) as the test runner is itself a publishable insight.

---

## Architecture: How the Pieces Connect

```
┌─────────────────────────────────────────────────────────┐
│                    YOUR TEST FILE                       │
│  import { AgentAssert } from '../../framework/AgentAssert.js' │
│  const trace = await agent.run("some prompt")           │
│  AgentAssert.toolWasInvoked(trace, 'file-reader')       │
│  AgentAssert.satisfiesContract(trace.output, CONTRACT)    │
└─────────────────┬──────────────────────────┬────────────┘
                  │                          │
      ┌───────────▼─────────┐    ┌───────────▼─────────────┐ 
      │    Agent (SUT)      │    │   AgentAssert           │
      │                     │    │   (assertion library)   │
      │ 1. Send prompt to   │    │                         │
      │    LLM (Anthropic / │    │ - toolWasInvoked()      │
      │     OpenAI / Ollama)│    │ - satisfiesContract()   │
      │ 2. Get tool calls   │    │ - boundaryNotViolated() │
      │    from model       │    │                         │
      │ 3. Execute tool     │    │ - traceFollowsSequence()│
      │ 4. Send result back │    │                         │
      │ 5. Capture TRACE    │    └───────────┬─────────────┘
      └────────┬────────────┘                │
               │                  ┌──────────▼──────────────┐
    ┌──────────▼───────────┐      │ NonDeterministicMatcher │
    │   ToolRegistry       │      │                         │
    │                      │      │ Layer 1: Structure      │
    │ file-reader → exec() │      │ Layer 2: Semantics      │
    │ api-caller  → exec() │      │ Layer 3: Forbidden      │
    └──────────────────────┘      │ Layer 4: Custom         │
                                  │                         │
                                  │ Returns: MatchResult    │
                                  │  { confidence: 0.82 }   │
                                  └─────────────────────────┘
```

### Data Flow (Step by Step)

1. **Test calls `agent.run(prompt)`** — sends a natural language task
2. **Agent sends prompt to the configured LLM API** (Anthropic, OpenAI, or Ollama via OpenAI-compatible API) — along with tool definitions from ToolRegistry
3. **The model responds with tool calls** — Anthropic: `tool_use` blocks; OpenAI: `function` tool calls — e.g. "call file-reader with path X"
4. **Agent executes the tool** via ToolRegistry — gets back `ToolResult`
5. **Agent sends tool result back to the model** — the model may request more tools
6. **Loop continues** until the model produces a final text response
7. **Agent builds `AgentTrace`** — captures EVERY step (tool calls, tool results, reasoning, output)
8. **Test receives the trace** and passes it to AgentAssert methods
9. **AgentAssert uses NonDeterministicMatcher** to evaluate output against BehaviorContracts
10. **MatchResult returned** with confidence score and detailed breakdown

---

## The Five Testing Patterns

### Pattern 1: Tool Invocation Assertion
**File:** `tests/behavioral/intent-routing.spec.ts`

**What it tests:** Did the agent select the correct tool for the given intent?

**Why it's unique:** Traditional tests check return values. Agent tests check *decisions*. The agent might return a plausible-looking summary even when it called the wrong tool (or no tool at all).

**Key assertion:**
```typescript
const result = AgentAssert.toolWasInvoked(trace, 'file-reader', { filePath: /.*\.log$/ });
AgentAssert.expectMatched(result, 'file-reader should be invoked'); // embeds AgentAssert.formatResult(result) on failure
```

**What to look at in the code:**
- `AgentAssert.toolWasInvoked()` — walks the trace looking for tool_call steps
- `paramMatchers` — regex patterns validated against tool input parameters
- Negative assertion — `AgentAssert.expectNotMatched(result, '...')` verifies a tool was NOT called (rich failure output via `formatResult`)

---

### Pattern 2: Behavior Contract Validation
**File:** `tests/behavioral/output-contract.spec.ts`

**What it tests:** Does the output satisfy a semantic contract (not exact string match)?

**Why it's unique:** `expect(output).toBe("...")` breaks on every LLM run. Contracts define rules that any correct output must satisfy, regardless of exact phrasing.

**Key assertion:**
```typescript
const result = AgentAssert.satisfiesContract(trace.output, BehaviorContract.SUMMARIZATION, 0.5);
AgentAssert.expectMatched(result, 'SUMMARIZATION contract should pass');
```

**What to look at in the code:**
- `BehaviorContract.ts` — pre-built contracts with required fields, keywords, forbidden patterns
- `NonDeterministicMatcher.evaluate()` — the three-layer evaluation engine
- `minKeywordMatchRatio` — controls how strict keyword matching is
- `forbiddenPatterns` — hard-fail patterns that override the confidence score

---

### Pattern 3: Multi-Step Trace Verification
**File:** `tests/behavioral/tool-invocation.spec.ts`

**What it tests:** Did the agent follow a valid reasoning path through multiple tool calls?

**Why it's unique:** No equivalent in Selenium/Playwright browser testing. Browser tests check page state, not the application's intermediate reasoning steps.

**Key assertion:**
```typescript
const result = AgentAssert.traceFollowsSequence(trace, [
  { type: 'tool_call', toolName: 'file-reader' },
  { type: 'tool_call', toolName: 'api-caller' },
]);
AgentAssert.expectMatched(result, 'trace should show file-reader then api-caller');
```

**What to look at in the code:**
- `AgentAssert.traceFollowsSequence()` — checks steps appear in order (not necessarily consecutive)
- The trace captures reasoning steps between tool calls
- `toolCallCountInRange()` — sanity check on how many tools were called

---

### Pattern 4: Boundary/Scope Enforcement
**File:** `tests/boundary/hallucination-guard.spec.ts`

**What it tests:** Did the agent stay within its defined task boundaries?

**Why it's unique:** LLMs hallucinate tool calls, fabricate data, and take unsolicited actions. Nobody tests for this systematically.

**Key assertion:**
```typescript
const result = AgentAssert.boundaryNotViolated(trace, ['file-reader']);
AgentAssert.expectMatched(result, 'only file-reader should be used');
```

**What to look at in the code:**
- `boundaryNotViolated()` — checks that ONLY allowed tools were called
- `createFileOnlyAgent()` — test factory that registers limited tools
- `HALLUCINATION_PROMPTS` — adversarial prompts designed to trigger out-of-scope behavior
- `SCOPE_BOUNDED` contract — forbidden patterns for scope-creep language

---

### Pattern 5: Failure & Retry Observability
**File:** `tests/boundary/retry-behavior.spec.ts`

**What it tests:** Does the agent degrade gracefully when tools fail?

**Why it's unique:** Most agent tests don't simulate tool failures at all.

**Key assertions (examples):**
```typescript
// Honest reporting: output mentions failure / contract passes
expect(mentionsFailure, 'output should reflect tool failure').toBe(true);

// No false success after API error
expect(claimsSuccess, 'must not claim ticket created when API failed').toBe(false);

// Retry cap: count only `file-reader` tool_call steps (metadata.toolCallCount includes all tools)
const n = trace.steps.filter(s => s.type === 'tool_call' && s.toolName === 'file-reader').length;
AgentAssert.expectMatched(
  {
    matched: n >= 1 && n <= 3,
    confidence: n >= 1 && n <= 3 ? 1 : 0,
    details: [`file-reader invocations: ${n} (expected: 1–3)`, '…'],
  },
  'file-reader retries on failure should stay between 1 and 3'
);
```

**What to look at in the code:**
- `createFailingFileReaderAgent()` — agent with tools wired to always fail
- `GRACEFUL_FAILURE` contract — requires error keywords, forbids success-claiming language
- `retryCount` in trace metadata — tracks how many tool results had `success: false` in the agent loop
- Cascade failure test — verifies downstream behavior when file-reader fails (see `textReflectsUpstreamFailure` / tool traces)

---

## Key Files Explained

### agent/types.ts
Every type definition. Read this first — everything else depends on these types.

- `AgentTrace` — the backbone. Every assertion operates on traces.
- `TraceStep` — one decision the agent made (tool_call, tool_result, reasoning, output)
- `ContractDefinition` — the rules that define "correct" for non-deterministic outputs
- `MatchResult` — what assertions return (confidence score + details)

### agent/agent.ts
The System Under Test. The tool-calling loop is the core pattern:

1. Send prompt + tool definitions to **Anthropic Messages API** or **OpenAI Chat Completions** (see `AgentConfig.provider`)
2. The model responds with text and/or tool calls (`tool_use` vs `function` / `tool_calls` depending on provider)
3. Execute requested tools
4. Send tool results back in the provider-specific message format
5. Repeat until the model gives a final answer
6. Build the AgentTrace from everything that happened

**Provider selection:** Pass `provider: 'anthropic' | 'openai' | 'ollama'`, or set `LLM_PROVIDER` in the environment. Keys: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or pass `apiKey`). For **`LLM_PROVIDER=ollama`**, the OpenAI client uses `OPENAI_BASE_URL`, then `OLLAMA_BASE_URL`, then defaults to `http://127.0.0.1:11434/v1`. For **`LLM_PROVIDER=openai`**, only **`OPENAI_BASE_URL`** is used for a custom base (Azure, proxy, etc.); **`OLLAMA_BASE_URL` is ignored** so a stale shell variable cannot send OpenAI traffic to Ollama by accident.

**Important:** The system prompt in this file shapes agent behavior. If you change it, update the test contracts to match.

### agent/tools/file-reader.ts and api-caller.ts
Tools use MCP-aligned JSON schemas and register through **`ToolRegistry`**. In this POC they run locally (file-reader reads from disk, api-caller uses mock responses). To connect them to a real MCP server, replace the `execute` function with MCP transport calls — the schema stays the same.

**Security note:** `file-reader.ts` includes path traversal protection. Read the comments.

### agent/tools/registry.ts
Maps tool names to definitions. Provides `toAnthropicTools()` and `toOpenAITools()` so the same tool definitions work with either API. This is the bridge between your tool definitions and the LLM.

### framework/NonDeterministicMatcher.ts
**The core innovation.** Three evaluation layers:

1. **Structural** (40% weight) — are required fields present?
2. **Semantic** (35% weight) — do enough intent keywords appear?
3. **Forbidden** (25% weight) — do any red-flag patterns match?

Forbidden patterns cause a hard failure regardless of other scores.

**Tuning knobs:**
- `minKeywordMatchRatio` in the contract — lower = more lenient
- `confidence` threshold in the test — lower = fewer flaky tests
- `forbiddenPatterns` — add patterns to catch more failure modes

### framework/BehaviorContract.ts
Pre-built contracts for common task types. Each contract defines what "correct" means for that task type. The five contracts: SUMMARIZATION, API_ACTION, MULTI_STEP, SCOPE_BOUNDED, GRACEFUL_FAILURE.

### framework/AgentAssert.ts
The public API. Core assertions (each returns a **`MatchResult`**):

1. `toolWasInvoked(trace, toolName, paramMatchers?)` — was a tool called?
2. `satisfiesContract(output, contract, minConfidence?)` — does output meet the contract?
3. `boundaryNotViolated(trace, allowedTools)` — only allowed tools used?
4. `traceFollowsSequence(trace, expectedSequence)` — correct execution order?
5. `toolCallCountInRange(trace, min, max)` — reasonable number of tool calls?

Helpers:

- `formatResult(result, debugHint?)` — pretty-print a `MatchResult` for logs or messages
- `expectMatched(result, context)` / `expectNotMatched(result, context)` — thin wrappers around Playwright’s `expect` so failures include `formatResult` automatically

---

### tests/env-llm.ts and `.env`

Playwright loads **`tests/env-llm.ts`** from **`playwright.config.ts`** (`applyLlmVarsFromDotEnv()`). Selected keys from a project-root **`.env`** file are merged into `process.env` (`.env` wins over existing shell vars for those keys): `LLM_PROVIDER`, `LLM_MODEL`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Copy **`.env.example`** to **`.env`** and fill in keys so tests and IDE runs see the same configuration without exporting variables manually.

---

### playwright.config.ts (high level)

- **`retries: 1`** — each failed test runs one more time (LLM outputs vary)
- **Timeouts:** default **45s**; **`behavioral`** project **60s** (multi-step runs); **`boundary`** **45s**
- **`trace: 'off'`** — browser-style Playwright traces are disabled (this suite does not use a browser). Failures still get rich attachments from **`registerAgentTraceForDiagnostics`** in `tests/fixtures/setup.ts` (see below)
- **`workers: 3`** — tune for your API rate limits
- **HTML report `title`** — includes resolved LLM provider and model for quick scanning

### tests/fixtures/setup.ts

Shared test factories (`createTestAgent`, `createFailingFileReaderAgent`, `createFileOnlyAgent`, etc.), fixture file paths (`FIXTURE_DIR` / `test-fixtures/`), and **`registerAgentTraceForDiagnostics`** — wires trace attachments into the Playwright report (see **Failure diagnostics** above).

---

## Setup & Running

### Prerequisites
- Node.js 18+
- An API key for cloud use, **or** a local [Ollama](https://ollama.com/) (or other OpenAI-compatible) server — see **Local Ollama** below

### Install
```bash
cd agent-assert   # or your clone folder name
npm install
npx playwright install  # Playwright still expects browser binaries to be present
```

### Configure API keys

Prefer a **`.env`** file at the repo root (see **`.env.example`**). The same variables work if you `export` them in the shell.

**Anthropic (default)** — set the key and optionally pin the provider (default is `anthropic` if `LLM_PROVIDER` is unset):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# optional explicit provider (defaults to anthropic)
export LLM_PROVIDER="anthropic"
```

**OpenAI** — set the OpenAI key and select the provider. If you omit `LLM_MODEL`, the agent defaults to `gpt-4o`:

```bash
export OPENAI_API_KEY="sk-..."
export LLM_PROVIDER="openai"
# optional:
export LLM_MODEL="gpt-4o-mini"
```

**Local Ollama** — no paid API key required; uses the OpenAI-compatible endpoint (`http://127.0.0.1:11434/v1` by default). Start Ollama, pull a model (e.g. `ollama pull qwen3.5`), then:

```bash
export LLM_PROVIDER="ollama"
export LLM_MODEL="qwen3.5:latest"
# optional if Ollama listens elsewhere:
# export OLLAMA_BASE_URL="http://127.0.0.1:11434/v1"
npx playwright test
```

Alternatively, keep `LLM_PROVIDER=openai` and point at Ollama with **`OPENAI_BASE_URL`** only (do not rely on `OLLAMA_BASE_URL` for this provider).

You can also pass `provider`, `apiKey`, `baseURL`, and `model` when constructing `Agent` in code instead of using environment variables.

### Failure diagnostics (HTML report)

Tests that call **`registerAgentTraceForDiagnostics(testInfo, trace)`** attach:

- **`agent-run-summary.txt`** — every run (provider, model, tool order, output preview)
- On failure: **`agent-diagnostics.txt`** (full trace dump) and **`playwright-failure.txt`** (Playwright error context)

Open the **Attachments** tab in the HTML report for the failing test.

### Run All Tests
```bash
npx playwright test
```

### Run Specific Pattern
```bash
npx playwright test tests/behavioral/intent-routing.spec.ts
npx playwright test tests/boundary/
npx playwright test --project=behavioral
npx playwright test --project=boundary
```

### View HTML Report
```bash
npx playwright show-report
```

---

## How to Extend

### Add a New Tool
1. Create `agent/tools/your-tool.ts` following the same factory pattern as `file-reader.ts`
2. Register it in the ToolRegistry in your test setup
3. Add mock responses in `setup.ts`
4. Write tests using `AgentAssert.toolWasInvoked(trace, 'your-tool')`

### Add a New Contract
1. Add a new static property to `BehaviorContract.ts`
2. Define requiredFields, requiredIntentKeywords, forbiddenPatterns
3. Set minKeywordMatchRatio (start with 0.2, tune from there)
4. Add a customValidator if you need logic beyond keywords/patterns
5. Write a test that asserts against your new contract

### Add a New Assertion Method
1. Add a static method to `AgentAssert.ts`
2. Accept `AgentTrace` or `AgentOutput` as input
3. Return `MatchResult`
4. Use `NonDeterministicMatcher` methods internally if needed
5. Include detailed reasons in the `details` array

### Adapt for Another LLM Provider (beyond Anthropic, OpenAI, and Ollama)
1. Add a branch in `agent/agent.ts` alongside the existing Anthropic and OpenAI-compatible loops
2. Add a `toYourProviderTools()` (or equivalent) on `ToolRegistry` if the tool schema differs
3. Map that provider’s tool-call and tool-result messages into the same `TraceStep` shapes the framework already expects
4. The framework layer (AgentAssert, NonDeterministicMatcher, BehaviorContract) stays UNCHANGED — it operates on `AgentTrace`, which is provider-agnostic

### Connect to a Real MCP Server
1. Replace the `execute` function in your tool with MCP client calls
2. Use `@modelcontextprotocol/sdk` for the transport layer
3. Keep the same `inputSchema` — MCP and Anthropic tool schemas are aligned by design
4. Update mock configurations in test setup to toggle between mock and live modes

---

## Why Playwright (Not Jest or Vitest)

| Feature | Jest/Vitest | Playwright |
|---------|------------|------------|
| Parallel isolation | Shared process | Separate worker processes |
| Built-in retries | Manual config | `retries: 1` in this project’s config |
| HTML reports | Needs plugin | Built in |
| Timeout granularity | Per-suite | Per-test, per-suite, global |
| Trace capture | None | This suite uses `trace: 'off'` + custom attachments on failure |
| Future browser testing | Separate framework | Same framework |
| Fixture system | beforeEach | test.extend() with typed fixtures |

The deliberate choice of Playwright for non-browser testing is itself a publishable insight for the article.

---

## Cost Awareness

Each test run calls a real LLM API. Costs depend on provider and model.

**Anthropic** — with `claude-sonnet-4-20250514` (order-of-magnitude; varies by prompt length):
- Simple tests (1 tool call): ~$0.01-0.03 per run
- Multi-step tests (2+ tool calls): ~$0.03-0.08 per run
- Full suite (**25** tests × 1 run): scale the above by test mix
- Full suite with Playwright retries (**25** tests × up to **2** attempts each when flaky): up to ~2× the single-run cost

**OpenAI** — pricing follows [OpenAI’s current rates](https://openai.com/pricing) for the model you set (e.g. `gpt-4o`, `gpt-4o-mini`).

**To reduce costs during development:**
- Use a smaller/cheaper model (`claude-haiku`, `gpt-4o-mini`, etc.) via `AgentConfig.model` or `LLM_MODEL`
- Run individual test files, not the full suite
- Keep `maxToolRounds` low (default 10 is already conservative)

---

## Troubleshooting

**Tests timeout (>60s):**
LLM APIs can be slow. Increase `timeout` in `playwright.config.ts`. Check your API key is valid for the chosen provider (`LLM_PROVIDER` / `AgentConfig.provider`). Check rate limits.

**Tests are flaky (pass sometimes, fail sometimes):**
This is expected with LLM testing. Three strategies:
1. Lower `minKeywordMatchRatio` in the contract
2. Add more keywords to the contract
3. Lower the confidence threshold in the assertion
4. Playwright’s `retries: 1` handles transient variation

**Wrong provider or API URL (401 / unexpected host):**  
Confirm `LLM_PROVIDER` matches the key you set. For `openai`, set **`OPENAI_BASE_URL`** for a custom endpoint; **`OLLAMA_BASE_URL` is not read** for that provider. Use **`LLM_PROVIDER=ollama`** with Ollama’s `/v1` base if you intend local Ollama.

**Agent output is not JSON:**
The system prompt tells Claude to respond in JSON, but it sometimes wraps it in markdown fences. The `parseOutput()` method in `agent.ts` handles this. If you see `taskType: "unknown"`, the JSON parsing failed entirely — check the raw text in the trace.

**File-reader returns "access denied":**
Path traversal protection. The file path must be within the configured `basePath`. Check that `FIXTURE_DIR` resolves correctly.

**"Tool X is not registered" error in trace:**
The agent tried to call a tool that wasn't in the ToolRegistry. This is actually a valid test finding — it means the agent hallucinated a tool call. Check the `boundaryNotViolated` assertion.
