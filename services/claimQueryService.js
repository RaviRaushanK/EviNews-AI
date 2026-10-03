/**
 * Claim query service (Phase 4).
 * Strictly read-only helpers used by the verification routes and CLI inspector.
 * No writes, no Gemini calls.
 */

const { Article, Claim, ClaimEvidence, Event, EventArticle, Source } = require('../models');
const evidenceMappingService = require('./evidenceMappingService');

async function getClaimsForArticle(articleId) {
  if (!Article || !Claim) {
    return null;
  }
  const article = await Article.findByPk(articleId, {
    attributes: ['id', 'title', 'processing_status', 'processing_error', 'content_hash', 'source_id'],
    include: [{ model: Source, attributes: ['name'], required: false }]
  });
  if (!article) {
    return null;
  }

  const claims = await Claim.findAll({
    where: { article_id: articleId },
    order: [['createdAt', 'ASC'], ['id', 'ASC']]
  });

  const evidenceRows = claims.length > 0
    ? await ClaimEvidence.findAll({ where: { claim_id: claims.map((claim) => claim.id) } })
    : [];

  const evidenceByClaim = {};
  for (const row of evidenceRows) {
    if (!evidenceByClaim[row.claim_id]) {
      evidenceByClaim[row.claim_id] = [];
    }
    evidenceByClaim[row.claim_id].push(row);
  }

  return {
    article: article.toJSON(),
    claims: claims.map((claim) => ({
      ...claim.toJSON(),
      evidence: (evidenceByClaim[claim.id] || []).map((row) => row.toJSON())
    }))
  };
}

async function getClaimsForEvent(eventId) {
  if (!Event || !EventArticle) {
    return null;
  }
  const event = await Event.findByPk(eventId);
  if (!event) {
    return null;
  }

  const links = await EventArticle.findAll({ where: { event_id: eventId } });
  const articleIds = links.map((link) => link.article_id);

  const claims = articleIds.length > 0
    ? await Claim.findAll({ where: { article_id: articleIds }, order: [['article_id', 'ASC'], ['createdAt', 'ASC']] })
    : [];

  const evidenceRows = claims.length > 0
    ? await ClaimEvidence.findAll({ where: { claim_id: claims.map((claim) => claim.id) } })
    : [];

  const evidenceByClaim = {};
  for (const row of evidenceRows) {
    if (!evidenceByClaim[row.claim_id]) {
      evidenceByClaim[row.claim_id] = [];
    }
    evidenceByClaim[row.claim_id].push(row);
  }

  return {
    event: event.toJSON(),
    member_articles: articleIds.length,
    claims: claims.map((claim) => ({
      ...claim.toJSON(),
      evidence: (evidenceByClaim[claim.id] || []).map((row) => row.toJSON())
    }))
  };
}

/**
 * Grounding audit: confirms every stored evidence_text really occurs in the
 * corresponding article text (normalized comparison). Read-only.
 */
async function auditEvidenceGrounding(articleIds) {
  const findings = [];
  if (!Article || !ClaimEvidence) {
    return findings;
  }

  const where = Array.isArray(articleIds) && articleIds.length > 0
    ? { article_id: articleIds }
    : {};
  const evidenceRows = await ClaimEvidence.findAll({ where, order: [['createdAt', 'ASC']] });

  const articles = await Article.findAll({
    where: { id: [...new Set(evidenceRows.map((row) => row.article_id))] }
  });
  const articleById = {};
  for (const article of articles) {
    articleById[article.id] = article;
  }

  for (const row of evidenceRows) {
    const article = articleById[row.article_id];
    const articleText = evidenceMappingService.buildArticleSourceText(article || {});
    const grounded = evidenceMappingService.normalizeForMatch(articleText)
      .includes(evidenceMappingService.normalizeForMatch(row.evidence_text));
    findings.push({
      evidence_id: row.id,
      claim_id: row.claim_id,
      article_id: row.article_id,
      grounded,
      source: row.evidence_location && row.evidence_location.source ? row.evidence_location.source : 'unknown'
    });
  }

  return findings;
}

module.exports = {
  getClaimsForArticle,
  getClaimsForEvent,
  auditEvidenceGrounding
};