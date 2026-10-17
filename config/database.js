require('dotenv').config();

function assertEnvironment(environment) {
  if (!process.env.NODE_ENV) {
    throw new Error('NODE_ENV must be set to development, test, or production');
  }
  if (process.env.NODE_ENV !== environment) {
    throw new Error(`Database environment mismatch: NODE_ENV is ${process.env.NODE_ENV}, requested ${environment}`);
  }
}

function localConfig(environment) {
  assertEnvironment(environment);
  return {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: environment === 'test' ? `${process.env.DB_NAME}_test` : process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    dialect: 'mysql'
  };
}

function productionConfig() {
  assertEnvironment('production');
  const required = ['HOST', 'PORT', 'NAME', 'USER', 'PASSWORD'];
  const missing = required.filter((key) => !process.env[`PROD_DB_${key}`]?.trim());
  if (missing.length) {
    throw new Error(`Production database configuration missing: ${missing.map((key) => `PROD_DB_${key}`).join(', ')}`);
  }

  const port = Number(process.env.PROD_DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PROD_DB_PORT must be a valid TCP port');
  }

  const normalizeHost = (host) => {
    const value = host.trim().toLowerCase();
    return ['localhost', '127.0.0.1', '::1'].includes(value) ? 'localhost' : value;
  };
  if (process.env.DB_HOST && process.env.DB_NAME &&
      normalizeHost(process.env.PROD_DB_HOST) === normalizeHost(process.env.DB_HOST) &&
      port === (Number(process.env.DB_PORT) || 3306) &&
      process.env.PROD_DB_NAME.toLowerCase() === process.env.DB_NAME.toLowerCase()) {
    throw new Error('Production database target must differ from development');
  }

  return {
    username: process.env.PROD_DB_USER,
    password: process.env.PROD_DB_PASSWORD,
    database: process.env.PROD_DB_NAME,
    host: process.env.PROD_DB_HOST,
    port,
    dialect: 'mysql'
  };
}

module.exports = {
  get development() { return localConfig('development'); },
  get test() { return localConfig('test'); },
  get production() { return productionConfig(); }
};
