/** Read-only change composition using strictly earlier report groups. */
const { parseTimelineDate, groupTimelineEntries } = require('../utils/timeline');
const { compareClaims } = require('../utils/eventChanges');
const { validateId } = require('./contradictionQueryService');
const contradictionsConfig = require('../config/contradictions');

function changeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateWindow(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw changeError('INVALID_CHANGE_OPTIONS', 'options must be an object');
  const result = { since: null, until: null };
  for (const key of ['since', 'until']) {
    if (options[key] === undefined) continue;
    result[key] = parseTimelineDate(options[key]);
    if (!result[key]) throw changeError('INVALID_CHANGE_DATE', key + ' must be a valid ISO date with an explicit timezone, or a date-only value.');
  }
  if (result.since && result.until && new Date(result.since).getTime() >= new Date(result.until).getTime()) {
    throw changeError('INVALID_CHANGE_RANGE', 'since must be earlier than until');
  }
  return result;
}

function reportContext(entry) {
  return entry ? {
    article_id: entry.article_id,
    timestamp: entry.report_timestamp,
    date_source: entry.date_source,
    title: entry.title,
    url: entry.url || null,
    source: structuredClone(entry.source)
  } : null;
}

function createEventChangeService({ timelineService, contradictionQuery }) {
  if (!timelineService || typeof timelineService.getTimelineForEvent !== 'function') throw new TypeError('timeline service is required');
  if (!contradictionQuery || typeof contradictionQuery.getContradictionsForEvent !== 'function') throw new TypeError('contradiction query service is required');

  return {
    async getChangesForEvent(eventId, options = {}) {
      const id = validateId(eventId, 'event_id');
      const window = validateWindow(options);
      // Load the full event before applying output bounds so older context survives.
      const timeline = await timelineService.getTimelineForEvent(id);
      const entries = timeline.entries;
      const warnings = structuredClone(timeline.warnings || []);
      const groups = groupTimelineEntries(entries);
      const claimById = new Map();
      const reportByClaim = new Map();
      for (const entry of entries) {
        for (const claim of entry.claims) {
          claimById.set(claim.id, claim);
          reportByClaim.set(claim.id, entry);
        }
      }

      const limit = contradictionsConfig.query.maxLimit;
      let response = null;
      try { response = await contradictionQuery.getContradictionsForEvent(id, { limit }); }
      catch (_) { /* Report unavailable annotations without failing the timeline. */ }
      const available = Boolean(response && Array.isArray(response.contradictions));
      const rows = available ? response.contradictions : [];
      const coverage = !available ? 'unknown' : rows.length >= limit ? 'limited' : 'unknown';
      warnings.push({
        code: !available ? 'CONTRADICTION_DATA_UNAVAILABLE' : coverage === 'limited' ? 'CONTRADICTION_COVERAGE_LIMITED' : 'CONTRADICTION_COVERAGE_UNKNOWN',
        message: !available ? 'Stored contradiction annotations could not be loaded.' : coverage === 'limited'
          ? 'The query reached its result cap; additional stored contradictions may be omitted.'
          : 'Available stored relations do not establish that every claim pair has been evaluated.'
      });
      const annotations = rows.map((row) => ({
        id: row.id,
        claim_id_1: row.claim_1 && row.claim_1.id || row.claim_id_1,
        claim_id_2: row.claim_2 && row.claim_2.id || row.claim_id_2,
        contradiction_type: row.contradiction_type,
        status: row.status,
        reason: row.reason
      })).filter((row) => claimById.has(row.claim_id_1) && claimById.has(row.claim_id_2) && ['direct', 'partial', 'temporal'].includes(row.contradiction_type))
        .sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

      const history = [];
      const changes = [];
      let baselineReports = 0;
      let selectedReports = 0;
      let undatedReports = 0;
      const since = window.since ? new Date(window.since).getTime() : -Infinity;
      const until = window.until ? new Date(window.until).getTime() : Infinity;
      for (const group of groups) {
        if (!group.report_timestamp) { undatedReports += group.entries.length; continue; }
        const time = new Date(group.report_timestamp).getTime();
        if (time > until) continue;
        if (time <= since) {
          baselineReports += group.entries.length;
        } else {
          selectedReports += group.entries.length;
          for (const entry of group.entries) {
            const currentClaims = [...entry.claims].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
            for (const comparison of compareClaims(currentClaims, history, annotations)) {
              const previous = claimById.get(comparison.previous_claim_id);
              const current = claimById.get(comparison.current_claim_id);
              const earlierIds = new Set(history.map((claim) => claim.id));
              const stored = annotations.filter((row) =>
                (row.claim_id_1 === current.id && earlierIds.has(row.claim_id_2)) ||
                (row.claim_id_2 === current.id && earlierIds.has(row.claim_id_1)))
                .map((row) => {
                  const previousId = row.claim_id_1 === current.id ? row.claim_id_2 : row.claim_id_1;
                  return {
                    ...row,
                    outcome: row.contradiction_type,
                    previous_claim_id: previousId,
                    current_claim_id: current.id,
                    previous_report: reportContext(reportByClaim.get(previousId))
                  };
                });
              changes.push({
                ...comparison,
                previous_report: reportContext(reportByClaim.get(comparison.previous_claim_id)),
                current_report: reportContext(entry),
                previous_claim: previous ? structuredClone(previous) : null,
                current_claim: structuredClone(current),
                stored_contradictions: stored,
                evidence: structuredClone(current.evidence || []),
                previous_evidence: structuredClone(previous && previous.evidence || [])
              });
            }
          }
        }
        // Add the whole group only after comparisons; IDs do not establish time order.
        for (const entry of group.entries) history.push(...entry.claims);
      }
      if (undatedReports) warnings.push({ code: 'UNDATED_REPORTS_NOT_COMPARED', count: undatedReports, message: 'Reports without a valid timestamp remain on the timeline but cannot be ordered for change analysis.' });
      return {
        event: structuredClone(timeline.event),
        baseline: { ...window, interval: '(since, until]', reports_at_or_before_since: baselineReports, selected_reports: selectedReports, undated_reports: undatedReports },
        count: changes.length,
        changes,
        warnings,
        completeness: {
          status: timeline.completeness.status === 'partial' || coverage === 'limited' || !available ? 'partial' : 'unknown',
          coverage: {
            ...structuredClone(timeline.completeness.coverage),
            contradictions: { status: coverage, available, returned: rows.length, accepted: annotations.length, limit }
          }
        }
      };
    }
  };
}

let defaultService;
function getDefaultService() {
  if (!defaultService) defaultService = createEventChangeService({
    timelineService: require('./eventTimelineService'),
    contradictionQuery: require('./contradictionQueryService')
  });
  return defaultService;
}

async function getChangesForEvent(eventId, options = {}) {
  return getDefaultService().getChangesForEvent(eventId, options);
}

module.exports = { validateWindow, createEventChangeService, getChangesForEvent };
