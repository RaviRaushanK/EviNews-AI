/**
 * Gemini embedding service (Phase 3).
 * Only place in the codebase that calls the Google GenAI SDK.
 * Uses gemini-embedding-001 with taskType CLUSTERING and 768 dimensions.
 */

const { GoogleGenAI } = require('@google/genai');
const embeddingsConfig = require('../config/embeddings');
const { normalizeVector } = require('../utils/similarity');

const TASK_TYPE = 'CLUSTERING';
const EXPECTED_DIMENSIONS = 768;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.code = 'GEMINI_KEY_MISSING';
    throw error;
  }
  return new GoogleGenAI({ apiKey });
}

function extractValues(response) {
  if (!response || !response.embeddings || !Array.isArray(response.embeddings)) {
    return null;
  }
  const first = response.embeddings[0];
  if (first && Array.isArray(first.values)) {
    return first.values;
  }
  // Some SDK shapes nest under embeddings[].embedding.values
  if (first && first.embedding && Array.isArray(first.embedding.values)) {
    return first.embedding.values;
  }
  return null;
}

function validateEmbedding(values) {
  if (!Array.isArray(values) || values.length === 0) {
    const error = new Error('Gemini returned an empty embedding');
    error.code = 'EMBEDDING_VALIDATION';
    throw error;
  }
  if (values.length !== EXPECTED_DIMENSIONS) {
    const error = new Error(`Unexpected embedding dimensions: got ${values.length}, expected ${EXPECTED_DIMENSIONS}`);
    error.code = 'EMBEDDING_VALIDATION';
    throw error;
  }
  const allFinite = values.every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!allFinite) {
    const error = new Error('Gemini returned non-numeric embedding values');
    error.code = 'EMBEDDING_VALIDATION';
    throw error;
  }
  return values;
}

function classifyError(error) {
  if (error && error.code) {
    return error;
  }
  const status = error && (error.status || error.statusCode || (error.response && error.response.status));
  const message = (error && error.message ? String(error.message) : 'Gemini embedding request failed').slice(0, 500);
  const mapped = new Error(message);
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(message)) {
    mapped.code = 'GEMINI_AUTH';
  } else if (status === 400) {
    mapped.code = 'GEMINI_BAD_REQUEST';
  } else if (status === 401 || status === 403) {
    mapped.code = 'GEMINI_AUTH';
  } else if (status === 429) {
    mapped.code = 'GEMINI_RATE_LIMIT';
  } else if (status >= 500 && status < 600) {
    mapped.code = 'GEMINI_SERVER';
  } else if (error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout/i.test(message))) {
    mapped.code = 'GEMINI_TIMEOUT';
  } else {
    mapped.code = 'GEMINI_ERROR';
  }
  mapped.status = status;
  return mapped;
}

function isRetryable(error) {
  return error && (error.code === 'GEMINI_RATE_LIMIT' || error.code === 'GEMINI_SERVER' || error.code === 'GEMINI_TIMEOUT');
}

/**
 * Generates one normalized embedding vector for the given text.
 * Never logs API keys or provider secrets.
 */
async function generateEmbedding(text, options = {}) {
  const model = options.model || process.env.GEMINI_EMBEDDING_MODEL || embeddingsConfig.gemini.embeddingModel;
  const dimensions = options.dimensions || EXPECTED_DIMENSIONS;
  const retryDelayMs = options.retryDelayMs || embeddingsConfig.gemini.retryDelayMs;
  const timeoutMs = options.timeoutMs || embeddingsConfig.gemini.timeoutMs;

  if (!text || String(text).trim().length === 0) {
    const error = new Error('Embedding text is empty');
    error.code = 'EMBEDDING_EMPTY';
    throw error;
  }

  const ai = getClient();
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const request = {
        model,
        contents: String(text),
        config: {
          taskType: TASK_TYPE,
          outputDimensionality: dimensions
        }
      };

      let response;
      if (timeoutMs && timeoutMs > 0) {
        response = await Promise.race([
          ai.models.embedContent(request),
          new Promise((_, reject) => {
            setTimeout(() => {
              const timeoutError = new Error(`Gemini embedding timed out after ${timeoutMs}ms`);
              timeoutError.code = 'GEMINI_TIMEOUT';
              reject(timeoutError);
            }, timeoutMs);
          })
        ]);
      } else {
        response = await ai.models.embedContent(request);
      }

      const values = validateEmbedding(extractValues(response));
      // gemini-embedding-001 with reduced dimensions needs manual normalization.
      const normalized = normalizeVector(values) || values;
      return {
        values: normalized,
        model,
        dimensions: normalized.length,
        taskType: TASK_TYPE
      };
    } catch (error) {
      lastError = classifyError(error);
      if (lastError.code === 'GEMINI_KEY_MISSING' || lastError.code === 'GEMINI_AUTH' || lastError.code === 'GEMINI_BAD_REQUEST') {
        throw lastError;
      }
      if (attempt < 3 && isRetryable(lastError)) {
        await sleep(retryDelayMs);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

module.exports = {
  TASK_TYPE,
  EXPECTED_DIMENSIONS,
  generateEmbedding
};
