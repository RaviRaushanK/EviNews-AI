const { parseTimelineDate } = require('./timeline');

const CATEGORY_LABELS = Object.freeze({
  new_information: 'New information',
  previously_reported: 'Previously reported',
  changed_value: 'Changed value',
  updated_information: 'Updated information',
  contradictory_information: 'Contradictory information',
  unclassified: 'Unclassified'
});

function safeArticleUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch (_) { return null; }
}

function formatDate(value) {
  const date = parseTimelineDate(value);
  return date ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) + ' UTC' : 'Date unavailable';
}

function categoryLabel(value) { return Object.hasOwn(CATEGORY_LABELS, value) ? CATEGORY_LABELS[value] : CATEGORY_LABELS.unclassified; }
function categoryClass(value) { return Object.hasOwn(CATEGORY_LABELS, value) ? value : 'unclassified'; }
function confidenceLabel(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 100) + '%' : 'Unavailable'; }

module.exports = { safeArticleUrl, formatDate, categoryLabel, categoryClass, confidenceLabel };
