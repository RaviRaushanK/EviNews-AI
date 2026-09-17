/**
 * API routes definition
 */

const express = require('express');
const collectionController = require('../controllers/collectionController');
const processingController = require('../controllers/processingController');

const router = express.Router();

// Example route - health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Phase 2: multi-source collection endpoints (verification only, no dashboard yet).
router.post('/collect/newsapi', collectionController.collectNewsApi);
router.post('/collect/rss', collectionController.collectRss);
router.get('/articles/recent', collectionController.recentArticles);

// Phase 3: processing + clustering verification endpoints (no dashboard yet).
router.post('/process/articles', processingController.processArticles);
router.post('/process/articles/reconcile', processingController.reconcileArticles);
router.post('/cluster/articles', processingController.clusterArticles);
router.get('/events', processingController.listEvents);
router.get('/events/:id', processingController.getEvent);

module.exports = router;

