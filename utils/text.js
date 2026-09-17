/**
 * Small text helpers used during article normalization.
 */

function stripHtml(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(value) {
  return stripHtml(value).replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function parseDateSafe(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^(https?:\/\/)/i.test(value.trim());
}

module.exports = {
  stripHtml,
  cleanText,
  truncate,
  parseDateSafe,
  isHttpUrl
};
