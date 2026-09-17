/**
 * Clustering orchestration service.
 * Loads embedded articles, matches against existing event centroids,
 * clusters the remainder, and creates new events for multi-article clusters.
 */

const { Op } = require('sequelize');
const { Article, ArticleEmbedding, Source, EventArticle } = require('../models');
const clusteringService = require('./clusteringService');
const eventService = require('./eventService');
const similarityService = require('./similarityService');
const embeddingsConfig = require('../config/embeddings');

function newResult() {
  return {
    candidates: 0,
    attached_to_existing: 0,
    clusters: 0,
    singletons: 0,
    events_created: 0,
    failed: 0,
    errors: []
  };
}

function recordError(result, message) {
  result.failed += 1;
  if (result.errors.length < 10) {
    result.errors.push(String(message || 'Clustering failed').slice(0, 500));
  }
}

async function fetchEmbeddedArticles(limit) {
  const safeLimit = Math.min(Math.max(Number(limit) || embeddingsConfig.clustering.maxArticlesPerRun, 1), 200);
  const articles = await Article.findAll({
    where: { processing_status: 'embedded' },
    order: [['fetched_at', 'ASC'], ['id', 'ASC']],
    limit: safeLimit,
    include: [{ model: Source, attributes: ['name'], required: false }]
  });
  const rows = [];
  for (const article of articles) {
    const embedding = await ArticleEmbedding.findOne({ where: { article_id: article.id } });
    if (embedding && Array.isArray(embedding.vector) && embedding.vector.length > 0) {
      rows.push({
        article,
        article_id: article.id,
        vector: embedding.vector,
        fetched_at: article.fetched_at
      });
    }
  }
  return rows;
}

async function clusterArticles(options = {}) {
  const result = newResult();
  const threshold = typeof options.threshold === 'number' ? options.threshold : embeddingsConfig.clustering.articleThreshold;
  const eventThreshold = typeof options.eventThreshold === 'number' ? options.eventThreshold : embeddingsConfig.clustering.eventThreshold;
  const minClusterSize = options.minClusterSize || embeddingsConfig.clustering.minClusterSize;

  if (!Article || !ArticleEmbedding) {
    recordError(result, 'Database models are not initialized');
    return result;
  }

  const rows = await fetchEmbeddedArticles(options.limit || embeddingsConfig.clustering.maxArticlesPerRun);
  result.candidates = rows.length;

  if (rows.length === 0) {
    return result;
  }

  // Step 1: try attaching to existing active/monitoring events via centroids.
  const centroids = await eventService.loadEventCentroids();
  const remaining = [];
  for (const row of rows) {
    try {
      const outcome = await eventService.attachToExistingEvent(row.article_id, row.vector, centroids, eventThreshold);
      if (outcome.attached) {
        result.attached_to_existing += 1;
      } else {
        remaining.push(row);
      }
    } catch (error) {
      recordError(result, `Attach check failed for ${row.article_id}: ${error && error.message}`);
      remaining.push(row);
    }
  }

  // Step 2: cluster the remainder.
  const { clusters, singletons } = clusteringService.clusterVectors(remaining, { threshold, minClusterSize });
  result.clusters = clusters.length;
  result.singletons = singletons.length;

  // Step 3: one event per multi-article cluster.
  for (const cluster of clusters) {
    try {
      const memberArticles = cluster.memberIds.map((id) => {
        const row = remaining.find((entry) => entry.article_id === id);
        return {
          id,
          title: row.article.title,
          description: row.article.description,
          published_at: row.article.published_at,
          fetched_at: row.article.fetched_at,
          sourceName: row.article.Source ? row.article.Source.name : null
        };
      });
      await eventService.createEventFromCluster(memberArticles, cluster.scores, threshold);
      result.events_created += 1;
    } catch (error) {
      if (error && error.name === 'SequelizeUniqueConstraintError') {
        continue;
      }
      recordError(result, `Event creation failed: ${error && error.message}`);
    }
  }

  return result;
}

module.exports = {
  clusterArticles
};
