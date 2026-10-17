/**
 * Database configuration using Sequelize
 * Only initializes when required MySQL environment variables are present
 */

const Sequelize = require('sequelize');

const databaseConfigs = require('./database');
const environment = process.env.NODE_ENV;
if (!environment) {
  throw new Error('NODE_ENV must be set to development, test, or production');
}
if (!Object.hasOwn(databaseConfigs, environment)) {
  throw new Error(`Unsupported database environment: ${environment}`);
}
const config = databaseConfigs[environment];
const useDatabase = config.host && config.username && config.password && config.database;

let sequelize = null;

if (useDatabase) {
  sequelize = new Sequelize(
    config.database,
    config.username,
    config.password,
    {
      host: config.host,
      port: config.port,
      dialect: config.dialect,
      dialectOptions: {
        connectTimeout: 5000,
        multipleStatements: true
      },
      logging: false // Disable verbose logging during development
    }
  );
}

module.exports = sequelize;
