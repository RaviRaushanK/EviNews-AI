/**
 * News collection configuration.
 * Reads environment variables and exposes safe defaults.
 * No secrets are hardcoded here.
 */

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseFeedList(value) {
  if (!value || typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

module.exports = {
  newsApi: {
    baseUrl: process.env.NEWS_API_BASE_URL || 'https://newsapi.org/v2',
    pageSize: parsePositiveInt(process.env.NEWS_API_PAGE_SIZE, 20),
    country: process.env.NEWS_API_COUNTRY || 'us',
    language: process.env.NEWS_API_LANGUAGE || 'en'
  },
  rss: {
    feedUrls: parseFeedList(process.env.RSS_FEED_URLS)
  },
  collection: {
    timeoutMs: parsePositiveInt(process.env.COLLECTION_TIMEOUT_MS, 10000),
    userAgent: process.env.COLLECTION_USER_AGENT || 'EviNews-AI/1.0'
  }
};
