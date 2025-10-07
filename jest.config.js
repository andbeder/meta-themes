module.exports = {
  testEnvironment: 'node',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/coverage/'
  ],
  testMatch: [
    '**/*.test.js'
  ],
  collectCoverageFrom: [
    'index.js',
    '!index.test.js'
  ]
};
