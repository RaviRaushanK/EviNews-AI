/**
 * Processing controller (Phase 3).
 * Thin HTTP adapter: validates input, calls services, returns summaries.
 */

const processingService = require('../services/processingService');
const clusteringOrchestrationService = require('../services/clusteringOrchestrationService');
const embeddingsConfig = require('../config/embeddings');
const { Article, Event, EventArticle, ArticleEmbedding } = require('../models');

function parseLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, 1), 200);
}

function parseThreshold(value, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return fallback;
  }
  return parsed;
}

async function processArticles(req, res, next) {
  try {
    const limit = parseLimit(req.body && req.body.limit, embeddingsConfig.clustering.maxArticlesPerRun);
    const result = await processingService.processArticles({ limit });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return next(error);
  }
}

async function reconcileArticles(req, res, next) {
  try {
    const limit = parseLimit(req.body && req.body.limit, embeddingsConfig.clustering.maxArticlesPerRun);
    const rawIds = req.body && req.body.articleIds;
    const articleIds = Array.isArray(rawIds)
      ? rawIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim())
      : undefined;
    const result = await processingService.reconcileEmbeddings({ limit, articleIds });
    return res.status(200).json({ ok: true, reconciled: true, result });
  } catch (error) {
    return next(error);
  }
}

async function clusterArticles(req, res, next) {
  try {
    const limit = parseLimit(req.body && req.body.limit, embeddingsConfig.clustering.maxArticlesPerRun);
    const threshold = parseThreshold(req.body && req.body.threshold, embeddingsConfig.clustering.articleThreshold);
    const eventThreshold = parseThreshold(req.body && req.body.eventThreshold, embeddingsConfig.clustering.eventThreshold);
    const result = await clusteringOrchestrationService.clusterArticles({ limit, threshold, eventThreshold });
    return res.status(200).json({ ok: true, threshold, eventThreshold, result });
  } catch (error) {
    return next(error);
  }
}

async function listEvents(req, res, next) {
  try {
    const events = await Event.findAll({ order: [['createdAt', 'DESC']], limit: 100 });
    const withCounts = [];
    for (const event of events) {
      const count = await EventArticle.count({ where: { event_id: event.id } });
      withCounts.push({ ...event.toJSON(), article_count: count });
    }
    return res.status(200).json({ ok: true, count: withCounts.length, events: withCounts });
  } catch (error) {
    return next(error);
  }
}

async function getEvent(req, res, next) {
  try {
    const event = await Event.findByPk(req.params.id);
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    const links = await EventArticle.findAll({ where: { event_id: event.id }, order: [['cluster_score', 'DESC']] });
    const articleIds = links.map((link) => link.article_id);
    const articles = articleIds.length > 0
      ? await Article.findAll({ where: { id: articleIds }, include: [{ model: ArticleEmbedding, required: false }] })
      : [];
    const scoreByArticle = {};
    for (const link of links) {
      scoreByArticle[link.article_id] = link.cluster_score;
    }
    return res.status(200).json({
      ok: true,
      event: event.toJSON(),
      members: articles.map((article) => ({ ...article.toJSON(), cluster_score: scoreByArticle[article.id] ?? null }))
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  processArticles,
  reconcileArticles,
  clusterArticles,
  listEvents,
  getEvent
};
