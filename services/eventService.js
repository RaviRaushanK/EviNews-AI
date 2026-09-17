/**
 * Event service (Phase 3).
 * Creates events from clusters and attaches new articles to existing events
 * by comparing against event centroids.
 */

const { Article, Event, EventArticle, ArticleEmbedding } = require('../models');
const similarityService = require('./similarityService');

function pickRepresentative(articles) {
  const ordered = [...articles].sort((a, b) => {
    const timeA = a.published_at ? new Date(a.published_at).getTime() : (a.fetched_at ? new Date(a.fetched_at).getTime() : 0);
    const timeB = b.published_at ? new Date(b.published_at).getTime() : (b.fetched_at ? new Date(b.fetched_at).getTime() : 0);
    return timeA - timeB;
  });
  return ordered[0];
}

function buildEventDescription(memberArticles, threshold) {
  const sources = [...new Set(memberArticles.map((article) => article.sourceName).filter(Boolean))];
  const representative = pickRepresentative(memberArticles);
  const sourcePart = sources.length > 0 ? ` Sources: ${sources.slice(0, 10).join(', ')}.` : '';
  return `${memberArticles.length} articles clustered (threshold ${threshold}). Representative: ${representative.title}.${sourcePart}`;
}

async function loadEventCentroids() {
  if (!Event || !ArticleEmbedding) {
    return [];
  }
  const events = await Event.findAll({
    where: { status: ['active', 'monitoring'] },
    order: [['createdAt', 'ASC']]
  });
  const centroids = [];
  for (const event of events) {
    const links = await EventArticle.findAll({ where: { event_id: event.id } });
    const articleIds = links.map((link) => link.article_id);
    if (articleIds.length === 0) {
      continue;
    }
    const embeddings = await ArticleEmbedding.findAll({ where: { article_id: articleIds } });
    const vectors = embeddings.map((row) => row.vector).filter(Array.isArray);
    const center = similarityService.centroid(vectors);
    if (center) {
      centroids.push({ event, center });
    }
  }
  return centroids;
}

async function attachToExistingEvent(articleId, vector, centroids, threshold) {
  let best = null;
  let bestScore = 0;
  for (const { event, center } of centroids) {
    const score = similarityService.similarity(vector, center);
    if (score > bestScore) {
      bestScore = score;
      best = event;
    }
  }
  if (best && bestScore >= threshold) {
    await EventArticle.findOrCreate({
      where: { event_id: best.id, article_id: articleId },
      defaults: { event_id: best.id, article_id: articleId, cluster_score: bestScore }
    });
    if (Article) {
      await Article.update({ processing_status: 'clustered', processing_error: null }, { where: { id: articleId } });
    }
    return { attached: true, event: best, score: bestScore };
  }
  return { attached: false, score: bestScore };
}

async function createEventFromCluster(memberArticles, scores, threshold) {
  const representative = pickRepresentative(memberArticles);
  const title = String(representative.title || 'Untitled event').slice(0, 500);
  const event = await Event.create({
    title,
    description: buildEventDescription(memberArticles, threshold),
    status: 'active',
    event_date: representative.published_at || representative.fetched_at || null
  });

  for (const article of memberArticles) {
    // Use the REAL computed similarity from clustering. Never synthesize 1.0.
    const rawScore = scores ? scores[article.id] : null;
    const clusterScore = typeof rawScore === 'number' && Number.isFinite(rawScore) ? rawScore : null;
    await EventArticle.findOrCreate({
      where: { event_id: event.id, article_id: article.id },
      defaults: { event_id: event.id, article_id: article.id, cluster_score: clusterScore }
    });
    await Article.update({ processing_status: 'clustered', processing_error: null }, { where: { id: article.id } });
  }

  return event;
}

module.exports = {
  loadEventCentroids,
  attachToExistingEvent,
  createEventFromCluster
};
