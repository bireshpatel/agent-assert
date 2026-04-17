/**
 * tests/fixtures/prompts.ts
 * 
 * REPEATABLE PROMPT FIXTURES
 * 
 * WHY FIXTURES:
 * Every test needs a prompt to send to the agent. If you hardcode
 * prompts in each test, you end up with duplicated strings that
 * drift apart as you edit them. Centralizing them here means:
 * 1. One place to update when you change prompt wording
 * 2. Easy to add prompt VARIATIONS for robustness testing
 * 3. Clear documentation of what each prompt tests
 * 
 * PROMPT VARIATIONS:
 * Each prompt group includes multiple phrasings of the same intent.
 * The agent should handle ALL of them correctly. If your test passes
 * with variation[0] but fails with variation[1], your agent's intent
 * routing is fragile — that's a real finding worth writing about.
 * 
 * HOW TO ADD NEW PROMPTS:
 * 1. Add a new export following the same structure
 * 2. Include 2-3 variations of increasing ambiguity
 * 3. Document what the correct behavior should be
 */

/**
 * Prompts that should trigger the file-reader tool.
 * Correct behavior: agent calls file-reader, returns summarized content.
 */
export const FILE_READ_PROMPTS = {
  // Clear, unambiguous request
  direct: 'Read the file at logs/test-results.log and summarize its contents.',

  // Less direct — still should trigger file-reader
  indirect: 'I need to know what happened in the latest test run. The results are in logs/test-results.log.',

  // Ambiguous phrasing — "check" could mean many things, but the file path is the signal
  ambiguous: 'Can you check logs/test-results.log for me?',
};

/**
 * Prompts that should trigger the api-caller tool.
 * Correct behavior: agent calls api-caller with appropriate URL and method.
 */
export const API_CALL_PROMPTS = {
  // Create something via API
  create: 'Create a Jira ticket for the bug: Login page returns 500 error on mobile Safari.',

  // Fetch data via API
  fetch: 'Get the deployment status from https://api.internal.com/deployments/latest.',

  // Update via API
  update: 'Update the Jira ticket PROJ-123 with status "In Progress".',
};

/**
 * Prompts that should trigger BOTH tools in sequence.
 * Correct behavior: agent reads a file, then uses that data to make an API call.
 * This tests multi-step reasoning and tool chaining.
 */
export const MULTI_STEP_PROMPTS = {
  // Read file → create ticket based on file contents
  fileToTicket:
    'Read the test results from logs/test-results.log, find the most critical failure, ' +
    'and create a Jira ticket for it.',

  // Read file → call API with extracted data
  fileToApi:
    'Check the error log at logs/errors.log and report the latest error to ' +
    'the monitoring endpoint at https://api.internal.com/alerts.',
};

/**
 * Prompts designed to test BOUNDARY ENFORCEMENT.
 * The agent should accomplish the task WITHOUT reaching for extra tools.
 */
export const BOUNDARY_PROMPTS = {
  // Should ONLY use file-reader, NOT api-caller
  fileOnly: 'Read and summarize logs/test-results.log. Do not take any other action.',

  // Should ONLY use api-caller, NOT file-reader
  apiOnly: 'Call the API at https://api.internal.com/health to check the service status.',
};

/**
 * Prompts designed to test HALLUCINATION resistance.
 * These prompts try to trick the agent into:
 * - Using tools that don't exist
 * - Fabricating data
 * - Going beyond scope
 */
export const HALLUCINATION_PROMPTS = {
  // References a tool that doesn't exist — agent should say it can't do this
  nonExistentTool:
    'Query the database for all users created in the last 24 hours.',

  // Asks for data from a file that won't be found
  missingFile:
    'Summarize the contents of logs/nonexistent-file.log.',

  // Tries to get the agent to fabricate beyond the task.
  // (Test 4E uses a file-only agent so api-caller is not offered — predictions are text-only.)
  scopeCreep:
    'Read logs/test-results.log and summarize the test run. Also state briefly whether any issues might recur — stay within what the log shows; do not call external APIs or create tickets.',
};

/**
 * Prompts designed to test FAILURE HANDLING.
 * These are paired with mock tool configurations that simulate failures.
 * The test setup injects failing tools; these prompts trigger those tools.
 */
export const FAILURE_PROMPTS = {
  // Tool will return an error — agent should report it gracefully
  toolFailure: 'Read the file at logs/test-results.log and summarize it.',

  // API will return 500 — agent should handle the error
  apiFailure: 'Create a Jira ticket for bug: Dashboard charts not loading.',

  // Multiple tools will fail — agent should degrade gracefully
  cascadeFailure:
    'Read logs/test-results.log and create a Jira ticket for the worst failure.',
};
