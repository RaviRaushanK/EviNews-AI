/**
 * Pure cosine-similarity helpers. No database or provider logic here.
 */

function dotProduct(a, b) {
  let sum = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    sum += a[i] * b[i];
  }
  return sum;
}

function vectorNorm(values) {
  let sum = 0;
  for (const value of values) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function isValidVector(values) {
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((value) => typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Cosine similarity in [-1, 1]. Returns 0 when either vector has zero norm
 * so that empty/degenerate vectors never crash clustering.
 */
function cosineSimilarity(a, b) {
  if (!isValidVector(a) || !isValidVector(b) || a.length !== b.length) {
    return 0;
  }
  const normA = vectorNorm(a);
  const normB = vectorNorm(b);
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dotProduct(a, b) / (normA * normB);
}

function normalizeVector(values) {
  if (!isValidVector(values)) {
    return null;
  }
  const norm = vectorNorm(values);
  if (norm === 0) {
    return null;
  }
  return values.map((value) => value / norm);
}

module.exports = {
  cosineSimilarity,
  normalizeVector,
  isValidVector
};
