require('dotenv').config();

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = Object.freeze({
  provider: 'gemini',
  model: process.env.GEMINI_SUMMARY_MODEL || '',
  promptVersion: process.env.SUMMARY_PROMPT_VERSION || 'phase7-v2',
  contractVersion: process.env.SUMMARY_CONTRACT_VERSION || 'phase7-summary-v2',
  maxContextBytes: positive(process.env.SUMMARY_MAX_CONTEXT_BYTES, 64000),
  maxClaims: positive(process.env.SUMMARY_MAX_CLAIMS, 50),
  maxEvidence: positive(process.env.SUMMARY_MAX_EVIDENCE, 100),
  maxContradictions: positive(process.env.SUMMARY_MAX_CONTRADICTIONS, 100),
  maxStatements: 30,
  maxStatementChars: 2000,
  timeoutMs: positive(process.env.SUMMARY_TIMEOUT_MS, 20000),
  retry: Object.freeze({ maxAttempts: 1, retryTimeouts: false }),
  summaryStatuses: Object.freeze(['pending', 'verified', 'needs_review']),
  generationStatuses: Object.freeze(['pending', 'succeeded', 'failed']),
  groundingStatuses: Object.freeze(['supported', 'partially_supported', 'conflicting', 'unsupported', 'needs_review'])
});
