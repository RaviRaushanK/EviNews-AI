/**
 * Similarity service.
 * Thin orchestration wrapper around pure cosine helpers (testability seam).
 * Cosine math itself lives in src/utils/similarity.js — never duplicate it here.
 */

const { cosineSimilarity, normalizeVector } = require('../utils/similarity');

function similarity(a, b) {
  return cosineSimilarity(a, b);
}

function centroid(vectors) {
  const valid = (Array.isArray(vectors) ? vectors : []).filter(
    (vector) => Array.isArray(vector) && vector.length > 0
  );
  if (valid.length === 0) {
    return null;
  }
  const length = valid[0].length;
  if (!valid.every((vector) => vector.length === length)) {
    return null;
  }
  const mean = new Array(length).fill(0);
  for (const vector of valid) {
    for (let i = 0; i < length; i += 1) {
      mean[i] += vector[i] / valid.length;
    }
  }
  return normalizeVector(mean) || mean;
}

module.exports = {
  similarity,
  centroid
};
