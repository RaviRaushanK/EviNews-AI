const crypto = require('crypto');
const { validateSummaryOutput, deepFreeze } = require('./summaryValidation');

function evidenceHash(text) { return crypto.createHash('sha256').update(text.trim().replace(/\s+/g, ' '), 'utf8').digest('hex'); }
function whitespace(text) { return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : ''; }
function groundStatement(statement, context) {
  const checks = [];
  const warnings = [];
  let supportBasis = null;
  const finish = status => deepFreeze({ statement_id: statement && statement.id || null, grounding_status: status, verification_status: 'needs_review', factual_truth_verified: false, support_basis: supportBasis, checks, warnings });
  try { validateSummaryOutput({ statements: [statement] }, context); }
  catch (error) { checks.push({ code: error.code || 'SUMMARY_INVALID_OUTPUT', passed: false }); return finish('unsupported'); }
  if (!statement.source_claim_ids.length || !statement.evidence_ids.length) { checks.push({ code: 'MISSING_SUPPORT', passed: false }); return finish('unsupported'); }
  const evidence = context.evidence.filter(row => statement.evidence_ids.includes(row.evidence_id));
  if (evidence.some(row => typeof row.evidence_text !== 'string' || !row.evidence_text.trim())) { checks.push({ code: 'EMPTY_EVIDENCE', passed: false }); return finish('unsupported'); }
  if (evidence.some(row => row.evidence_hash && evidenceHash(row.evidence_text) !== row.evidence_hash)) { checks.push({ code: 'STALE_EVIDENCE_HASH', passed: false }); return finish('unsupported'); }
  if (evidence.some(row => row.source_grounded === false)) { checks.push({ code: 'EVIDENCE_NOT_IN_SOURCE', passed: false }); return finish('unsupported'); }
  if (evidence.some(row => !row.evidence_hash || row.source_grounded !== true)) { checks.push({ code: 'EVIDENCE_AUDIT_UNAVAILABLE', passed: false }); return finish('needs_review'); }
  checks.push({ code: 'EVIDENCE_HASH_AND_SOURCE_OCCURRENCE', passed: true });
  const claims = context.claims.filter(row => statement.source_claim_ids.includes(row.claim_id));
  const names = [...new Set(claims.map(row => row.source && row.source.name).filter(Boolean))].sort();
  if (!names.length || claims.some(row => !row.source || !row.source.name) || statement.attribution !== names.join('; ')) { checks.push({ code: 'ATTRIBUTION_NOT_ESTABLISHED', passed: false }); return finish('needs_review'); }
  let supported = 0;
  const excerptForm = names.length === 1 && whitespace(statement.text).startsWith(names[0] + ' excerpt: ');
  if (excerptForm) {
    const row = evidence[0];
    const claim = claims[0];
    const report = context.reports.find(item => item.article_id === row.article_id);
    const provenance = row.source_excerpt_provenance;
    const valid = context.metadata?.contract_version === 'phase7-summary-v2' && claims.length === 1 && evidence.length === 1 &&
      row.exact_source_grounded === true && provenance && provenance.article_id === row.article_id &&
      provenance.evidence_hash === row.evidence_hash && /^[a-f0-9]{64}$/.test(provenance.source_text_hash || '') &&
      typeof provenance.source_id === 'string' && provenance.source_id &&
      provenance.source_id === claim.source.id && provenance.source_id === report?.source?.id &&
      provenance.source_name === claim.source.name && provenance.source_name === report?.source?.name &&
      whitespace(statement.text) === whitespace(provenance.source_name + ' excerpt: ' + row.evidence_text);
    checks.push({ code: 'EXACT_ATTRIBUTED_SOURCE_EXCERPT', passed: Boolean(valid) });
    if (!valid) return finish('needs_review');
    supportBasis = 'source_excerpt';
    warnings.push({ code: 'EXCERPT_PROVENANCE_ONLY', message: 'This excerpt is traceable to its source; the linked claim is not independently verified.' });
    supported = 1;
  } else {
    for (const claim of claims) {
      const exact = statement.text === claim.claim_text || statement.text === claim.source.name + ' reports: ' + claim.claim_text;
      const quoted = evidence.some(row => row.claim_id === claim.claim_id && whitespace(row.evidence_text) === whitespace(claim.claim_text));
      if (exact && quoted) supported++;
    }
    checks.push({ code: 'EXACT_ATTRIBUTED_EXTRACTIVE_SUPPORT', passed: supported === claims.length, supported_claims: supported, cited_claims: claims.length });
    if (!supported) return finish('needs_review');
    supportBasis = 'exact_claim';
  }
  if (supported !== claims.length) return finish('partially_supported');
  const relations = context.contradictions.filter(row => [row.claim_id_1, row.claim_id_2].some(id => statement.source_claim_ids.includes(id)));
  if (relations.length) {
    warnings.push({ code: 'STORED_CONTRADICTION_CONTEXT', relations: structuredClone(relations) });
    if (relations.some(row => row.status !== 'resolved')) return finish('conflicting');
    return finish('needs_review');
  }
  if (context.coverage && (context.coverage.status !== 'complete' || context.coverage.contradictions && context.coverage.contradictions.status !== 'complete')) warnings.push({ code: 'INCOMPLETE_COVERAGE', message: 'Source support does not establish complete coverage or factual truth.' });
  return finish(supported === claims.length ? 'supported' : 'partially_supported');
}
function verifySummary(output, context) {
  const validated = validateSummaryOutput(output, context);
  const statements = validated.statements.map(statement => groundStatement(statement, context));
  let status = 'needs_review';
  if (statements.length) {
    if (statements.some(row => row.grounding_status === 'conflicting')) status = 'conflicting';
    else if (statements.every(row => row.grounding_status === 'supported')) status = 'supported';
    else if (statements.some(row => ['supported', 'partially_supported'].includes(row.grounding_status))) status = 'partially_supported';
    else if (statements.every(row => row.grounding_status === 'unsupported')) status = 'unsupported';
  }
  return deepFreeze({ grounding_status: status, verification_status: 'needs_review', factual_truth_verified: false, statements });
}

module.exports = { evidenceHash, groundStatement, verifySummary };
