/**
 * Phase 3 clustering-quality evaluation (read-only).
 *
 * Loads ground-truth labels from evaluation/phase3-labels.json,
 * fetches the existing stored embeddings for those articles,
 * and runs the pure clusterVectors() function in memory for each
 * threshold using the SAME vectors.
 *
 * Strictly read-only:
 * - never calls clusteringOrchestrationService
 * - never creates/updates/deletes events or event_articles
 * - never updates article statuses
 * - never calls Gemini
 * - never writes to the database
 *
 * Usage:
 *   node scripts/evaluate-clustering.js
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const models = require('../models');
const clusteringService = require('../services/clusteringService');

const THRESHOLDS = [0.70, 0.75, 0.78, 0.82, 0.85];
const MIN_CLUSTER_SIZE = 2;
const EXPECTED_DIMENSIONS = 768;

function isNoneLabel(label) {
  return typeof label === 'string' && label.startsWith('NONE_');
}

function evaluateThreshold(rows, labels, threshold) {
  const { clusters, singletons } = clusteringService.clusterVectors(rows, {
    threshold,
    minClusterSize: MIN_CLUSTER_SIZE
  });

  // Predicted cluster index per article (singletons get none).
  const predicted = {};
  clusters.forEach((cluster, index) => {
    for (const memberId of cluster.memberIds) {
      predicted[memberId] = index;
    }
  });

  const ids = rows.map((row) => row.article_id);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let falseMerges = 0;
  let falseSplits = 0;

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      const sameTruth = !isNoneLabel(labels[a]) && labels[a] === labels[b];
      const samePredicted = predicted[a] !== undefined && predicted[a] === predicted[b];
      if (sameTruth && samePredicted) {
        tp += 1;
      } else if (!sameTruth && samePredicted) {
        fp += 1;
        falseMerges += 1;
      } else if (sameTruth && !samePredicted) {
        fn += 1;
        falseSplits += 1;
      }
    }
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;

  return {
    threshold,
    tp,
    fp,
    fn,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    clusters: clusters.length,
    singletons: singletons.length,
    false_merges: falseMerges,
    false_splits: falseSplits
  };
}

async function main() {
  const labelsPath = path.join(__dirname, '..', 'evaluation', 'phase3-labels.json');
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const ids = Object.keys(labels);

  const { Article, ArticleEmbedding, sequelize } = models;
  if (!Article || !ArticleEmbedding) {
    console.error('Database models are not initialized. Check your .env DB settings.');
    process.exitCode = 1;
    return;
  }

  const labelCounts = {};
  for (const id of ids) {
    labelCounts[labels[id]] = (labelCounts[labels[id]] || 0) + 1;
  }
  console.log('LABELED_ARTICLES=' + ids.length);
  console.log('LABEL_COUNTS=' + JSON.stringify(labelCounts));

  const rows = [];
  const missing = [];
  for (const id of ids) {
    const article = await Article.findByPk(id);
    if (!article) {
      missing.push(id + ' (article missing)');
      continue;
    }
    const embedding = await ArticleEmbedding.findOne({ where: { article_id: id } });
    if (!embedding || !Array.isArray(embedding.vector) || embedding.vector.length !== EXPECTED_DIMENSIONS) {
      missing.push(id + ' (embedding missing/invalid)');
      continue;
    }
    rows.push({ article_id: id, vector: embedding.vector, fetched_at: article.fetched_at });
  }

  if (missing.length > 0) {
    console.error('MISSING_EMBEDDINGS=' + JSON.stringify(missing));
    process.exitCode = 1;
    if (sequelize) {
      await sequelize.close();
    }
    return;
  }
  console.log('EMBEDDINGS_OK=' + rows.length + ' model=gemini-embedding-001 dimensions=768');

  const results = THRESHOLDS.map((threshold) => evaluateThreshold(rows, labels, threshold));
  for (const result of results) {
    console.log('THRESHOLD_RESULT=' + JSON.stringify(result));
  }

  if (sequelize) {
    await sequelize.close();
  }
}

main().catch((error) => {
  console.error('EVALUATE_FAILED: ' + (error && error.message));
  process.exitCode = 1;
});
