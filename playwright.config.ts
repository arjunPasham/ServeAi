import { defineConfig, devices } from '@playwright/test';

// Step 15 E2E suite (see .superpowers/sdd/task-4-brief.md).
//
// Two projects:
//  - api: pure supabase-js/service-role tests against the real dev DB, no browser.
//  - ui:  chromium against `npm run dev`.
//
// The dev server is started with every DEV_MODE-gated external key cleared so
// the run is deterministic and offline-friendly: Stripe payments simulated,
// OTP is always 000000, the /api/scan route returns the synthetic fixtures
// added in src/services/foodVision.ts, and address validation accepts any
// non-empty address with synthetic Detroit coords. This mirrors what
// SETUP.md calls "dev mode" for every service except Supabase itself.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],

  projects: [
    {
      name: 'api',
      testMatch: /.*\.api\.spec\.ts/,
    },
    {
      name: 'ui',
      testMatch: /.*\.ui\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3000',
        trace: 'retain-on-failure',
      },
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    // Local dev keeps reuse for speed; CI always spawns its own server so the
    // suite can never bind to a dev server holding real keys (Task 0.5, Minor).
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Force every external service into its DEV_MODE fallback so the suite
      // is deterministic regardless of what real keys .env.local has:
      STRIPE_SECRET_KEY: '',
      TWILIO_VERIFY_SERVICE_SID: '',
      GEMINI_API_KEY: '',
      SMARTY_AUTH_ID: '',
      SMARTY_AUTH_TOKEN: '',
    },
  },
});
