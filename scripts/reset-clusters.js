/**
 * Phase 3 development tool: safely remove ONE test event (and only its links)
 * so the clustering run can be repeated without leaving stale/duplicate rows.
 *
 * It never touches sources, articles content, embeddings, or other events.
 * Articles are set back to processing_status='embedded' ONLY when they are not
 * linked to any other event afterwards.
 *
 * Usage:
 *   node scripts/reset-clusters.js <eventId>
 */

require('dotenv').config();

const models = require('../models');

async function main() {
  const { Article, Event, EventArticle, sequelize } = models;
  const eventId = process.argv[2];

  if (!Event || !EventArticle || !Article) {
    console.error('Database models are not initialized. Check your .env DB settings.');
    process.exitCode = 1;
    return;
  }

  if (!eventId) {
    console.error('Usage: node scripts/reset-clusters.js <eventId>');
    process.exitCode = 1;
    return;
  }

  const event = await Event.findByPk(eventId);
  if (!event) {
    console.error('EVENT_NOT_FOUND=' + eventId);
    process.exitCode = 1;
    if (sequelize) {
      await sequelize.close();
    }
    return;
  }

  console.log('RESET_EVENT=' + JSON.stringify({ id: event.id, title: event.title, status: event.status }));

  const links = await EventArticle.findAll({ where: { event_id: event.id } });
  const articleIds = links.map((link) => link.article_id);
  console.log('EVENT_LINK_COUNT_BEFORE=' + links.length);
  for (const link of links) {
    console.log('  LINK article_id=' + link.article_id + ' cluster_score=' + link.cluster_score);
  }

  const deletedLinks = await EventArticle.destroy({ where: { event_id: event.id } });
  console.log('DELETED_LINKS=' + deletedLinks);

  await event.destroy();
  console.log('DELETED_EVENT=' + event.id);

  let resetCount = 0;
  for (const articleId of articleIds) {
    const remaining = await EventArticle.count({ where: { article_id: articleId } });
    if (remaining > 0) {
      console.log('  KEPT_CLUSTERED article_id=' + articleId + ' (still linked to ' + remaining + ' other event(s))');
      continue;
    }
    const [updated] = await Article.update(
      { processing_status: 'embedded', processing_error: null },
      { where: { id: articleId, processing_status: 'clustered' } }
    );
    if (updated > 0) {
      resetCount += updated;
      console.log('  RESET_TO_EMBEDDED article_id=' + articleId);
    }
  }
  console.log('RESET_ARTICLES=' + resetCount);

  if (sequelize) {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error('RESET_FAILED: ' + (error && error.message));
  process.exitCode = 1;
});