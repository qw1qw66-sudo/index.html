export default {
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry'
  },
  webServer: {
    command: 'npx http-server . -p 4173 -c-1',
    url: 'http://127.0.0.1:4173/app/',
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } }
  ]
};
