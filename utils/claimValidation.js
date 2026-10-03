/**
 * Pure claim-payload validation (Phase 4).
 * No database access. No Gemini/API access. Fully unit-testable.
 *
 * Expected model output shape:
 * {
 *   "claims": [
 *     { "claim_text": "...", "claim_type": "fact", "confidence": 0.85, "evidence_quote": "..." }
 *   ]
 * }
 */

const ALLOWED_CLAIM_TYPES = ['fact', 'opinion', 'quote', 'data'];
const MIN_CLAIM_TEXT_CHARS = 10;
const MAX_CLAIM_TEXT_CHARS = 500;
const MAX_EVIDENCE_QUOTE_CHARS = 1000;

function normalizeClaimText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalized identity of a claim, used for application-level duplicate checks.
 */
function buildClaimKey(articleId, claimText) {
  return `${String(articleId || '')}::${normalizeClaimText(claimText).toLowerCase()}`;
}

function validateClaimItem(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { ok: false, index, reason: 'claim item must be an object' };
  }

  // claim_text
  if (typeof item.claim_text !== 'string') {
    return { ok: false, index, reason: 'claim_text must be a string' };
  }
  const claimText = normalizeClaimText(item.claim_text);
  if (claimText.length < MIN_CLAIM_TEXT_CHARS) {
    return { ok: false, index, reason: `claim_text must be at least ${MIN_CLAIM_TEXT_CHARS} characters` };
  }
  if (claimText.length > MAX_CLAIM_TEXT_CHARS) {
    return { ok: false, index, reason: `claim_text must be at most ${MAX_CLAIM_TEXT_CHARS} characters` };
  }

  // claim_type (absent => fact, because the DB schema defaults to 'fact')
  let claimType = 'fact';
  if (item.claim_type !== undefined && item.claim_type !== null && item.claim_type !== '') {
    if (typeof item.claim_type !== 'string') {
      return { ok: false, index, reason: 'claim_type must be a string' };
    }
    const normalizedType = item.claim_type.trim().toLowerCase();
    if (!ALLOWED_CLAIM_TYPES.includes(normalizedType)) {
      return { ok: false, index, reason: `claim_type must be one of: ${ALLOWED_CLAIM_TYPES.join(', ')}` };
    }
    claimType = normalizedType;
  }

  // confidence (absent => null). Invalid values are rejected, never clamped.
  let confidence = null;
  if (item.confidence !== undefined && item.confidence !== null && item.confidence !== '') {
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)) {
      return { ok: false, index, reason: 'confidence must be a finite number between 0 and 1' };
    }
    if (item.confidence < 0 || item.confidence > 1) {
      return { ok: false, index, reason: 'confidence must be between 0 and 1' };
    }
    confidence = item.confidence;
  }

  // evidence_quote (optional)
  let evidenceQuote = '';
  if (item.evidence_quote !== undefined && item.evidence_quote !== null) {
    if (typeof item.evidence_quote !== 'string') {
      return { ok: false, index, reason: 'evidence_quote must be a string' };
    }
    evidenceQuote = normalizeClaimText(item.evidence_quote);
    if (evidenceQuote.length > MAX_EVIDENCE_QUOTE_CHARS) {
      return { ok: false, index, reason: `evidence_quote must be at most ${MAX_EVIDENCE_QUOTE_CHARS} characters` };
    }
  }

  return {
    ok: true,
    index,
    value: {
      claim_text: claimText,
      claim_type: claimType,
      confidence,
      evidence_quote: evidenceQuote
    }
  };
}

/**
 * Validates a parsed model payload.
 * Returns { ok, accepted: [...], rejected: [{index, reason}], error }
 * `ok` is true when the payload shape itself was usable (even if some items were rejected).
 */
function validateClaimsPayload(payload, options = {}) {
  const maxClaims = Number.isFinite(Number(options.maxClaims)) && Number(options.maxClaims) > 0
    ? Number(options.maxClaims)
    : 10;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'payload must be a JSON object containing a claims array', accepted: [], rejected: [] };
  }
  if (!Array.isArray(payload.claims)) {
    return { ok: false, error: 'payload.claims must be an array', accepted: [], rejected: [] };
  }

  const accepted = [];
  const rejected = [];

  const items = payload.claims.slice(0, maxClaims);
  for (let i = 0; i < items.length; i += 1) {
    const outcome = validateClaimItem(items[i], i);
    if (outcome.ok) {
      accepted.push(outcome.value);
    } else {
      rejected.push({ index: outcome.index, reason: outcome.reason });
    }
  }

  if (payload.claims.length > maxClaims) {
    rejected.push({
      index: maxClaims,
      reason: `${payload.claims.length - maxClaims} claim(s) exceeded maxClaims=${maxClaims} and were ignored`
    });
  }

  return { ok: true, accepted, rejected };
}

module.exports = {
  ALLOWED_CLAIM_TYPES,
  MIN_CLAIM_TEXT_CHARS,
  MAX_CLAIM_TEXT_CHARS,
  MAX_EVIDENCE_QUOTE_CHARS,
  normalizeClaimText,
  buildClaimKey,
  validateClaimItem,
  validateClaimsPayload
};