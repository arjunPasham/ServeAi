# FoodLink

The operating system for surplus food (pivot in progress — see `analysis/` and
`PHASE_1_PLAN.md`). Merchants scan surplus with an AI vision pipeline; every scan
becomes structured, valued inventory; confirmed manifests become declared loads for
batched cold-chain routes to institutions. Built with Next.js 16, Supabase, Inngest,
and Stripe. Every paid integration has a simulated **dev mode**, so the only hard
requirement to run locally is a Supabase project + a Gemini API key.

> The legacy consumer marketplace (donor listings → consumer checkout → courier
> delivery) is mothballed behind `NEXT_PUBLIC_CONSUMER_ENABLED` and will be removed
> as pivot phases replace its dependencies.

## Getting started

Full instructions — env vars, database migrations, the demo walkthrough, and real
Stripe mode — are in **[docs/SETUP.md](docs/SETUP.md)**. Quick version:

```bash
cp .env.example .env.local        # fill in Supabase values + GEMINI_API_KEY
npm install
# run supabase/migrations/*.sql (in filename order) + supabase/seed.sql
#   in the Supabase SQL editor — see docs/SETUP.md §3
npm run dev                        # terminal 1 — the app (http://localhost:3000)
npx inngest-cli@latest dev         # terminal 2 — background jobs (http://localhost:8288)
```

## Documentation

| Doc | Covers |
|---|---|
| `analysis/` + `PHASE_1_PLAN.md` | **Pivot source of truth** — audit, red-team, transition plan, Phase 1 build plan |
| [docs/SETUP.md](docs/SETUP.md) | Local setup, env vars, demo script, admin creation, Stripe mode |
| [docs/FoodLink_PRD_v2.md](docs/FoodLink_PRD_v2.md) | Product requirements |
| [docs/FoodLink_TRD_v1.1.md](docs/FoodLink_TRD_v1.1.md) | Technical requirements |
| [docs/FoodLink_AppFlow.md](docs/FoodLink_AppFlow.md) | End-to-end app flow |
| [docs/FoodLink_UIUX_Consumer.md](docs/FoodLink_UIUX_Consumer.md) · [Courier](docs/FoodLink_UIUX_Courier.md) · [Donor](docs/FoodLink_UIUX_Donor.md) | UI/UX specs per role |

## Repo layout

```
src/                 Next.js app — routes, server actions, components, lib, inngest jobs
supabase/            SQL migrations (001…013) + seed.sql
N8N-BUILDER/         Optional n8n workflow automations + Claude skills (not required to run the app)
docs/                Setup + product/technical/UX docs
public/              Static assets
scripts/             One-off scripts (e.g. test-scan)
```

Root-level config files (`package.json`, `tsconfig.json`, `next.config.ts`,
`eslint.config.mjs`, `postcss.config.mjs`, `.gitignore`, `.env.example`) must stay
at the repo root — their tooling only reads them there.
