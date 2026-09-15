export default {
  globalSetup: './tests/jest/jest.setup.js',
  globalTeardown: './tests/jest/jest.teardown.js',
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/tests/hd/', '/tests/package/'],
  testTimeout: 60000,
  maxWorkers: 1
}
