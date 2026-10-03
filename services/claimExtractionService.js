/**
 * Claim extraction service (Phase 4).
 * Builds the extraction prompt from the ORIGINAL article text, calls Gemini
 * text generation, defensively parses JSON, and validates the payload.
 *
 * No database access here — persistence happens in claimProcessingService.
 */

const claimsConfig = require('../config/claims');
const geminiClientService = require('./geminiClientService');
const { cleanField, truncateAtWordBoundary } = require('./articleProcessingService');
const { validateClaimsPayload } = require('../utils/claimValidation');

/**
 * Builds the article text supplied to Gemini.
 * Deliberately does NOT reuse the embedding title-weighting behaviour.
 */
function buildClaimArticleText(article, maxChars) {
  const limit = maxChars || claimsConfig.extraction.maxArticleChars;
  const title = cleanField(article && article.title);
  const description = cleanField(article && article.description);
  const content = cleanField(article && article.content);

  const parts = [];
  if (title) {
    parts.push(title);
  }
  if (description) {
    parts.push(description);
  }
  if (content) {
    parts.push(content);
  }

  const combined = truncateAtWordBoundary(parts.join('\n\n'), limit);
  return { text: combined, length: combined.length, title, description, content };
}

function buildPrompt(articleText, maxClaims) {
  return [
    'You are a careful news-claim extraction assistant.',
    'Read the article text below and extract only the most important, verifiable claims.',
    '',
    'Rules:',
    `1. Return at most ${maxClaims} claims.`,
    '2. Each claim must be a single, self-contained statement written in your own concise wording.',
    '3. Classify each claim as exactly one of: fact, opinion, quote, data.',
    '4. Provide a confidence value between 0 and 1 for each claim.',
    '5. Provide evidence_quote: a short excerpt COPIED VERBATIM from the article text below that',
    '   supports the claim. Never invent, paraphrase, or translate evidence. If you cannot find',
    '   a supporting excerpt, use an empty string for evidence_quote.',
    '6. If the article contains no meaningful claims, return {"claims":[]}.',
    '7. Return VALID JSON ONLY. No markdown fences, no commentary, no trailing text.',
    '',
    'Required JSON shape:',
    '{"claims":[{"claim_text":"...","claim_type":"fact|opinion|quote|data","confidence":0.0,"evidence_quote":"..."}]}',
    '',
    'ARTICLE TEXT:',
    '"""',
    articleText,
    '"""'
  ].join('\n');
}

/**
 * Strips markdown fences and isolates the JSON object, then parses it.
 * Throws GEMINI_PARSE_ERROR when parsing is impossible.
 */
function parseModelJson(rawText) {
  let text = String(rawText || '').trim();

  // Remove ```json ... ``` or ``` ... ``` fences.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    text = fenceMatch[1].trim();
  }

  // Fall back to the outermost JSON object if extra prose slipped through.
  if (!text.startsWith('{')) {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    const parseError = new Error(`Gemini response was not valid JSON: ${(error && error.message) || 'parse failed'}`);
    parseError.code = 'GEMINI_PARSE_ERROR';
    throw parseError;
  }
}

/**
 * Extracts and validates claims for one article.
 * Returns { ok, claims: [...], rejected: [...], model, attempts, textLength }
 * Throws an error with a .code for provider/parse failures.
 */
async function extractClaimsForArticle(article, options = {}) {
  const built = buildClaimArticleText(article, options.maxArticleChars);
  if (!built.text || built.text.length < 30) {
    const error = new Error('insufficient article text for claim extraction (title/description/content too short)');
    error.code = 'CLAIM_INSUFFICIENT_TEXT';
    throw error;
  }

  const maxClaims = options.maxClaims || claimsConfig.extraction.maxClaimsPerArticle;
  const prompt = buildPrompt(built.text, maxClaims);

  const generated = await geminiClientService.generateText(prompt, {
    model: options.model,
    timeoutMs: options.timeoutMs,
    retryDelayMs: options.retryDelayMs
  });

  const parsed = parseModelJson(generated.text);
  const validation = validateClaimsPayload(parsed, { maxClaims });

  if (!validation.ok) {
    const shapeError = new Error(`Gemini payload shape invalid: ${validation.error}`);
    shapeError.code = 'GEMINI_PARSE_ERROR';
    throw shapeError;
  }

  return {
    ok: true,
    claims: validation.accepted,
    rejected: validation.rejected,
    model: generated.model,
    attempts: generated.attempts,
    textLength: built.length,
    articleText: built.text
  };
}

module.exports = {
  buildClaimArticleText,
  buildPrompt,
  parseModelJson,
  extractClaimsForArticle
};