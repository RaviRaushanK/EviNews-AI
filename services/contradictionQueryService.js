/**
 * Read-only contradiction and evaluation-history queries (Phase 5).
 * Results are ordered by detection/check time DESC, then id ASC.
 */

const contradictionsConfig = require('../config/contradictions');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_STATUSES = Object.freeze(['unresolved', 'resolved', 'under_review']);
const ALLOWED_TYPES = Object.freeze(['direct', 'partial', 'temporal']);

function queryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateId(value, name) {
  const upperName = name.toUpperCase();
  if (value === undefined || value === null || value === '') {
    throw queryError(`MISSING_${upperName}`, `${name} is required`);
  }
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw queryError(`INVALID_${upperName}`, `${name} must be a valid UUID`);
  }
  return value.trim().toLowerCase();
}

function validateQueryOptions(options, config = contradictionsConfig.query) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw queryError('INVALID_QUERY_OPTIONS', 'options must be an object');
  }

  if (options.status !== undefined && !ALLOWED_STATUSES.includes(options.status)) {
    throw queryError(
      'INVALID_CONTRADICTION_STATUS',
      `status must be one of: ${ALLOWED_STATUSES.join(', ')}`
    );
  }
  if (options.type !== undefined && !ALLOWED_TYPES.includes(options.type)) {
    throw queryError(
      'INVALID_CONTRADICTION_TYPE',
      `type must be one of: ${ALLOWED_TYPES.join(', ')}`
    );
  }

  const requestedLimit = options.limit === undefined ? config.defaultLimit : options.limit;
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit) ||
      !Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    throw queryError('INVALID_QUERY_LIMIT', 'limit must be a positive finite integer');
  }

  return {
    status: options.status,
    type: options.type,
    limit: Math.min(requestedLimit, config.maxLimit)
  };
}

function validateHistoryOptions(options, config = contradictionsConfig.query) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw queryError('INVALID_QUERY_OPTIONS', 'options must be an object');
  }
  const requestedLimit = options.limit === undefined ? config.defaultLimit : options.limit;
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit) ||
      !Number.isInteger(requestedLimit) || requestedLimit <= 0) {
    throw queryError('INVALID_QUERY_LIMIT', 'limit must be a positive finite integer');
  }
  return { limit: Math.min(requestedLimit, config.maxLimit) };
}

function toIsoOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function sortNewestFirst(rows, dateField) {
  return [...rows].sort((first, second) => {
    const firstTime = new Date(first[dateField]).getTime();
    const secondTime = new Date(second[dateField]).getTime();
    const timeDifference = (Number.isFinite(secondTime) ? secondTime : 0) -
      (Number.isFinite(firstTime) ? firstTime : 0);
    return timeDifference || String(first.id).localeCompare(String(second.id));
  });
}

function applyContradictionFilters(rows, options) {
  return rows.filter((row) =>
    (options.status === undefined || row.status === options.status) &&
    (options.type === undefined || row.contradiction_type === options.type));
}

function formatClaimContext(claim) {
  if (!claim) {
    return null;
  }
  return {
    id: claim.id,
    claim_text: claim.claim_text,
    claim_type: claim.claim_type,
    article: claim.article ? {
      id: claim.article.id,
      title: claim.article.title,
      published_at: toIsoOrNull(claim.article.published_at),
      source: claim.article.source ? {
        id: claim.article.source.id,
        name: claim.article.source.name
      } : null
    } : null,
    evidence: (claim.evidence || []).map((evidence) => ({
      id: evidence.id,
      evidence_text: evidence.evidence_text,
      article_id: evidence.article_id,
      evidence_hash: evidence.evidence_hash
    }))
  };
}

function formatContradictions(rows, contexts) {
  const byId = new Map(contexts.map((claim) => [claim.id, claim]));
  return rows.map((row) => ({
    id: row.id,
    contradiction_type: row.contradiction_type,
    status: row.status,
    reason: row.reason,
    detected_at: toIsoOrNull(row.detected_at),
    claim_1: formatClaimContext(byId.get(row.claim_id_1)),
    claim_2: formatClaimContext(byId.get(row.claim_id_2))
  }));
}

function createSequelizeContradictionQueryRepository(modelRegistry, Op) {
  const {
    Event,
    EventArticle,
    Claim,
    ClaimEvidence,
    Article,
    Source,
    Contradiction,
    ContradictionCheck
  } = modelRegistry;

  return {
    async findEvent(eventId) {
      return Event.findByPk(eventId, {
        attributes: ['id', 'title', 'description', 'status', 'event_date'],
        raw: true
      });
    },

    async findEventArticleIds(eventId) {
      const rows = await EventArticle.findAll({
        where: { event_id: eventId },
        attributes: ['article_id'],
        order: [['article_id', 'ASC']],
        raw: true
      });
      return rows.map((row) => row.article_id);
    },

    async findClaimIdsForArticles(articleIds) {
      if (articleIds.length === 0) {
        return [];
      }
      const rows = await Claim.findAll({
        where: { article_id: { [Op.in]: articleIds } },
        attributes: ['id'],
        order: [['id', 'ASC']],
        raw: true
      });
      return rows.map((row) => row.id);
    },

    async findClaim(claimId) {
      return Claim.findByPk(claimId, { attributes: ['id'], raw: true });
    },

    async findContradictionsForClaimIds(claimIds, filters) {
      if (claimIds.length === 0) {
        return [];
      }
      const where = {
        claim_id_1: { [Op.in]: claimIds },
        claim_id_2: { [Op.in]: claimIds }
      };
      if (filters.status !== undefined) {
        where.status = filters.status;
      }
      if (filters.type !== undefined) {
        where.contradiction_type = filters.type;
      }
      return Contradiction.findAll({
        where,
        attributes: [
          'id', 'claim_id_1', 'claim_id_2', 'contradiction_type',
          'status', 'reason', 'detected_at'
        ],
        order: [['detected_at', 'DESC'], ['id', 'ASC']],
        raw: true
      });
    },

    async findContradictionsForClaim(claimId, filters) {
      const where = {
        [Op.or]: [{ claim_id_1: claimId }, { claim_id_2: claimId }]
      };
      if (filters.status !== undefined) {
        where.status = filters.status;
      }
      if (filters.type !== undefined) {
        where.contradiction_type = filters.type;
      }
      return Contradiction.findAll({
        where,
        attributes: [
          'id', 'claim_id_1', 'claim_id_2', 'contradiction_type',
          'status', 'reason', 'detected_at'
        ],
        order: [['detected_at', 'DESC'], ['id', 'ASC']],
        raw: true
      });
    },

    async loadClaimContexts(claimIds) {
      if (claimIds.length === 0) {
        return [];
      }
      const claims = await Claim.findAll({
        where: { id: { [Op.in]: claimIds } },
        attributes: ['id', 'article_id', 'claim_text', 'claim_type'],
        raw: true
      });
      const articleIds = [...new Set(claims.map((claim) => claim.article_id))];
      const articles = await Article.findAll({
        where: { id: { [Op.in]: articleIds } },
        attributes: ['id', 'source_id', 'title', 'published_at'],
        raw: true
      });
      const sourceIds = [...new Set(articles.map((article) => article.source_id).filter(Boolean))];
      const sources = sourceIds.length > 0
        ? await Source.findAll({
          where: { id: { [Op.in]: sourceIds } },
          attributes: ['id', 'name'],
          raw: true
        })
        : [];
      const evidence = await ClaimEvidence.findAll({
        where: { claim_id: { [Op.in]: claimIds } },
        attributes: ['id', 'claim_id', 'article_id', 'evidence_text', 'evidence_hash'],
        order: [['claim_id', 'ASC'], ['id', 'ASC']],
        raw: true
      });

      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const articleById = new Map(articles.map((article) => [article.id, {
        id: article.id,
        title: article.title,
        published_at: article.published_at,
        source: sourceById.get(article.source_id) || null
      }]));
      const evidenceByClaim = new Map();
      for (const row of evidence) {
        const items = evidenceByClaim.get(row.claim_id) || [];
        items.push(row);
        evidenceByClaim.set(row.claim_id, items);
      }

      return claims.map((claim) => ({
        id: claim.id,
        claim_text: claim.claim_text,
        claim_type: claim.claim_type,
        article: articleById.get(claim.article_id) || null,
        evidence: evidenceByClaim.get(claim.id) || []
      }));
    },

    async findChecksForClaim(claimId) {
      return ContradictionCheck.findAll({
        where: {
          [Op.or]: [{ claim_id_1: claimId }, { claim_id_2: claimId }]
        },
        attributes: [
          'id', 'claim_id_1', 'claim_id_2', 'outcome', 'reason',
          'model', 'prompt_version', 'checked_at', 'input_fingerprint'
        ],
        order: [['checked_at', 'DESC'], ['id', 'ASC']],
        raw: true
      });
    }
  };
}

function createContradictionQueryService({ repository, config = contradictionsConfig }) {
  if (!repository || typeof repository.findEvent !== 'function' ||
      typeof repository.findClaim !== 'function' ||
      typeof repository.loadClaimContexts !== 'function') {
    throw new TypeError('contradiction query repository is required');
  }

  async function hydrate(rows) {
    const claimIds = [...new Set(rows.flatMap((row) => [row.claim_id_1, row.claim_id_2]))];
    const contexts = await repository.loadClaimContexts(claimIds);
    return formatContradictions(rows, contexts);
  }

  return {
    async getContradictionsForEvent(eventId, options = {}) {
      const normalizedEventId = validateId(eventId, 'event_id');
      const validatedOptions = validateQueryOptions(options, config.query);
      const event = await repository.findEvent(normalizedEventId);
      if (!event) {
        throw queryError('EVENT_NOT_FOUND', `Event not found: ${normalizedEventId}`);
      }

      const articleIds = await repository.findEventArticleIds(normalizedEventId);
      const claimIds = await repository.findClaimIdsForArticles(articleIds);
      const memberClaims = new Set(claimIds);
      const rows = await repository.findContradictionsForClaimIds(claimIds, validatedOptions);
      const filtered = applyContradictionFilters(rows, validatedOptions)
        .filter((row) => memberClaims.has(row.claim_id_1) && memberClaims.has(row.claim_id_2));
      const selected = sortNewestFirst(filtered, 'detected_at').slice(0, validatedOptions.limit);

      return {
        event: {
          id: event.id,
          title: event.title,
          description: event.description,
          status: event.status,
          event_date: toIsoOrNull(event.event_date)
        },
        member_articles: articleIds.length,
        member_claims: claimIds.length,
        count: selected.length,
        contradictions: await hydrate(selected)
      };
    },

    async getContradictionsForClaim(claimId, options = {}) {
      const normalizedClaimId = validateId(claimId, 'claim_id');
      const validatedOptions = validateQueryOptions(options, config.query);
      const claim = await repository.findClaim(normalizedClaimId);
      if (!claim) {
        throw queryError('CLAIM_NOT_FOUND', `Claim not found: ${normalizedClaimId}`);
      }

      const rows = await repository.findContradictionsForClaim(normalizedClaimId, validatedOptions);
      const filtered = applyContradictionFilters(rows, validatedOptions)
        .filter((row) => row.claim_id_1 === normalizedClaimId || row.claim_id_2 === normalizedClaimId);
      const selected = sortNewestFirst(filtered, 'detected_at').slice(0, validatedOptions.limit);

      return {
        claimId: normalizedClaimId,
        count: selected.length,
        contradictions: await hydrate(selected)
      };
    },

    async getContradictionChecksForClaim(claimId, options = {}) {
      const normalizedClaimId = validateId(claimId, 'claim_id');
      const validatedOptions = validateHistoryOptions(options, config.query);
      const claim = await repository.findClaim(normalizedClaimId);
      if (!claim) {
        throw queryError('CLAIM_NOT_FOUND', `Claim not found: ${normalizedClaimId}`);
      }

      const rows = await repository.findChecksForClaim(normalizedClaimId);
      const selected = sortNewestFirst(
        rows.filter((row) => row.claim_id_1 === normalizedClaimId || row.claim_id_2 === normalizedClaimId),
        'checked_at'
      ).slice(0, validatedOptions.limit);

      return {
        claimId: normalizedClaimId,
        count: selected.length,
        checks: selected.map((row) => ({
          id: row.id,
          claim_id_1: row.claim_id_1,
          claim_id_2: row.claim_id_2,
          outcome: row.outcome,
          reason: row.reason,
          model: row.model,
          prompt_version: row.prompt_version,
          checked_at: toIsoOrNull(row.checked_at),
          input_fingerprint: row.input_fingerprint
        }))
      };
    }
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    const models = require('../models');
    const { Op } = require('sequelize');
    defaultService = createContradictionQueryService({
      repository: createSequelizeContradictionQueryRepository(models, Op)
    });
  }
  return defaultService;
}

async function getContradictionsForEvent(eventId, options = {}) {
  return getDefaultService().getContradictionsForEvent(eventId, options);
}

async function getContradictionsForClaim(claimId, options = {}) {
  return getDefaultService().getContradictionsForClaim(claimId, options);
}

async function getContradictionChecksForClaim(claimId, options = {}) {
  return getDefaultService().getContradictionChecksForClaim(claimId, options);
}

module.exports = {
  ALLOWED_STATUSES,
  ALLOWED_TYPES,
  validateId,
  validateQueryOptions,
  validateHistoryOptions,
  sortNewestFirst,
  createSequelizeContradictionQueryRepository,
  createContradictionQueryService,
  getContradictionsForEvent,
  getContradictionsForClaim,
  getContradictionChecksForClaim
};
