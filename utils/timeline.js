const { parseDateSafe } = require('./text');

function parseTimelineDate(value) {
  try {
    if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value === 'string') {
      // Reject timezone-dependent strings and calendar dates JS would roll forward.
      const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/);
      if (!match) return null;
      const clock = value.trim().match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
      if (clock && (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59)) return null;
      const day = new Date(0);
      day.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      if (day.getUTCFullYear() !== Number(match[1]) || day.getUTCMonth() !== Number(match[2]) - 1 || day.getUTCDate() !== Number(match[3])) return null;
    }
    const date = parseDateSafe(value === 0 ? new Date(0) : value);
    return date ? date.toISOString() : null;
  } catch (_) {
    return null;
  }
}

function selectReportDate(article = {}) {
  for (const field of ['published_at', 'fetched_at']) {
    const timestamp = parseTimelineDate(article && article[field]);
    if (timestamp) return { report_timestamp: timestamp, date_source: field };
  }
  return { report_timestamp: null, date_source: null };
}

function buildTimelineEntry(article = {}, claims = null, evidence = null) {
  article = article && typeof article === 'object' ? article : {};
  const rows = Array.isArray(claims) ? structuredClone(claims) : [];
  const snippets = Array.isArray(evidence)
    ? structuredClone(evidence)
    : rows.flatMap((claim) => Array.isArray(claim.evidence) ? structuredClone(claim.evidence) : []);
  return {
    article_id: article.id || null,
    source: structuredClone(article.source || article.Source || { id: article.source_id || null }),
    title: typeof article.title === 'string' ? article.title : '',
    ...selectReportDate(article),
    claims: rows,
    evidence: snippets,
    claim_count: rows.length,
    claims_status: !Array.isArray(claims) ? 'unavailable' : rows.length ? 'available' : 'empty',
    claims_unavailable: !Array.isArray(claims),
    claims_empty: Array.isArray(claims) && rows.length === 0
  };
}

function compareTimelineEntries(first, second) {
  const a = parseTimelineDate(first.report_timestamp);
  const b = parseTimelineDate(second.report_timestamp);
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  }
  const firstId = String(first.article_id || '');
  const secondId = String(second.article_id || '');
  return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
}

function sortTimelineEntries(entries = []) {
  return (Array.isArray(entries) ? structuredClone(entries) : []).sort(compareTimelineEntries);
}

function groupTimelineEntries(entries = []) {
  const groups = [];
  for (const entry of sortTimelineEntries(entries)) {
    const timestamp = parseTimelineDate(entry.report_timestamp);
    const previous = groups[groups.length - 1];
    if (timestamp !== null && previous && previous.report_timestamp === timestamp) {
      previous.entries.push(entry);
      previous.tied = true;
    } else {
      groups.push({ report_timestamp: timestamp, tied: false, entries: [entry] });
    }
  }
  return groups;
}

module.exports = { parseTimelineDate, selectReportDate, buildTimelineEntry, compareTimelineEntries, sortTimelineEntries, groupTimelineEntries };
