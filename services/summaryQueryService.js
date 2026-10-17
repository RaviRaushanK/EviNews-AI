/** Summary reads and atomic persistence. Generation and grounding happen elsewhere. */
const { validateId } = require('./contradictionQueryService');
const { summaryError, buildInputFingerprint, stableSerialize, validateSummaryOutput } = require('../utils/summaryValidation');
const { verifySummary } = require('../utils/summaryGrounding');

const FINGERPRINT = /^[a-f0-9]{64}$/;
const GROUNDING = new Set(['supported', 'partially_supported', 'conflicting', 'unsupported', 'needs_review']);
const LINK_STATUSES = new Set(['supported', 'partially_supported', 'conflicting', 'unsupported']);
const PROVIDERS = new Set(['gemini', 'openai', 'local']);

function invalid(message) { throw summaryError('SUMMARY_INVALID_PERSISTENCE_INPUT', message); }
function plain(row) { return row && typeof row.toJSON === 'function' ? row.toJSON() : row; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validateFingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT.test(value)) invalid('input_fingerprint must be a SHA-256 hex digest');
  return value;
}

function validateVerification(metadata, groundingStatus, verificationStatus) {
  if (verificationStatus !== 'needs_review') invalid('A summary cannot be marked verified by this persistence service');
  if (!GROUNDING.has(groundingStatus)) invalid('Invalid grounding_status');
  if (!object(metadata) || metadata.grounding_status !== groundingStatus ||
      metadata.verification_status !== verificationStatus || metadata.factual_truth_verified !== false ||
      !Array.isArray(metadata.statements)) invalid('Deterministic verification metadata is required');
}

function validatePersistence(input) {
  if (!object(input)) invalid('Summary data must be an object');
  const eventId = validateId(input.event_id, 'event_id');
  const fingerprint = validateFingerprint(input.input_fingerprint);
  if (typeof input.summary_text !== 'string' || !input.summary_text.trim()) invalid('summary_text is required');
  if (!PROVIDERS.has(input.model_provider) || typeof input.model_version !== 'string' || !input.model_version.trim()) invalid('Provider and model version are required');
  if (typeof input.prompt_version !== 'string' || !input.prompt_version.trim() ||
      typeof input.contract_version !== 'string' || !input.contract_version.trim()) invalid('Prompt and contract versions are required');
  if (input.generation_status !== 'succeeded') invalid('Only successfully generated summaries may be persisted');
  validateVerification(input.verification_metadata, input.grounding_status, input.verification_status);
  if (!object(input.structured_output) || !object(input.context_snapshot) ||
      input.context_snapshot.event?.id !== eventId ||
      input.context_snapshot.metadata?.input_fingerprint !== fingerprint) invalid('Context snapshot must match the event and fingerprint');
  try {
    if (buildInputFingerprint(input.context_snapshot) !== fingerprint) invalid('Context snapshot fingerprint does not match its content');
    validateSummaryOutput(input.structured_output, input.context_snapshot);
    if (stableSerialize(verifySummary(input.structured_output, input.context_snapshot)) !== stableSerialize(input.verification_metadata)) {
      invalid('Verification metadata does not match deterministic grounding');
    }
  } catch (error) {
    if (error.code === 'SUMMARY_INVALID_PERSISTENCE_INPUT') throw error;
    invalid('Structured output or context snapshot is invalid');
  }
  if (!Array.isArray(input.claims)) invalid('claims must be an array');
  const links = new Map();
  for (const link of input.claims) {
    if (!object(link) || !LINK_STATUSES.has(link.verification_status)) invalid('Invalid summary claim link');
    const claimId = validateId(link.claim_id, 'claim_id');
    if (links.has(claimId) && links.get(claimId) !== link.verification_status) invalid('Duplicate claim has conflicting verification statuses');
    links.set(claimId, link.verification_status);
  }
  if (input.generated_at !== undefined && !(input.generated_at instanceof Date && !Number.isNaN(input.generated_at.getTime()))) invalid('generated_at must be a valid Date');
  return {
    eventId, fingerprint,
    links: [...links].sort(([a], [b]) => a.localeCompare(b)).map(([claim_id, verification_status]) => ({ claim_id, verification_status })),
    data: {
      event_id: eventId, input_fingerprint: fingerprint, summary_text: input.summary_text,
      model_provider: input.model_provider, model_version: input.model_version,
      prompt_version: input.prompt_version, contract_version: input.contract_version,
      generation_status: input.generation_status, grounding_status: input.grounding_status,
      verification_status: input.verification_status, structured_output: input.structured_output,
      context_snapshot: input.context_snapshot, verification_metadata: input.verification_metadata,
      ...(input.generated_at === undefined ? {} : { generated_at: input.generated_at })
    }
  };
}

function createSequelizeSummaryRepository(models) {
  const { sequelize, Summary, SummaryClaim, Claim, Event, EventArticle } = models;
  if (![sequelize, Summary, SummaryClaim, Claim, Event, EventArticle].every(Boolean)) throw new TypeError('Summary models are unavailable');

  async function hydrate(row, transaction) {
    if (!row) return null;
    const summary = plain(row);
    const links = await SummaryClaim.findAll({ where: { summary_id: summary.id }, order: [['claim_id', 'ASC']], raw: true, transaction });
    const ids = links.map(link => link.claim_id);
    const claims = ids.length ? await Claim.findAll({ where: { id: ids }, attributes: ['id', 'article_id', 'event_id', 'claim_text', 'claim_type'], raw: true, transaction }) : [];
    const byId = new Map(claims.map(claim => [claim.id, claim]));
    return { ...summary, claims: links.map(link => ({ ...byId.get(link.claim_id), claim_id: link.claim_id, verification_status: link.verification_status })) };
  }

  return {
    transaction: work => sequelize.transaction(work),
    async findById(id, transaction) { return hydrate(await Summary.findByPk(id, { raw: true, transaction }), transaction); },
    async findByFingerprint(eventId, fingerprint) {
      return hydrate(await Summary.findOne({ where: { event_id: eventId, input_fingerprint: fingerprint }, raw: true }));
    },
    async findForEvent(eventId) {
      const rows = await Summary.findAll({ where: { event_id: eventId }, order: [['generated_at', 'DESC'], ['id', 'ASC']], raw: true });
      return Promise.all(rows.map(row => hydrate(row)));
    },
    async findEvent(eventId, transaction) { return Event.findByPk(eventId, { attributes: ['id', 'title', 'description', 'status', 'event_date'], raw: true, transaction }); },
    async findMemberArticleIds(eventId, transaction) {
      const rows = await EventArticle.findAll({ where: { event_id: eventId }, attributes: ['article_id'], raw: true, transaction });
      return rows.map(row => row.article_id);
    },
    async findClaims(ids, transaction) {
      return ids.length ? Claim.findAll({ where: { id: ids }, attributes: ['id', 'article_id', 'event_id'], raw: true, transaction }) : [];
    },
    async createSummary(data, transaction) { return Summary.create(data, { transaction }); },
    async createLinks(links, transaction) { return SummaryClaim.bulkCreate(links, { transaction, validate: true }); },
    async updateSummary(id, fields, transaction) { return Summary.update(fields, { where: { id }, transaction }); }
  };
}

function createSummaryQueryService({ repository }) {
  if (!repository || typeof repository.transaction !== 'function') throw new TypeError('Summary repository is required');

  async function findEventById(id) { return repository.findEvent(validateId(id, 'event_id')); }
  async function findSummaryById(id) { return repository.findById(validateId(id, 'summary_id')); }
  async function findSummariesForEvent(eventId) {
    const rows = await repository.findForEvent(validateId(eventId, 'event_id'));
    return [...rows].sort((a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime() || a.id.localeCompare(b.id));
  }
  async function findSummaryByFingerprint(eventId, fingerprint) {
    return repository.findByFingerprint(validateId(eventId, 'event_id'), validateFingerprint(fingerprint));
  }

  async function persistSummary(input) {
    const { eventId, fingerprint, links, data } = validatePersistence(input);
    try {
      const existing = await repository.findByFingerprint(eventId, fingerprint);
      if (existing) return existing;
      return await repository.transaction(async transaction => {
        if (!await repository.findEvent(eventId, transaction)) throw summaryError('SUMMARY_EVENT_NOT_FOUND', 'Event not found');
        if (links.length) {
          const [memberIds, claims] = await Promise.all([
            repository.findMemberArticleIds(eventId, transaction),
            repository.findClaims(links.map(link => link.claim_id), transaction)
          ]);
          const members = new Set(memberIds);
          const byId = new Map(claims.map(claim => [claim.id, claim]));
          for (const link of links) {
            const claim = byId.get(link.claim_id);
            if (!claim || !members.has(claim.article_id) || (claim.event_id && claim.event_id !== eventId)) {
              throw summaryError('SUMMARY_CROSS_EVENT_CLAIM', 'A summary claim does not belong to the event');
            }
          }
        }
        const summary = plain(await repository.createSummary(data, transaction));
        if (links.length) await repository.createLinks(links.map(link => ({ summary_id: summary.id, ...link })), transaction);
        return repository.findById(summary.id, transaction);
      });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') {
        try {
          const winner = await repository.findByFingerprint(eventId, fingerprint);
          if (winner) return winner;
        } catch (_) { /* Preserve the sanitized persistence error below. */ }
      }
      if (error.code && error.code.startsWith('SUMMARY_')) throw error;
      throw summaryError('SUMMARY_PERSISTENCE_FAILED', 'Summary could not be persisted');
    }
  }

  async function updateVerificationState(summaryId, state) {
    const id = validateId(summaryId, 'summary_id');
    if (!object(state)) invalid('Verification state must be an object');
    validateVerification(state.verification_metadata, state.grounding_status, state.verification_status);
    try {
      return await repository.transaction(async transaction => {
        const current = await repository.findById(id, transaction);
        if (!current) return null;
        if (current.generation_status !== 'succeeded') invalid('Only generated summaries may be verified');
        if (stableSerialize(verifySummary(current.structured_output, current.context_snapshot)) !== stableSerialize(state.verification_metadata)) {
          invalid('Verification metadata does not match deterministic grounding');
        }
        await repository.updateSummary(id, {
          grounding_status: state.grounding_status,
          verification_status: state.verification_status,
          verification_metadata: state.verification_metadata
        }, transaction);
        return repository.findById(id, transaction);
      });
    } catch (error) {
      if (error.code && error.code.startsWith('SUMMARY_')) throw error;
      throw summaryError('SUMMARY_PERSISTENCE_FAILED', 'Summary verification state could not be updated');
    }
  }

  return { findEventById, findSummaryById, findSummariesForEvent, findSummaryByFingerprint, persistSummary, updateVerificationState };
}

let defaultService;
function service() {
  if (!defaultService) defaultService = createSummaryQueryService({ repository: createSequelizeSummaryRepository(require('../models')) });
  return defaultService;
}
module.exports = {
  createSequelizeSummaryRepository, createSummaryQueryService,
  findEventById: id => service().findEventById(id),
  findSummaryById: id => service().findSummaryById(id),
  findSummariesForEvent: id => service().findSummariesForEvent(id),
  findSummaryByFingerprint: (eventId, fingerprint) => service().findSummaryByFingerprint(eventId, fingerprint),
  persistSummary: input => service().persistSummary(input),
  updateVerificationState: (id, state) => service().updateVerificationState(id, state)
};
