const crypto = require('crypto');
const config = require('../config/summaries');

function summaryError(code, message) { const error = new Error(message); error.code = code; return error; }
function stableSerialize(value) {
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError('Only JSON objects are fingerprinted');
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}';
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('Only finite JSON values are fingerprinted');
  return JSON.stringify(value);
}
function buildInputFingerprint(context) {
  const input = structuredClone(context);
  delete input.metadata.input_fingerprint;
  // Source report dates are inputs; no runtime clock or random generation ID is used.
  return crypto.createHash('sha256').update(stableSerialize(input), 'utf8').digest('hex');
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function requireContext(context) {
  if (!context || !context.event || typeof context.event.id !== 'string' || !Array.isArray(context.reports) || !Array.isArray(context.claims) || !Array.isArray(context.evidence) || !Array.isArray(context.contradictions)) throw summaryError('SUMMARY_INVALID_CONTEXT', 'A scoped summary context is required');
  const members = new Set(context.reports.map(row => row.article_id));
  if (members.size !== context.reports.length || context.reports.some(row => typeof row.article_id !== 'string' || !row.article_id.trim())) throw summaryError('SUMMARY_INVALID_CONTEXT', 'Report membership IDs are invalid or duplicated');
  const claims = new Map();
  for (const claim of context.claims) {
    if (!claim || typeof claim.claim_id !== 'string' || !claim.claim_id.trim() || claims.has(claim.claim_id) || !members.has(claim.article_id)) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Claim is outside the event snapshot or duplicated');
    if (typeof claim.claim_text !== 'string' || !claim.claim_text.trim()) throw summaryError('SUMMARY_INVALID_CONTEXT', 'Source claim text is missing');
    claims.set(claim.claim_id, claim);
  }
  const evidence = new Map();
  for (const row of context.evidence) {
    if (!row || typeof row.evidence_id !== 'string' || evidence.has(row.evidence_id) || !claims.has(row.claim_id) || !members.has(row.article_id) || claims.get(row.claim_id).article_id !== row.article_id) throw summaryError('SUMMARY_INVALID_EVIDENCE_REFERENCE', 'Evidence is outside the event or its claim article');
    evidence.set(row.evidence_id, row);
  }
  const contradictions = new Map();
  for (const row of context.contradictions) {
    if (!claims.has(row.claim_id_1) || !claims.has(row.claim_id_2) || row.claim_id_1 === row.claim_id_2 || !['direct', 'partial', 'temporal'].includes(row.contradiction_type) || !['unresolved', 'resolved', 'under_review'].includes(row.status)) throw summaryError('SUMMARY_INVALID_CONTRADICTION_REFERENCE', 'Contradiction is outside the event snapshot');
    if (row.contradiction_id !== null) {
      if (typeof row.contradiction_id !== 'string' || contradictions.has(row.contradiction_id)) throw summaryError('SUMMARY_INVALID_CONTRADICTION_REFERENCE', 'Contradiction ID is invalid or duplicated');
      contradictions.set(row.contradiction_id, row);
    }
  }
  return { members, claims, evidence, contradictions };
}
function exactFields(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
function idArray(value) { return Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 100 && id.trim() === id) && new Set(value).size === value.length; }
function requireSummaryModel(settings = config) {
  if (!settings || typeof settings.model !== 'string' || !settings.model.trim()) throw summaryError('SUMMARY_MODEL_NOT_CONFIGURED', 'GEMINI_SUMMARY_MODEL must be explicitly configured');
  if (settings.provider !== 'gemini') throw summaryError('SUMMARY_PROVIDER_NOT_SUPPORTED', 'Only the configured Gemini summary provider is supported');
  return settings.model;
}
function validateSummaryOutput(output, context, limits = config) {
  const scoped = requireContext(context);
  if (!exactFields(output, ['statements']) || !Array.isArray(output.statements) || output.statements.length > limits.maxStatements) throw summaryError('SUMMARY_INVALID_OUTPUT', 'Expected a bounded statements array only');
  const ids = new Set();
  const fields = ['id', 'text', 'source_claim_ids', 'evidence_ids', 'contradiction_ids', 'attribution'];
  for (const statement of output.statements) {
    if (!exactFields(statement, fields) || typeof statement.id !== 'string' || !/^s[1-9]\d{0,5}$/.test(statement.id) || ids.has(statement.id) || typeof statement.text !== 'string' || !statement.text.trim() || statement.text.length > limits.maxStatementChars || !idArray(statement.source_claim_ids) || !idArray(statement.evidence_ids) || !idArray(statement.contradiction_ids) || !(statement.attribution === null || (typeof statement.attribution === 'string' && statement.attribution.trim() && statement.attribution.length <= limits.maxStatementChars))) throw summaryError('SUMMARY_INVALID_STATEMENT', 'Statement fields are malformed or duplicated');
    ids.add(statement.id);
    for (const id of statement.source_claim_ids) if (!scoped.claims.has(id)) throw summaryError('SUMMARY_UNKNOWN_CLAIM', 'Unknown source claim');
    for (const id of statement.evidence_ids) {
      if (!scoped.evidence.has(id)) throw summaryError('SUMMARY_UNKNOWN_EVIDENCE', 'Unknown evidence');
      if (!statement.source_claim_ids.includes(scoped.evidence.get(id).claim_id)) throw summaryError('SUMMARY_WRONG_EVIDENCE_CLAIM', 'Evidence does not belong to a cited claim');
    }
    for (const id of statement.contradiction_ids) {
      const row = scoped.contradictions.get(id);
      if (!row) throw summaryError('SUMMARY_UNKNOWN_CONTRADICTION', 'Unknown contradiction');
      if (![row.claim_id_1, row.claim_id_2].every(claimId => statement.source_claim_ids.includes(claimId))) throw summaryError('SUMMARY_WRONG_CONTRADICTION_CLAIMS', 'Contradiction does not link the cited claims');
    }
  }
  return deepFreeze(structuredClone(output));
}

module.exports = { summaryError, stableSerialize, buildInputFingerprint, deepFreeze, requireContext, requireSummaryModel, validateSummaryOutput };
