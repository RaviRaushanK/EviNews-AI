/**
 * Gemini generation client service (Phase 4).
 * Reusable client factory + error classification + bounded retry/timeout.
 *
 * This file is the ONLY new place that calls the Google GenAI SDK for text
 * generation. embeddingService.js is intentionally left untouched.
 * Never logs API keys or provider secrets.
 */

const { GoogleGenAI } = require('@google/genai');
const claimsConfig = require('../config/claims');

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getApiKey() {
  return process.env.GEMINI_API_KEY || '';
}

/**
 * Creates a Gemini client. Throws GEMINI_KEY_MISSING when no key is configured.
 */
function getClient() {
  const apiKey = getApiKey();
  if (!apiKey) {
    const error = new Error('GEMINI_API_KEY is not configured');
    error.code = 'GEMINI_KEY_MISSING';
    throw error;
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Resolves the generation model. Fails clearly instead of guessing a name.
 */
function resolveClaimModel(options = {}) {
  const model = options.model || claimsConfig.gemini.claimModel;
  if (!model) {
    const error = new Error('GEMINI_CLAIM_MODEL is not configured (no generation model selected)');
    error.code = 'CLAIM_MODEL_NOT_CONFIGURED';
    throw error;
  }
  return model;
}

function classifyError(error) {
  if (error && error.code) {
    return error;
  }
  const status = error && (error.status || error.statusCode || (error.response && error.response.status));
  const message = (error && error.message ? String(error.message) : 'Gemini request failed').slice(0, 500);
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
  } else if (error && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || /timeout|timed out/i.test(message))) {
    mapped.code = 'GEMINI_TIMEOUT';
  } else {
    mapped.code = 'GEMINI_ERROR';
  }
  mapped.status = status;
  return mapped;
}

function isRetryable(error) {
  return Boolean(error) && (
    error.code === 'GEMINI_RATE_LIMIT' ||
    error.code === 'GEMINI_SERVER' ||
    error.code === 'GEMINI_TIMEOUT'
  );
}

function isFatal(error) {
  return Boolean(error) && (
    error.code === 'GEMINI_KEY_MISSING' ||
    error.code === 'CLAIM_MODEL_NOT_CONFIGURED' ||
    error.code === 'GEMINI_AUTH' ||
    error.code === 'GEMINI_BAD_REQUEST'
  );
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
        timeoutError.code = 'GEMINI_TIMEOUT';
        reject(timeoutError);
      }, timeoutMs);
    })
  ]);
}

/**
 * Runs one generateContent call with bounded retries and timeout handling.
 * Retries only rate-limit / server / timeout errors (max 5 attempts).
 *
 * @param {string} prompt
 * @param {object} options { model?, timeoutMs?, retryDelayMs?, maxAttempts? }
 * @returns {Promise<{ text: string, model: string, attempts: number }>}
 */
async function generateText(prompt, options = {}) {
  if (!prompt || String(prompt).trim().length === 0) {
    const error = new Error('Prompt text is empty');
    error.code = 'GEMINI_BAD_REQUEST';
    throw error;
  }

  const model = resolveClaimModel(options);
  const timeoutMs = options.timeoutMs || claimsConfig.gemini.timeoutMs;
  const retryDelayMs = options.retryDelayMs || claimsConfig.gemini.retryDelayMs;
  const maxAttempts = options.maxAttempts || 5;

  const ai = getClient();
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents: String(prompt)
        }),
        timeoutMs,
        'Gemini generation'
      );

      const text = response && (response.text || (response.candidates && response.candidates[0] && response.candidates[0].content && Array.isArray(response.candidates[0].content.parts)
        ? response.candidates[0].content.parts.map((part) => part && part.text ? part.text : '').join('')
        : ''));
      if (!text || String(text).trim().length === 0) {
        const emptyError = new Error('Gemini returned an empty response body');
        emptyError.code = 'GEMINI_EMPTY_RESPONSE';
        throw emptyError;
      }
      return { text: String(text), model, attempts: attempt };
    } catch (error) {
      lastError = classifyError(error);
      if (isFatal(lastError)) {
        throw lastError;
      }
      if (attempt < maxAttempts && isRetryable(lastError)) {
        const backoffMs = Math.min(retryDelayMs * (2 ** (attempt - 1)), 30000);
        await sleep(backoffMs);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

module.exports = {
  getClient,
  resolveClaimModel,
  classifyError,
  isRetryable,
  isFatal,
  generateText
};
