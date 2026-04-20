/**
 * Public entry — re-exports the reusable assertion layer from `framework/`.
 *
 * This repo is a **proof-of-concept** (`"private": true`); it is not published
 * to npm. The demo LLM agent lives under `examples/agent/`, not here.
 *
 * In a TypeScript project that vendors this repo, use:
 *   import { AgentAssert, BehaviorContract } from 'agent-assert';
 * (with `package.json` dependencies pointing at this path or Git URL.)
 */

export * from './framework/index.js';
