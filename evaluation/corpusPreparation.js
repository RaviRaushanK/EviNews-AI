'use strict';

const crypto = require('node:crypto');
const { VERSION, safeArtifactPath, validateReferenceArtifact, referenceEvidence, validateRelationGroups } = require('./realWorldQuality');
const FORMAT = '8w-corpus-authoring-v1';
const STATES = ['draft', 'annotated', 'reviewed', 'adjudicated', 'frozen'];
const ORIGINS = { confirmed_independent: 'confirmed', likely_independent: 'uncertain', confirmed_shared_origin: 'confirmed', syndicated: 'confirmed', unknown: 'unknown' };
const RELATIONS = { contradiction: 'conflict', partial_disagreement: 'conflict', temporal_update: 'normal_update', correction: 'correction', equivalent: 'equivalent', not_comparable: 'ambiguous', ambiguous: 'ambiguous' };
const QUOTAS = { A: [2, 6], B: [2, 6], C: [2, 8], D: [1, 3], E: [1, 2], F: [1, 4], G: [1, 3] };
function fail(code = 'CORPUS_INVALID') { throw Object.assign(new Error('Corpus preparation rejected input'), { code }); }
function ok(value) { if (!value) fail(); }
function object(value, keys) { ok(value && !Array.isArray(value) && typeof value === 'object'); ok(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))); }
function arr(value) { ok(Array.isArray(value) && value.length <= 1000); return value; }
function string(value, empty = false) { ok(typeof value === 'string' && value.length <= 64000 && (empty || value.trim().length > 0)); }
function id(value) { ok(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value)); }
function unique(values) { ok(new Set(values).size === values.length); }
function map(rows, key = 'id') { const result = new Map(); for (const row of arr(rows)) { id(row[key]); ok(!result.has(row[key])); result.set(row[key], row); } return result; }
function date(value, nullable = false) {
  if (value === null && nullable) return;
  ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value));
  const parsed = new Date(value); ok(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'));
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function digest(value) { return sha(stable(value)); }
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function dataOnly(value, depth = 0, count = { n: 0 }) {
  ok(depth <= 40 && ++count.n <= 80000);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { ok(value.length <= 64000); return; }
  if (typeof value === 'number') { ok(Number.isFinite(value)); return; }
  ok(value && typeof value === 'object' && [Object.prototype, Array.prototype].includes(Object.getPrototypeOf(value)));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    ok(typeof key === 'string'); if (Array.isArray(value) && key === 'length') continue;
    const row = descriptors[key]; ok(row.enumerable && Object.hasOwn(row, 'value'));
    if (Array.isArray(value)) ok(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length);
    dataOnly(row.value, depth + 1, count);
  }
  if (Array.isArray(value)) ok(Object.keys(value).length === value.length);
}
function sourceUrl(value) {
  ok(typeof value === 'string' && value.length <= 4096 && /^https:\/\//i.test(value) && !/[\\\u0000-\u0020\u007f]/.test(value) && !/%(?![a-f0-9]{2})/i.test(value));
  let parsed; try { parsed = new URL(value); } catch (_) { fail(); }
  ok(parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password); return parsed;
}
function refs(values, known) { arr(values); unique(values); values.forEach(value => ok(known.has(value))); }
function mapIndependence(classification) { ok(typeof classification === 'string' && Object.hasOwn(ORIGINS, classification)); return ORIGINS[classification]; }
function deterministicId(prefix, identity) { id(prefix); ok(prefix.length <= 75); dataOnly(identity); return prefix + '-' + digest(identity).slice(0, 24); }
function mappedClaim(row) {
  return { id: row.id, report_id: row.report_id, text: row.proposition, type: row.type, attribution: row.attribution,
    modality: row.modality, quantity: row.quantity, unit: row.unit, location: row.location, reference_period: row.relevant_time, equivalence_group: row.equivalence_group };
}
function mappedRelation(row) {
  return { id: row.id, claim_ids: [...row.claim_ids], kind: RELATIONS[row.type], classification: row.classification,
    required_disclosure: row.required_disclosure, resolution: row.resolution, notes: row.notes };
}
function claimIdentity(claim) {
  const { id: ignored, equivalence_group: ignoredGroup, ...identity } = mappedClaim(claim);
  return stable({ ...identity, text: identity.text.trim().replace(/\s+/g, ' ') });
}
function material(bundle, event) {
  const reference = bundle.references.find(row => row.event_id === event.id);
  return { event: { id: event.id, scenario: event.scenario, split: event.split, assessment_cutoff: event.assessment_cutoff, reports: event.reports }, reference };
}
function materialFingerprint(bundle, eventId) {
  dataOnly(bundle); const event = bundle.manifest.events.find(row => row.id === eventId); ok(event);
  return digest(material(bundle, event));
}
function freezeFingerprint(bundle, eventId) {
  dataOnly(bundle); const event = bundle.manifest.events.find(row => row.id === eventId); ok(event);
  return digest({ material: material(bundle, event), reviews: bundle.reviews.filter(row => row.event_id === eventId), adjudication: bundle.adjudications.find(row => row.event_id === eventId) });
}
function reviewSubjects(bundle, event) {
  const ref = bundle.references.find(row => row.event_id === event.id);
  return [...event.reports.map(row => ['report', row.id]), ...ref.claims.map(row => ['claim', row.id]),
    ...ref.evidence.map(row => ['evidence', row.id]), ...ref.relations.map(row => ['relation', row.id]), ['summary', event.id]];
}
function checkReviews(bundle, event, fingerprint) {
  const records = bundle.reviews.filter(row => row.event_id === event.id);
  const a = records.find(row => row.role === 'A'), b = records.find(row => row.role === 'B');
  if (STATES.indexOf(event.status) >= 2) {
    ok(a && b && a.reviewer_id !== b.reviewer_id);
    ok(records.every(row => row.state === 'complete' && row.reference_fingerprint === fingerprint));
    const expected = reviewSubjects(bundle, event).map(row => row.join(':'));
    ok(records.every(row => expected.every(key => row.annotations.some(annotation => annotation.category + ':' + annotation.subject_id === key))));
  }
  const adjudication = bundle.adjudications.find(row => row.event_id === event.id);
  if (STATES.indexOf(event.status) >= 3) {
    ok(adjudication && adjudication.state === 'resolved' && adjudication.reference_fingerprint === fingerprint);
    ok(adjudication.disagreements.every(row => row.resolution === 'resolved' || !row.required && row.resolution === 'excluded'));
    for (const annotation of records.flatMap(row => row.annotations).filter(row => row.decision !== 'agree')) {
      ok(adjudication.disagreements.some(row => row.subject_id === annotation.subject_id && row.category === annotation.category && row.required && row.resolution === 'resolved'));
    }
    ok(event && a && b); string(adjudication.notes);
  }
  return { a, b, adjudication };
}
function projectedEvent(bundle, event) {
  const ref = bundle.references.find(row => row.event_id === event.id);
  const { a, b, adjudication } = checkReviews(bundle, event, digest(material(bundle, event)));
  ok(a && b && adjudication && adjudication.state === 'resolved');
  const representative = group => ref.claims.filter(row => row.equivalence_group === group).map(row => row.id).sort()[0];
  return { id: event.id, scenario: event.scenario, assessment_cutoff: event.assessment_cutoff,
    reports: event.reports.map(row => ({ id: row.id, source_id: row.source_id, publisher_id: row.publisher.id,
      origin_group: row.origin_group, independence_confidence: mapIndependence(row.independence), url: row.url,
      published_at: row.published_at, collected_at: row.collected_at, occurred_at: row.occurred_at,
      time_uncertain: row.time_uncertain, date_fallback: row.date_fallback,
      artifact: { path: row.artifact_path, sha256: row.sha256, complete: row.complete }, text: ref.sources.find(source => source.report_id === row.id).text })),
    claims: ref.claims.map(mappedClaim), evidence: structuredClone(referenceEvidence({ claims: ref.claims.map(mappedClaim), evidence: ref.evidence })), relations: ref.relations.map(mappedRelation), changes: structuredClone(ref.changes),
    required_summary_facts: ref.summary.required_groups.map(representative), optional_facts: ref.summary.optional_groups.map(representative),
    prohibited_settled_assertions: [...ref.summary.prohibited_settled_assertions], expected_abstention: ref.summary.expected_abstention,
    review: { status: 'resolved', reviewers: [a.reviewer_id, b.reviewer_id], adjudicator: adjudication.adjudicator_id, notes: adjudication.notes } };
}
function projection(bundle, split) {
  const manifest = bundle.manifest, events = manifest.events.filter(row => row.split === split);
  ok(events.length > 0 && events.every(row => STATES.indexOf(row.status) >= 3));
  const result = { version: VERSION, kind: manifest.kind === 'synthetic-template' ? 'synthetic' : 'human-labelled-local', complete: true,
    corpus: { id: manifest.corpus_id, version: manifest.corpus_version, split: manifest.kind === 'synthetic-template' ? 'synthetic' : split,
      storage_approval: 'Authoring attestations; no automatic storage permission.',
      notes: 'Authoring split=' + split + '; annotation=' + manifest.annotation_version + '; authoring_sha256=' + digest(bundle) },
    events: events.map(event => projectedEvent(bundle, event)), factual_truth_verified: false };
  validateReferenceArtifact(result); return result;
}

function inspect(bundle) {
  dataOnly(bundle); ok(Buffer.byteLength(stable(bundle)) <= 2000000);
  object(bundle, ['manifest', 'references', 'reviews', 'adjudications']);
  const m = bundle.manifest;
  object(m, ['format', 'kind', 'corpus_id', 'corpus_version', 'annotation_version', 'status', 'evaluator_version', 'evaluator_commit', 'freeze_at', 'change_notes', 'revision', 'factual_truth_verified', 'events']);
  ok(m.format === FORMAT && ['synthetic-template', 'local-authoring'].includes(m.kind)); id(m.corpus_id); id(m.corpus_version); id(m.annotation_version);
  ok(STATES.includes(m.status) && m.evaluator_version === VERSION && m.factual_truth_verified === false);
  ok(m.evaluator_commit === null || typeof m.evaluator_commit === 'string' && /^[a-f0-9]{7,40}$/.test(m.evaluator_commit)); date(m.freeze_at, true);
  arr(m.change_notes).forEach(value => string(value));
  if (m.revision !== null) {
    object(m.revision, ['previous_fingerprint', 'previous_corpus_version', 'previous_annotation_version', 'at', 'note']);
    ok(/^[a-f0-9]{64}$/.test(m.revision.previous_fingerprint)); id(m.revision.previous_corpus_version); id(m.revision.previous_annotation_version); date(m.revision.at); string(m.revision.note);
    ok(m.revision.previous_corpus_version !== m.corpus_version && m.revision.previous_annotation_version !== m.annotation_version);
  }
  const events = map(m.events); ok(events.size > 0 && events.size <= 12);
  const references = map(bundle.references, 'event_id'); ok(references.size === events.size && [...references.keys()].every(value => events.has(value)));
  const allIds = new Set(); const pending = [];
  function register(rows) { for (const row of rows) { id(row.id); ok(!allIds.has(row.id)); allIds.add(row.id); } }
  for (const event of m.events) {
    object(event, ['id', 'scenario', 'split', 'status', 'assessment_cutoff', 'history', 'freeze', 'reports']);
    ok(Object.hasOwn(QUOTAS, event.scenario) && ['development', 'assessment'].includes(event.split) && STATES.includes(event.status)); date(event.assessment_cutoff, true);
    const rank = STATES.indexOf(event.status); const history = arr(event.history); ok(history.length === rank + 1);
    history.forEach((row, index) => { object(row, ['status', 'at', 'note']); ok(row.status === STATES[index]); date(row.at); string(row.note); if (index) ok(Date.parse(row.at) >= Date.parse(history[index - 1].at)); });
    const reports = map(event.reports), ref = references.get(event.id); register([event, ...event.reports]); ok(reports.size <= 100);
    object(ref, ['event_id', 'sources', 'claims', 'evidence', 'relations', 'changes', 'summary']);
    const sources = map(ref.sources, 'report_id');
    for (const source of ref.sources) { object(source, ['report_id', 'text']); ok(reports.has(source.report_id)); string(source.text); }
    for (const report of event.reports) {
      object(report, ['id', 'source_id', 'title', 'publisher', 'url', 'published_at', 'collected_at', 'frozen_at', 'occurred_at', 'time_uncertain', 'date_fallback', 'origin_group', 'independence', 'independence_rationale', 'sha256', 'artifact_path', 'storage', 'complete', 'truncation_note']);
      id(report.source_id); string(report.title); object(report.publisher, ['id', 'name']); id(report.publisher.id); string(report.publisher.name);
      const url = sourceUrl(report.url); if (m.kind === 'synthetic-template') ok(url.origin === 'https://fixture.invalid');
      date(report.published_at, true); date(report.collected_at, true); date(report.frozen_at, true); date(report.occurred_at, true);
      if (report.collected_at && report.frozen_at) ok(Date.parse(report.frozen_at) >= Date.parse(report.collected_at));
      ok(typeof report.time_uncertain === 'boolean' && report.date_fallback === (report.published_at === null));
      id(report.origin_group); mapIndependence(report.independence); string(report.independence_rationale);
      ok(report.sha256 === null || /^[a-f0-9]{64}$/.test(report.sha256)); safeArtifactPath(report.artifact_path);
      ok(report.artifact_path.startsWith('artifacts/8w-v1/reports/') && report.artifact_path.endsWith('.txt'));
      object(report.storage, ['classification', 'approved', 'rationale']);
      ok(['synthetic', 'restricted_local', 'redistribution_approved', 'metadata_only'].includes(report.storage.classification));
      ok(typeof report.storage.approved === 'boolean'); string(report.storage.rationale); ok(typeof report.complete === 'boolean'); string(report.truncation_note, report.complete);
      if (sources.has(report.id) && report.sha256 !== null) ok(sha(sources.get(report.id).text) === report.sha256);
      if (event.assessment_cutoff) {
        for (const key of ['published_at', 'collected_at']) if (report[key]) ok(Date.parse(report[key]) <= Date.parse(event.assessment_cutoff));
      }
      if (!sources.has(report.id) || !report.sha256 || !report.collected_at || !report.frozen_at || !report.storage.approved) pending.push({ event_id: event.id, code: 'REPORT_INCOMPLETE' });
    }
    const claims = map(ref.claims), evidence = map(ref.evidence), relations = map(ref.relations); map(ref.changes); register([...ref.claims, ...ref.evidence, ...ref.relations, ...ref.changes]);
    const identities = new Map();
    for (const claim of ref.claims) {
      object(claim, ['id', 'report_id', 'proposition', 'type', 'equivalence_group', 'attribution', 'modality', 'quantity', 'unit', 'location', 'relevant_time', 'scope', 'uncertainty', 'review_state']);
      ok(reports.has(claim.report_id)); string(claim.proposition); string(claim.attribution); string(claim.modality); string(claim.scope); id(claim.equivalence_group);
      ok(['fact', 'data', 'quote', 'opinion'].includes(claim.type) && ['none', 'qualified', 'unknown'].includes(claim.uncertainty) && ['provisional', 'final'].includes(claim.review_state));
      ok(claim.quantity === null || Number.isFinite(claim.quantity)); for (const key of ['unit', 'location', 'relevant_time']) ok(claim[key] === null || typeof claim[key] === 'string');
      const key = claimIdentity(claim); if (identities.has(key)) ok(identities.get(key) === claim.equivalence_group); identities.set(key, claim.equivalence_group);
      if (rank >= 3) ok(claim.review_state === 'final');
    }
    for (const row of ref.evidence) {
      object(row, ['id', 'claim_id', 'report_id', 'excerpt', 'start', 'end', 'relationship']);
      ok(claims.has(row.claim_id) && reports.has(row.report_id) && claims.get(row.claim_id).report_id === row.report_id);
      string(row.excerpt); ok(['support', 'contradict', 'insufficient'].includes(row.relationship));
      ok(Number.isSafeInteger(row.start) && Number.isSafeInteger(row.end) && row.start >= 0 && row.end > row.start);
      if (sources.has(row.report_id)) { const source = sources.get(row.report_id).text; ok(row.end <= source.length && source.slice(row.start, row.end) === row.excerpt); }
      else pending.push({ event_id: event.id, code: 'EVIDENCE_SOURCE_UNAVAILABLE' });
    }
    referenceEvidence({ claims: ref.claims.map(mappedClaim), evidence: ref.evidence });
    const pairs = new Map();
    for (const row of ref.relations) {
      object(row, ['id', 'claim_ids', 'type', 'classification', 'required_disclosure', 'resolution', 'notes']); refs(row.claim_ids, claims); ok(row.claim_ids.length === 2);
      ok(Object.hasOwn(RELATIONS, row.type) && typeof row.required_disclosure === 'boolean' && ['provisional', 'resolved', 'excluded'].includes(row.resolution)); string(row.notes);
      if (row.type === 'contradiction') ok(['direct', 'temporal'].includes(row.classification));
      else if (row.type === 'partial_disagreement') ok(row.classification === 'partial');
      else if (['not_comparable', 'ambiguous'].includes(row.type)) ok(row.classification === null && row.resolution === 'excluded' && !row.required_disclosure);
      else ok(row.classification === 'none');
      validateRelationGroups(mappedRelation(row), claims);
      const pair = row.claim_ids.map(value => claimIdentity(claims.get(value)));
      const directional = ['temporal_update', 'correction'].includes(row.type);
      const key = stable(directional ? [row.type, ...pair] : ['symmetric', ...pair.sort()]);
      const annotation = stable([row.type, row.classification, row.required_disclosure, row.resolution]); if (pairs.has(key)) ok(pairs.get(key) === annotation); pairs.set(key, annotation);
      if (rank >= 3) ok(row.resolution !== 'provisional');
    }
    for (const change of ref.changes) { object(change, ['id', 'current_claim_id', 'previous_claim_id', 'category']); ok(claims.has(change.current_claim_id) && claims.has(change.previous_claim_id)); ok(['new_information', 'previously_reported', 'changed_value', 'updated_information', 'contradictory_information', 'unclassified'].includes(change.category)); }
    if (ref.summary !== null) {
      object(ref.summary, ['required_groups', 'optional_groups', 'prohibited_settled_assertions', 'expected_abstention', 'abstention_rationale', 'salience_notes']);
      const groups = new Set(ref.claims.map(row => row.equivalence_group)); refs(ref.summary.required_groups, groups); refs(ref.summary.optional_groups, groups);
      ok(!ref.summary.required_groups.some(value => ref.summary.optional_groups.includes(value))); arr(ref.summary.prohibited_settled_assertions).forEach(value => string(value));
      ok(typeof ref.summary.expected_abstention === 'boolean'); string(ref.summary.abstention_rationale); string(ref.summary.salience_notes);
    }
    if (!event.assessment_cutoff || !reports.size || ref.summary === null) pending.push({ event_id: event.id, code: 'ANNOTATION_INCOMPLETE' });
    if (rank >= 1) {
      ok(!pending.some(row => row.event_id === event.id));
      ok(ref.summary.expected_abstention || claims.size > 0 && evidence.size > 0);
    }
  }
  map(bundle.reviews); unique(bundle.reviews.map(row => row.event_id + ':' + row.role));
  for (const row of bundle.reviews) {
    object(row, ['id', 'event_id', 'role', 'reviewer_id', 'state', 'reference_fingerprint', 'annotations', 'notes']);
    ok(events.has(row.event_id) && ['A', 'B'].includes(row.role) && ['pending', 'complete'].includes(row.state)); id(row.reviewer_id); string(row.notes);
    ok(row.reference_fingerprint === null || /^[a-f0-9]{64}$/.test(row.reference_fingerprint)); if (row.state === 'complete') ok(row.reference_fingerprint !== null);
    arr(row.annotations); const subjects = new Set(reviewSubjects(bundle, events.get(row.event_id)).map(item => item.join(':')));
    unique(row.annotations.map(item => item.category + ':' + item.subject_id));
    for (const annotation of row.annotations) {
      object(annotation, ['subject_id', 'category', 'decision', 'notes']); ok(subjects.has(annotation.category + ':' + annotation.subject_id));
      ok(['agree', 'disagree', 'uncertain'].includes(annotation.decision)); string(annotation.notes);
    }
  }
  map(bundle.adjudications, 'event_id');
  for (const row of bundle.adjudications) {
    object(row, ['event_id', 'state', 'adjudicator_id', 'reference_fingerprint', 'disagreements', 'notes']);
    ok(events.has(row.event_id) && ['pending', 'resolved'].includes(row.state)); id(row.adjudicator_id); string(row.notes);
    ok(row.reference_fingerprint === null || /^[a-f0-9]{64}$/.test(row.reference_fingerprint)); map(row.disagreements);
    const subjects = new Set(reviewSubjects(bundle, events.get(row.event_id)).map(item => item.join(':')));
    for (const disagreement of row.disagreements) { object(disagreement, ['id', 'subject_id', 'category', 'required', 'resolution', 'notes']); ok(subjects.has(disagreement.category + ':' + disagreement.subject_id)); ok(typeof disagreement.required === 'boolean' && ['unresolved', 'resolved', 'excluded'].includes(disagreement.resolution)); string(disagreement.notes); }
  }
  for (const event of m.events) {
    const fingerprint = digest(material(bundle, event)); checkReviews(bundle, event, fingerprint);
    if (event.status === 'frozen') {
      object(event.freeze, ['at', 'corpus_version', 'annotation_version', 'event_fingerprint']); date(event.freeze.at);
      ok(m.evaluator_commit !== null && event.freeze.at === event.history.at(-1).at && event.freeze.corpus_version === m.corpus_version && event.freeze.annotation_version === m.annotation_version && event.freeze.event_fingerprint === freezeFingerprint(bundle, event.id));
    } else ok(event.freeze === null);
    if (STATES.indexOf(event.status) >= 3) {
      const single = { ...bundle, manifest: { ...m, events: [event] } };
      projection(single, event.split);
    }
  }
  for (const split of ['development', 'assessment']) {
    const rows = m.events.filter(event => event.split === split);
    if (rows.length && rows.every(event => STATES.indexOf(event.status) >= 3)) projection(bundle, split);
  }
  ok(m.status === STATES[Math.min(...m.events.map(event => STATES.indexOf(event.status)))]);
  if (m.status === 'frozen') { ok(m.freeze_at !== null && m.evaluator_commit !== null); ok(m.events.every(event => Date.parse(event.freeze.at) <= Date.parse(m.freeze_at))); }
  else ok(m.freeze_at === null);
  return { pending, events };
}

function validateCorpus(bundle) {
  const { pending } = inspect(bundle), status = bundle.manifest.status;
  return { format: FORMAT, state: { draft: 'VALID_DRAFT', annotated: 'READY_FOR_REVIEW', reviewed: 'AWAITING_ADJUDICATION', adjudicated: 'READY_TO_FREEZE', frozen: 'FROZEN_VALID' }[status],
    reference_structure_valid: STATES.indexOf(status) >= 3, evaluation_performed: false, factual_truth_verified: false,
    fingerprint: digest(bundle), counts: { events: bundle.manifest.events.length, reports: bundle.manifest.events.reduce((n, event) => n + event.reports.length, 0) }, pending };
}
function projectReferences(bundle, split) { inspect(bundle); ok(['development', 'assessment'].includes(split)); return projection(bundle, split); }
function validateFinalComposition(bundle, options = {}) {
  inspect(bundle); dataOnly(options); object(options, Object.hasOwn(options, 'allowProvisionalDevelopment') ? ['allowProvisionalDevelopment'] : []);
  ok(options.allowProvisionalDevelopment === undefined || typeof options.allowProvisionalDevelopment === 'boolean');
  const events = bundle.manifest.events;
  if (events.length !== 10 || events.reduce((n, event) => n + event.reports.length, 0) !== 32 || events.filter(row => row.split === 'development').length !== 2 || events.filter(row => row.split === 'assessment').length !== 8) fail('CORPUS_COMPOSITION_INVALID');
  for (const [scenario, [eventCount, reportCount]] of Object.entries(QUOTAS)) {
    const rows = events.filter(row => row.scenario === scenario);
    if (rows.length !== eventCount || rows.reduce((n, event) => n + event.reports.length, 0) !== reportCount) fail('CORPUS_COMPOSITION_INVALID');
  }
  if (!events.every(event => event.status === 'frozen' || options.allowProvisionalDevelopment === true && event.split === 'development')) fail('CORPUS_NOT_FROZEN');
  return { composition_valid: true, assessment_frozen: true, provisional_development: events.some(row => row.status !== 'frozen'), evaluation_performed: false, factual_truth_verified: false };
}
function validateTransition(previous, next) {
  inspect(previous); inspect(next);
  ok(previous.manifest.corpus_id === next.manifest.corpus_id);
  const changedFrozen = previous.manifest.events.some(event => event.split === 'assessment' && event.status === 'frozen' &&
    (!next.manifest.events.some(row => row.id === event.id) || freezeFingerprint(previous, event.id) !== freezeFingerprint(next, event.id)));
  const sameRevision = previous.manifest.corpus_version === next.manifest.corpus_version && previous.manifest.annotation_version === next.manifest.annotation_version;
  if (changedFrozen || !sameRevision) {
    const revision = next.manifest.revision;
    ok(revision && revision.previous_fingerprint === digest(previous) && revision.previous_corpus_version === previous.manifest.corpus_version && revision.previous_annotation_version === previous.manifest.annotation_version);
  } else {
    for (const event of previous.manifest.events) {
      const current = next.manifest.events.find(row => row.id === event.id); ok(current && STATES.indexOf(current.status) >= STATES.indexOf(event.status));
      ok(stable(current.history.slice(0, event.history.length)) === stable(event.history));
    }
  }
  return { transition_valid: true, evaluation_performed: false, factual_truth_verified: false };
}
module.exports = { FORMAT, mapIndependence, deterministicId, materialFingerprint, freezeFingerprint, validateCorpus, projectReferences, validateFinalComposition, validateTransition };
