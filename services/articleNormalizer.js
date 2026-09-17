/**
 * Article normalizer.
 * Maps NewsAPI and RSS payloads into one canonical Phase 2 shape.
 */

const { cleanText, truncate, parseDateSafe, isHttpUrl } = require('../utils/text');

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function extractRssImage(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (item.enclosure && item.enclosure.url) {
    return item.enclosure.url;
  }
  const mediaContent = item['media:content'];
  if (mediaContent && mediaContent.$ && mediaContent.$.url) {
    return mediaContent.$.url;
  }
  const mediaThumbnail = item['media:thumbnail'];
  if (mediaThumbnail && mediaThumbnail.$ && mediaThumbnail.$.url) {
    return mediaThumbnail.$.url;
  }
  return null;
}

function normalizeNewsApiItem(raw, fallbackSourceName) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const title = cleanText(raw.title);
  const url = String(raw.url || '').trim();
  if (!title || !isHttpUrl(url)) {
    return null;
  }

  const sourceName = cleanText((raw.source && raw.source.name) || fallbackSourceName || 'NewsAPI') || 'NewsAPI';

  return {
    source: {
      name: truncate(sourceName, 255),
      url: null,
      rss_url: null,
      api_identifier: truncate((raw.source && raw.source.id) || null, 100)
    },
    title,
    description: cleanText(raw.description) || null,
    content: cleanText(raw.content) || null,
    url,
    author: truncate(cleanText(raw.author) || null, 255),
    published_at: parseDateSafe(raw.publishedAt),
    image_url: truncate(String(raw.urlToImage || '').trim() || null, 1024)
  };
}

function normalizeRssItem(raw, feedMeta = {}) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const title = cleanText(raw.title);
  const url = String(pickFirst(raw.link, raw.id, raw.guid) || '').trim();
  if (!title || !isHttpUrl(url)) {
    return null;
  }

  const feedTitle = cleanText(feedMeta.feedTitle || raw.source || 'RSS Feed') || 'RSS Feed';

  return {
    source: {
      name: truncate(feedTitle, 255),
      url: truncate(String(feedMeta.feedLink || '').trim() || null, 512),
      rss_url: truncate(String(feedMeta.feedUrl || '').trim() || null, 512),
      api_identifier: null
    },
    title,
    description: cleanText(pickFirst(raw.contentSnippet, raw.summary, raw.description)) || null,
    content: cleanText(pickFirst(raw.content, raw['content:encoded'], raw.contentSnippet)) || null,
    url,
    author: truncate(cleanText(pickFirst(raw.creator, raw.author)) || null, 255),
    published_at: parseDateSafe(pickFirst(raw.isoDate, raw.pubDate, raw.updated)),
    image_url: truncate(String(extractRssImage(raw) || '').trim() || null, 1024)
  };
}

module.exports = {
  normalizeNewsApiItem,
  normalizeRssItem
};
