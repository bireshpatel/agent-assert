# Examples

## `agent/` — demo system under test

This folder holds a **reference LLM agent** (tool loop + `ToolRegistry` + sample tools). It exists to drive the Playwright tests in `tests/` and to show how `AgentTrace` / `AgentOutput` are produced.

It is **not** the reusable assertion library — that lives in `framework/` at the repo root and is re-exported from `index.ts`.

To try your own agent: implement a runner that yields the same trace shapes (see `framework/types.ts`), wire it in `tests/fixtures/setup.ts`, and keep or replace the demo tools.
