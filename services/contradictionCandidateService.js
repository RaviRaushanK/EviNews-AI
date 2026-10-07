/**
 * Read-only contradiction candidate generation (Phase 5).
 * Event membership is authoritative; claim.event_id is intentionally ignored.
 */

const contradictionsConfig = require('../config/contradictions');
const {
  normalizeText,
  canonicalizeClaimPair,
  buildEvaluationFingerprint
} = require('../utils/contradictionValidation');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'in', 'is', 'it', 'its', 'of', 'on',
  'or', 'said', 'says', 'she', 'that', 'the', 'their', 'they', 'this', 'to', 'was',
  'were', 'will', 'with'
]);
const LIGHT_EQUIVALENCE_WORDS = new Set(['a', 'an', 'the']);
const ACTION_TERMS = new Set([
  'announced', 'approved', 'banned', 'cancelled', 'closed', 'confirmed', 'cut',
  'denied', 'fell', 'increased', 'launched', 'opened', 'planned', 'raised',
  'rejected', 'released', 'resumed', 'rose', 'suspended'
]);

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateEventId(eventId) {
  if (typeof eventId !== 'string' || !UUID_PATTERN.test(eventId.trim())) {
    throw serviceError('INVALID_EVENT_ID', 'eventId must be a valid UUID');
  }
  return eventId.trim().toLowerCase();
}

function validateOptions(options, defaultMaxCandidates) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw serviceError('INVALID_OPTIONS', 'options must be an object');
  }

  const includeEvaluated = options.includeEvaluated === undefined
    ? false
    : options.includeEvaluated;
  if (typeof includeEvaluated !== 'boolean') {
    throw serviceError('INVALID_INCLUDE_EVALUATED', 'includeEvaluated must be a boolean');
  }

  const maxCandidates = options.maxCandidates === undefined
    ? defaultMaxCandidates
    : options.maxCandidates;
  if (typeof maxCandidates !== 'number' || !Number.isFinite(maxCandidates) ||
      !Number.isInteger(maxCandidates) || maxCandidates <= 0) {
    throw serviceError('INVALID_MAX_CANDIDATES', 'maxCandidates must be a positive finite integer');
  }

  return { includeEvaluated, maxCandidates };
}

function resolveContradictionModel(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw serviceError(
      'CONTRADICTION_MODEL_NOT_CONFIGURED',
      'GEMINI_CONTRADICTION_MODEL is required for contradiction candidate fingerprints'
    );
  }
  return value.trim();
}

function tokenize(value) {
  return normalizeText(value, { allowEmpty: false, fieldName: 'claim_text' })
    .toLowerCase()
    .match(/[\p{L}\p{N}%]+/gu) || [];
}

function comparableClaimText(value) {
  return tokenize(value).join(' ');
}

function lightEquivalenceSignature(value) {
  return tokenize(value).filter((token) => !LIGHT_EQUIVALENCE_WORDS.has(token)).join(' ');
}

function isObviousDuplicate(firstText, secondText) {
  const firstComparable = comparableClaimText(firstText);
  const secondComparable = comparableClaimText(secondText);
  return firstComparable === secondComparable ||
    lightEquivalenceSignature(firstText) === lightEquivalenceSignature(secondText);
}

function extractSignals(value) {
  const tokens = tokenize(value);
  const meaningful = new Set(tokens.filter((token) =>
    token.length >= 3 && !STOP_WORDS.has(token) && !ACTION_TERMS.has(token)));
  const numbers = new Set(tokens.filter((token) => /\d/.test(token)));
  const actions = new Set(tokens.filter((token) => ACTION_TERMS.has(token)));
  return { meaningful, numbers, actions };
}

function intersection(first, second) {
  return [...first].filter((value) => second.has(value));
}

function assessCompatibility(firstClaim, secondClaim) {
  const first = extractSignals(firstClaim.claim_text);
  const second = extractSignals(secondClaim.claim_text);
  const sharedTerms = intersection(first.meaningful, second.meaningful);
  const sharedNumbers = intersection(first.numbers, second.numbers);
  const sharedActions = intersection(first.actions, second.actions);
  const hasNumericContext = first.numbers.size > 0 && second.numbers.size > 0 && sharedTerms.length >= 1;
  const hasPredicateContext = first.actions.size > 0 && second.actions.size > 0 && sharedTerms.length >= 1;
  const compatible = (sharedNumbers.length > 0 && sharedTerms.length >= 1) ||
    sharedTerms.length >= 2 ||
    (sharedActions.length > 0 && sharedTerms.length >= 1) ||
    hasPredicateContext ||
    hasNumericContext;

  return {
    compatible,
    signals: {
      sharedTerms,
      sharedNumbers,
      sharedActions,
      hasNumericContext,
      hasPredicateContext
    }
  };
}

function toIsoDate(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw serviceError('INVALID_ARTICLE_DATE', 'article published_at must be a valid date');
  }
  return date.toISOString();
}

function normalizeCandidateClaim(claim) {
  return {
    id: claim.id,
    article_id: claim.article_id,
    claim_text: normalizeText(claim.claim_text, { allowEmpty: false, fieldName: 'claim_text' }),
    claim_type: normalizeText(claim.claim_type, { allowEmpty: false, fieldName: 'claim_type' }),
    evidence: [...new Set((claim.evidence || []).map((text, index) => normalizeText(text, {
      allowEmpty: false,
      fieldName: `evidence[${index}]`
    })))].sort(),
    article: {
      id: claim.article.id,
      title: claim.article.title,
      source: claim.article.source || null,
      published_at: toIsoDate(claim.article.published_at)
    }
  };
}

function fingerprintClaim(claim) {
  return {
    id: claim.id,
    text: claim.claim_text,
    type: claim.claim_type,
    evidence: claim.evidence,
    published_at: claim.article.published_at,
    reference_date: null
  };
}

function checkKey(claimId1, claimId2, fingerprint) {
  return `${claimId1}:${claimId2}:${fingerprint}`;
}

function generateCandidatePairs(claimRows, options) {
  const claims = claimRows.map(normalizeCandidateClaim).sort((a, b) => a.id.localeCompare(b.id));
  const generated = [];
  let rawPairCount = 0;
  let skippedSameArticle = 0;
  let skippedDuplicate = 0;
  let skippedIncompatible = 0;

  for (let firstIndex = 0; firstIndex < claims.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < claims.length; secondIndex += 1) {
      const first = claims[firstIndex];
      const second = claims[secondIndex];
      if (first.article_id === second.article_id) {
        skippedSameArticle += 1;
        continue;
      }

      rawPairCount += 1;
      if (isObviousDuplicate(first.claim_text, second.claim_text)) {
        skippedDuplicate += 1;
        continue;
      }

      const compatibility = assessCompatibility(first, second);
      if (!compatibility.compatible) {
        skippedIncompatible += 1;
        continue;
      }

      const pair = canonicalizeClaimPair(first.id, second.id);
      const byId = new Map([[first.id, first], [second.id, second]]);
      const claim1 = byId.get(pair.claim_id_1);
      const claim2 = byId.get(pair.claim_id_2);
      const inputFingerprint = buildEvaluationFingerprint({
        claim_1: fingerprintClaim(claim1),
        claim_2: fingerprintClaim(claim2),
        model: options.model,
        prompt_version: options.promptVersion
      });

      generated.push({
        claim_id_1: pair.claim_id_1,
        claim_id_2: pair.claim_id_2,
        claim_1: claim1,
        claim_2: claim2,
        input_fingerprint: inputFingerprint
      });
    }
  }

  generated.sort((a, b) =>
    a.claim_id_1.localeCompare(b.claim_id_1) || a.claim_id_2.localeCompare(b.claim_id_2));

  return {
    totalClaims: claims.length,
    rawPairCount,
    compatiblePairCount: generated.length,
    skippedSameArticle,
    skippedDuplicate,
    skippedIncompatible,
    generated
  };
}

function createSequelizeCandidateRepository(modelRegistry, Op) {
  const { Event, EventArticle, Article, Source, Claim, ClaimEvidence, ContradictionCheck } = modelRegistry;

  return {
    async loadClaimsForEvent(eventId) {
      const event = await Event.findByPk(eventId, { attributes: ['id'], raw: true });
      if (!event) {
        return { eventExists: false, claims: [] };
      }

      const memberships = await EventArticle.findAll({
        where: { event_id: eventId },
        attributes: ['article_id'],
        order: [['article_id', 'ASC']],
        raw: true
      });
      const articleIds = memberships.map((membership) => membership.article_id);
      if (articleIds.length === 0) {
        return { eventExists: true, claims: [] };
      }

      const articles = await Article.findAll({
        where: { id: { [Op.in]: articleIds } },
        attributes: ['id', 'source_id', 'title', 'published_at'],
        order: [['id', 'ASC']],
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
      const sourceById = new Map(sources.map((source) => [source.id, source]));
      const articleById = new Map(articles.map((article) => [article.id, {
        id: article.id,
        title: article.title,
        published_at: article.published_at,
        source: sourceById.has(article.source_id)
          ? { id: sourceById.get(article.source_id).id, name: sourceById.get(article.source_id).name }
          : null
      }]));

      const claims = await Claim.findAll({
        where: { article_id: { [Op.in]: articleIds } },
        attributes: ['id', 'article_id', 'event_id', 'claim_text', 'claim_type'],
        order: [['id', 'ASC']],
        raw: true
      });
      const claimIds = claims.map((claim) => claim.id);
      const evidenceRows = claimIds.length > 0
        ? await ClaimEvidence.findAll({
          where: { claim_id: { [Op.in]: claimIds } },
          attributes: ['id', 'claim_id', 'evidence_text'],
          order: [['claim_id', 'ASC'], ['id', 'ASC']],
          raw: true
        })
        : [];
      const evidenceByClaim = new Map();
      for (const evidence of evidenceRows) {
        const values = evidenceByClaim.get(evidence.claim_id) || [];
        values.push(evidence.evidence_text);
        evidenceByClaim.set(evidence.claim_id, values);
      }

      return {
        eventExists: true,
        claims: claims
          .filter((claim) => articleById.has(claim.article_id))
          .map((claim) => ({
            ...claim,
            evidence: evidenceByClaim.get(claim.id) || [],
            article: articleById.get(claim.article_id)
          }))
      };
    },

    async loadExistingChecks(claimIds) {
      if (claimIds.length === 0) {
        return [];
      }
      return ContradictionCheck.findAll({
        where: {
          claim_id_1: { [Op.in]: claimIds },
          claim_id_2: { [Op.in]: claimIds }
        },
        attributes: ['claim_id_1', 'claim_id_2', 'input_fingerprint', 'outcome'],
        raw: true
      });
    }
  };
}

function createContradictionCandidateService({ repository, config = contradictionsConfig }) {
  if (!repository || typeof repository.loadClaimsForEvent !== 'function' ||
      typeof repository.loadExistingChecks !== 'function') {
    throw new TypeError('candidate repository is required');
  }

  return {
    async getContradictionCandidates(eventId, options = {}) {
      const normalizedEventId = validateEventId(eventId);
      const validatedOptions = validateOptions(options, config.detection.maxCandidatesPerRun);
      const model = resolveContradictionModel(config.gemini.contradictionModel);
      const promptVersion = normalizeText(config.detection.promptVersion, {
        allowEmpty: false,
        fieldName: 'promptVersion'
      });

      const loaded = await repository.loadClaimsForEvent(normalizedEventId);
      if (!loaded.eventExists) {
        throw serviceError('EVENT_NOT_FOUND', `Event not found: ${normalizedEventId}`);
      }

      const pairResult = generateCandidatePairs(loaded.claims, { model, promptVersion });
      let existingChecks = [];
      if (!validatedOptions.includeEvaluated && pairResult.generated.length > 0) {
        existingChecks = await repository.loadExistingChecks(
          [...new Set(pairResult.generated.flatMap((candidate) => [
            candidate.claim_id_1,
            candidate.claim_id_2
          ]))]
        );
      }
      const existingKeys = new Set(existingChecks.map((check) => checkKey(
        check.claim_id_1,
        check.claim_id_2,
        check.input_fingerprint
      )));
      const eligible = pairResult.generated.filter((candidate) => !existingKeys.has(checkKey(
        candidate.claim_id_1,
        candidate.claim_id_2,
        candidate.input_fingerprint
      )));
      const candidates = eligible.slice(0, validatedOptions.maxCandidates);

      return {
        eventId: normalizedEventId,
        totalClaims: pairResult.totalClaims,
        rawPairCount: pairResult.rawPairCount,
        compatiblePairCount: pairResult.compatiblePairCount,
        skippedSameArticle: pairResult.skippedSameArticle,
        skippedDuplicate: pairResult.skippedDuplicate,
        skippedIncompatible: pairResult.skippedIncompatible,
        skippedPreviouslyEvaluated: pairResult.generated.length - eligible.length,
        eligibleCandidateCount: eligible.length,
        returnedCandidateCount: candidates.length,
        truncatedCandidateCount: eligible.length - candidates.length,
        candidates
      };
    }
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    const models = require('../models');
    const { Op } = require('sequelize');
    defaultService = createContradictionCandidateService({
      repository: createSequelizeCandidateRepository(models, Op)
    });
  }
  return defaultService;
}

async function getContradictionCandidates(eventId, options = {}) {
  return getDefaultService().getContradictionCandidates(eventId, options);
}

module.exports = {
  validateEventId,
  validateOptions,
  resolveContradictionModel,
  isObviousDuplicate,
  assessCompatibility,
  generateCandidatePairs,
  createSequelizeCandidateRepository,
  createContradictionCandidateService,
  getContradictionCandidates
};
