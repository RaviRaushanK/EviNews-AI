/**
 * Pure contradiction-classification validation and fingerprint helpers.
 * No database, provider, filesystem, or mutable environment access.
 */

const crypto = require('crypto');
const contradictionsConfig = require('../config/contradictions');

const {
  supportedClassifications: SUPPORTED_CLASSIFICATIONS,
  confidenceMin: MIN_CONFIDENCE,
  confidenceMax: MAX_CONFIDENCE,
  maxReasonChars: MAX_REASON_CHARS
} = contradictionsConfig.validation;

const RESPONSE_FIELDS = new Set([
  'classification',
  'reason',
  'same_subject',
  'same_reference_time',
  'normal_update',
  'confidence'
]);

function normalizeText(value, options = {}) {
  const {
    allowCoercion = false,
    allowEmpty = true,
    fieldName = 'text'
  } = options;

  let text = value;
  if (typeof text !== 'string') {
    if (!allowCoercion || text === null || text === undefined) {
      throw new TypeError(`${fieldName} must be a string`);
    }
    text = String(text);
  }

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function canonicalizeClaimPair(firstClaimId, secondClaimId) {
  const first = normalizeText(firstClaimId, { allowEmpty: false, fieldName: 'firstClaimId' });
  const second = normalizeText(secondClaimId, { allowEmpty: false, fieldName: 'secondClaimId' });

  if (first === second) {
    throw new RangeError('claim pair requires two different claim IDs');
  }

  return first < second
    ? { claim_id_1: first, claim_id_2: second }
    : { claim_id_1: second, claim_id_2: first };
}

function validateClassification(value) {
  if (typeof value !== 'string' || !SUPPORTED_CLASSIFICATIONS.includes(value)) {
    throw new TypeError(`classification must be one of: ${SUPPORTED_CLASSIFICATIONS.join(', ')}`);
  }
  return value;
}

function validateReason(value) {
  const reason = normalizeText(value, { allowEmpty: false, fieldName: 'reason' });
  if (reason.length > MAX_REASON_CHARS) {
    throw new RangeError(`reason must be at most ${MAX_REASON_CHARS} characters`);
  }
  return reason;
}

function validateConfidence(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('confidence must be a finite number between 0 and 1');
  }
  if (value < MIN_CONFIDENCE || value > MAX_CONFIDENCE) {
    throw new RangeError(`confidence must be between ${MIN_CONFIDENCE} and ${MAX_CONFIDENCE}`);
  }
  return value;
}

function validateBooleanField(value, fieldName, options = {}) {
  const { required = false } = options;
  if (value === undefined || value === null) {
    if (required) {
      throw new TypeError(`${fieldName} must be a boolean`);
    }
    return null;
  }
  if (typeof value !== 'boolean') {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
  return value;
}

function validateContradictionResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('contradiction response must be an object');
  }

  const unexpectedFields = Object.keys(response).filter((field) => !RESPONSE_FIELDS.has(field));
  if (unexpectedFields.length > 0) {
    throw new TypeError(`contradiction response contains unexpected field(s): ${unexpectedFields.join(', ')}`);
  }

  return {
    classification: validateClassification(response.classification),
    reason: validateReason(response.reason),
    same_subject: validateBooleanField(response.same_subject, 'same_subject', { required: true }),
    same_reference_time: validateBooleanField(
      response.same_reference_time,
      'same_reference_time',
      { required: true }
    ),
    normal_update: validateBooleanField(response.normal_update, 'normal_update', { required: true }),
    confidence: validateConfidence(response.confidence)
  };
}

function normalizeEvidence(value, fieldName) {
  if (value === undefined || value === null) {
    return [];
  }
  const values = Array.isArray(value) ? value : [value];
  const normalized = values.map((item, index) => normalizeText(item, {
    allowEmpty: false,
    fieldName: `${fieldName}[${index}]`
  }));
  return [...new Set(normalized)].sort();
}

function normalizeOptionalText(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return normalizeText(value, { allowEmpty: false, fieldName });
}

function normalizeFingerprintClaim(claim, fieldName) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  return {
    id: normalizeText(claim.id, { allowEmpty: false, fieldName: `${fieldName}.id` }),
    text: normalizeText(claim.text, { allowEmpty: false, fieldName: `${fieldName}.text` }),
    type: normalizeText(claim.type, { allowEmpty: false, fieldName: `${fieldName}.type` }),
    evidence: normalizeEvidence(claim.evidence, `${fieldName}.evidence`),
    published_at: normalizeOptionalText(claim.published_at, `${fieldName}.published_at`),
    reference_date: normalizeOptionalText(claim.reference_date, `${fieldName}.reference_date`)
  };
}

/**
 * Fingerprint input:
 * {
 *   claim_1: { id, text, type, evidence, published_at?, reference_date? },
 *   claim_2: { id, text, type, evidence, published_at?, reference_date? },
 *   prompt_version,
 *   model
 * }
 */
function buildEvaluationFingerprint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('fingerprint input must be an object');
  }

  const first = normalizeFingerprintClaim(input.claim_1, 'claim_1');
  const second = normalizeFingerprintClaim(input.claim_2, 'claim_2');
  const pair = canonicalizeClaimPair(first.id, second.id);
  const claimsById = new Map([[first.id, first], [second.id, second]]);

  const normalizedInput = {
    claim_1: claimsById.get(pair.claim_id_1),
    claim_2: claimsById.get(pair.claim_id_2),
    model: normalizeText(input.model, { allowEmpty: false, fieldName: 'model' }),
    prompt_version: normalizeText(input.prompt_version, {
      allowEmpty: false,
      fieldName: 'prompt_version'
    })
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalizedInput), 'utf8')
    .digest('hex');
}

module.exports = {
  SUPPORTED_CLASSIFICATIONS,
  MIN_CONFIDENCE,
  MAX_CONFIDENCE,
  MAX_REASON_CHARS,
  normalizeText,
  canonicalizeClaimPair,
  validateClassification,
  validateReason,
  validateConfidence,
  validateBooleanField,
  validateContradictionResponse,
  buildEvaluationFingerprint
};
