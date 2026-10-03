/**
 * Claim controller (Phase 4).
 * Thin HTTP adapter: parses/validates input, calls services, returns JSON.
 * No Gemini logic. No claim business logic.
 */

const claimProcessingService = require('../services/claimProcessingService');
const claimQueryService = require('../services/claimQueryService');
const claimsConfig = require('../config/claims');

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 1), 200);
}

function parseArticleIds(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const ids = value
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  return ids.length > 0 ? ids : undefined;
}

async function extractClaims(req, res, next) {
  try {
    const limit = parseLimit(req.body && req.body.limit, claimsConfig.extraction.maxArticlesPerRun);
    const articleIds = parseArticleIds(req.body && req.body.articleIds);
    const result = await claimProcessingService.processClaims({ limit, articleIds });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return next(error);
  }
}

async function extractClaimsForArticle(req, res, next) {
  try {
    const articleId = typeof req.params.articleId === 'string' ? req.params.articleId.trim() : '';
    if (!articleId) {
      return res.status(400).json({ ok: false, error: 'articleId is required' });
    }
    const result = await claimProcessingService.processClaims({ articleIds: [articleId] });
    return res.status(200).json({ ok: true, articleId, result });
  } catch (error) {
    return next(error);
  }
}

async function listEventClaims(req, res, next) {
  try {
    const data = await claimQueryService.getClaimsForEvent(req.params.id);
    if (!data) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    return res.status(200).json({ ok: true, count: data.claims.length, ...data });
  } catch (error) {
    return next(error);
  }
}

async function listArticleClaims(req, res, next) {
  try {
    const data = await claimQueryService.getClaimsForArticle(req.params.id);
    if (!data) {
      return res.status(404).json({ ok: false, error: 'Article not found' });
    }
    return res.status(200).json({ ok: true, count: data.claims.length, ...data });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  extractClaims,
  extractClaimsForArticle,
  listEventClaims,
  listArticleClaims
};