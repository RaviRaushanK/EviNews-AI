/** Read-only report chronology. EventArticle membership is authoritative. */
const { validateId, createSequelizeContradictionQueryRepository } = require('./contradictionQueryService');
const { buildTimelineEntry, sortTimelineEntries, groupTimelineEntries, parseTimelineDate } = require('../utils/timeline');

function timelineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function compareIds(first, second) {
  const a = String(first.id || first.evidence_text || '');
  const b = String(second.id || second.evidence_text || '');
  return a < b ? -1 : a > b ? 1 : 0;
}

function createSequelizeTimelineRepository(models, Op) {
  const existing = createSequelizeContradictionQueryRepository(models, Op);
  return {
    findEvent: existing.findEvent,
    findEventArticleIds: existing.findEventArticleIds,
    async loadArticles(articleIds) {
      if (articleIds.length === 0) return [];
      const rows = await models.Article.findAll({
        where: { id: { [Op.in]: articleIds } },
        attributes: ['id', 'source_id', 'title', 'url', 'published_at', 'fetched_at', 'processing_status'],
        include: [{ model: models.Source, attributes: ['id', 'name', 'url'], required: false }],
        order: [['id', 'ASC']]
      });
      return rows.map((row) => {
        const article = row.toJSON();
        return { ...article, source: article.Source || { id: article.source_id, name: null, url: null } };
      });
    }
  };
}

function createEventTimelineService({ repository, claimQuery }) {
  if (!repository || ['findEvent', 'findEventArticleIds', 'loadArticles'].some((method) => typeof repository[method] !== 'function')) {
    throw new TypeError('timeline repository is required');
  }
  if (!claimQuery || typeof claimQuery.getClaimsForEvent !== 'function') throw new TypeError('claim query service is required');

  return {
    async getTimelineForEvent(eventId) {
      const id = validateId(eventId, 'event_id');
      let event;
      let articleIds;
      let articles;
      try {
        event = await repository.findEvent(id);
        if (!event) throw timelineError('EVENT_NOT_FOUND', 'Event not found: ' + id);
        articleIds = [...new Set(await repository.findEventArticleIds(id))].sort();
        articles = articleIds.length ? await repository.loadArticles(articleIds) : [];
      } catch (error) {
        if (error.code === 'EVENT_NOT_FOUND') throw error;
        throw timelineError('TIMELINE_READ_ERROR', 'Unable to read event membership or article metadata.');
      }

      const warnings = [];
      const memberIds = new Set(articleIds);
      const articleById = new Map(articles.filter((article) => memberIds.has(article.id)).map((article) => [article.id, article]));
      let claimData = { claims: [] };
      if (articleIds.length) {
        try { claimData = await claimQuery.getClaimsForEvent(id); }
        catch (_) { claimData = null; }
      }
      const claimsAvailable = Boolean(claimData && Array.isArray(claimData.claims));
      if (!claimsAvailable) warnings.push({ code: 'CLAIMS_UNAVAILABLE', message: 'Claim data could not be loaded; articles remain visible.' });
      const claimsByArticle = new Map();
      const missingEvidence = [];
      for (const input of claimsAvailable ? claimData.claims : []) {
        if (!input || !memberIds.has(input.article_id)) continue;
        const claim = structuredClone(input);
        const evidenceAvailable = Array.isArray(claim.evidence);
        if (!evidenceAvailable || claim.evidence.length === 0) missingEvidence.push(claim.id);
        claim.evidence_status = !evidenceAvailable ? 'unavailable' : claim.evidence.length ? 'available' : 'empty';
        claim.evidence = (evidenceAvailable ? claim.evidence : []).map((evidence) => {
          const article = articleById.get(evidence.article_id);
          return article ? {
            ...evidence,
            article: evidence.article || { id: article.id, title: article.title, url: article.url },
            source: evidence.source || structuredClone(article.source || article.Source || null)
          } : evidence;
        }).sort(compareIds);
        const list = claimsByArticle.get(claim.article_id) || [];
        list.push(claim);
        claimsByArticle.set(claim.article_id, list);
      }

      const entries = [];
      for (const articleId of articleIds) {
        const article = articleById.get(articleId);
        const claims = (claimsByArticle.get(articleId) || []).sort(compareIds);
        const extractionPending = article && article.processing_status &&
          !['claims_extracted', 'processed'].includes(article.processing_status) && claims.length === 0;
        const available = Boolean(article && claimsAvailable && !extractionPending);
        const entry = {
          ...buildTimelineEntry(article || { id: articleId }, available ? claims : null),
          url: article && article.url || null,
          claims_available: available,
          article_available: Boolean(article)
        };
        if (!article) warnings.push({ code: 'MEMBER_ARTICLE_UNAVAILABLE', article_id: articleId, message: 'Member article metadata is unavailable.' });
        if (extractionPending) warnings.push({ code: 'CLAIMS_NOT_EXTRACTED', article_id: articleId, message: 'This report has no extracted claims yet.' });
        if (!entry.report_timestamp) warnings.push({ code: 'REPORT_DATE_UNAVAILABLE', article_id: articleId, message: 'No valid publication or collection date is available.' });
        if (entry.date_source === 'fetched_at') warnings.push({ code: 'FETCHED_DATE_USED', article_id: articleId, message: 'Collection time substitutes for unavailable publication time.' });
        entries.push(entry);
      }
      if (missingEvidence.length) warnings.push({ code: 'EVIDENCE_UNAVAILABLE', claim_ids: [...missingEvidence].sort(), message: 'Some claims have no available evidence snippets.' });
      const ordered = sortTimelineEntries(entries);
      const undated = ordered.filter((entry) => !entry.report_timestamp).length;
      const unavailableClaims = ordered.filter((entry) => !entry.claims_available).length;
      const unavailableArticles = ordered.filter((entry) => !entry.article_available).length;
      return {
        event: { ...structuredClone(event), event_date: parseTimelineDate(event.event_date) },
        member_articles: articleIds.length,
        count: ordered.length,
        entries: ordered,
        groups: groupTimelineEntries(ordered),
        warnings,
        completeness: {
          status: undated || unavailableClaims || unavailableArticles || missingEvidence.length ? 'partial' : 'complete',
          coverage: {
            articles: { expected: articleIds.length, available: articleIds.length - unavailableArticles },
            dates: { dated: ordered.length - undated, undated },
            claims: { status: unavailableClaims ? 'partial' : 'complete', unavailable_articles: unavailableClaims },
            evidence: { status: missingEvidence.length || unavailableClaims ? 'unknown' : 'complete', missing_claim_ids: [...missingEvidence].sort() }
          }
        }
      };
    }
  };
}

let defaultService;
function getDefaultService() {
  if (!defaultService) {
    const models = require('../models');
    const { Op } = require('sequelize');
    defaultService = createEventTimelineService({
      repository: createSequelizeTimelineRepository(models, Op),
      claimQuery: require('./claimQueryService')
    });
  }
  return defaultService;
}

async function getTimelineForEvent(eventId) {
  return getDefaultService().getTimelineForEvent(eventId);
}

module.exports = { createSequelizeTimelineRepository, createEventTimelineService, getTimelineForEvent };
