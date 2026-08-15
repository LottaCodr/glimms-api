/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  roots:               ['<rootDir>/src'],
  testMatch:           ['**/*.test.ts', '**/*.spec.ts'],
  reporters:           ['default', '<rootDir>/gha-failure-reporter.js'], // TEMP debug — removed before merge
  moduleNameMapper:    { '^@/(.*)$': '<rootDir>/src/$1' },
  collectCoverageFrom: ['src/**/*.ts', '!src/server.ts', '!src/**/*.d.ts'],
  coverageDirectory:   'coverage',
  setupFilesAfterFramework: [],
  testTimeout:         15_000,
};
