/**
 * Hash utilities for article deduplication.
 * Existing schema uses url_hash and content_hash unique columns.
 */

const crypto = require('crypto');

function normalizeForHash(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeUrl(value) {
  return String(value || '').trim();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function buildUrlHash(url) {
  return sha256Hex(normalizeUrl(url));
}

function buildContentHash({ title, description, content, url }) {
  const canonical = [
    normalizeForHash(title),
    normalizeForHash(description),
    normalizeForHash(content),
    normalizeForHash(url)
  ].join('\n');
  return sha256Hex(canonical);
}

module.exports = {
  normalizeForHash,
  normalizeUrl,
  sha256Hex,
  buildUrlHash,
  buildContentHash
};
