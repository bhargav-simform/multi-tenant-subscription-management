/** @type {import('jest').Config} */
const base = require('./jest.config.js');

/**
 * §28.1: integration tests need real PostgreSQL (Testcontainers, real Docker)
 * and take tens of seconds per suite — kept separate from the fast unit
 * suite (jest.config.js) so `pnpm test` stays fast and `pnpm test:integration`
 * is the explicit, opt-in slow path.
 */
module.exports = {
  ...base,
  testRegex: '.*\\.integration\\.spec\\.ts$',
  testTimeout: 120_000,
};
