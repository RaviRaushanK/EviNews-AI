const summariesConfig = require('../config/summaries');
const contradictionsConfig = require('../config/contradictions');
const { validateId } = require('./contradictionQueryService');
const { parseTimelineDate } = require('../utils/timeline');
const { summaryError, stableSerialize, buildInputFingerprint, deepFreeze, requireContext } = require('../utils/summaryValidation');
const { evidenceHash } = require('../utils/summaryGrounding');
const { buildArticleSourceText } = require('./evidenceMappingService');

const clone = value => structuredClone(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = (rows, key) => rows.sort((a, b) => compare(String(a[key] || ''), String(b[key] || '')));
function reportContext(row) {
  return {
    article_id: row.article_id, title: row.title || '', url: row.url || null,
    source: clone(row.source || null), report_timestamp: parseTimelineDate(row.report_timestamp || row.timestamp),
    date_source: row.date_source || null
  };
}
function restrictReferences(snapshot) {
  const members = new Set(snapshot.reports.map(row => row.article_id));
  snapshot.claims = snapshot.claims.filter(row => members.has(row.article_id));
  const claims = new Set(snapshot.claims.map(row => row.claim_id));
  snapshot.evidence = snapshot.evidence.filter(row => claims.has(row.claim_id) && members.has(row.article_id));
  const evidence = new Set(snapshot.evidence.map(row => row.evidence_id));
  snapshot.contradictions = snapshot.contradictions.filter(row => claims.has(row.claim_id_1) && claims.has(row.claim_id_2));
  snapshot.changes = snapshot.changes.filter(row => claims.has(row.current_claim_id) && (!row.previous_claim_id || claims.has(row.previous_claim_id)));
  for (const row of snapshot.contradictions) row.evidence_ids = row.evidence_ids.filter(id => evidence.has(id));
  for (const row of snapshot.changes) {
    row.evidence_ids = row.evidence_ids.filter(id => evidence.has(id));
    row.previous_evidence_ids = row.previous_evidence_ids.filter(id => evidence.has(id));
  }
}
function counts(snapshot) { return Object.fromEntries(['reports', 'claims', 'evidence', 'contradictions', 'changes'].map(key => [key, snapshot[key].length])); }
function boundSnapshot(snapshot, config) {
  const original = counts(snapshot);
  snapshot.claims = snapshot.claims.slice(0, config.maxClaims);
  snapshot.evidence = snapshot.evidence.slice(0, config.maxEvidence);
  snapshot.contradictions = snapshot.contradictions.slice(0, config.maxContradictions);
  restrictReferences(snapshot);
  const update = () => {
    const retained = counts(snapshot);
    const truncated = Object.keys(original).some(key => retained[key] < original[key]);
    snapshot.coverage.bounds = { original, retained, truncated };
    if (truncated) snapshot.coverage.status = 'partial';
    snapshot.warnings = snapshot.warnings.filter(row => row.code !== 'SUMMARY_CONTEXT_TRUNCATED');
    if (truncated) snapshot.warnings.push({ code: 'SUMMARY_CONTEXT_TRUNCATED', message: 'Whole records were omitted to meet context bounds; references remain closed.' });
    snapshot.warnings.sort((a, b) => compare(stableSerialize(a), stableSerialize(b)));
    snapshot.metadata.input_fingerprint = buildInputFingerprint(snapshot);
  };
  update();
  // Drop complete units, never factual substrings, and close references each time.
  while (Buffer.byteLength(stableSerialize(snapshot), 'utf8') > config.maxContextBytes) {
    const section = ['changes', 'contradictions', 'evidence', 'claims', 'reports'].find(key => snapshot[key].length);
    if (!section) throw summaryError('SUMMARY_CONTEXT_TOO_LARGE', 'Event metadata and coverage exceed the context byte budget');
    snapshot[section].pop();
    restrictReferences(snapshot);
    update();
  }
  return deepFreeze(snapshot);
}

function createSummaryContextService({ timelineService, changeService, claimQuery, contradictionQuery, articleSourceQuery, config = summariesConfig }) {
  config = deepFreeze(clone(config));
  for (const [service, method] of [[timelineService, 'getTimelineForEvent'], [changeService, 'getChangesForEvent'], [claimQuery, 'auditEvidenceGrounding'], [contradictionQuery, 'getContradictionsForEvent']]) if (!service || typeof service[method] !== 'function') throw new TypeError('Summary context dependencies are required');
  for (const key of ['maxContextBytes', 'maxClaims', 'maxEvidence', 'maxContradictions']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new TypeError('Invalid summary bound: ' + key);
  return {
    async buildContextForEvent(eventId) {
      const id = validateId(eventId, 'event_id');
      const timeline = await timelineService.getTimelineForEvent(id);
      if (!timeline || !timeline.event || timeline.event.id !== id || !Array.isArray(timeline.entries)) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Timeline does not describe the requested event');
      const warnings = clone(timeline.warnings || []);
      let changes = null;
      let relations = null;
      try { changes = await changeService.getChangesForEvent(id); }
      catch (_) { warnings.push({ code: 'SUMMARY_CHANGES_UNAVAILABLE', message: 'Change context could not be read.' }); }
      const limit = Math.min(config.maxContradictions, contradictionsConfig.query.maxLimit);
      try { relations = await contradictionQuery.getContradictionsForEvent(id, { limit }); }
      catch (_) { warnings.push({ code: 'SUMMARY_CONTRADICTIONS_UNAVAILABLE', message: 'Stored contradiction context could not be read.' }); }
      for (const data of [changes, relations]) if (data && (!data.event || data.event.id !== id)) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Read service returned another event');
      warnings.push(...clone(changes && changes.warnings || []));
      const reports = timeline.entries.map(row => ({ ...reportContext(row), claims_status: row.claims_status, claim_count: row.claim_count }));
      if (new Set(reports.map(row => row.article_id)).size !== reports.length) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Duplicate report membership');
      reports.sort((a, b) => a.report_timestamp === b.report_timestamp ? compare(a.article_id, b.article_id) : !a.report_timestamp ? 1 : !b.report_timestamp ? -1 : a.report_timestamp < b.report_timestamp ? -1 : 1);
      const reportById = new Map(reports.map(row => [row.article_id, row]));
      const claims = [];
      const evidence = [];
      for (const entry of timeline.entries) {
        for (const claim of entry.claims || []) {
          if (claim.article_id !== entry.article_id) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Claim does not belong to its report');
          claims.push({ claim_id: claim.id, article_id: claim.article_id, claim_text: claim.claim_text, claim_type: claim.claim_type, extraction_confidence: claim.confidence_score ?? null, source: clone(entry.source || null), article_title: entry.title || '', report_timestamp: parseTimelineDate(entry.report_timestamp), date_source: entry.date_source || null });
          for (const item of claim.evidence || []) {
            if (item.claim_id !== claim.id || item.article_id !== claim.article_id || !reportById.has(item.article_id)) throw summaryError('SUMMARY_INVALID_EVIDENCE_REFERENCE', 'Evidence does not belong to its claim article or event');
            evidence.push({ evidence_id: item.id, claim_id: item.claim_id, article_id: item.article_id, evidence_text: item.evidence_text, evidence_hash: item.evidence_hash || null, evidence_location: clone(item.evidence_location || null), article: clone(reportById.get(item.article_id)), source_grounded: null, exact_source_grounded: null, source_excerpt_provenance: null });
          }
        }
      }
      const memberIds = reports.map(row => row.article_id);
      if (memberIds.length && evidence.length) {
        let audit = [];
        try { audit = await claimQuery.auditEvidenceGrounding(memberIds); }
        catch (_) { warnings.push({ code: 'SUMMARY_EVIDENCE_AUDIT_UNAVAILABLE', message: 'Source-occurrence audit could not be read.' }); }
        const byId = new Map((Array.isArray(audit) ? audit : []).map(row => [row.evidence_id, row]));
        for (const row of evidence) {
          const finding = byId.get(row.evidence_id);
          if (finding && (finding.claim_id !== row.claim_id || finding.article_id !== row.article_id)) throw summaryError('SUMMARY_INVALID_EVIDENCE_REFERENCE', 'Audit reference differs from the evidence snapshot');
          row.source_grounded = finding && typeof finding.grounded === 'boolean' ? finding.grounded : null;
        }
        let articles = null;
        try { if (articleSourceQuery) articles = await articleSourceQuery(memberIds); }
        catch (_) { /* Missing source reads leave excerpt provenance unavailable. */ }
        if (!Array.isArray(articles)) {
          warnings.push({ code: 'SUMMARY_EXCERPT_AUDIT_UNAVAILABLE', message: 'Case-sensitive excerpt provenance could not be established.' });
        } else {
          const byArticle = new Map();
          for (const article of articles) {
            if (!reportById.has(article.id) || byArticle.has(article.id)) throw summaryError('SUMMARY_INVALID_EVIDENCE_REFERENCE', 'Source audit returned an unrelated or duplicate article');
            byArticle.set(article.id, article);
          }
          for (const row of evidence) {
            const article = byArticle.get(row.article_id);
            const report = reportById.get(row.article_id);
            if (!article) continue;
            const source = article.source;
            if (!source?.id || !source.name) continue;
            if (source.id !== report.source?.id || source.name !== report.source?.name) throw summaryError('SUMMARY_INVALID_EVIDENCE_REFERENCE', 'Source audit attribution differs from the report');
            const sourceText = buildArticleSourceText(article).trim().replace(/\s+/g, ' ');
            const quote = typeof row.evidence_text === 'string' ? row.evidence_text.trim().replace(/\s+/g, ' ') : '';
            row.exact_source_grounded = Boolean(quote && sourceText.includes(quote));
            if (row.exact_source_grounded && row.evidence_hash === evidenceHash(row.evidence_text)) {
              row.source_excerpt_provenance = { article_id: article.id, source_id: source.id, source_name: source.name, evidence_hash: row.evidence_hash, source_text_hash: evidenceHash(sourceText) };
            }
          }
        }
      }
      const sourceIds = new Set(claims.map(row => row.source?.id || row.source?.name).filter(Boolean));
      if (sourceIds.size === 1) warnings.push({ code: 'SUMMARY_SINGLE_SOURCE', message: 'Claims in this summary context have one named source.' });
      const contradictions = (relations && relations.contradictions || []).map(row => {
        const first = row.claim_id_1 || row.claim_1 && row.claim_1.id;
        const second = row.claim_id_2 || row.claim_2 && row.claim_2.id;
        return { contradiction_id: row.id || null, claim_id_1: first, claim_id_2: second, contradiction_type: row.contradiction_type, status: row.status, reason: row.reason || null, evidence_ids: evidence.filter(item => [first, second].includes(item.claim_id)).map(item => item.evidence_id).sort() };
      });
      const claimIds = new Set(claims.map(row => row.claim_id));
      const claimById = new Map(claims.map(row => [row.claim_id, row]));
      const evidenceById = new Map(evidence.map(row => [row.evidence_id, row]));
      const composedChanges = (changes && changes.changes || []).map(row => {
        if (!claimIds.has(row.current_claim_id) || row.previous_claim_id && !claimIds.has(row.previous_claim_id)) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Change refers to an unknown claim');
        for (const report of [row.previous_report, row.current_report]) if (report && !reportById.has(report.article_id)) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Change refers to an unknown report');
        if (!row.current_report || row.current_report.article_id !== claimById.get(row.current_claim_id).article_id || row.previous_claim_id && (!row.previous_report || row.previous_report.article_id !== claimById.get(row.previous_claim_id).article_id)) throw summaryError('SUMMARY_CROSS_EVENT_REFERENCE', 'Change report does not belong to its referenced claim');
        const refs = (items, claimId) => (items || []).map(item => {
          const known = evidenceById.get(item.id);
          if (!known || known.claim_id !== claimId) throw summaryError('SUMMARY_INVALID_EVIDENCE_REFERENCE', 'Change evidence belongs to another claim');
          return item.id;
        }).sort();
        return { category: row.category, rule_id: row.rule_id, previous_claim_id: row.previous_claim_id || null, current_claim_id: row.current_claim_id, previous_report: row.previous_report ? reportContext(row.previous_report) : null, current_report: row.current_report ? reportContext(row.current_report) : null, reason: row.reason, previous_value: row.previous_value ?? null, current_value: row.current_value ?? null, previous_context: clone(row.previous_context || null), current_context: clone(row.current_context || null), evidence_ids: refs(row.evidence, row.current_claim_id), previous_evidence_ids: refs(row.previous_evidence, row.previous_claim_id) };
      });
      const available = Boolean(relations && Array.isArray(relations.contradictions));
      const contradictionCoverage = !available ? 'unknown' : contradictions.length >= limit ? 'limited' : 'unknown';
      warnings.push({ code: 'SUMMARY_CONTRADICTION_COVERAGE_' + contradictionCoverage.toUpperCase(), message: contradictionCoverage === 'limited' ? 'Stored contradiction results reached their cap.' : 'Stored results do not establish that all pairs have been evaluated.' });
      const snapshot = {
        event: { id, title: timeline.event.title || '', description: timeline.event.description || null, status: timeline.event.status || null, event_date: parseTimelineDate(timeline.event.event_date) },
        reports, claims: order(claims, 'claim_id'), evidence: order(evidence, 'evidence_id'),
        contradictions: contradictions.sort((a, b) => compare(stableSerialize(a), stableSerialize(b))),
        changes: composedChanges.sort((a, b) => compare(stableSerialize(a), stableSerialize(b))),
        coverage: { status: timeline.completeness && timeline.completeness.status === 'partial' || !changes || !available ? 'partial' : 'unknown', timeline: clone(timeline.completeness || null), changes: clone(changes && changes.completeness || null), baseline: clone(changes && changes.baseline || null), contradictions: { status: contradictionCoverage, available, returned: contradictions.length, limit } },
        warnings,
        metadata: { provider: config.provider, model: config.model, prompt_version: config.promptVersion, contract_version: config.contractVersion }
      };
      requireContext(snapshot);
      snapshot.warnings.sort((a, b) => compare(stableSerialize(a), stableSerialize(b)));
      // Retain a digest of omitted inputs too, so caps cannot hide changed sources.
      snapshot.metadata.source_snapshot_fingerprint = buildInputFingerprint(snapshot);
      return boundSnapshot(snapshot, config);
    }
  };
}

let service;
async function buildContextForEvent(eventId) {
  if (!service) service = createSummaryContextService({
    timelineService: require('./eventTimelineService'), changeService: require('./eventChangeService'), claimQuery: require('./claimQueryService'), contradictionQuery: require('./contradictionQueryService'),
    articleSourceQuery: async ids => {
      const { Article, Source } = require('../models');
      const rows = await Article.findAll({ where: { id: ids }, attributes: ['id', 'title', 'description', 'content'], include: [{ model: Source, attributes: ['id', 'name'], required: false }] });
      return rows.map(row => { const value = row.toJSON(); return { ...value, source: value.Source || null }; });
    }
  });
  return service.buildContextForEvent(eventId);
}
module.exports = { createSummaryContextService, buildContextForEvent };
