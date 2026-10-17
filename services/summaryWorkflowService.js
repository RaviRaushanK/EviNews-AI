/** Application-level generation orchestration. The query service owns persistence. */
const { validateId } = require('./contradictionQueryService');
const { buildInputFingerprint, summaryError } = require('../utils/summaryValidation');

function createSummaryWorkflowService({ contextService, generationService, queryService }) {
  if (!contextService || typeof contextService.buildContextForEvent !== 'function' ||
      !generationService || typeof generationService.generateSummaryForEvent !== 'function' ||
      !queryService || typeof queryService.findSummaryByFingerprint !== 'function' ||
      typeof queryService.persistSummary !== 'function') throw new TypeError('Summary workflow dependencies are required');

  const inFlight = new Map();
  return {
    async generateForEvent(eventId) {
      const id = validateId(eventId, 'event_id');
      const context = await contextService.buildContextForEvent(id);
      const fingerprint = context?.metadata?.input_fingerprint;
      if (context?.event?.id !== id || typeof fingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(fingerprint) || buildInputFingerprint(context) !== fingerprint) {
        throw summaryError('SUMMARY_CONTEXT_INVALID', 'Summary context failed its integrity checks');
      }
      const existing = await queryService.findSummaryByFingerprint(id, fingerprint);
      if (existing) return { status: 'ready', reused: true, summary: existing, attempts: 0 };

      const key = `${id}:${fingerprint}`;
      if (inFlight.has(key)) {
        const result = await inFlight.get(key);
        return result.status === 'ready' ? { ...result, reused: true } : result;
      }
      const work = (async () => {
        const generated = await generationService.generateSummaryForEvent(id, context);
        if (generated.status !== 'generated' || !generated.persistenceReady) {
          const findings = (generated.verification_metadata?.statements || []).map(row => ({
            statement_id: row.statement_id,
            grounding_status: row.grounding_status,
            failed_checks: (row.checks || []).filter(check => check.passed === false).map(check => check.code),
            warnings: (row.warnings || []).map(warning => warning.code)
          }));
          return { status: generated.status, reused: false, summary: null, attempts: generated.attempts || 0,
            reason: generated.reason || null, error: generated.error || null,
            grounding_status: generated.grounding_status || null, warnings: generated.warnings || [], findings };
        }
        if (generated.persistenceReady.event_id !== id || generated.persistenceReady.input_fingerprint !== fingerprint) {
          throw summaryError('SUMMARY_CONTEXT_INVALID', 'Generated summary does not match the requested context');
        }
        const summary = await queryService.persistSummary(generated.persistenceReady);
        return { status: 'ready', reused: false, summary, attempts: generated.attempts || 1 };
      })();
      inFlight.set(key, work);
      try { return await work; }
      finally { inFlight.delete(key); }
    }
  };
}

let defaultService;
function generateForEvent(eventId) {
  if (!defaultService) defaultService = createSummaryWorkflowService({
    contextService: require('./summaryContextService'),
    generationService: require('./summaryGenerationService'),
    queryService: require('./summaryQueryService')
  });
  return defaultService.generateForEvent(eventId);
}

module.exports = { createSummaryWorkflowService, generateForEvent };
