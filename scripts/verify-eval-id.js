#!/usr/bin/env node
/**
 * Temporary evaluation label verification helper.
 * Retrieves full article record for a given ID to confirm label eligibility.
 * Remove after label finalization.
 */
require('dotenv').config();
const models = require('../models');

const targetId = process.argv[2];
if (!targetId) {
  console.error('Usage: node verify-eval-id.js <article-id>');
  process.exit(1);
}

(async () => {
  const { Article, Source, sequelize } = models;
  const article = await Article.findByPk(targetId, {
    include: [{
      model: Source,
      attributes: ['id', 'name', 'url', 'rss_url']
    }]
  });

  if (!article) {
    console.log('NOT_FOUND');
    console.log('ID=' + targetId);
    await sequelize?.close();
    process.exit(1);
  }

  console.log('FOUND');
  console.log('ID=' + article.id);
  console.log('TITLE=' + article.title);
  console.log('URL=' + article.url);
  console.log('SOURCE_ID=' + article.source_id);
  console.log('SOURCE_NAME=' + (article.Source ? article.Source.name : 'null'));
  console.log('SOURCE_URL=' + (article.Source ? article.Source.url : 'null'));
  console.log('DESCRIPTION=' + (article.description || '(empty)'));
  console.log('CONTENT=' + (article.content || '(empty)'));
  console.log('PUBLISHED_AT=' + article.published_at);
  console.log('FETCHED_AT=' + article.fetched_at);
  console.log('PROCESSING_STATUS=' + article.processing_status);
  console.log('URL_HASH=' + article.url_hash);
  console.log('CONTENT_HASH=' + article.content_hash);

  await sequelize.close();
})();
