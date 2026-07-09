import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Demo mode is fixture-only by construction: pages under (demo) and the demo
  // lib may never import server actions, Supabase, Stripe, Inngest, or any
  // messaging integration. This is what makes "demo writes reach prod"
  // structurally impossible.
  {
    files: ["src/app/(demo)/**/*.{ts,tsx}", "src/lib/demo/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/actions/*",
                "@/lib/supabase/*",
                "@/lib/stripe",
                "@/lib/twilio",
                "@/lib/email",
                "@/lib/onesignal",
                "@/lib/smarty",
                "@/lib/google-routes",
                "@/lib/dispatch-events",
                "@/inngest/*",
              ],
              message:
                "Demo routes are fixture-only. No server actions, DB, payments, timers, or messaging — inject fake data via src/lib/demo/fixtures.ts instead.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Plain-node maintenance scripts (require() by design)
    "scripts/**/*.cjs",
  ]),
]);

export default eslintConfig;
