/**
 * Threshold-based greedy incremental clustering (connected-components style).
 * Deterministic when input rows are ordered by fetched_at ASC, id ASC.
 * Singletons (size 1) never become events — they stay at status embedded.
 *
 * Score semantics: every member of a kept cluster gets cluster_score =
 * its REAL cosine similarity to its closest peer inside the same cluster.
 * No synthetic 1.0 is ever assigned, so the value always represents an
 * actual computed similarity.
 */

const similarityService = require('./similarityService');

function sortDeterministic(rows) {
  return [...rows].sort((a, b) => {
    const timeA = a.fetched_at ? new Date(a.fetched_at).getTime() : 0;
    const timeB = b.fetched_at ? new Date(b.fetched_at).getTime() : 0;
    if (timeA !== timeB) {
      return timeA - timeB;
    }
    return String(a.article_id).localeCompare(String(b.article_id));
  });
}

function maxSimilarityToCluster(vector, cluster, vectorsByArticle) {
  let best = 0;
  for (const memberId of cluster.memberIds) {
    const memberVector = vectorsByArticle.get(memberId);
    if (!memberVector) {
      continue;
    }
    const score = similarityService.similarity(vector, memberVector);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

/**
 * Real membership score for every member of a cluster:
 * the member's highest computed cosine similarity to another member.
 * For a two-article cluster both members get the actual pairwise similarity.
 */
function computeMemberScores(cluster, vectorsByArticle) {
  const scores = {};
  for (const memberId of cluster.memberIds) {
    let best = null;
    for (const otherId of cluster.memberIds) {
      if (otherId === memberId) {
        continue;
      }
      const memberVector = vectorsByArticle.get(memberId);
      const otherVector = vectorsByArticle.get(otherId);
      if (!memberVector || !otherVector) {
        continue;
      }
      const score = similarityService.similarity(memberVector, otherVector);
      if (best === null || score > best) {
        best = score;
      }
    }
    // null only if a peer vector is missing — the event service stores null then.
    scores[memberId] = best;
  }
  return scores;
}

/**
 * rows: [{ article_id, vector, fetched_at }]
 * Returns { clusters: [{ memberIds, scores }], singletons: [article_id] }
 * clusters[].scores[article_id] is always a real computed similarity.
 */
function clusterVectors(rows, options = {}) {
  const threshold = typeof options.threshold === 'number' ? options.threshold : 0.78;
  const minClusterSize = options.minClusterSize || 2;
  const ordered = sortDeterministic(rows || []);

  const vectorsByArticle = new Map();
  for (const row of ordered) {
    vectorsByArticle.set(row.article_id, row.vector);
  }

  const clusters = [];

  for (const row of ordered) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      const score = maxSimilarityToCluster(row.vector, clusters[i], vectorsByArticle);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestScore >= threshold) {
      clusters[bestIndex].memberIds.push(row.article_id);
    } else {
      clusters.push({ memberIds: [row.article_id] });
    }
  }

  // Kept clusters get real member scores computed from the stored vectors.
  const kept = clusters
    .filter((cluster) => cluster.memberIds.length >= minClusterSize)
    .map((cluster) => ({ memberIds: cluster.memberIds, scores: computeMemberScores(cluster, vectorsByArticle) }));
  const singletonClusters = clusters.filter((cluster) => cluster.memberIds.length < minClusterSize);
  const singletons = singletonClusters.flatMap((cluster) => cluster.memberIds);

  return { clusters: kept, singletons };
}

module.exports = {
  clusterVectors
};
