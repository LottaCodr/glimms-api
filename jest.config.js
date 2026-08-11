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
  // BullMQ queues + the lazy Redis client keep handles open after the suites
  // finish; forceExit makes the run exit promptly & deterministically in CI.
  forceExit:           true,
  // TEMPORARY: posts jest failure details to a GitHub issue when running in CI
  reporters:           ['default', '<rootDir>/jest.debugReporter.js'],
};
