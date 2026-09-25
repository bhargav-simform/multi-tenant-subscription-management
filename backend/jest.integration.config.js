const base = require('./jest.config.js');

/**
 * Integration + HTTP contract tests need real PostgreSQL (Testcontainers, real
 * Docker) and take tens of seconds per suite — kept apart from the fast unit suite
 * so `pnpm test` stays fast and `pnpm test:integration` is the explicit slow path.
 *
 * tsconfig.integration.json only adds a `paths` entry for @casl/ability: these suites
 * import the whole app (the unit suite never reaches lib/casl.ts), and ts-jest's
 * CommonJS/node10 resolution cannot see that package's `exports`-only types.
 */
module.exports = {
  ...base,
  testRegex: 'tests/(integration|http)/.*\\.spec\\.ts$',
  testTimeout: 120_000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.integration.json',
        diagnostics: { ignoreCodes: ['TS151002'] },
      },
    ],
  },
};
