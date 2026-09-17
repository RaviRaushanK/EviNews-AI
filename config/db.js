/**
 * Database configuration using Sequelize
 * Only initializes when required MySQL environment variables are present
 */

const Sequelize = require('sequelize');

// Check if required environment variables are set
const useDatabase = (
  process.env.DB_HOST &&
  process.env.DB_USER &&
  process.env.DB_PASSWORD &&
  process.env.DB_NAME
);

let sequelize = null;

if (useDatabase) {
  sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
    {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      dialect: 'mysql',
      dialectOptions: {
        connectTimeout: 5000,
        multipleStatements: true
      },
      logging: false // Disable verbose logging during development
    }
  );
}

module.exports = sequelize;