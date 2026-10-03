/**
 * Claim extraction configuration (Phase 4).
 * Reads environment variables and exposes safe defaults.
 *
 * IMPORTANT: geminiClaimModel has NO default. Live extraction must fail with
 * CLAIM_MODEL_NOT_CONFIGURED rather than guessing a generation model name.
 */

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFloatSafe(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  gemini: {
    claimModel: process.env.GEMINI_CLAIM_MODEL || '',
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    timeoutMs: parsePositiveInt(process.env.CLAIM_TIMEOUT_MS, 20000),
    retryDelayMs: parsePositiveInt(process.env.CLAIM_RETRY_DELAY_MS, 2000)
  },
  extraction: {
    maxArticleChars: parsePositiveInt(process.env.CLAIM_MAX_ARTICLE_CHARS, 6000),
    maxClaimsPerArticle: parsePositiveInt(process.env.CLAIM_MAX_PER_ARTICLE, 10),
    maxArticlesPerRun: parsePositiveInt(process.env.CLAIM_MAX_ARTICLES_PER_RUN, 20)
  },
  evidence: {
    minOverlap: parseFloatSafe(process.env.EVIDENCE_MIN_OVERLAP, 0.25)
  }
};