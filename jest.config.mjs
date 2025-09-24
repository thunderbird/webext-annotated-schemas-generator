export default {
  type: 'module',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/*.test.mjs'],
  collectCoverageFrom: ['modules/**/*.mjs', '!modules/**/*.test.mjs'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testEnvironment: 'node',
};
