const router = require('express').Router();
const controller = require('../controllers/eventPageController');
router.get('/events', controller.index);
router.get('/events/:eventId', controller.show);
module.exports = router;
