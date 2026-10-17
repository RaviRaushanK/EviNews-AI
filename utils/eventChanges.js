const { parseTimelineDate } = require('./timeline');

const CATEGORIES = Object.freeze(['new_information', 'previously_reported', 'changed_value', 'updated_information', 'contradictory_information', 'unclassified']);

function normalizeClaimText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase().replace(/[.!]+$/, '') : '';
}

function extractNumbers(text) {
  return [...String(text || '').matchAll(/\b\d+(?:,\d{3})*(?:\.\d+)?\b/g)].map((match) => match[0]);
}

function extractPercentages(text) {
  return [...String(text || '').matchAll(/\b(\d+(?:\.\d+)?)\s*(%|percent\b)/gi)].map((match) => ({ value: Number(match[1]), unit: match[2].toLowerCase() }));
}

function extractUnits(text) {
  return [...String(text || '').matchAll(/\$|%|\b(?:percent|people|homes|workers|jobs|million|billion|km|miles|kg|tonnes)\b/gi)].map((match) => match[0].toLowerCase());
}

function extractDates(text) {
  return [...String(text || '').matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((match) => match[0]).filter((date) => parseTimelineDate(date) !== null);
}

function hasNegation(text) {
  return /\b(?:no|not|never|without|neither|nor|cannot|denied)\b|\b\w+n['\u2019]t\b/i.test(String(text || ''));
}

function extractAttribution(text) {
  const match = String(text || '').match(/\b([^.!?:]+?)\s+(?:said|says|reported|stated|claimed|announced)\b/i);
  if (match) return normalizeClaimText(match[1]);
  const according = String(text || '').match(/\baccording to\s+([^,.;:]+)/i);
  if (according) return normalizeClaimText(according[1]);
  const colon = String(text || '').match(/^([^:]+):\s*["']/);
  return colon ? normalizeClaimText(colon[1]) : null;
}

function extractMetricValue(claim) {
  const text = normalizeClaimText(claim && claim.claim_text);
  if (!text || hasNegation(text) || (claim && ['quote', 'opinion'].includes(claim.claim_type))) return null;
  if (/\b(?:it|they|these|those|some|several)\b/.test(text)) return null;
  const dates = extractDates(text);
  const reference = dates.length ? dates.join('|') : normalizeClaimText(claim && claim.reference_period);
  if (!reference) return null;
  // Only one count, percent, or dollar amount; the rest of the sentence must match.
  const matches = [...text.matchAll(/\$(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s+(million|billion))?|\b(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|percent\b|people\b|homes\b|workers\b|jobs\b)/g)];
  if (matches.length !== 1) return null;
  if (extractNumbers(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')).length !== 1) return null;
  const match = matches[0];
  if (match.index > 0 && /[-\d.]/.test(text[match.index - 1])) return null;
  const value = Number((match[1] || match[3]).replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  const unit = match[1] ? '$' + (match[2] ? ' ' + match[2] : '') : match[4];
  const metric = match[1] ? 'money' : /%|percent/.test(unit) ? 'percentage' : 'count';
  const skeleton = text.slice(0, match.index) + '<value:' + unit + '>' + text.slice(match.index + match[0].length);
  return { value, unit, metric, reference_period: reference, attribution: extractAttribution(text), skeleton };
}

function extractTemporalState(claim) {
  const text = normalizeClaimText(claim && claim.claim_text);
  if (!claim || claim.claim_type !== 'fact' || hasNegation(text) || extractAttribution(text)) return null;
  const match = text.match(/^(.+?) (?:was )?(suspended|resumed|closed|reopened) on (\d{4}-\d{2}-\d{2})(?: after (repairs|maintenance))?$/);
  if (!match || !parseTimelineDate(match[3])) return null;
  if (/\b(?:it|they|these|those)\b/.test(match[1])) return null;
  return { subject: match[1], state: match[2], reference_date: match[3] };
}

function result(category, ruleId, current, previous, reason, details = {}) {
  return {
    category,
    previous_claim_id: previous && previous.id || null,
    current_claim_id: current && current.id || null,
    reason,
    rule_id: ruleId,
    previous_value: null,
    current_value: null,
    previous_context: null,
    current_context: null,
    ...structuredClone(details)
  };
}

function sharesContext(first, second) {
  const ignored = new Set(['the', 'a', 'an', 'on', 'in', 'at', 'to', 'of', 'and', 'was', 'is', 'were', 'for', 'by', 'with', 'said', 'reported']);
  const tokens = (text) => new Set((normalizeClaimText(text).match(/[a-z]+/g) || []).filter((word) => word.length > 2 && !ignored.has(word)));
  const a = tokens(first);
  return [...tokens(second)].some((word) => a.has(word));
}

function compareClaimPair(current, previous, contradictions = []) {
  const currentText = normalizeClaimText(current && current.claim_text);
  const previousText = normalizeClaimText(previous && previous.claim_text);
  if (!currentText || !previousText) return result('unclassified', 'AMBIGUOUS_MATCH', current, previous, 'Missing claim text; comparison unavailable.');
  const relation = (Array.isArray(contradictions) ? contradictions : []).filter((row) =>
    row && ['direct', 'partial', 'temporal'].includes(row.contradiction_type) &&
    current.id && previous.id && current.id !== previous.id &&
    ((row.claim_id_1 === current.id && row.claim_id_2 === previous.id) || (row.claim_id_2 === current.id && row.claim_id_1 === previous.id)))
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')))[0];
  if (relation) return result('contradictory_information', 'STORED_CONTRADICTION', current, previous, relation.reason || 'Stored contradiction annotation.', {
    contradiction: { id: relation.id || null, contradiction_type: relation.contradiction_type, status: relation.status || null, reason: relation.reason || null }
  });
  if (!current.claim_type || current.claim_type !== previous.claim_type) return result('unclassified', 'AMBIGUOUS_MATCH', current, previous, 'Claim types differ or are unavailable.');
  const sameReference = normalizeClaimText(current.reference_period) === normalizeClaimText(previous.reference_period);
  const unattributedQuote = current.claim_type === 'quote' && !extractAttribution(currentText);
  if (currentText === previousText && sameReference && !unattributedQuote) return result('previously_reported', 'MATCH_EXACT_NARROW', current, previous, 'Same claim type, reference context, and text after whitespace, case, and terminal punctuation normalization.');
  const a = extractMetricValue(previous);
  const b = extractMetricValue(current);
  if (a && b && sameReference && a.skeleton === b.skeleton && a.reference_period === b.reference_period && a.unit === b.unit && a.metric === b.metric && a.attribution === b.attribution && a.value !== b.value) {
    return result('changed_value', 'VALUE_CHANGED', current, previous, 'One reported value differs within an otherwise identical statement and reference period; this does not establish a contradiction or update.', {
      previous_value: a.value, current_value: b.value, previous_context: a, current_context: b
    });
  }
  const before = extractTemporalState(previous);
  const after = extractTemporalState(current);
  if (before && after && before.subject === after.subject && after.reference_date > before.reference_date &&
      ((before.state === 'suspended' && after.state === 'resumed') || (before.state === 'closed' && after.state === 'reopened'))) {
    return result('updated_information', 'TEMPORAL_UPDATE', current, previous, 'An explicit later reference date describes a narrowly recognized restoration of the same subject.', {
      previous_context: before, current_context: after
    });
  }
  return sharesContext(currentText, previousText)
    ? result('unclassified', 'AMBIGUOUS_MATCH', current, previous, 'Overlapping wording is insufficient to establish the same proposition, attribution, scope, or reference time.')
    : result('new_information', 'NEW_NO_MATCH', current, null, 'No narrow match to earlier supplied claims; newly reported does not mean factually novel.');
}

// The caller supplies strictly earlier claims; tied report groups are not earlier.
function compareClaimToHistory(current, previousClaims = [], contradictions = []) {
  if (!current || !normalizeClaimText(current.claim_text)) return result('unclassified', 'AMBIGUOUS_MATCH', current, null, 'Missing current claim text.');
  const history = (Array.isArray(previousClaims) ? previousClaims : []).filter((claim) => claim && claim.id !== current.id)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  if (history.length === 0) return result('new_information', 'NEW_NO_MATCH', current, null, 'No earlier supplied claims; newly reported does not mean factually novel.');
  const comparisons = history.map((claim) => compareClaimPair(current, claim, contradictions));
  for (const category of ['contradictory_information', 'previously_reported']) {
    const match = comparisons.find((item) => item.category === category);
    if (match) return match;
  }
  const specific = comparisons.filter((item) => ['changed_value', 'updated_information'].includes(item.category));
  if (specific.length === 1) return specific[0];
  if (specific.length > 1) return result('unclassified', 'AMBIGUOUS_MATCH', current, null, 'Multiple earlier claims could be the baseline; no unique comparison.', { previous_context: { candidate_claim_ids: specific.map((item) => item.previous_claim_id) } });
  return comparisons.find((item) => item.category === 'unclassified') || comparisons[0];
}

function compareClaims(currentClaims = [], previousClaims = [], contradictions = []) {
  return (Array.isArray(currentClaims) ? currentClaims : []).map((claim) => compareClaimToHistory(claim, previousClaims, contradictions));
}

module.exports = { CATEGORIES, normalizeClaimText, extractNumbers, extractPercentages, extractUnits, extractDates, hasNegation, extractAttribution, extractMetricValue, extractTemporalState, compareClaimPair, compareClaimToHistory, compareClaims };
