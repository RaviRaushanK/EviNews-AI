'use strict';

const { validatePreflight, requireSafe, failure } = require('./liveSummarySafety');
const { createProviderDispatcher } = require('./providerDispatch');
const { loadOfflineSummaryDependencies } = require('./offlineSummaryDependencies');
const SAFE_ERRORS = new Set(['GEMINI_TIMEOUT', 'GEMINI_AUTH', 'GEMINI_SERVER', 'GEMINI_RATE_LIMIT', 'GEMINI_BAD_REQUEST',
  'SUMMARY_INVALID_JSON', 'SUMMARY_INVALID_OUTPUT', 'SUMMARY_CONTEXT_INVALID', 'ELIVE_PROVIDER_BUDGET', 'ELIVE_PROVIDER_CLOSED']);

function immutableJson(value, depth = 0, seen = new Set()) {
  requireSafe(depth <= 40, 'EOFFLINE_SNAPSHOT_INVALID');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') { requireSafe(Number.isFinite(value), 'EOFFLINE_SNAPSHOT_INVALID'); return; }
  requireSafe(value && typeof value === 'object' && Object.isFrozen(value) && !seen.has(value) &&
    (Array.isArray(value) ? Object.getPrototypeOf(value) === Array.prototype : Object.getPrototypeOf(value) === Object.prototype), 'EOFFLINE_SNAPSHOT_INVALID');
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    requireSafe(typeof key === 'string' && Object.hasOwn(descriptors[key], 'value'), 'EOFFLINE_SNAPSHOT_INVALID');
    if (Array.isArray(value) && key === 'length') continue;
    requireSafe(descriptors[key].enumerable && (!Array.isArray(value) ||
      /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length), 'EOFFLINE_SNAPSHOT_INVALID');
    immutableJson(descriptors[key].value, depth + 1, seen);
  }
  if (Array.isArray(value)) for (let i = 0; i < value.length; i++) requireSafe(Object.hasOwn(value, i), 'EOFFLINE_SNAPSHOT_INVALID');
  seen.delete(value);
}

function createOfflineSummaryWorkflow({ config, approval, snapshots, snapshotApproval, transport, httpsTransport, executionMode }) {
  const plan = validatePreflight(config, approval);
  requireSafe(snapshotApproval && snapshotApproval.approved === true && Array.isArray(snapshotApproval.fingerprints) &&
    snapshotApproval.fingerprints.length > 0 && snapshotApproval.fingerprints.length <= 24 &&
    snapshotApproval.fingerprints.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) &&
    new Set(snapshotApproval.fingerprints).size === snapshotApproval.fingerprints.length, 'EOFFLINE_SNAPSHOT_APPROVAL_REQUIRED');
  requireSafe(Array.isArray(snapshots) && Object.isFrozen(snapshots) && snapshots.length > 0 && snapshots.length <= 24, 'EOFFLINE_SNAPSHOT_INVALID');
  immutableJson(snapshots);
  const settings = Object.freeze({ ...plan.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 });
  const api = loadOfflineSummaryDependencies(settings);
  const contexts = new Map();
  for (const context of snapshots) {
    requireSafe(Buffer.byteLength(JSON.stringify(context)) <= 64000 && plan.eventIds.includes(context.event?.id) &&
      Array.isArray(context.claims) && context.claims.length <= 50 && Array.isArray(context.evidence) && context.evidence.length <= 100 &&
      Array.isArray(context.contradictions) && context.contradictions.length <= 100 && Array.isArray(context.warnings), 'EOFFLINE_SNAPSHOT_INVALID');
    const allowed = plan.articles.filter(row => row.event_id === context.event.id).map(row => row.id);
    requireSafe(Array.isArray(context.reports) && context.reports.length <= allowed.length &&
      context.reports.every(row => allowed.includes(row.article_id)), 'EOFFLINE_SNAPSHOT_INVALID');
    try { api.requireContext(context); } catch (_) { throw failure('EOFFLINE_SNAPSHOT_INVALID'); }
    const hash = context.metadata?.input_fingerprint;
    requireSafe(snapshotApproval.fingerprints.includes(hash) && api.buildInputFingerprint(context) === hash &&
      context.metadata.model === settings.model && context.metadata.prompt_version === settings.promptVersion &&
      context.metadata.contract_version === settings.contractVersion, 'EOFFLINE_SNAPSHOT_INVALID');
    contexts.set(hash, context);
  }
  requireSafe(snapshotApproval.fingerprints.every(hash => contexts.has(hash)), 'EOFFLINE_SNAPSHOT_INVALID');
  const useHttps = httpsTransport !== undefined;
  requireSafe(useHttps !== (transport !== undefined), 'EOFFLINE_TRANSPORT_INVALID');
  let dispatcher;
  if (useHttps) {
    const nativeMode = executionMode === 'authenticated-native-evaluation';
    const authenticated = nativeMode || executionMode === 'authenticated-fixture-test';
    requireSafe((executionMode === 'loopback-test' || authenticated) && httpsTransport &&
      Object.getPrototypeOf(httpsTransport) === Object.prototype, 'EOFFLINE_TRANSPORT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(httpsTransport);
    const allowedFields = nativeMode ? ['nativeApproval', 'credentialChannel'] : authenticated ? ['httpsFixture', 'credentialChannel'] : ['loopback', 'maxResponseBytes'];
    requireSafe(Reflect.ownKeys(descriptors).every(key => allowedFields.includes(key) &&
      Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable) &&
      (authenticated ? allowedFields.every(key => Object.hasOwn(descriptors, key)) : Object.hasOwn(descriptors, 'loopback')), 'EOFFLINE_TRANSPORT_INVALID');
    if (authenticated) requireSafe(plan.eventIds.length === 1 && snapshots.length === 1 && contexts.size === 1 &&
      snapshotApproval.fingerprints.length === 1 && plan.attempts.length === 1 &&
      plan.limits.maxEvents === 1 && plan.limits.maxSummaryAttempts === 1 && plan.limits.maxProviderCalls === 1 &&
      settings.timeoutMs === 20000, 'ELIVE_AUTH_PROFILE_INVALID');
    if (nativeMode) {
      const native = httpsTransport.nativeApproval;
      requireSafe(native && native.model === settings.model && native.fingerprint === snapshotApproval.fingerprints[0] &&
        native.promptVersion === settings.promptVersion && native.contractVersion === settings.contractVersion,
      'ELIVE_NATIVE_APPROVAL_REQUIRED');
    }
    // This factory owns the sole dispatcher and budget; do not wrap it again.
    const { createSingleRequestHttpsDispatcher } = require('./singleRequestHttpsTransport');
    dispatcher = createSingleRequestHttpsDispatcher({ ...httpsTransport, executionMode,
      maxProviderCalls: plan.limits.maxProviderCalls, model: settings.model, timeoutMs: settings.timeoutMs });
  } else {
    requireSafe(executionMode === undefined || executionMode === 'offline-test', 'EOFFLINE_TRANSPORT_INVALID');
    dispatcher = createProviderDispatcher({ executionMode: 'offline-test', transport,
      maxProviderCalls: plan.limits.maxProviderCalls, model: settings.model, timeoutMs: settings.timeoutMs });
  }
  const generation = api.createSummaryGenerationService({ config: settings, geminiClient: dispatcher,
    contextService: { buildContextForEvent() { throw failure('EOFFLINE_CONTEXT_LOOKUP_FORBIDDEN'); } } });
  const results = new Map(), inFlight = new Map();
  let attempts = 0, closed = false;
  return Object.freeze({
    get dispatches() { return dispatcher.dispatches; },
    async evaluate(fingerprint) {
      requireSafe(!closed, 'ELIVE_PROVIDER_CLOSED');
      requireSafe(typeof fingerprint === 'string' && contexts.has(fingerprint), 'EOFFLINE_SNAPSHOT_NOT_APPROVED');
      if (results.has(fingerprint)) return structuredClone(results.get(fingerprint));
      if (inFlight.has(fingerprint)) return structuredClone(await inFlight.get(fingerprint));
      requireSafe(attempts < plan.limits.maxSummaryAttempts, 'ELIVE_ATTEMPT_LIMIT'); attempts++;
      const work = (async () => {
        const context = contexts.get(fingerprint);
        let generated;
        try { generated = await generation.generateSummaryForEvent(context.event.id, context); }
        catch (_) { generated = { status: 'failed' }; }
        const accepted = !closed && generated.status === 'generated' && Boolean(generated.persistenceReady);
        const status = accepted ? 'accepted' : closed ? 'failed' :
          ['failed', 'needs_review', 'insufficient_grounding'].includes(generated.status) ? generated.status : 'failed';
        const candidateCode = closed ? 'ELIVE_PROVIDER_CLOSED' : dispatcher.violation || generated.error?.code;
        const result = { event_id: context.event.id, input_fingerprint: fingerprint, status,
          factual_truth_verified: false, verification_status: 'needs_review',
          structured_output: generated.structured_output || null,
          verification_metadata: generated.verification_metadata || null,
          warnings: generated.warnings || context.warnings,
          error: status === 'failed' ? { code: SAFE_ERRORS.has(candidateCode) ? candidateCode : 'EOFFLINE_EVALUATION_FAILED' } : null };
        if (dispatcher.diagnostic) result.diagnostic = dispatcher.diagnostic;
        // Never expose or execute the production persistenceReady payload.
        results.set(fingerprint, structuredClone(result)); return result;
      })();
      inFlight.set(fingerprint, work);
      try { return structuredClone(await work); } finally { inFlight.delete(fingerprint); }
    },
    close() { closed = true; dispatcher.close(); }
  });
}

module.exports = { createOfflineSummaryWorkflow };
