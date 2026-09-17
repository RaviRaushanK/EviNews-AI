/**
 * Phase 3 read-only verification tool.
 *
 * Prints the current clustering state so the pipeline can be inspected without
 * a running web server or one-off ad-hoc scripts:
 *   - articles grouped by processing_status
 *   - events with their member count
 *   - event_articles links and stored cluster_score values
 *   - pairwise cosine similarity distribution of the still 'embedded' articles
 *
 * It never writes to the database and never calls Gemini.
 *
 * Usage:
 *   node scripts/verify-clusters.js
 */

require('dotenv').config();

const models = require('../models');
const { Op } = require('sequelize');
const { cosineSimilarity } = require('../utils/similarity');
const similarityService = require('../services/similarityService');
const embeddingsConfig = require('../config/embeddings');

async function main() {
  const { Article, ArticleEmbedding, Event, EventArticle, Source, sequelize } = models;

  if (!Article || !Event) {
    console.error('Database models are not initialized. Check your .env DB settings.');
    process.exitCode = 1;
    return;
  }

  // 1. Article pipeline statuses.
  const articles = await Article.findAll({ attributes: ['id', 'title', 'processing_status', 'published_at', 'fetched_at'] });
  const byStatus = {};
  for (const article of articles) {
    byStatus[article.processing_status] = (byStatus[article.processing_status] || 0) + 1;
  }
  console.log('ARTICLE_STATUS_COUNTS=' + JSON.stringify(byStatus));

  // 2. Events.
  const events = await Event.findAll({ order: [['createdAt', 'ASC']] });
  console.log('EVENT_COUNT=' + events.length);
  console.log('RESOLVED_EVENT_COUNT=' + events.filter((event) => event.status === 'resolved').length);

  for (const event of events) {
    const links = await EventArticle.findAll({ where: { event_id: event.id }, order: [['cluster_score', 'DESC']] });
    console.log('EVENT ' + JSON.stringify({
      id: event.id,
      title: event.title,
      status: event.status,
      event_date: event.event_date,
      description: event.description,
      member_count: links.length
    }));
    for (const link of links) {
      const member = articles.find((article) => article.id === link.article_id);
      const memberEmbedding = member ? await ArticleEmbedding.findOne({ where: { article_id: member.id } }) : null;
      console.log('  LINK article_id=' + link.article_id + ' cluster_score=' + link.cluster_score + ' title=' + (member ? JSON.stringify(member.title) : 'null'));
      if (memberEmbedding) {
        link._vector = memberEmbedding.vector;
      }
    }

    // Intra-event member similarity (read-only, explains stored cluster_score values).
    const memberVectors = links.map((link) => link._vector).filter(Array.isArray);
    for (let i = 0; i < memberVectors.length; i += 1) {
      for (let j = i + 1; j < memberVectors.length; j += 1) {
        console.log('  EVENT_SIM ' + links[i].article_id + ' vs ' + links[j].article_id + ' = ' + Number(cosineSimilarity(memberVectors[i], memberVectors[j]).toFixed(4)));
      }
    }
  }

  // 3. Similarity distribution among still-embedded articles.
  const embedded = await Article.findAll({ where: { processing_status: 'embedded' } });
  const vectors = [];
  for (const article of embedded) {
    const embedding = await ArticleEmbedding.findOne({ where: { article_id: article.id } });
    if (embedding && Array.isArray(embedding.vector) && embedding.vector.length > 0) {
      vectors.push({ id: article.id, vector: embedding.vector, dimensions: embedding.dimensions, model: embedding.model });
    }
  }
  console.log('EMBEDDED_VECTOR_COUNT=' + vectors.length);
  console.log('THRESHOLD_ARTICLE=' + embeddingsConfig.clustering.articleThreshold);
  console.log('THRESHOLD_EVENT=' + embeddingsConfig.clustering.eventThreshold);
  console.log('MIN_CLUSTER_SIZE=' + embeddingsConfig.clustering.minClusterSize);
  if (vectors.length > 0) {
    console.log('EMBEDDING_MODEL=' + vectors[0].model);
    console.log('EMBEDDING_DIMENSIONS=' + vectors[0].dimensions);
  }

  // 4. Existing-event attachment check (read-only): how close is each still-embedded
  //    article to the centroid of each active/monitoring event?
  //    Mirrors eventService.loadEventCentroids() + attachToExistingEvent() math.
  const eventCentroids = [];
  for (const event of events) {
    if (event.status !== 'active' && event.status !== 'monitoring') {
      continue;
    }
    const eventLinks = await EventArticle.findAll({ where: { event_id: event.id } });
    const memberVectors = [];
    for (const link of eventLinks) {
      const embedding = await ArticleEmbedding.findOne({ where: { article_id: link.article_id } });
      if (embedding && Array.isArray(embedding.vector) && embedding.vector.length > 0) {
        memberVectors.push(embedding.vector);
      }
    }
    const center = similarityService.centroid(memberVectors);
    if (center) {
      eventCentroids.push({ event, center, memberVectorCount: memberVectors.length });
    }
  }
  console.log('EVENT_CENTROIDS=' + eventCentroids.length);
  for (const { event, center, memberVectorCount } of eventCentroids) {
    console.log('  CENTROID event_id=' + event.id + ' status=' + event.status + ' member_vectors=' + memberVectorCount);
    for (const entry of vectors) {
      const score = cosineSimilarity(entry.vector, center);
      console.log(
        '    ARTICLE_CENTROID_SIM article_id=' + entry.id +
        ' sim=' + Number(score.toFixed(6)) +
        ' attach_threshold=' + embeddingsConfig.clustering.eventThreshold +
        ' would_attach=' + (score >= embeddingsConfig.clustering.eventThreshold)
      );
    }
  }

  let comparisons = 0;
  const similarities = [];
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      const score = cosineSimilarity(vectors[i].vector, vectors[j].vector);
      comparisons += 1;
      similarities.push({ a: vectors[i].id, b: vectors[j].id, score: Number(score.toFixed(4)) });
    }
  }
  similarities.sort((x, y) => y.score - x.score);
  console.log('PAIRWISE_COMPARISONS=' + comparisons);
  for (const pair of similarities) {
    console.log('  SIM ' + pair.score + '  ' + pair.a + '  ' + pair.b);
  }
  if (vectors.length > 1) {
    const scores = similarities.map((pair) => pair.score);
    console.log('SIM_MAX=' + Math.max(...scores) + ' SIM_MIN=' + Math.min(...scores));
  }

  // 5. Most recently collected articles (read-only), so a collection run can be
  //    verified without ad-hoc scripts. Newest first.
  const recentCollected = await Article.findAll({
    where: { processing_status: { [Op.in]: ['collected', 'cleaned'] } },
    order: [['fetched_at', 'DESC'], ['id', 'ASC']],
    limit: 100,
    include: [{ model: Source, attributes: ['name'], required: false }]
  });
  console.log('RECENT_COLLECTED_COUNT=' + recentCollected.length);
  for (const article of recentCollected) {
    console.log('  COLLECTED id=' + article.id +
      ' fetched_at=' + (article.fetched_at ? article.fetched_at.toISOString() : 'null') +
      ' source=' + JSON.stringify(article.Source ? article.Source.name : null) +
      ' title=' + JSON.stringify((article.title || '').slice(0, 110)));
  }

  if (sequelize) {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error('VERIFY_FAILED: ' + (error && error.message));
  process.exitCode = 1;
});
