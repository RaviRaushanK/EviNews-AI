/**
 * Processing service.
 * Orchestrates: clean (collected->cleaned) -> embed (cleaned->embedded).
 * Respects MAX_ARTICLES_PER_RUN and skips articles that already have a
 * valid embedding for the current content_hash.
 * Explicit opt-in reconciliation for embedded/clustered rows is provided
 * via reconcileEmbeddings(); the normal processArticles() path only ever
 * selects collected/cleaned rows.
 *
 * INVARIANT for any future article text-edit path: recompute content_hash
 * with buildContentHash({ title, description, content, url }) from
 * utils/hashes and either reset processing_status to 'cleaned' (normal
 * pipeline picks it up) or explicitly invoke reconcileEmbeddings().
 * Never persist edited article text without updating content_hash — the
 * skip/stale embedding comparison depends on it.
 */

const { Op } = require('sequelize');
const { Article, ArticleEmbedding, Source } = require('../models');
const { prepareArticleForEmbedding } = require('./articleProcessingService');
const embeddingService = require('./embeddingService');
const embeddingsConfig = require('../config/embeddings');

function newResult() {
  return {
    candidates: 0,
    cleaned: 0,
    embedded: 0,
    skipped_embedded: 0,
    failed: 0,
    errors: []
  };
}

function recordError(result, message) {
  result.failed += 1;
  if (result.errors.length < 10) {
    result.errors.push(String(message || 'Processing failed').slice(0, 500));
  }
}

async function fetchCandidates(limit, articleIds) {
  const requestedIds = Array.isArray(articleIds) ? articleIds.filter(Boolean) : [];
  const defaultLimit = embeddingsConfig.clustering.maxArticlesPerRun;
  const requestedLimit = requestedIds.length > 0 ? requestedIds.length : (Number(limit) || defaultLimit);
  const safeLimit = Math.min(Math.max(requestedLimit, 1), 200);

  const where = { processing_status: { [Op.in]: ['collected', 'cleaned'] } };
  if (requestedIds.length > 0) {
    where.id = { [Op.in]: requestedIds };
  }

  return Article.findAll({
    where,
    order: [['fetched_at', 'ASC'], ['id', 'ASC']],
    limit: safeLimit,
    include: [{ model: Source, attributes: ['name'], required: false }]
  });
}

/**
 * Reconciliation candidates: ONLY already-processed articles.
 * The normal processArticles() path never selects these rows.
 */
async function fetchReconcileCandidates(limit, articleIds) {
  const requestedIds = Array.isArray(articleIds) ? articleIds.filter(Boolean) : [];
  const defaultLimit = embeddingsConfig.clustering.maxArticlesPerRun;
  const requestedLimit = requestedIds.length > 0 ? requestedIds.length : (Number(limit) || defaultLimit);
  const safeLimit = Math.min(Math.max(requestedLimit, 1), 200);

  const where = { processing_status: { [Op.in]: ['embedded', 'clustered'] } };
  if (requestedIds.length > 0) {
    where.id = { [Op.in]: requestedIds };
  }

  return Article.findAll({
    where,
    order: [['fetched_at', 'ASC'], ['id', 'ASC']],
    limit: safeLimit,
    include: [{ model: Source, attributes: ['name'], required: false }]
  });
}

async function processSingleArticle(article, result, options = {}) {
  try {
    // Skip re-embedding when a valid embedding already exists for this content.
    const existing = await ArticleEmbedding.findOne({ where: { article_id: article.id } });
    if (existing && existing.content_hash === article.content_hash && Array.isArray(existing.vector) && existing.vector.length === embeddingService.EXPECTED_DIMENSIONS) {
      result.skipped_embedded += 1;
      if (article.processing_status !== 'embedded' && article.processing_status !== 'clustered') {
        await article.update({ processing_status: 'embedded', processing_error: null });
      }
      return null;
    }

    // Step 1: clean.
    const prepared = prepareArticleForEmbedding(article);
    if (!prepared.ok) {
      await article.update({ processing_status: 'failed', processing_error: prepared.reason.slice(0, 500) });
      recordError(result, `Article ${article.id}: ${prepared.reason}`);
      return null;
    }
    if (article.processing_status === 'collected') {
      await article.update({ processing_status: 'cleaned', processing_error: null });
    }
    result.cleaned += 1;

    // Step 2: embed via Gemini.
    const embedding = await embeddingService.generateEmbedding(prepared.text);
    await ArticleEmbedding.upsert({
      article_id: article.id,
      model: embedding.model,
      dimensions: embedding.dimensions,
      content_hash: article.content_hash,
      vector: embedding.values
    });
    // Re-embedding must not demote an existing event member.
    const keepClustered = article.processing_status === 'clustered';
    await article.update({ processing_status: keepClustered ? 'clustered' : 'embedded', processing_error: null });
    result.embedded += 1;

    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    return null;
  } catch (error) {
    const code = error && error.code ? error.code : 'PROCESS_ERROR';
    const message = `Article ${article.id} [${code}]: ${(error && error.message) || 'processing failed'}`;
    // Embedding/provider failure: keep at cleaned so a later run can retry.
    if (article.processing_status === 'collected') {
      await article.update({ processing_status: 'cleaned', processing_error: message.slice(0, 500) }).catch(() => {});
    } else {
      await article.update({ processing_error: message.slice(0, 500) }).catch(() => {});
    }
    recordError(result, message);
    // Stop early on auth/key errors — retrying the whole batch is pointless.
    // Gemini returns invalid keys as 400 API_KEY_INVALID, so detect it explicitly.
    if (
      code === 'GEMINI_AUTH' ||
      code === 'GEMINI_KEY_MISSING' ||
      /API_KEY_INVALID|API key not valid/i.test((error && error.message) || '')
    ) {
      result.stoppedEarly = code;
      return 'stop';
    }
    return null;
  }
}

async function processArticles(options = {}) {
  const result = newResult();

  if (!Article || !ArticleEmbedding) {
    recordError(result, 'Database models are not initialized');
    return result;
  }

  const candidates = await fetchCandidates(
    options.limit || embeddingsConfig.clustering.maxArticlesPerRun,
    options.articleIds
  );
  result.candidates = candidates.length;

  for (const article of candidates) {
    const signal = await processSingleArticle(article, result, options);
    if (signal === 'stop') {
      break;
    }
  }

  return result;
}

/**
 * Explicit opt-in reconciliation for already-processed articles.
 * Regenerates embeddings that are missing or stale (content_hash mismatch);
 * rows with a matching content_hash and valid dimensions skip Gemini.
 */
async function reconcileEmbeddings(options = {}) {
  const result = newResult();

  if (!Article || !ArticleEmbedding) {
    recordError(result, 'Database models are not initialized');
    return result;
  }

  const candidates = await fetchReconcileCandidates(
    options.limit || embeddingsConfig.clustering.maxArticlesPerRun,
    options.articleIds
  );
  result.candidates = candidates.length;

  for (const article of candidates) {
    const signal = await processSingleArticle(article, result, options);
    if (signal === 'stop') {
      break;
    }
  }

  return result;
}

module.exports = {
  processArticles,
  reconcileEmbeddings
};
