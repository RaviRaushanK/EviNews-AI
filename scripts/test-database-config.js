const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');

const keys = [
  'NODE_ENV', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'PROD_DB_HOST', 'PROD_DB_PORT', 'PROD_DB_NAME', 'PROD_DB_USER', 'PROD_DB_PASSWORD'
];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const configPath = path.resolve(__dirname, '../config/database.js');
const runtimePath = path.resolve(__dirname, '../config/db.js');

function configure(environment, production = {}) {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: environment,
    DB_HOST: 'localhost',
    DB_PORT: '3306',
    DB_NAME: 'evinews_ai',
    DB_USER: 'local_user',
    DB_PASSWORD: 'local_password',
    ...production
  });
  delete require.cache[configPath];
  delete require.cache[runtimePath];
}

function runtimeOptions() {
  const sequelize = require(runtimePath);
  assert.ok(sequelize);
  return sequelize.config;
}

test('development CLI and runtime use the local database', () => {
  configure('development');
  const cli = require(configPath).development;
  const runtime = runtimeOptions();
  assert.equal(cli.host, 'localhost');
  assert.equal(cli.port, 3306);
  assert.equal(cli.database, 'evinews_ai');
  assert.equal(runtime.database, cli.database);
  assert.equal(runtime.host, cli.host);
  assert.equal(runtime.port, cli.port);
});

test('test CLI and runtime use the test database', () => {
  configure('test');
  const cli = require(configPath).test;
  const runtime = runtimeOptions();
  assert.equal(cli.database, 'evinews_ai_test');
  assert.equal(runtime.database, cli.database);
  assert.equal(runtime.host, cli.host);
});

test('production CLI and runtime use only the separate production target', () => {
  configure('production', {
    PROD_DB_HOST: 'prod.example.invalid',
    PROD_DB_PORT: '3307',
    PROD_DB_NAME: 'prod_news',
    PROD_DB_USER: 'prod_user',
    PROD_DB_PASSWORD: 'prod_password'
  });
  const cli = require(configPath).production;
  const runtime = runtimeOptions();
  assert.equal(cli.host, 'prod.example.invalid');
  assert.equal(cli.port, 3307);
  assert.equal(cli.database, 'prod_news');
  assert.equal(runtime.database, cli.database);
  assert.equal(runtime.username, cli.username);
});

test('production rejects missing variables without falling back', () => {
  configure('production');
  assert.throws(() => require(configPath).production, /Production database configuration missing/);
  assert.throws(() => require(runtimePath), /Production database configuration missing/);
});

test('production rejects the development target, including loopback aliases', () => {
  configure('production', {
    PROD_DB_HOST: '127.0.0.1',
    PROD_DB_PORT: '3306',
    PROD_DB_NAME: 'evinews_ai',
    PROD_DB_USER: 'prod_user',
    PROD_DB_PASSWORD: 'prod_password'
  });
  assert.throws(() => require(configPath).production, /must differ from development/);
  assert.throws(() => require(runtimePath), /must differ from development/);
});

test('CLI environment cannot conflict with NODE_ENV', () => {
  configure('development');
  assert.throws(() => require(configPath).production, /environment mismatch/);
  configure('production', {
    PROD_DB_HOST: 'prod.example.invalid',
    PROD_DB_PORT: '3307',
    PROD_DB_NAME: 'prod_news',
    PROD_DB_USER: 'prod_user',
    PROD_DB_PASSWORD: 'prod_password'
  });
  assert.throws(() => require(configPath).development, /environment mismatch/);
});

test('empty NODE_ENV cannot silently select development', () => {
  configure('development');
  process.env.NODE_ENV = '';
  assert.throws(() => require(configPath).development, /NODE_ENV must be set/);
  assert.throws(() => require(runtimePath), /NODE_ENV must be set/);
});

test('local migration and undo scripts are pinned to development', () => {
  const scripts = require('../package.json').scripts;
  assert.equal(scripts['db:migrate'], 'sequelize db:migrate --env development');
  assert.equal(scripts['db:migrate:undo'], 'sequelize db:migrate:undo --env development');
});

process.on('exit', () => {
  for (const key of keys) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});
