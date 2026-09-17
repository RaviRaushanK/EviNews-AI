/**
 * Collection service.
 * Orchestrates NewsAPI/RSS fetching, normalization, deduplication, and storage.
 */

const { Article } = require('../models');
const { normalizeNewsApiItem, normalizeRssItem } = require('./articleNormalizer');
const newsApiClient = require('./newsApiClient');
const rssCollector = require('./rssCollector');
const sourceService = require('./sourceService');
const { buildUrlHash, buildContentHash } = require('../utils/hashes');

function newResult() {
  return {
    fetched: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };
}

function recordError(result, message) {
  result.failed += 1;
  if (result.errors.length < 10) {
    result.errors.push(String(message || 'Collection item failed').slice(0, 500));
  }
}

async function saveNormalizedArticle(normalized, sourceResolver) {
  const result = { status: 'failed' };

  if (!normalized || !normalized.title || !normalized.url) {
    return { status: 'skipped_invalid' };
  }

  const { source } = await sourceResolver(normalized.source);
  const urlHash = buildUrlHash(normalized.url);
  const contentHash = buildContentHash({
    title: normalized.title,
    description: normalized.description,
    content: normalized.content,
    url: normalized.url
  });

  const duplicateUrl = await Article.findOne({ where: { url_hash: urlHash } });
  if (duplicateUrl) {
    return { status: 'duplicate_url' };
  }

  const duplicateContent = await Article.findOne({ where: { content_hash: contentHash } });
  if (duplicateContent) {
    return { status: 'duplicate_content' };
  }

  try {
    await Article.create({
      source_id: source.id,
      title: normalized.title,
      description: normalized.description,
      content: normalized.content,
      url: normalized.url,
      url_hash: urlHash,
      author: normalized.author,
      published_at: normalized.published_at,
      image_url: normalized.image_url,
      content_hash: contentHash,
      processing_status: 'collected'
    });
    return { status: 'inserted' };
  } catch (error) {
    if (error && error.name === 'SequelizeUniqueConstraintError') {
      return { status: 'duplicate_race' };
    }
    result.error = (error && error.message) || 'Database insert failed';
    return result;
  }
}

function tally(result, status, error) {
  if (status === 'inserted') {
    result.inserted += 1;
  } else if (status === 'duplicate_url' || status === 'duplicate_content' || status === 'duplicate_race') {
    result.duplicates += 1;
  } else if (status === 'skipped_invalid') {
    result.skipped += 1;
  } else {
    recordError(result, error);
  }
}

async function collectFromNewsApi(params = {}) {
  const result = newResult();

  if (!Article) {
    recordError(result, 'Database models are not initialized');
    return result;
  }

  const response = params.mode === 'everything'
    ? await newsApiClient.fetchEverything(params)
    : await newsApiClient.fetchTopHeadlines(params);

  if (!response.ok) {
    recordError(result, response.error);
    return result;
  }

  const items = Array.isArray(response.items) ? response.items : [];
  result.fetched = items.length;

  for (const raw of items) {
    try {
      const normalized = normalizeNewsApiItem(raw);
      if (!normalized) {
        result.skipped += 1;
        continue;
      }
      const outcome = await saveNormalizedArticle(normalized, (source) =>
        sourceService.findOrCreateNewsApiSource({
          name: source.name,
          api_identifier: source.api_identifier
        })
      );
      tally(result, outcome.status, outcome.error);
    } catch (error) {
      recordError(result, error && error.message);
    }
  }

  return result;
}

async function collectFromRss(feedUrls) {
  const result = newResult();
  result.feeds = [];

  if (!Article) {
    recordError(result, 'Database models are not initialized');
    return result;
  }

  const feeds = await rssCollector.fetchAllFeeds(feedUrls);
  for (const feed of feeds) {
    const feedResult = { feedUrl: feed.feedUrl, ok: feed.ok, fetched: feed.items.length, error: feed.error || null };
    result.feeds.push(feedResult);

    if (!feed.ok) {
      recordError(result, `RSS feed failed (${feed.feedUrl}): ${feed.error}`);
      continue;
    }

    result.fetched += feed.items.length;
    for (const raw of feed.items) {
      try {
        const normalized = normalizeRssItem(raw, {
          feedUrl: feed.feedUrl,
          feedTitle: feed.feedTitle,
          feedLink: feed.feedLink
        });
        if (!normalized) {
          result.skipped += 1;
          continue;
        }
        const outcome = await saveNormalizedArticle(normalized, (source) =>
          sourceService.findOrCreateRssSource({
            name: source.name,
            url: source.url,
            rss_url: source.rss_url
          })
        );
        tally(result, outcome.status, outcome.error);
      } catch (error) {
        recordError(result, error && error.message);
      }
    }
  }

  return result;
}

async function getRecentArticles(limit = 20) {
  const safeLimit = Number.isFinite(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 100) : 20;
  return Article.findAll({
    order: [['fetched_at', 'DESC']],
    limit: safeLimit
  });
}

module.exports = {
  collectFromNewsApi,
  collectFromRss,
  getRecentArticles
};
