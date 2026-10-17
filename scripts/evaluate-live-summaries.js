'use strict';

const { validatePreflight, failure, requireSafe } = require('../evaluation/liveSummarySafety');
const { createProviderDispatcher } = require('../evaluation/providerDispatch');
const { createSingleRequestHttpsDispatcher } = require('../evaluation/singleRequestHttpsTransport');
const AUTHORIZATION = 'APPROVED_ISOLATED_LIVE_EVALUATION';
const ERROR_CODES = new Set(['ELIVE_PROVIDER_BUDGET', 'ELIVE_PROVIDER_CONTRACT', 'ELIVE_CONTEXT_SCOPE', 'ELIVE_CONTEXT_LIMIT', 'ELIVE_ADAPTER_INVALID',
  'GEMINI_TIMEOUT', 'GEMINI_AUTH', 'GEMINI_SERVER', 'GEMINI_RATE_LIMIT', 'GEMINI_BAD_REQUEST', 'GEMINI_ERROR',
  'SUMMARY_INVALID_OUTPUT', 'SUMMARY_INVALID_JSON', 'SUMMARY_CONTEXT_INVALID', 'SUMMARY_PERSISTENCE_FAILED']);
function safeCode(error) { return ERROR_CODES.has(error?.code) ? error.code : 'ELIVE_EXECUTION_FAILED'; }

async function runLiveEvaluation(config, approval, dependencies, authorization) {
  const plan = validatePreflight(config, approval);
  requireSafe(authorization === AUTHORIZATION, 'ELIVE_EXECUTION_NOT_AUTHORIZED');
  requireSafe(dependencies && typeof dependencies.initialize === 'function', 'ELIVE_ADAPTER_REQUIRED');
  requireSafe(!('provider' in dependencies) && !('generateOnce' in dependencies), 'ELIVE_LEGACY_PROVIDER_REJECTED');
  requireSafe(!(dependencies.transport && dependencies.httpsTransport), 'ELIVE_ADAPTER_INVALID');
  let provider;
  if (dependencies.httpsTransport) {
    const settings = dependencies.httpsTransport;
    const binding = dependencies.executionMode === 'loopback-test' ? 'loopback' : 'httpsFixture';
    requireSafe(Object.getPrototypeOf(settings) === Object.prototype && Object.hasOwn(settings, binding) &&
      Object.keys(settings).every(key => [binding, 'maxResponseBytes'].includes(key)), 'ELIVE_ADAPTER_INVALID');
    provider = createSingleRequestHttpsDispatcher({ ...settings, executionMode: dependencies.executionMode,
      model: plan.summary.model, timeoutMs: plan.summary.timeoutMs, maxProviderCalls: plan.limits.maxProviderCalls });
  } else {
    provider = createProviderDispatcher({ executionMode: dependencies.executionMode, transport: dependencies.transport,
      maxProviderCalls: plan.limits.maxProviderCalls, ...plan.summary });
  }
  let resource;
  let attempts = 0, violation = null;
  const results = [];
  const started = performance.now();
  try {
    // Trusted adapters are supplied explicitly after preflight; never import the
    // application's default models, DB config or provider client here.
    resource = await dependencies.initialize(plan);
    requireSafe(resource && resource.contextService && typeof resource.contextService.buildContextForEvent === 'function' &&
      resource.summaryRepository && typeof resource.summaryRepository.transaction === 'function' &&
      !('provider' in resource) && typeof resource.close === 'function', 'ELIVE_ADAPTER_INVALID');
    const { createSummaryGenerationService } = require('../services/summaryGenerationService');
    const { createSummaryWorkflowService } = require('../services/summaryWorkflowService');
    const { createSummaryQueryService } = require('../services/summaryQueryService');
    const { requireContext } = require('../utils/summaryValidation');
    const scopedContext = { async buildContextForEvent(id) {
      requireSafe(plan.eventIds.includes(id), 'ELIVE_CONTEXT_SCOPE');
      const context = await resource.contextService.buildContextForEvent(id);
      requireSafe(context?.event?.id === id && Array.isArray(context.reports), 'ELIVE_CONTEXT_SCOPE');
      const allowed = plan.articles.filter(row => row.event_id === id).map(row => row.id);
      requireSafe(context.reports.length <= allowed.length && context.reports.every(row => allowed.includes(row.article_id)), 'ELIVE_CONTEXT_SCOPE');
      requireSafe(Array.isArray(context.claims) && context.claims.length <= 50 && Array.isArray(context.evidence) && context.evidence.length <= 100 &&
        Array.isArray(context.contradictions) && context.contradictions.length <= 100 && Buffer.byteLength(JSON.stringify(context)) <= 64000, 'ELIVE_CONTEXT_LIMIT');
      requireContext(context);
      return context;
    } };
    const settings = { ...plan.summary, provider: 'gemini', maxStatements: 30, maxStatementChars: 2000 };
    const generation = createSummaryGenerationService({ contextService: scopedContext, geminiClient: provider, config: settings });
    const query = createSummaryQueryService({ repository: resource.summaryRepository });
    const workflow = createSummaryWorkflowService({ contextService: scopedContext, generationService: generation, queryService: query });
    for (const id of plan.attempts) {
      requireSafe(attempts < plan.limits.maxSummaryAttempts, 'ELIVE_ATTEMPT_LIMIT');
      attempts++;
      const before = provider.dispatches, time = performance.now();
      const result = await workflow.generateForEvent(id);
      results.push({ attempt: attempts, event_id: id, status: ['ready', 'failed', 'needs_review', 'insufficient_grounding'].includes(result.status) ? result.status : 'failed',
        reused: result.reused === true, providerDispatches: provider.dispatches - before, durationMs: Math.round(performance.now() - time),
        error: result.error ? safeCode(result.error) : null });
      if (provider.violation || ['failed', 'needs_review', 'insufficient_grounding'].includes(result.status)) break;
    }
  } catch (error) {
    violation = safeCode(error);
  } finally {
    provider.close();
    if (provider.violation) violation = provider.violation;
    if (resource && typeof resource.close === 'function') {
      try { await resource.close(); } catch (_) { violation = 'ELIVE_CLEANUP_FAILED'; }
    }
  }
  const complete = !violation && results.length === plan.attempts.length && results.every(row => row.status === 'ready');
  return { mode: 'OFFLINE_DISPATCH_EVALUATION', complete, results, summaryAttempts: attempts, providerDispatches: provider.dispatches,
    durationMs: Math.round(performance.now() - started), error: violation, exitCode: complete ? 0 : 1,
    limitations: ['In-memory or loopback tests only; external execution is unavailable. Injected repositories are trusted, not sandboxed.',
      'This report is operational only, not a human quality score.'] };
}

// No adapter paths, URL fetching, dotenv, credential loading or live default.
function main() {
  try {
    requireSafe(process.argv.length === 3 && process.argv[2] === '--preflight-stdin', 'ELIVE_PREFLIGHT_ONLY');
    const fs = require('node:fs'), chunks = [];
    let total = 0;
    const buffer = Buffer.alloc(4096);
    for (;;) {
      const size = fs.readSync(0, buffer, 0, buffer.length, null);
      if (!size) break;
      total += size; requireSafe(total <= 200000, 'ELIVE_INPUT_LIMIT'); chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const plan = validatePreflight(input.config, input.approval);
    console.log(JSON.stringify({ status: 'PREFLIGHT_VALID', execution: 'NOT RUN', events: plan.eventIds.length, articles: plan.articles.length,
      attempts: plan.attempts.length, maximumProviderDispatches: plan.limits.maxProviderCalls, databaseIsolation: 'NOT VERIFIED' }));
  } catch (_) {
    console.log(JSON.stringify({ status: 'PREFLIGHT_REJECTED', execution: 'NOT RUN' })); process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { runLiveEvaluation, AUTHORIZATION };
