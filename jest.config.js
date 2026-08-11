/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  roots:               ['<rootDir>/src'],
  testMatch:           ['**/*.test.ts', '**/*.spec.ts'],
  moduleNameMapper:    { '^@/(.*)$': '<rootDir>/src/$1' },
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/**/*.d.ts'],
  coverageDirectory:   'coverage',
  testTimeout:         15_000,
  // TEMPORARY: posts jest failure details to a GitHub issue when running in CI
  reporters:           ['default', '<rootDir>/jest.debugReporter.js'],
};
