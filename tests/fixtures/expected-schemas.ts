/**
 * tests/fixtures/expected-schemas.ts
 * 
 * JSON SCHEMA CONTRACTS
 * 
 * These schemas define the STRUCTURE of valid agent outputs.
 * They complement the BehaviorContracts (which check semantics).
 * 
 * SCHEMA vs CONTRACT:
 * - Schema: "Does the output have the right fields and types?"
 * - Contract: "Does the output express the right intent?"
 * 
 * Both are needed. An output can have perfect structure but
 * wrong content (schema passes, contract fails). Or it can
 * express the right intent but in malformed JSON (contract
 * passes, schema fails).
 * 
 * THESE SCHEMAS USE JSON SCHEMA DRAFT-07.
 * They're designed to work with the `ajv` library.
 * 
 * HOW TO ADD NEW SCHEMAS:
 * 1. Define what fields the output MUST have
 * 2. Define the allowed types for each field
 * 3. Add enum constraints where the value set is known
 * 4. Export it with a clear, descriptive name
 */

/**
 * Base schema that all agent outputs must conform to.
 * Every valid output has these five fields.
 */
export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['taskType', 'result', 'toolsUsed', 'confidence', 'summary'],
  properties: {
    taskType: {
      type: 'string',
      enum: ['summarization', 'api_call', 'file_read', 'multi_step', 'unknown'],
      description: 'Classification of the task the agent performed',
    },
    result: {
      // `result` can be anything — string, object, array.
      // The shape depends on the task type.
      description: 'The actual payload of the agent\'s work',
    },
    toolsUsed: {
      type: 'array',
      items: { type: 'string' },
      description: 'List of tool names the agent used',
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
      description: 'Agent\'s self-reported confidence in the result',
    },
    summary: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable summary of what was done',
    },
  },
  additionalProperties: true,  // Allow extra fields without failing
};

/**
 * Schema for summarization task outputs.
 * The `result` field should be a string or an object with summary details.
 */
export const SUMMARIZATION_OUTPUT_SCHEMA = {
  ...AGENT_OUTPUT_SCHEMA,
  properties: {
    ...AGENT_OUTPUT_SCHEMA.properties,
    taskType: {
      type: 'string',
      enum: ['summarization', 'file_read'],  // Either classification is acceptable
    },
    result: {
      oneOf: [
        { type: 'string', minLength: 10 },
        {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            sourceFile: { type: 'string' },
          },
        },
      ],
    },
  },
};

/**
 * Schema for API action outputs.
 * The `result` field should contain the API response details.
 */
export const API_ACTION_OUTPUT_SCHEMA = {
  ...AGENT_OUTPUT_SCHEMA,
  properties: {
    ...AGENT_OUTPUT_SCHEMA.properties,
    taskType: {
      type: 'string',
      enum: ['api_call'],
    },
    result: {
      type: 'object',
      description: 'API response data — status, body, or confirmation',
    },
  },
};

/**
 * Schema for multi-step task outputs.
 * toolsUsed must have at least 2 entries.
 */
export const MULTI_STEP_OUTPUT_SCHEMA = {
  ...AGENT_OUTPUT_SCHEMA,
  properties: {
    ...AGENT_OUTPUT_SCHEMA.properties,
    taskType: {
      type: 'string',
      enum: ['multi_step'],
    },
    toolsUsed: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
    },
  },
};

/**
 * Schema for error/failure outputs.
 * Used in retry-behavior tests. The structure should still
 * be valid even when the task fails.
 */
export const FAILURE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['taskType', 'summary'],
  properties: {
    taskType: {
      type: 'string',
    },
    summary: {
      type: 'string',
      minLength: 1,
    },
    confidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
  },
};
