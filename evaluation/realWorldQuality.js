'use strict';

const crypto = require('node:crypto');
const VERSION = '8w-quality-v1';
const SCENARIOS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const CLASSES = ['direct', 'partial', 'temporal', 'none'];
const CHANGES = ['new_information', 'previously_reported', 'changed_value', 'updated_information', 'contradictory_information', 'unclassified'];
const STAGE_METRICS = {
  technical: ['technical_completion'], schema: ['schema_validity'], claims: ['claim_precision', 'claim_recall'],
  evidence: ['evidence_traceability', 'evidence_support'],
  summary: ['unsupported_statement_rate', 'attribution_accuracy', 'summary_coverage', 'redundancy'],
  contradictions: ['contradiction_candidate_recall', 'contradiction_classification', 'conflict_preservation'],
  timeline: ['timeline_ordering'], changes: ['change_precision', 'change_recall'],
  grounding: ['grounding_decision_accuracy', 'unsupported_acceptance_rate'],
  abstention: ['insufficient_grounding_accuracy'], idempotency: ['idempotency']
};
function invalid() { throw Object.assign(new Error('Invalid or incomplete quality artifact'), { code: 'QUALITY_ARTIFACT_INVALID' }); }
function check(value) { if (!value) invalid(); }
function text(value) { check(typeof value === 'string' && value.trim().length > 0 && value.length <= 64000); }
function bool(value) { check(typeof value === 'boolean'); }
function id(value) { check(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)); }
function list(value) { check(Array.isArray(value) && value.length <= 1000); return value; }
function fields(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)));
}
function unique(values) { check(new Set(values).size === values.length); }
function ids(rows) { const result = new Map(); for (const row of list(rows)) { id(row.id); check(!result.has(row.id)); result.set(row.id, row); } return result; }
function refs(values, map) { list(values); unique(values); values.forEach(value => { id(value); check(map.has(value)); }); }
function timestamp(value, nullable = false) {
  if (nullable && value === null) return;
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value));
  const date = new Date(value); check(Number.isFinite(date.getTime()) && date.toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'));
}
function safeArtifactPath(value) {
  check(typeof value === 'string' && value.length <= 240 && /^(?:artifacts|fixtures|evaluation\/corpora)\/[a-zA-Z0-9_/-]+\.(?:json|txt)$/.test(value));
  check(!value.split('/').some(part => !part || part === '..' || /(?:^\.|env|secret|credential|password|token|private)/i.test(part)));
  return value;
}
function validateSourceUrl(value) {
  check(typeof value === 'string' && value.length <= 4096 && /^https:\/\//i.test(value));
  check(!/[\\\u0000-\u0020\u007f]/.test(value) && !/%(?![a-f0-9]{2})/i.test(value));
  let parsed;
  try { parsed = new URL(value); } catch (_) { invalid(); }
  check(parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password);
  return parsed; // Metadata only: URL parsing does not resolve or fetch the host.
}
// Reject representations that JSON canonicalization could silently omit or execute.
function jsonData(value, depth = 0, budget = { count: 0 }) {
  check(depth <= 40 && ++budget.count <= 50000);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { check(value.length <= 64000); return; }
  if (typeof value === 'number') { check(Number.isFinite(value)); return; }
  check(value && typeof value === 'object' && [Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    check(typeof key === 'string'); const descriptor = descriptors[key];
    if (Array.isArray(value) && key === 'length') continue;
    check(descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    if (Array.isArray(value)) check(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length);
    jsonData(descriptor.value, depth + 1, budget);
  }
  if (Array.isArray(value)) check(Object.keys(value).length === value.length);
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function review(value) {
  fields(value, ['status', 'reviewers', 'adjudicator', 'notes']); check(value.status === 'resolved');
  list(value.reviewers); check(value.reviewers.length >= 2); unique(value.reviewers); value.reviewers.forEach(id); id(value.adjudicator);
  check(typeof value.notes === 'string');
}
function nullableLabel(value, options) { check(value === null || options.includes(value)); }
function claimIdentity(claim) {
  const { id: ignoredId, equivalence_group: ignoredGroup, ...identity } = claim;
  return canonical({ ...identity, text: claim.text.trim().replace(/\s+/g, ' ') });
}
function relationIdentity(row, event) {
  const pair = row.claim_ids.map(value => claimIdentity(event.claims.find(claim => claim.id === value)));
  const directional = ['normal_update', 'correction'].includes(row.kind);
  return canonical(directional ? [row.kind, ...pair] : ['symmetric', ...pair.sort()]);
}
function deduplicate(rows, identity, annotation) {
  const found = new Map();
  for (const row of rows) {
    const key = identity(row);
    if (found.has(key)) check(canonical(annotation(found.get(key))) === canonical(annotation(row)));
    else found.set(key, row);
  }
  return [...found.values()];
}
function referenceRelations(event) {
  return deduplicate(event.relations, row => relationIdentity(row, event), row => ({ kind: row.kind, classification: row.classification, required_disclosure: row.required_disclosure, resolution: row.resolution }));
}
function evidenceObservations(run, event) {
  return deduplicate(run.evidence, row => {
    const ref = event.evidence.find(item => item.id === row.reference_evidence_id);
    return canonical([claimIdentity(event.claims.find(claim => claim.id === ref.claim_id)), ref.report_id, ref.start, ref.end]);
  }, row => ({ excerpt: row.excerpt, human_support: row.human_support }));
}

function validateReferenceData(input) {
  check(input.version === VERSION && ['synthetic', 'human-labelled-local'].includes(input.kind) && input.complete === true && input.factual_truth_verified === false);
  fields(input.corpus, ['id', 'version', 'split', 'storage_approval', 'notes']); id(input.corpus.id); id(input.corpus.version);
  check(['development', 'assessment', 'synthetic'].includes(input.corpus.split)); text(input.corpus.storage_approval); text(input.corpus.notes);
  check(input.kind !== 'synthetic' || input.corpus.split === 'synthetic');
  const events = ids(input.events); check(events.size > 0 && events.size <= 12);
  const globalIds = new Set();
  function register(rows) { for (const row of rows) { check(!globalIds.has(row.id)); globalIds.add(row.id); } }
  for (const event of input.events) {
    fields(event, ['id', 'scenario', 'assessment_cutoff', 'reports', 'claims', 'evidence', 'relations', 'changes', 'required_summary_facts', 'optional_facts', 'prohibited_settled_assertions', 'expected_abstention', 'review']);
    check(SCENARIOS.includes(event.scenario)); timestamp(event.assessment_cutoff); bool(event.expected_abstention); review(event.review);
    const reports = ids(event.reports), claims = ids(event.claims), evidence = ids(event.evidence), relations = ids(event.relations), changes = ids(event.changes);
    register([event, ...event.reports, ...event.claims, ...event.evidence, ...event.relations, ...event.changes]);
    check(reports.size > 0 && reports.size <= 100);
    for (const report of event.reports) {
      fields(report, ['id', 'source_id', 'publisher_id', 'origin_group', 'independence_confidence', 'url', 'published_at', 'collected_at', 'occurred_at', 'time_uncertain', 'date_fallback', 'artifact', 'text']);
      id(report.source_id); id(report.publisher_id); id(report.origin_group);
      check(['confirmed', 'uncertain', 'unknown'].includes(report.independence_confidence));
      const sourceUrl = validateSourceUrl(report.url);
      if (input.kind === 'synthetic') check(sourceUrl.origin === 'https://fixture.invalid');
      timestamp(report.published_at, true); timestamp(report.collected_at); timestamp(report.occurred_at, true);
      check(Date.parse(report.collected_at) <= Date.parse(event.assessment_cutoff) && (!report.published_at || Date.parse(report.published_at) <= Date.parse(event.assessment_cutoff)));
      bool(report.time_uncertain); bool(report.date_fallback); check(report.date_fallback === (report.published_at === null));
      fields(report.artifact, ['path', 'sha256', 'complete']); safeArtifactPath(report.artifact.path); bool(report.artifact.complete); text(report.text);
      check(report.artifact.sha256 === hash(report.text));
    }
    const claimGroups = new Map();
    for (const claim of event.claims) {
      fields(claim, ['id', 'report_id', 'text', 'type', 'attribution', 'modality', 'quantity', 'unit', 'location', 'reference_period', 'equivalence_group']);
      check(reports.has(claim.report_id)); text(claim.text); check(['fact', 'data', 'quote', 'opinion'].includes(claim.type));
      text(claim.attribution); text(claim.modality); id(claim.equivalence_group);
      check(claim.quantity === null || Number.isFinite(claim.quantity));
      for (const key of ['unit', 'location', 'reference_period']) check(claim[key] === null || typeof claim[key] === 'string');
      const identity = claimIdentity(claim);
      if (claimGroups.has(identity)) check(claimGroups.get(identity) === claim.equivalence_group);
      claimGroups.set(identity, claim.equivalence_group);
    }
    for (const row of event.evidence) {
      fields(row, ['id', 'claim_id', 'report_id', 'excerpt', 'start', 'end', 'relationship']);
      check(claims.has(row.claim_id) && reports.has(row.report_id) && claims.get(row.claim_id).report_id === row.report_id);
      check(['support', 'contradict', 'insufficient'].includes(row.relationship)); text(row.excerpt);
      check(Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && row.start >= 0 && row.end > row.start && row.end <= reports.get(row.report_id).text.length && reports.get(row.report_id).text.slice(row.start, row.end) === row.excerpt);
    }
    for (const row of event.relations) {
      fields(row, ['id', 'claim_ids', 'kind', 'classification', 'required_disclosure', 'resolution', 'notes']);
      refs(row.claim_ids, claims); check(row.claim_ids.length === 2);
      check(['equivalent', 'conflict', 'normal_update', 'correction', 'ambiguous'].includes(row.kind));
      nullableLabel(row.classification, CLASSES); bool(row.required_disclosure); text(row.notes);
      check(['resolved', 'excluded'].includes(row.resolution));
      check(row.kind === 'ambiguous' ? row.resolution === 'excluded' && row.classification === null && !row.required_disclosure : row.resolution === 'resolved' && CLASSES.includes(row.classification));
      check(row.kind === 'conflict' ? row.classification !== 'none' : row.classification === 'none' || row.kind === 'ambiguous');
    }
    referenceRelations(event);
    for (const row of event.changes) { fields(row, ['id', 'current_claim_id', 'previous_claim_id', 'category']); check(claims.has(row.current_claim_id) && claims.has(row.previous_claim_id)); check(CHANGES.includes(row.category)); }
    refs(event.required_summary_facts, claims); refs(event.optional_facts, claims);
    check(!event.required_summary_facts.some(value => event.optional_facts.includes(value)));
    list(event.prohibited_settled_assertions).forEach(text);
  }
  return { events, globalIds };
}
function validateReferenceArtifact(input) {
  jsonData(input); check(Buffer.byteLength(canonical(input)) <= 1000000);
  fields(input, ['version', 'kind', 'complete', 'corpus', 'events', 'factual_truth_verified']);
  validateReferenceData(input);
  return input;
}
function validateArtifact(input) {
  jsonData(input); check(Buffer.byteLength(canonical(input)) <= 1000000);
  fields(input, ['version', 'kind', 'complete', 'scope', 'corpus', 'events', 'runs', 'factual_truth_verified']);
  const { events, globalIds } = validateReferenceData(input);
  fields(input.scope, ['type', 'required_stages']); check(['component', 'end_to_end'].includes(input.scope.type));
  list(input.scope.required_stages); unique(input.scope.required_stages); check(input.scope.required_stages.length > 0);
  check(input.scope.required_stages.every(stage => Object.hasOwn(STAGE_METRICS, stage)));
  if (input.scope.type === 'end_to_end') check(input.scope.required_stages.length === Object.keys(STAGE_METRICS).length);
  ids(input.runs); check(input.runs.length > 0 && input.runs.length <= 24);
  for (const run of input.runs) {
    fields(run, ['id', 'event_id', 'status', 'schema_valid', 'summary_status', 'claims', 'evidence', 'statements', 'candidate_relation_ids', 'classifications', 'disclosed_relation_ids', 'timeline', 'changes', 'grounding_trials', 'idempotency_trials', 'warnings', 'factual_truth_verified', 'review']);
    check(events.has(run.event_id) && !globalIds.has(run.id)); globalIds.add(run.id); review(run.review);
    const event = events.get(run.event_id), claims = ids(event.claims), evidence = ids(event.evidence), reports = ids(event.reports), relations = ids(event.relations), changes = ids(event.changes);
    check(['completed', 'failed'].includes(run.status)); check(run.schema_valid === null || typeof run.schema_valid === 'boolean');
    check(['accepted', 'needs_review', 'insufficient_grounding', 'failed'].includes(run.summary_status) && run.factual_truth_verified === false);
    check(run.summary_status !== 'accepted' || run.status === 'completed' && run.schema_valid === true);
    for (const key of ['claims', 'evidence', 'statements', 'classifications', 'changes', 'grounding_trials', 'idempotency_trials']) if (run[key] !== null) ids(run[key]);
    if (run.claims !== null) for (const row of run.claims) {
      fields(row, ['id', 'reference_claim_id', 'supported', 'attribution_correct']);
      check(row.reference_claim_id === null || claims.has(row.reference_claim_id)); bool(row.supported); bool(row.attribution_correct);
      check(!row.supported || row.reference_claim_id !== null);
    }
    if (run.evidence !== null) for (const row of run.evidence) {
      fields(row, ['id', 'claim_output_id', 'reference_evidence_id', 'report_id', 'excerpt', 'human_support']);
      check(run.claims !== null && run.claims.some(claim => claim.id === row.claim_output_id) && evidence.has(row.reference_evidence_id) && reports.has(row.report_id)); text(row.excerpt);
      check(['support', 'contradict', 'insufficient'].includes(row.human_support));
      const ref = evidence.get(row.reference_evidence_id), claim = run.claims.find(item => item.id === row.claim_output_id);
      check(ref.claim_id === claim.reference_claim_id && ref.report_id === row.report_id);
    }
    if (run.evidence !== null) evidenceObservations(run, event);
    if (run.statements !== null) for (const row of run.statements) {
      fields(row, ['id', 'text', 'reference_claim_ids', 'evidence_ids', 'claim_support', 'support', 'attribution_correct', 'proposition_group']);
      text(row.text); refs(row.reference_claim_ids, claims); refs(row.evidence_ids, evidence); bool(row.attribution_correct); id(row.proposition_group);
      check(['support', 'contradict', 'insufficient'].includes(row.support));
      check(row.support !== 'support' || row.reference_claim_ids.length > 0 && row.evidence_ids.length > 0);
      check(row.evidence_ids.every(value => row.reference_claim_ids.includes(evidence.get(value).claim_id)));
      list(row.claim_support); unique(row.claim_support.map(item => item.claim_id));
      check(row.claim_support.length === row.reference_claim_ids.length);
      const linked = new Set();
      for (const item of row.claim_support) {
        fields(item, ['claim_id', 'evidence_ids', 'support']); check(row.reference_claim_ids.includes(item.claim_id));
        refs(item.evidence_ids, evidence); check(['support', 'contradict', 'insufficient'].includes(item.support));
        check(item.evidence_ids.every(value => row.evidence_ids.includes(value) && evidence.get(value).claim_id === item.claim_id));
        item.evidence_ids.forEach(value => linked.add(value));
        if (item.support === 'support') check(item.evidence_ids.length > 0);
        if (row.support === 'support') check(item.support === 'support');
      }
      check(row.evidence_ids.every(value => linked.has(value)));
    }
    check(run.summary_status !== 'accepted' || run.statements !== null && run.statements.length > 0);
    for (const key of ['candidate_relation_ids', 'disclosed_relation_ids']) if (run[key] !== null) refs(run[key], relations);
    if (run.classifications !== null) for (const row of run.classifications) { fields(row, ['id', 'relation_id', 'classification']); check(relations.has(row.relation_id) && relations.get(row.relation_id).resolution === 'resolved' && CLASSES.includes(row.classification)); }
    if (run.classifications !== null) unique(run.classifications.map(row => row.relation_id));
    if (run.classifications !== null) deduplicate(run.classifications, row => relationIdentity(relations.get(row.relation_id), event), row => row.classification);
    if (run.timeline !== null) refs(run.timeline, reports);
    if (run.changes !== null) for (const row of run.changes) { fields(row, ['id', 'reference_change_id', 'category']); check(row.reference_change_id === null || changes.has(row.reference_change_id)); check(CHANGES.includes(row.category)); }
    if (run.grounding_trials !== null) for (const row of run.grounding_trials) { fields(row, ['id', 'expected_accept', 'actual_accept', 'adversarial']); bool(row.expected_accept); bool(row.actual_accept); bool(row.adversarial); }
    if (run.idempotency_trials !== null) for (const row of run.idempotency_trials) { fields(row, ['id', 'same_input', 'same_output', 'extra_dispatches']); bool(row.same_input); bool(row.same_output); check(Number.isSafeInteger(row.extra_dispatches) && row.extra_dispatches >= 0); }
    list(run.warnings); // Warning shapes remain intact; no message-only normalization.
  }
  check(input.events.every(event => input.runs.some(run => run.event_id === event.id)));
  return input;
}

function ratio(numerator, denominator, reason = 'ZERO_DENOMINATOR') {
  return { value: denominator ? numerator / denominator : 'N/A', numerator, denominator, reason: denominator ? null : reason };
}
function absent(reason = 'OBSERVATIONS_UNAVAILABLE') { return { value: 'N/A', numerator: null, denominator: null, reason }; }
function tally(rows, predicate) { return ratio(rows.filter(predicate).length, rows.length); }
function wholeStatementSupported(row) { return row.support === 'support' && row.attribution_correct && row.claim_support.every(item => item.support === 'support' && item.evidence_ids.length > 0); }
function scoreRun(run, event, scope) {
  const metrics = { technical_completion: ratio(Number(run.status === 'completed'), 1), schema_validity: run.schema_valid === null ? absent() : ratio(Number(run.schema_valid), 1) };
  const referenceGroups = new Set(event.claims.map(row => row.equivalence_group));
  const group = value => event.claims.find(row => row.id === value)?.equivalence_group;
  metrics.claim_precision = run.claims === null ? absent() : tally(run.claims, row => row.supported);
  metrics.claim_recall = run.claims === null ? absent() : ratio(new Set(run.claims.filter(row => row.supported).map(row => group(row.reference_claim_id))).size, referenceGroups.size);
  const observations = run.evidence === null ? null : evidenceObservations(run, event);
  metrics.evidence_traceability = observations === null ? absent() : tally(observations, row => event.reports.find(report => report.id === row.report_id).text.includes(row.excerpt));
  metrics.evidence_support = observations === null ? absent() : tally(observations, row => row.human_support === 'support');
  const accepted = run.summary_status === 'accepted' ? run.statements : [];
  metrics.unsupported_statement_rate = run.statements === null ? absent() : tally(accepted, row => !wholeStatementSupported(row));
  metrics.attribution_accuracy = run.statements === null ? absent() : tally(run.statements, row => row.attribution_correct);
  const relations = referenceRelations(event);
  const relationKey = value => relationIdentity(event.relations.find(row => row.id === value), event);
  const candidateKeys = new Set((run.candidate_relation_ids || []).map(relationKey));
  const disclosedKeys = new Set((run.disclosed_relation_ids || []).map(relationKey));
  const conflicts = relations.filter(row => row.kind === 'conflict');
  metrics.contradiction_candidate_recall = run.candidate_relation_ids === null ? absent() : ratio(conflicts.filter(row => candidateKeys.has(relationIdentity(row, event))).length, conflicts.length);
  const required = conflicts.filter(row => row.required_disclosure);
  metrics.conflict_preservation = run.disclosed_relation_ids === null ? absent() : ratio(required.filter(row => disclosedKeys.has(relationIdentity(row, event))).length, required.length);
  const matrix = Object.fromEntries(CLASSES.map(label => [label, Object.fromEntries(CLASSES.map(predicted => [predicted, 0]))]));
  if (run.classifications !== null) for (const row of deduplicate(run.classifications, item => relationKey(item.relation_id), item => item.classification)) matrix[event.relations.find(ref => ref.id === row.relation_id).classification][row.classification]++;
  metrics.contradiction_classification = { confusion_matrix: run.classifications === null ? null : matrix, classes: {} };
  for (const label of CLASSES) {
    const tp = matrix[label][label], fp = CLASSES.reduce((n, other) => n + (other === label ? 0 : matrix[other][label]), 0);
    // Unclassified reference pairs are missed, not silently removed from recall.
    const expected = relations.filter(row => row.resolution === 'resolved' && row.classification === label).length;
    metrics.contradiction_classification.classes[label] = run.classifications === null ? { precision: absent(), recall: absent(), f1: absent(), tp: null, fp: null, fn: null } :
      { precision: ratio(tp, tp + fp), recall: ratio(tp, expected), f1: ratio(2 * tp, 2 * tp + fp + expected - tp), tp, fp, fn: expected - tp };
  }
  let correct = 0, comparable = 0, excluded = 0;
  if (run.timeline !== null) for (let a = 0; a < event.reports.length; a++) for (let b = a + 1; b < event.reports.length; b++) {
    const first = event.reports[a], second = event.reports[b];
    if (!first.published_at || !second.published_at || first.time_uncertain || second.time_uncertain || Date.parse(first.published_at) === Date.parse(second.published_at)) { excluded++; continue; }
    comparable++; const x = run.timeline.indexOf(first.id), y = run.timeline.indexOf(second.id);
    if (x >= 0 && y >= 0 && (x < y) === (Date.parse(first.published_at) < Date.parse(second.published_at))) correct++;
  }
  metrics.timeline_ordering = run.timeline === null ? absent() : { ...ratio(correct, comparable), excluded_pairs: excluded };
  const matchingChanges = run.changes === null ? [] : run.changes.filter(row => event.changes.some(ref => ref.id === row.reference_change_id && ref.category === row.category));
  const changeTP = new Set(matchingChanges.map(row => row.reference_change_id)).size;
  metrics.change_precision = run.changes === null ? absent() : ratio(changeTP, run.changes.length);
  metrics.change_recall = run.changes === null ? absent() : ratio(changeTP, event.changes.length);
  const requiredGroups = new Set(event.required_summary_facts.map(group));
  const covered = new Set(accepted.filter(wholeStatementSupported).flatMap(row => row.claim_support.filter(item => item.support === 'support' && item.evidence_ids.length > 0).map(item => group(item.claim_id))));
  metrics.summary_coverage = run.statements === null ? absent() : ratio([...requiredGroups].filter(value => covered.has(value)).length, requiredGroups.size);
  metrics.grounding_decision_accuracy = run.grounding_trials === null ? absent() : tally(run.grounding_trials, row => row.expected_accept === row.actual_accept);
  metrics.unsupported_acceptance_rate = run.grounding_trials === null ? absent() : tally(run.grounding_trials.filter(row => row.adversarial && !row.expected_accept), row => row.actual_accept);
  metrics.insufficient_grounding_accuracy = ratio(Number(run.status === 'completed' && run.summary_status !== 'failed' && (run.summary_status === 'insufficient_grounding') === event.expected_abstention), 1);
  metrics.redundancy = run.statements === null ? absent() : ratio(accepted.length - new Set(accepted.map(row => row.proposition_group)).size, accepted.length);
  metrics.idempotency = run.idempotency_trials === null ? absent() : tally(run.idempotency_trials.filter(row => row.same_input), row => row.same_output && row.extra_dispatches === 0);
  const groups = new Set(event.reports.filter(row => row.independence_confidence === 'confirmed').map(row => row.origin_group));
  const availability = {
    technical: true, schema: run.schema_valid !== null, claims: run.claims !== null, evidence: observations !== null,
    summary: run.statements !== null, contradictions: run.candidate_relation_ids !== null && run.classifications !== null && run.disclosed_relation_ids !== null,
    timeline: run.timeline !== null, changes: run.changes !== null, grounding: run.grounding_trials !== null && run.grounding_trials.length > 0,
    abstention: run.statements !== null, idempotency: run.idempotency_trials !== null && run.idempotency_trials.some(row => row.same_input)
  };
  const stages = {};
  for (const [stage, names] of Object.entries(STAGE_METRICS)) {
    const required = scope.required_stages.includes(stage);
    stages[stage] = { required, status: required && availability[stage] ? 'EVALUATED' : 'NOT EVALUATED', reason: !required ? 'OUT_OF_SCOPE' : availability[stage] ? null : 'OBSERVATIONS_UNAVAILABLE' };
    if (!required) for (const name of names) {
      if (name === 'contradiction_classification') metrics[name] = { confusion_matrix: null, classes: Object.fromEntries(CLASSES.map(label => [label, { precision: absent('OUT_OF_SCOPE'), recall: absent('OUT_OF_SCOPE'), f1: absent('OUT_OF_SCOPE'), tp: null, fp: null, fn: null }])) };
      else metrics[name] = absent('OUT_OF_SCOPE');
    }
  }
  return { metrics, stages,
    evidence_observations: observations === null ? null : { raw: run.evidence.length, unique: observations.length, duplicates: run.evidence.length - observations.length },
    source_independence: { publishers: new Set(event.reports.map(row => row.publisher_id)).size, confirmed_origin_groups: groups.size, unknown_or_uncertain_reports: event.reports.filter(row => row.independence_confidence !== 'confirmed').length },
    safety_findings: { unsupported_accepted: scope.required_stages.includes('summary') ? accepted.filter(row => !wholeStatementSupported(row)).length : null,
      misattributed_accepted: scope.required_stages.includes('summary') ? accepted.filter(row => !row.attribution_correct).length : null },
    reference_exclusions: relations.filter(row => row.resolution === 'excluded').length };
}
function evaluateArtifact(input) {
  validateArtifact(input);
  const runs = input.runs.map(run => ({ run_id: run.id, event_id: run.event_id, ...scoreRun(run, input.events.find(event => event.id === run.event_id), input.scope) }));
  const complete = runs.every(run => Object.values(run.stages).every(stage => !stage.required || stage.status === 'EVALUATED'));
  const anyEvaluated = runs.some(run => Object.values(run.stages).some(stage => stage.status === 'EVALUATED'));
  const minimumChecks = complete && input.runs.every(run => run.status === 'completed' &&
    (!input.scope.required_stages.includes('schema') || run.schema_valid === true) &&
    (!input.scope.required_stages.includes('summary') || run.summary_status !== 'failed')) &&
      runs.every(row => !row.safety_findings.unsupported_accepted && !row.safety_findings.misattributed_accepted &&
        !(typeof row.metrics.unsupported_acceptance_rate.numerator === 'number' && row.metrics.unsupported_acceptance_rate.numerator > 0));
  return { version: VERSION, mode: 'OFFLINE_ARTIFACT_QUALITY_EVALUATION', fingerprint: hash(canonical(input)),
    artifact_complete: true, complete, scope: { type: input.scope.type, required_stages: [...input.scope.required_stages] },
    evaluation_status: complete ? 'COMPLETE' : anyEvaluated ? 'PARTIAL' : 'NOT EVALUATED',
    end_to_end_complete: input.scope.type === 'end_to_end' && complete,
    factual_truth_verified: false, minimum_checks_pass: minimumChecks, evaluation_success: minimumChecks,
    runs, limitations: ['Human semantic annotations are inputs, not independently established facts.', 'No provider, database, collection or native execution is performed.', 'Idempotency observations are artifact labels, not database concurrency verification.'] };
}
module.exports = { VERSION, safeArtifactPath, validateReferenceArtifact, validateArtifact, evaluateArtifact };
