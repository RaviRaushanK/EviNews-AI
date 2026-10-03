/**
 * Claim processing service (Phase 4).
 * Orchestrates: select eligible articles -> extract -> validate -> map evidence
 * -> persist -> update processing status.
 *
 * Status contract (Phase 4):
 *   clustered -> claims_extracted   on success (including zero claims)
 *   clustered -> clustered          remains eligible for retry on
 *                                   Gemini / parse / insufficient-text failure
 *   `failed` is NOT used for transient provider failures.
 *
 * Phase 3 state is never modified beyond the intended single status transition.
 */

const crypto = require('crypto');
const { Op } = require('sequelize');
const claimsConfig = require('../config/claims');
const claimExtractionService = require('./claimExtractionService');
const evidenceMappingService = require('./evidenceMappingService');
const { buildClaimKey, normalizeClaimText } = require('../utils/claimValidation');

function newResult() {
  return {
    candidates: 0,
    processed: 0,
    skipped_existing: 0,
    no_claims: 0,
    claims_created: 0,
    duplicate_claims: 0,
    claims_rejected: 0,
    evidence_created: 0,
    duplicate_evidence: 0,
    claims_without_evidence: 0,
    failed: 0,
    errors: []
  };
}

function recordError(result, message) {
  result.failed += 1;
  if (result.errors.length < 10) {
    result.errors.push(String(message || 'Claim processing failed').slice(0, 500));
  }
}

/** Informational note (validation rejections are not batch failures). */
function recordNote(result, message) {
  if (result.errors.length < 10) {
    result.errors.push(String(message || '').slice(0, 500));
  }
}

/**
 * Eligible articles: processing_status = 'clustered' only (never 'embedded' by default).
 * Deterministic ordering: fetched_at ASC, id ASC.
 */
async function fetchEligibleArticles(limit, articleIds) {
  const { Article, Source } = require('../models');
  const requestedIds = Array.isArray(articleIds) ? articleIds.filter(Boolean) : [];
  const defaultLimit = claimsConfig.extraction.maxArticlesPerRun;
  const requestedLimit = requestedIds.length > 0 ? requestedIds.length : (Number(limit) || defaultLimit);
  const safeLimit = Math.min(Math.max(requestedLimit, 1), 200);

  const where = { processing_status: 'clustered' };
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
 * Resolves the event association for a claim.
 * Exactly one event link => that event. Zero or many => null (never guess).
 */
async function resolveEventId(articleId) {
  const { EventArticle } = require('../models');
  if (!EventArticle) {
    return null;
  }
  const links = await EventArticle.findAll({ where: { article_id: articleId }, attributes: ['event_id'] });
  if (links.length === 1) {
    return links[0].event_id;
  }
  return null;
}

/**
 * Persists extracted claims + evidence and marks the article complete.
 * Uses one transaction so partial writes or status changes cannot be committed.
 */
async function persistClaims(article, extracted, eventId, options = {}) {
  const { Claim, ClaimEvidence, sequelize } = require('../models');
  const stats = {
    claims_created: 0,
    duplicate_claims: 0,
    evidence_created: 0,
    duplicate_evidence: 0,
    claims_without_evidence: 0
  };

  const existing = await Claim.findAll({
    where: { article_id: article.id },
    attributes: ['id', 'claim_text']
  });
  const existingKeys = new Set(existing.map((row) => buildClaimKey(article.id, row.claim_text)));
  const articleText = evidenceMappingService.buildArticleSourceText(article);

  const write = async (transaction) => {
    const tx = transaction || undefined;

    for (const claim of extracted) {
      const key = buildClaimKey(article.id, claim.claim_text);
      if (existingKeys.has(key)) {
        stats.duplicate_claims += 1;
        continue;
      }

      const created = await Claim.create({
        article_id: article.id,
        event_id: eventId,
        claim_text: claim.claim_text,
        claim_type: claim.claim_type,
        confidence_score: claim.confidence,
        extracted_at: new Date()
      }, tx ? { transaction: tx } : undefined);

      stats.claims_created += 1;
      existingKeys.add(key);

      const evidence = evidenceMappingService.resolveEvidence(article, claim, {
        articleText,
        minOverlap: options.minOverlap
      });

      if (!evidence.hasEvidence) {
        stats.claims_without_evidence += 1;
        continue;
      }

      const normalizedEvidence = normalizeClaimText(evidence.text);
      const evidenceHash = crypto.createHash('sha256').update(normalizedEvidence, 'utf8').digest('hex');

      const found = await ClaimEvidence.findOne({
        where: { claim_id: created.id, article_id: article.id, evidence_hash: evidenceHash },
        transaction: tx
      });
      if (found) {
        stats.duplicate_evidence += 1;
        continue;
      }

      await ClaimEvidence.create({
        claim_id: created.id,
        article_id: article.id,
        evidence_text: normalizedEvidence,
        evidence_location: evidence.location || null
      }, tx ? { transaction: tx } : undefined);

      stats.evidence_created += 1;
    }

    if (!options.dryRun) {
      await article.update(
        { processing_status: 'claims_extracted', processing_error: null },
        tx ? { transaction: tx } : undefined
      );
    }
  };

  if (sequelize && !options.dryRun) {
    await sequelize.transaction(async (transaction) => write(transaction));
  } else {
    await write(null);
  }

  return stats;
}

/**
 * Processes one article end to end.
 * Returns 'stop' when a fatal provider error means the rest of the batch should stop.
 */
async function processSingleArticle(article, result, options = {}) {
  const { Claim } = require('../models');

  try {
    // Idempotency guard #1: already-claimed articles skip without a Gemini call.
    const existingCount = await Claim.count({ where: { article_id: article.id } });
    if (existingCount > 0) {
      result.skipped_existing += 1;
      return null;
    }

    const extraction = await claimExtractionService.extractClaimsForArticle(article, {
      maxArticleChars: options.maxArticleChars,
      maxClaims: options.maxClaims,
      model: options.model,
      timeoutMs: options.timeoutMs,
      retryDelayMs: options.retryDelayMs
    });

    result.claims_rejected += extraction.rejected.length;
    for (const rejected of extraction.rejected) {
      recordNote(result, `Article ${article.id} claim #${rejected.index} rejected: ${rejected.reason}`);
    }

    const eventId = await resolveEventId(article.id);
    const stats = await persistClaims(article, extraction.claims, eventId, options);

    result.claims_created += stats.claims_created;
    result.duplicate_claims += stats.duplicate_claims;
    result.evidence_created += stats.evidence_created;
    result.duplicate_evidence += stats.duplicate_evidence;
    result.claims_without_evidence += stats.claims_without_evidence;

    if (extraction.claims.length === 0) {
      result.no_claims += 1;
    }

    result.processed += 1;
    return null;
  } catch (error) {
    const code = error && error.code ? error.code : 'CLAIM_ERROR';
    const message = `Article ${article.id} [${code}]: ${(error && error.message) || 'claim extraction failed'}`;

    // Transient failures keep the article at 'clustered' so a later run retries.
    if (!options.dryRun) {
      await article.update({ processing_error: message.slice(0, 500) }).catch(() => {});
    }
    recordError(result, message);

    if (
      code === 'GEMINI_KEY_MISSING' ||
      code === 'CLAIM_MODEL_NOT_CONFIGURED' ||
      code === 'GEMINI_AUTH' ||
      code === 'GEMINI_BAD_REQUEST'
    ) {
      result.stoppedEarly = code;
      return 'stop';
    }
    return null;
  }
}

/**
 * Main entry point for Phase 4 extraction.
 */
async function processClaims(options = {}) {
  const result = newResult();
  const models = require('../models');

  if (!models.Article || !models.Claim) {
    recordError(result, 'Database models are not initialized');
    return result;
  }

  const candidates = await fetchEligibleArticles(
    options.limit || claimsConfig.extraction.maxArticlesPerRun,
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
 * Dry-run preview: reports eligible/selected articles and the estimated number
 * of Gemini calls WITHOUT calling Gemini and WITHOUT writing to the database.
 */
async function previewClaims(options = {}) {
  const models = require('../models');
  const preview = {
    dry_run: true,
    eligible: 0,
    already_claimed: 0,
    to_process: 0,
    estimated_gemini_calls: 0,
    articles: []
  };

  if (!models.Article || !models.Claim) {
    preview.error = 'Database models are not initialized';
    return preview;
  }

  const candidates = await fetchEligibleArticles(
    options.limit || claimsConfig.extraction.maxArticlesPerRun,
    options.articleIds
  );
  preview.eligible = candidates.length;

  for (const article of candidates) {
    const claimCount = await models.Claim.count({ where: { article_id: article.id } });
    if (claimCount > 0) {
      preview.already_claimed += 1;
      continue;
    }
    preview.to_process += 1;
    preview.articles.push({
      id: article.id,
      title: String(article.title || '').slice(0, 120),
      status: article.processing_status,
      source: article.Source ? article.Source.name : null
    });
  }

  preview.estimated_gemini_calls = preview.to_process;
  return preview;
}

module.exports = {
  fetchEligibleArticles,
  resolveEventId,
  persistClaims,
  processSingleArticle,
  processClaims,
  previewClaims,
  newResult,
  recordError,
  recordNote
};
