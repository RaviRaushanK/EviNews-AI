/**
 * Collection controller.
 * Thin HTTP adapter for Phase 2 collection endpoints.
 */

const collectionService = require('../services/collectionService');
const newsConfig = require('../config/newsSources');

const ALLOWED_CATEGORIES = ['business', 'entertainment', 'general', 'health', 'science', 'sports', 'technology'];
const ALLOWED_SORT_VALUES = ['relevancy', 'popularity', 'publishedAt'];

function parsePageSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return newsConfig.newsApi.pageSize;
  }
  return Math.min(Math.max(parsed, 1), 100);
}

function parseFeedUrls(body) {
  if (!body || body.feedUrls === undefined) {
    return null;
  }
  if (!Array.isArray(body.feedUrls)) {
    return { error: 'feedUrls must be an array of RSS URLs' };
  }
  const urls = body.feedUrls.map((value) => String(value).trim()).filter(Boolean);
  if (urls.length > 20) {
    return { error: 'A maximum of 20 RSS feeds is allowed per request' };
  }
  return { urls };
}

async function collectNewsApi(req, res, next) {
  try {
    const mode = req.body && req.body.mode === 'everything' ? 'everything' : 'top-headlines';
    const q = req.body && typeof req.body.q === 'string' ? req.body.q.trim().slice(0, 200) : '';
    const category = req.body && typeof req.body.category === 'string' ? req.body.category.trim().toLowerCase() : undefined;

    if (category && !ALLOWED_CATEGORIES.includes(category)) {
      return res.status(400).json({ ok: false, error: 'Invalid category' });
    }
    if (mode === 'everything' && !q) {
      return res.status(400).json({ ok: false, error: 'A search query (q) is required for mode=everything' });
    }

    const sortBy = req.body && typeof req.body.sortBy === 'string' ? req.body.sortBy.trim() : undefined;
    if (sortBy && !ALLOWED_SORT_VALUES.includes(sortBy)) {
      return res.status(400).json({ ok: false, error: 'Invalid sortBy value' });
    }

    const result = await collectionService.collectFromNewsApi({
      mode,
      q: q || undefined,
      category,
      country: typeof req.body.country === 'string' ? req.body.country.trim().slice(0, 10) : undefined,
      language: typeof req.body.language === 'string' ? req.body.language.trim().slice(0, 10) : undefined,
      pageSize: parsePageSize(req.body && req.body.pageSize),
      sortBy,
      from: req.body && req.body.from,
      to: req.body && req.body.to
    });

    const status = result.inserted > 0 ? 200 : 502;
    return res.status(status).json({ ok: result.failed === 0 || result.inserted > 0, mode, result });
  } catch (error) {
    return next(error);
  }
}

async function collectRss(req, res, next) {
  try {
    const parsed = parseFeedUrls(req.body);
    if (parsed && parsed.error) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const feedUrls = parsed ? parsed.urls : null;
    const result = await collectionService.collectFromRss(
      feedUrls && feedUrls.length > 0 ? feedUrls : undefined
    );
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return next(error);
  }
}

async function recentArticles(req, res, next) {
  try {
    const articles = await collectionService.getRecentArticles(req.query.limit);
    return res.status(200).json({ ok: true, count: articles.length, articles });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  collectNewsApi,
  collectRss,
  recentArticles
};
