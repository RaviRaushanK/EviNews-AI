require('dotenv').config();
const Sequelize = require('sequelize');
const sequelize = require('../config/db');

const models = {};

function loadModels() {
  if (!sequelize) {
    return null;
  }

  const modelFiles = [
    'source',
    'article',
    'articleEmbedding',
    'event',
    'eventArticle',
    'claim',
    'claimEvidence',
    'contradiction',
    'contradictionCheck',
    'timelineEvent',
    'summary',
    'summaryClaim'
  ];

  for (const modelName of modelFiles) {
    const model = require(`./${modelName}`)(sequelize, Sequelize.DataTypes);
    // Store under both the file key and the Sequelize model name for convenience
    models[modelName] = model;
    models[model.name] = model;
  }

  // Establish associations (iterate unique model instances only)
  const seen = new Set();
  for (const modelName of modelFiles) {
    const model = models[modelName];
    if (model && !seen.has(model) && typeof model.associate === 'function') {
      model.associate(models);
      seen.add(model);
    }
  }

  return models;
}

const loaded = loadModels();

module.exports = {
  sequelize,
  Sequelize,
  ...(loaded || {})
};
