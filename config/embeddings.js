/**
 * Embedding + clustering configuration.
 * Reads environment variables and exposes safe defaults.
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
    apiKey: process.env.GEMINI_API_KEY || '',
    baseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
    dimensions: parsePositiveInt(process.env.EMBEDDING_DIMENSIONS, 768),
    timeoutMs: parsePositiveInt(process.env.EMBEDDING_TIMEOUT_MS, 15000),
    maxChars: parsePositiveInt(process.env.EMBEDDING_MAX_CHARS, 7000),
    batchSize: parsePositiveInt(process.env.EMBEDDING_BATCH_SIZE, 10),
    retryDelayMs: parsePositiveInt(process.env.EMBEDDING_RETRY_DELAY_MS, 2000)
  },
  clustering: {
    articleThreshold: parseFloatSafe(process.env.ARTICLE_SIMILARITY_THRESHOLD, 0.78),
    eventThreshold: parseFloatSafe(process.env.EVENT_MATCH_THRESHOLD, 0.78),
    minClusterSize: parsePositiveInt(process.env.MIN_CLUSTER_SIZE, 2),
    maxArticlesPerRun: parsePositiveInt(process.env.MAX_ARTICLES_PER_RUN, 50)
  }
};
