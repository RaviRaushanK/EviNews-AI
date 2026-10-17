'use strict';

const HARD_LIMITS = Object.freeze({ maxEvents: 12, maxArticles: 100, maxSummaryAttempts: 24, maxProviderCalls: 24 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function failure(code) { const error = new Error('Isolated evaluation rejected'); error.code = code; return error; }
function requireSafe(ok, code) { if (!ok) throw failure(code); }
function fields(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function target(value, dedicated = false) {
  requireSafe(fields(value, ['host', 'port', 'database']), 'ELIVE_TARGET_INVALID');
  requireSafe(typeof value.host === 'string' && value.host.length <= 253 &&
    /^(?:[a-zA-Z0-9][a-zA-Z0-9.-]*|::1)$/.test(value.host), 'ELIVE_TARGET_INVALID');
  requireSafe(Number.isInteger(value.port) && value.port >= 1 && value.port <= 65535, 'ELIVE_TARGET_INVALID');
  requireSafe(typeof value.database === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(value.database), 'ELIVE_TARGET_INVALID');
  const host = value.host.toLowerCase();
  const result = { host: ['localhost', '127.0.0.1', '::1'].includes(host) ? 'localhost' : host, port: value.port, database: value.database.toLowerCase() };
  if (dedicated) requireSafe(/^evinews_ai_eval_[a-z0-9_]+$/.test(result.database), 'ELIVE_DEDICATED_TARGET_REQUIRED');
  return result;
}
function key(value) { return JSON.stringify(value); }
function ids(value, code, maximum = HARD_LIMITS.maxArticles) {
  requireSafe(Array.isArray(value) && value.length > 0 && value.length <= maximum && value.every(id => typeof id === 'string' && UUID.test(id)) && new Set(value).size === value.length, code);
  return [...value];
}
function limits(value) {
  requireSafe(fields(value, Object.keys(HARD_LIMITS)), 'ELIVE_LIMITS_INVALID');
  for (const name of Object.keys(HARD_LIMITS)) requireSafe(Number.isSafeInteger(value[name]) && value[name] > 0 && value[name] <= HARD_LIMITS[name], 'ELIVE_LIMITS_INVALID');
  return { ...value };
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

// Pure validation: no environment defaults, dotenv, adapters, secrets or I/O.
function validatePreflight(config, approval) {
  requireSafe(config?.mode === 'isolated-live', 'ELIVE_MODE_REQUIRED');
  requireSafe(fields(config, ['mode', 'target', 'eventIds', 'articles', 'attempts', 'limits', 'summary']), 'ELIVE_CONFIG_INVALID');
  requireSafe(fields(approval, ['approved', 'targetAllowlist', 'developmentTarget', 'productionTargets', 'productionNotConfigured', 'eventIds', 'articleIds', 'limits', 'summary']), 'ELIVE_APPROVAL_REQUIRED');
  requireSafe(approval.approved === true, 'ELIVE_APPROVAL_REQUIRED');
  const selected = target(config.target, true), development = target(approval.developmentTarget);
  requireSafe(Array.isArray(approval.productionTargets) && typeof approval.productionNotConfigured === 'boolean' &&
    (approval.productionNotConfigured ? approval.productionTargets.length === 0 : approval.productionTargets.length > 0), 'ELIVE_PROTECTED_TARGETS_REQUIRED');
  const production = approval.productionTargets.map(row => target(row));
  // Reject protected database names even at a different hostname/port.
  requireSafe(![development, ...production].some(row => row.database === selected.database), 'ELIVE_PROTECTED_TARGET');
  requireSafe(Array.isArray(approval.targetAllowlist) && approval.targetAllowlist.length > 0 && approval.targetAllowlist.length <= 12, 'ELIVE_ALLOWLIST_REQUIRED');
  const allowlist = approval.targetAllowlist.map(row => target(row, true));
  requireSafe(allowlist.every(row => ![development, ...production].some(protectedTarget => protectedTarget.database === row.database)), 'ELIVE_PROTECTED_TARGET');
  requireSafe(new Set(allowlist.map(key)).size === allowlist.length && allowlist.some(row => key(row) === key(selected)), 'ELIVE_TARGET_NOT_APPROVED');
  const budget = limits(config.limits), approvedLimits = limits(approval.limits);
  requireSafe(Object.keys(budget).every(name => budget[name] <= approvedLimits[name]), 'ELIVE_BUDGET_NOT_APPROVED');
  const events = ids(config.eventIds, 'ELIVE_EVENTS_INVALID', HARD_LIMITS.maxEvents), allowedEvents = ids(approval.eventIds, 'ELIVE_EVENTS_INVALID', HARD_LIMITS.maxEvents);
  requireSafe(events.length <= budget.maxEvents && events.every(id => allowedEvents.includes(id)), 'ELIVE_EVENT_LIMIT');
  const allowedArticles = ids(approval.articleIds, 'ELIVE_ARTICLES_INVALID');
  requireSafe(Array.isArray(config.articles) && config.articles.length > 0 && config.articles.length <= budget.maxArticles, 'ELIVE_ARTICLE_LIMIT');
  const articles = config.articles.map(row => {
    requireSafe(fields(row, ['id', 'event_id']) && UUID.test(row.id) && events.includes(row.event_id) && allowedArticles.includes(row.id), 'ELIVE_ARTICLES_INVALID');
    return { id: row.id, event_id: row.event_id };
  });
  requireSafe(new Set(articles.map(row => row.id)).size === articles.length && events.every(id => articles.some(row => row.event_id === id)), 'ELIVE_ARTICLES_INVALID');
  requireSafe(Array.isArray(config.attempts) && config.attempts.length > 0 && config.attempts.length <= budget.maxSummaryAttempts &&
    config.attempts.every(id => events.includes(id)), 'ELIVE_ATTEMPT_LIMIT');
  const summaryKeys = ['model', 'promptVersion', 'contractVersion', 'timeoutMs'];
  requireSafe(fields(config.summary, summaryKeys) && fields(approval.summary, summaryKeys), 'ELIVE_SUMMARY_INVALID');
  requireSafe(typeof config.summary.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(config.summary.model) &&
    config.summary.promptVersion === 'phase7-v2' && config.summary.contractVersion === 'phase7-summary-v2' &&
    Number.isSafeInteger(config.summary.timeoutMs) && config.summary.timeoutMs > 0 && config.summary.timeoutMs <= 60000 &&
    summaryKeys.every(name => config.summary[name] === approval.summary[name]), 'ELIVE_SUMMARY_INVALID');
  return freeze({ mode: config.mode, target: selected, eventIds: events, articles, attempts: [...config.attempts], limits: budget, summary: { ...config.summary } });
}
module.exports = { validatePreflight, failure, requireSafe, HARD_LIMITS };
