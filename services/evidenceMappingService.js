/**
 * Evidence mapping service (Phase 4).
 *
 * CRITICAL RULE: never invent evidence.
 *   1. Preferred: the model's evidence_quote, verified as a verbatim span of the
 *      ORIGINAL article text (whitespace/case normalized) => source 'llm_verified'.
 *   2. Fallback: deterministic highest-token-overlap sentence taken from the
 *      original article => source 'deterministic_match'.
 *   3. Otherwise: no evidence row is created at all (the claim is still kept).
 *
 * Persistence uses ClaimEvidence.findOrCreate keyed on
 * (claim_id, article_id, evidence_hash); the existing DB unique index is the
 * final duplicate guard.
 */

const crypto = require('crypto');
const claimsConfig = require('../config/claims');
const { cleanField } = require('./articleProcessingService');
const { normalizeClaimText } = require('../utils/claimValidation');

const MIN_QUOTE_CHARS = 20;
const MIN_SENTENCE_CHARS = 20;

/**
 * Full original article text used for grounding checks.
 */
function buildArticleSourceText(article) {
  const title = cleanField(article && article.title);
  const description = cleanField(article && article.description);
  const content = cleanField(article && article.content);
  return [title, description, content].filter(Boolean).join(' ');
}

function normalizeForMatch(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function splitIntoSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeClaimText(sentence))
    .filter((sentence) => sentence.length >= MIN_SENTENCE_CHARS);
}

function tokenize(value) {
  return normalizeForMatch(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

/**
 * Token-overlap ratio: |shared| / |claim tokens| (claim coverage by the sentence).
 */
function tokenOverlap(claimText, sentence) {
  const claimTokens = new Set(tokenize(claimText));
  const sentenceTokens = new Set(tokenize(sentence));
  if (claimTokens.size === 0 || sentenceTokens.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of claimTokens) {
    if (sentenceTokens.has(token)) {
      shared += 1;
    }
  }
  return shared / claimTokens.size;
}

/**
 * Attempts to locate the model quote verbatim inside the article text.
 * Never returns text that is absent from the source.
 */
function verifyModelQuote(articleText, quote) {
  const normalizedArticle = normalizeForMatch(articleText);
  const normalizedQuote = normalizeForMatch(quote);
  if (normalizedQuote.length < MIN_QUOTE_CHARS) {
    return { ok: false };
  }
  const index = normalizedArticle.indexOf(normalizedQuote);
  if (index < 0) {
    return { ok: false };
  }
  return {
    ok: true,
    text: normalizeClaimText(quote),
    location: {
      source: 'llm_verified',
      normalized_char_start: index,
      normalized_char_end: index + normalizedQuote.length,
      quote_chars: normalizedQuote.length
    }
  };
}

/**
 * Deterministic fallback: best-overlap sentence from the original article.
 */
function findDeterministicEvidence(articleText, claimText, minOverlap) {
  const floor = Number.isFinite(Number(minOverlap)) ? Number(minOverlap) : claimsConfig.evidence.minOverlap;
  const sentences = splitIntoSentences(articleText);
  let best = null;
  let bestScore = 0;
  let bestIndex = -1;

  for (let i = 0; i < sentences.length; i += 1) {
    const score = tokenOverlap(claimText, sentences[i]);
    if (score > bestScore) {
      bestScore = score;
      best = sentences[i];
      bestIndex = i;
    }
  }

  if (!best || bestScore < floor) {
    return { ok: false, overlap: bestScore };
  }

  return {
    ok: true,
    text: best,
    overlap: Number(bestScore.toFixed(4)),
    location: {
      source: 'deterministic_match',
      sentence_index: bestIndex,
      overlap: Number(bestScore.toFixed(4)),
      sentence_chars: best.length
    }
  };
}

/**
 * Resolves evidence text + provenance for one claim. Pure (no DB, no API).
 * Returns { hasEvidence, text, location, method, overlap }
 */
function resolveEvidence(article, claim, options = {}) {
  const articleText = options.articleText || buildArticleSourceText(article);
  const claimText = claim && (claim.claim_text || claim.claimText);

  if (!articleText || !claimText) {
    return { hasEvidence: false, method: 'none', reason: 'missing article text or claim text' };
  }

  const modelQuote = claim.evidence_quote !== undefined ? claim.evidence_quote : (claim.evidenceQuote || '');
  const verified = verifyModelQuote(articleText, modelQuote);
  if (verified.ok) {
    return {
      hasEvidence: true,
      text: verified.text,
      location: verified.location,
      method: 'llm_verified',
      overlap: null
    };
  }

  const fallback = findDeterministicEvidence(articleText, claimText, options.minOverlap);
  if (fallback.ok) {
    return {
      hasEvidence: true,
      text: fallback.text,
      location: fallback.location,
      method: 'deterministic_match',
      overlap: fallback.overlap
    };
  }

  return {
    hasEvidence: false,
    method: 'none',
    reason: 'no verbatim quote and no sentence above the overlap threshold',
    overlap: fallback.overlap
  };
}

/**
 * Persists one evidence row for a claim. Returns { created, skipped, reason }.
 * The (claim_id, article_id, evidence_hash) unique index is the final guard.
 */
async function persistEvidence(claimId, articleId, text, location) {
  const { ClaimEvidence } = require('../models');
  if (!ClaimEvidence) {
    return { created: false, skipped: false, reason: 'ClaimEvidence model unavailable' };
  }

  const normalized = normalizeClaimText(text);
  if (!normalized) {
    return { created: false, skipped: false, reason: 'empty evidence text' };
  }

  const evidenceHash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
  const [, created] = await ClaimEvidence.findOrCreate({
    where: { claim_id: claimId, article_id: articleId, evidence_hash: evidenceHash },
    defaults: {
      claim_id: claimId,
      article_id: articleId,
      evidence_text: normalized,
      evidence_location: location || null
    }
  });

  return created
    ? { created: true, skipped: false }
    : { created: false, skipped: true, reason: 'duplicate evidence' };
}

module.exports = {
  MIN_QUOTE_CHARS,
  buildArticleSourceText,
  normalizeForMatch,
  splitIntoSentences,
  tokenize,
  tokenOverlap,
  verifyModelQuote,
  findDeterministicEvidence,
  resolveEvidence,
  persistEvidence
};