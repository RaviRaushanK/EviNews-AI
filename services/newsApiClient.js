/**
 * NewsAPI HTTP client.
 * Transport layer only: fetches raw items and reports provider errors.
 */

const axios = require('axios');
const newsConfig = require('../config/newsSources');

function requireApiKey() {
  const apiKey = process.env.NEWS_API_KEY;
  if (!apiKey) {
    const error = new Error('NEWS_API_KEY is not configured');
    error.code = 'NEWS_API_KEY_MISSING';
    throw error;
  }
  return apiKey;
}

function createClient(timeoutMs, userAgent) {
  return axios.create({
    baseURL: newsConfig.newsApi.baseUrl,
    timeout: timeoutMs || newsConfig.collection.timeoutMs,
    headers: {
      'User-Agent': userAgent || newsConfig.collection.userAgent,
      'X-Api-Key': requireApiKey()
    }
  });
}

function normalizeError(error) {
  if (error && error.code === 'NEWS_API_KEY_MISSING') {
    return { ok: false, error: 'NEWS_API_KEY is not configured' };
  }
  if (error && error.response) {
    return {
      ok: false,
      error: `NewsAPI responded with status ${error.response.status}`,
      status: error.response.status
    };
  }
  if (error && error.code === 'ECONNABORTED') {
    return { ok: false, error: 'NewsAPI request timed out' };
  }
  return { ok: false, error: (error && error.message) || 'NewsAPI request failed' };
}

async function fetchTopHeadlines({ q, category, country, pageSize } = {}) {
  try {
    const client = createClient();
    const response = await client.get('/top-headlines', {
      params: {
        q: q || undefined,
        category: category || undefined,
        country: country || newsConfig.newsApi.country,
        pageSize: pageSize || newsConfig.newsApi.pageSize
      }
    });
    if (!response.data || response.data.status !== 'ok') {
      return { ok: false, error: 'NewsAPI returned an unsuccessful response' };
    }
    return { ok: true, items: Array.isArray(response.data.articles) ? response.data.articles : [] };
  } catch (error) {
    return normalizeError(error);
  }
}

async function fetchEverything({ q, from, to, sortBy, language, pageSize } = {}) {
  try {
    const client = createClient();
    const response = await client.get('/everything', {
      params: {
        q,
        from: from || undefined,
        to: to || undefined,
        sortBy: sortBy || undefined,
        language: language || newsConfig.newsApi.language,
        pageSize: pageSize || newsConfig.newsApi.pageSize
      }
    });
    if (!response.data || response.data.status !== 'ok') {
      return { ok: false, error: 'NewsAPI returned an unsuccessful response' };
    }
    return { ok: true, items: Array.isArray(response.data.articles) ? response.data.articles : [] };
  } catch (error) {
    return normalizeError(error);
  }
}

module.exports = {
  fetchTopHeadlines,
  fetchEverything
};
