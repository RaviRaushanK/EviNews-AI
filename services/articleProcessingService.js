/**
 * Article processing service (Phase 3).
 * Cleans collected articles and builds deterministic embedding text.
 * No Gemini calls here — embedding happens in embeddingService.
 */

const { cleanText } = require('../utils/text');
const embeddingsConfig = require('../config/embeddings');

const MIN_EMBEDDING_CHARS = 30;

function removeProviderArtifacts(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) {
        return false;
      }
      const lowered = line.toLowerCase();
      if (lowered === '[removed]') {
        return false;
      }
      if (/^\[\+\d+\s+chars\]$/.test(line)) {
        return false;
      }
      return true;
    })
    .join('\n');
}

function cleanField(value) {
  return removeProviderArtifacts(cleanText(value || ''));
}

function truncateAtWordBoundary(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) {
    return value;
  }
  const sliced = value.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(' ');
  if (lastSpace > maxChars * 0.5) {
    return sliced.slice(0, lastSpace).trim();
  }
  return sliced.trim();
}

/**
 * Builds deterministic embedding text with title weighting:
 * title + title + description + content.
 */
function buildEmbeddingText(article, maxChars) {
  const limit = maxChars || embeddingsConfig.gemini.maxChars;
  const title = cleanField(article && article.title);
  const description = cleanField(article && article.description);
  const content = cleanField(article && article.content);

  const parts = [];
  if (title) {
    parts.push(title);
    parts.push(title);
  }
  if (description) {
    parts.push(description);
  }
  if (content) {
    parts.push(content);
  }

  const combined = truncateAtWordBoundary(parts.join('\n\n'), limit);
  return {
    text: combined,
    title,
    description,
    content,
    length: combined.length
  };
}

function prepareArticleForEmbedding(article, maxChars) {
  const built = buildEmbeddingText(article, maxChars);
  if (!built.text || built.text.length < MIN_EMBEDDING_CHARS) {
    return {
      ok: false,
      reason: 'insufficient text for embedding (title/description/content too short or only provider artifacts)',
      text: built.text
    };
  }
  return { ok: true, text: built.text, length: built.length };
}

module.exports = {
  MIN_EMBEDDING_CHARS,
  buildEmbeddingText,
  prepareArticleForEmbedding,
  cleanField,
  truncateAtWordBoundary
};
