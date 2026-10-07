/**
 * Contradiction detection orchestration (Phase 5).
 * Candidate generation, provider classification, validation, and per-pair persistence.
 */

const contradictionsConfig = require('../config/contradictions');
const { validateContradictionResponse } = require('../utils/contradictionValidation');
const { resolveContradictionModel } = require('./contradictionCandidateService');

const POSITIVE_CLASSIFICATIONS = new Set(['direct', 'partial', 'temporal']);

function detectionError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function validateDetectionOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw detectionError('INVALID_DETECTION_OPTIONS', 'options must be an object');
  }
  if (options.maxCandidates !== undefined && (
    typeof options.maxCandidates !== 'number' ||
    !Number.isFinite(options.maxCandidates) ||
    !Number.isInteger(options.maxCandidates) ||
    options.maxCandidates <= 0
  )) {
    throw detectionError(
      'INVALID_MAX_CANDIDATES',
      'maxCandidates must be a positive finite integer'
    );
  }
  return { maxCandidates: options.maxCandidates };
}

function serializePromptClaim(claim) {
  return {
    claim_id: claim.id,
    claim_text: claim.claim_text,
    claim_type: claim.claim_type,
    evidence_snippets: claim.evidence,
    article: {
      article_id: claim.article.id,
      title: claim.article.title,
      source_name: claim.article.source ? claim.article.source.name : null,
      publication_time: claim.article.published_at
    },
    claim_reference_time: null
  };
}

function buildContradictionPrompt(eventId, eventContext, candidate) {
  const input = {
    event: {
      event_id: eventId,
      title: eventContext && eventContext.title ? eventContext.title : null,
      description: eventContext && eventContext.description ? eventContext.description : null,
      event_date: eventContext && eventContext.event_date ? eventContext.event_date : null
    },
    claim_1: serializePromptClaim(candidate.claim_1),
    claim_2: serializePromptClaim(candidate.claim_2)
  };

  return [
    'You classify whether two news claims about the same event contradict each other.',
    'This task is NOT to determine general truth. Compare only the two supplied claims and evidence.',
    '',
    'CLASSIFICATIONS:',
    'direct: The claims concern substantially the same subject, proposition, scope, and reference time, and cannot both be true.',
    'partial: The claims materially overlap but conflict in quantity, location, population, scope, attribution, condition, or another important qualifier.',
    'temporal: The claims conflict about timing, ordering, duration, or state at the same relevant time.',
    'none: The claims are consistent, paraphrases, concern different subjects, or describe a coherent normal update.',
    '',
    'RULES:',
    '1. A later report reflecting changed circumstances is not automatically a contradiction.',
    '2. Paraphrases and repeated reporting are none.',
    '3. Claims about different entities, events, or propositions are none.',
    '4. Do not infer contradiction merely because two numbers differ.',
    '5. ARTICLE PUBLICATION TIME is not the same as CLAIM REFERENCE TIME.',
    '6. claim_reference_time is null when no separately structured reference time is available.',
    '7. Infer reference time only when the claim or evidence clearly supports it; otherwise be conservative.',
    '8. normal_update must be true when a chronological change plausibly explains the difference.',
    '',
    'Return STRICT JSON ONLY. No markdown fences, commentary, or extra fields.',
    'Required shape:',
    '{"classification":"direct|partial|temporal|none","reason":"Concise evidence-grounded explanation","same_subject":true,"same_reference_time":true,"normal_update":false,"confidence":0.91}',
    '',
    'INPUT:',
    JSON.stringify(input)
  ].join('\n');
}

function parseContradictionJson(rawText) {
  if (typeof rawText !== 'string' || rawText.trim().length === 0) {
    throw detectionError('CONTRADICTION_PARSE_ERROR', 'Gemini contradiction response was empty');
  }

  try {
    return JSON.parse(rawText.trim());
  } catch (error) {
    throw detectionError(
      'CONTRADICTION_PARSE_ERROR',
      `Gemini contradiction response was not strict JSON: ${error.message}`,
      error
    );
  }
}

function parseAndValidateResponse(rawText) {
  const parsed = parseContradictionJson(rawText);
  try {
    return validateContradictionResponse(parsed);
  } catch (error) {
    throw detectionError(
      'CONTRADICTION_VALIDATION_ERROR',
      `Gemini contradiction response failed validation: ${error.message}`,
      error
    );
  }
}

function isUniqueConstraintError(error) {
  return Boolean(error) && (
    error.name === 'SequelizeUniqueConstraintError' ||
    error.code === 'ER_DUP_ENTRY' ||
    (error.original && error.original.code === 'ER_DUP_ENTRY') ||
    (error.parent && error.parent.code === 'ER_DUP_ENTRY')
  );
}

function createSequelizeDetectionRepository(modelRegistry) {
  const { sequelize, Event, Contradiction, ContradictionCheck } = modelRegistry;

  return {
    async loadEventContext(eventId) {
      const event = await Event.findByPk(eventId, {
        attributes: ['id', 'title', 'description', 'event_date'],
        raw: true
      });
      if (!event) {
        return null;
      }
      return {
        id: event.id,
        title: event.title,
        description: event.description,
        event_date: event.event_date instanceof Date
          ? event.event_date.toISOString()
          : event.event_date || null
      };
    },

    async persistEvaluation(candidate, classification, metadata) {
      try {
        return await sequelize.transaction(async (transaction) => {
          try {
            await ContradictionCheck.create({
              claim_id_1: candidate.claim_id_1,
              claim_id_2: candidate.claim_id_2,
              input_fingerprint: candidate.input_fingerprint,
              outcome: classification.classification,
              reason: classification.reason,
              model: metadata.model,
              prompt_version: metadata.promptVersion,
              checked_at: metadata.checkedAt
            }, { transaction });
          } catch (error) {
            if (isUniqueConstraintError(error)) {
              throw detectionError(
                'CONTRADICTION_CHECK_ALREADY_EXISTS',
                'The claim pair and fingerprint were persisted concurrently',
                error
              );
            }
            throw error;
          }

          if (!POSITIVE_CLASSIFICATIONS.has(classification.classification)) {
            return {
              checkCreated: true,
              contradictionCreated: false,
              existingPositive: false
            };
          }

          const pairWhere = {
            claim_id_1: candidate.claim_id_1,
            claim_id_2: candidate.claim_id_2
          };
          const existing = await Contradiction.findOne({ where: pairWhere, transaction });
          if (existing) {
            return {
              checkCreated: true,
              contradictionCreated: false,
              existingPositive: true
            };
          }

          try {
            await Contradiction.create({
              ...pairWhere,
              contradiction_type: classification.classification,
              status: 'unresolved',
              reason: classification.reason,
              detected_at: metadata.checkedAt
            }, { transaction });
            return {
              checkCreated: true,
              contradictionCreated: true,
              existingPositive: false
            };
          } catch (error) {
            if (!isUniqueConstraintError(error)) {
              throw error;
            }
            return {
              checkCreated: true,
              contradictionCreated: false,
              existingPositive: true,
              concurrentPositive: true
            };
          }
        });
      } catch (error) {
        if (error && error.code === 'CONTRADICTION_CHECK_ALREADY_EXISTS') {
          return {
            checkCreated: false,
            contradictionCreated: false,
            existingPositive: false,
            alreadyEvaluated: true,
            concurrent: true
          };
        }
        throw detectionError(
          'CONTRADICTION_PERSISTENCE_ERROR',
          `Failed to persist contradiction evaluation: ${error.message}`,
          error
        );
      }
    }
  };
}

function errorType(error) {
  const code = error && error.code ? error.code : '';
  if (code === 'CONTRADICTION_PARSE_ERROR') {
    return 'parsing';
  }
  if (code === 'CONTRADICTION_VALIDATION_ERROR') {
    return 'validation';
  }
  if (code === 'CONTRADICTION_PERSISTENCE_ERROR') {
    return 'persistence';
  }
  if (code.startsWith('GEMINI_')) {
    return 'provider';
  }
  return 'unknown';
}

function createContradictionDetectionService({
  candidateService,
  geminiClient,
  repository,
  config = contradictionsConfig,
  now = () => new Date()
}) {
  if (!candidateService || typeof candidateService.getContradictionCandidates !== 'function') {
    throw new TypeError('candidateService is required');
  }
  if (!geminiClient || typeof geminiClient.generateText !== 'function') {
    throw new TypeError('geminiClient is required');
  }
  if (!repository || typeof repository.persistEvaluation !== 'function') {
    throw new TypeError('detection repository is required');
  }

  return {
    async detectContradictionsForEvent(eventId, options = {}) {
      const validatedOptions = validateDetectionOptions(options);
      const model = resolveContradictionModel(config.gemini.contradictionModel);
      const promptVersion = config.detection.promptVersion;
      const candidateOptions = validatedOptions.maxCandidates === undefined
        ? {}
        : { maxCandidates: validatedOptions.maxCandidates };
      const candidateResult = await candidateService.getContradictionCandidates(eventId, candidateOptions);
      const eventContext = typeof repository.loadEventContext === 'function'
        ? await repository.loadEventContext(candidateResult.eventId)
        : null;
      const results = [];
      let evaluated = 0;
      let skipped = candidateResult.skippedPreviouslyEvaluated || 0;
      let contradictionsCreated = 0;
      let noneRecorded = 0;
      let failed = 0;

      for (const candidate of candidateResult.candidates) {
        try {
          const prompt = buildContradictionPrompt(candidateResult.eventId, eventContext, candidate);
          const generated = await geminiClient.generateText(prompt, { model });
          const classification = parseAndValidateResponse(generated.text);
          const persistence = await repository.persistEvaluation(candidate, classification, {
            model,
            promptVersion,
            checkedAt: now()
          });

          if (persistence.alreadyEvaluated) {
            skipped += 1;
            results.push({
              claim_id_1: candidate.claim_id_1,
              claim_id_2: candidate.claim_id_2,
              input_fingerprint: candidate.input_fingerprint,
              status: 'skipped',
              classification: classification.classification,
              reason: 'already_persisted_concurrently'
            });
            continue;
          }

          evaluated += 1;
          if (persistence.contradictionCreated) {
            contradictionsCreated += 1;
          }
          if (classification.classification === 'none') {
            noneRecorded += 1;
          }
          results.push({
            claim_id_1: candidate.claim_id_1,
            claim_id_2: candidate.claim_id_2,
            input_fingerprint: candidate.input_fingerprint,
            status: 'evaluated',
            classification: classification.classification,
            contradiction_created: persistence.contradictionCreated,
            existing_positive: persistence.existingPositive,
            concurrent_positive: Boolean(persistence.concurrentPositive)
          });
        } catch (error) {
          failed += 1;
          results.push({
            claim_id_1: candidate.claim_id_1,
            claim_id_2: candidate.claim_id_2,
            input_fingerprint: candidate.input_fingerprint,
            status: 'failed',
            error_type: errorType(error),
            error_code: error && error.code ? error.code : 'CONTRADICTION_DETECTION_ERROR',
            error: String((error && error.message) || 'Contradiction evaluation failed').slice(0, 500)
          });
        }
      }

      return {
        eventId: candidateResult.eventId,
        candidates_considered: candidateResult.candidates.length,
        evaluated,
        skipped,
        contradictions_created: contradictionsCreated,
        none_recorded: noneRecorded,
        failed,
        candidate_summary: {
          total_claims: candidateResult.totalClaims,
          raw_pairs: candidateResult.rawPairCount,
          compatible_pairs: candidateResult.compatiblePairCount,
          skipped_same_article: candidateResult.skippedSameArticle,
          skipped_duplicate: candidateResult.skippedDuplicate,
          skipped_incompatible: candidateResult.skippedIncompatible,
          skipped_previously_evaluated: candidateResult.skippedPreviouslyEvaluated,
          truncated: candidateResult.truncatedCandidateCount
        },
        results
      };
    }
  };
}

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    const models = require('../models');
    const candidateService = require('./contradictionCandidateService');
    const geminiClient = require('./geminiClientService');
    defaultService = createContradictionDetectionService({
      candidateService,
      geminiClient,
      repository: createSequelizeDetectionRepository(models)
    });
  }
  return defaultService;
}

async function detectContradictionsForEvent(eventId, options = {}) {
  return getDefaultService().detectContradictionsForEvent(eventId, options);
}

module.exports = {
  POSITIVE_CLASSIFICATIONS,
  validateDetectionOptions,
  buildContradictionPrompt,
  parseContradictionJson,
  parseAndValidateResponse,
  isUniqueConstraintError,
  createSequelizeDetectionRepository,
  createContradictionDetectionService,
  detectContradictionsForEvent
};
