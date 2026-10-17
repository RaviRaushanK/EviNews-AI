const { safeArticleUrl } = require('./eventPresentation');

function buildSummaryView(summary) {
  if (!summary) return null;
  const context = summary.context_snapshot || {};
  const output = summary.structured_output || {};
  const audit = summary.verification_metadata || {};
  const claims = new Map((context.claims || []).map(row => [row.claim_id, row]));
  const evidence = new Map((context.evidence || []).map(row => [row.evidence_id, row]));
  const reports = new Map((context.reports || []).map(row => [row.article_id, row]));
  const contradictions = new Map((context.contradictions || []).filter(row => row.contradiction_id).map(row => [row.contradiction_id, row]));
  const checks = new Map((audit.statements || []).map(row => [row.statement_id, row]));
  const citedClaims = new Set((output.statements || []).flatMap(row => row.source_claim_ids || []));
  const citedRelations = new Set((output.statements || []).flatMap(row => row.contradiction_ids || []));
  const statements = (output.statements || []).map(row => ({
    id: row.id, text: row.text, attribution: row.attribution,
    grounding_status: checks.get(row.id)?.grounding_status || 'needs_review',
    checks: checks.get(row.id)?.checks || [],
    warnings: checks.get(row.id)?.warnings || [],
    claims: (row.source_claim_ids || []).map(id => claims.get(id)).filter(Boolean),
    evidence: (row.evidence_ids || []).map(id => {
      const item = evidence.get(id);
      if (!item) return null;
      const report = reports.get(item.article_id);
      return { ...item, article: report ? { id: report.article_id, title: report.title, url: safeArticleUrl(report.url) } : null,
        source: report?.source || null };
    }).filter(Boolean),
    contradictions: (row.contradiction_ids || []).map(id => contradictions.get(id)).filter(Boolean)
  }));
  const sourceCount = new Set((context.claims || []).map(row => row.source?.name).filter(Boolean)).size;
  const grounding = summary.grounding_status;
  const state = summary.generation_status === 'failed' ? 'Generation Failed' :
    grounding === 'supported' ? 'Grounded' :
    grounding === 'unsupported' ? 'Insufficient Evidence' : 'Needs Review';
  return {
    summary, statements, sourceCount, state,
    coverage: context.coverage?.status || 'unknown',
    contradictionCoverage: context.coverage?.contradictions?.status || 'unknown',
    warnings: context.warnings || [],
    contradictions: [...contradictions.values()].filter(row => citedRelations.has(row.contradiction_id) ||
      (citedClaims.has(row.claim_id_1) && citedClaims.has(row.claim_id_2)))
  };
}

module.exports = { buildSummaryView };
