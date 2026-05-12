export default {
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'npx http-server . -p 4173 -c-1',
    url: 'http://localhost:4173/',
    reuseExistingServer: false,
    timeout: 60000
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } }
  ]
};
