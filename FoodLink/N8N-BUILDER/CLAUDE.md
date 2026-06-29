# FoodLink — n8n Workflow Builder

**Purpose:** This file briefs Claude Code on the FoodLink system architecture,
n8n's precise role within it, the MCP tooling and skills available, the
workflow(s) to build or modify, and every constraint that must be respected.

---

## BUILDER AI — READ THIS FIRST

```
═══════════════════════════════════════════════════════════════════
🤖 BUILDER AI — READ THIS BEFORE TOUCHING ANY WORKFLOW
═══════════════════════════════════════════════════════════════════
1. n8n handles WEBHOOKS ONLY. Every timer/scheduler job in
   FoodLink runs on Inngest. Do NOT add cron or schedule triggers
   in n8n — those belong in Inngest, full stop.
2. Every inbound webhook workflow MUST verify x-n8n-signature
   before any processing. A workflow that skips this is a P0
   security bug and must not be activated.
3. No secrets in workflow node parameters. All credentials live
   in n8n's built-in Credential store — reference by name only.
4. Audit log writes are NEVER delegated to n8n. Every state change
   audit must happen inside the PostgreSQL RPCs.
5. n8n is self-hosted. Use the n8n-mcp MCP tools to create,
   update, activate, and inspect workflows — do NOT export/import
   JSON by hand unless explicitly instructed.
6. Start with search_templates before building from scratch.
   There are 2,352 templates available — check first.
7. NEVER edit production workflows directly. Deactivate, edit,
   test, verify executions, then reactivate.
8. Never trust defaults. Explicitly configure ALL parameters
   controlling node behavior.
9. Read "ORIGINAL WORKFLOW" and "NEW WORKFLOW TWEAKS" carefully
   before making any changes. Do not invent requirements.
═══════════════════════════════════════════════════════════════════
```

---

## 1. FoodLink System Context

FoodLink is a three-sided food redistribution marketplace:
- **Donors** (restaurants, households) list surplus food via AI scan
- **Consumers** (shelters, families) browse and purchase listings
- **Couriers** (independent contractors) pick up and deliver

Backend stack: **Next.js 16 / Supabase PostgreSQL 17 + PostGIS /
Stripe Connect Separate Charges+Transfers / Inngest / n8n (self-hosted,
webhooks only) / Gemini 2.5 Flash / Twilio Verify / OneSignal / Google
Routes API / Smarty**

### What n8n Does in FoodLink

n8n is the **webhook orchestration layer** — it connects FoodLink app events
to external services and coordinates multi-step integrations.

| App Event | n8n's Job |
|---|---|
| Listing goes `live` | Fan-out notifications to marketplace subscribers |
| Purchase confirmed | Route secondary notifications; coordinate external logistics |
| Delivery confirmed | Trigger external partner callbacks |
| Inbound call from Next.js at `/api/n8n/webhook` | Process and respond to app-originated events |

### What n8n Does NOT Own

| Task | Who Owns It |
|---|---|
| Every 5-min cold-chain expiry check | Inngest `cold-chain-check` cron |
| 2-hour dispute window sleep | Inngest `dispute-window` function |
| 30-min post-delivery feedback prompt | Inngest `feedback-prompt` function |
| Payout release after dispute window | Inngest `payout-release` function |
| Atomic listing claim lock | PostgreSQL `claim_listing()` RPC |
| Delivery confirmation state write | PostgreSQL `confirm_delivery()` RPC |
| Audit log inserts | Inside PostgreSQL RPCs — append-only, immutable |

**Hard rule:** If a workflow needs a `Wait` node, `Sleep`, or any cron /
schedule trigger, stop and ask the human. That job belongs in Inngest.

---

## 2. FoodLink Data Model (Reference)

```
listings.status:  draft → live → purchased → dispatched → delivered
                  live → hidden   (Inngest cold-chain)
                  delivered → disputed  (consumer files within 2hr)

orders.status:    pending_dispatch → dispatched → delivered
                  delivered → refunded | disputed

Key env vars available to n8n:
  N8N_WEBHOOK_SECRET        HMAC key for verifying inbound calls from Next.js
  SUPABASE_URL              Supabase project REST URL
  SUPABASE_SERVICE_ROLE_KEY Server-side key (in n8n Credential store only)
  ONESIGNAL_REST_API_KEY    Push notifications (in n8n Credential store)
  GOOGLE_ROUTES_API_KEY     Routing / ETA (in n8n Credential store)

Next.js inbound endpoint: POST /api/n8n/webhook/route.ts
```

n8n workflows **read** status values for routing decisions; they **never
write** `status` columns directly — that is always a PostgreSQL RPC.

---

## 3. Tooling Setup

### 3.1 n8n-mcp MCP Server

**Repository:** https://github.com/czlonkowski/n8n-mcp  
**Version:** v2.61.0+ (22k stars, actively maintained)

#### Installation (one-time, run in terminal)

```bash
claude mcp add n8n-mcp \
  -e MCP_MODE=stdio \
  -e LOG_LEVEL=error \
  -e DISABLE_CONSOLE_OUTPUT=true \
  -e N8N_API_URL=http://localhost:5678 \
  -e N8N_API_KEY=your-api-key \
  -- npx n8n-mcp
```

Or add to `.mcp.json` in the project root for team sharing:

```json
{
  "mcpServers": {
    "n8n-mcp": {
      "command": "npx",
      "args": ["n8n-mcp"],
      "env": {
        "MCP_MODE": "stdio",
        "LOG_LEVEL": "error",
        "DISABLE_CONSOLE_OUTPUT": "true",
        "N8N_API_URL": "http://localhost:5678",
        "N8N_API_KEY": "your-api-key"
      }
    }
  }
}
```

#### Core Documentation Tools (always available, no API key needed)

| Tool | Use For |
|---|---|
| `tools_documentation` | Read this first — get docs for any MCP tool |
| `search_nodes` | Find nodes by name or capability; use `source:'community'` for community nodes, `includeExamples:true` for usage patterns |
| `get_node` | Get node details; modes: `docs`, `search_properties`, `versions`, `compare` |
| `validate_node` | Validate a node config; modes: `minimal` or `full`; profiles: `minimal`, `runtime`, `ai-friendly`, `strict` |
| `validate_workflow` | Validate complete workflow JSON including AI Agent checks |
| `search_templates` | Search 2,352 templates by keyword, node type, or task — always check here first |
| `get_template` | Retrieve full workflow JSON; modes: `nodes_only`, `structure`, `full` |

#### n8n Instance Management Tools (require N8N_API_URL + N8N_API_KEY)

**Workflow CRUD:**

| Tool | Use For |
|---|---|
| `n8n_list_workflows` | List all workflows with filtering and pagination |
| `n8n_get_workflow` | Get a workflow; modes: `full`, `details`, `structure`, `minimal` |
| `n8n_create_workflow` | Create a new workflow |
| `n8n_update_full_workflow` | Replace a workflow completely |
| `n8n_update_partial_workflow` | Diff-based partial update — prefer this for targeted edits |
| `n8n_delete_workflow` | Permanent deletion — confirm with user before calling |
| `n8n_validate_workflow` | Validate a deployed workflow by ID |
| `n8n_autofix_workflow` | Auto-correct common errors in a workflow |
| `n8n_workflow_versions` | Version history and rollback |
| `n8n_deploy_template` | Deploy a template from n8n.io directly |

**Execution Management:**

| Tool | Use For |
|---|---|
| `n8n_test_workflow` | Execute a workflow for testing |
| `n8n_executions` | View and manage execution history |

**Credentials & System:**

| Tool | Use For |
|---|---|
| `n8n_manage_credentials` | CRUD on credentials + retrieve schema |
| `n8n_health_check` | Verify API connectivity before any operation |
| `n8n_audit_instance` | Security audit of the n8n instance |

---

### 3.2 n8n-skills Claude Code Plugin

**Repository:** https://github.com/czlonkowski/n8n-skills  
**Version:** 5.6k stars — 14 skills for production-ready workflow building

#### Installation (one-time, run in Claude Code)

```
/plugin install czlonkowski/n8n-skills
```

Skills activate automatically based on query context. They compose for
complex requests — e.g., "build and validate a webhook workflow" engages
Workflow Patterns + Validation Expert + MCP Tools Expert simultaneously.

#### Available Skills

| Skill | When It Activates |
|---|---|
| **n8n MCP Tools Expert** *(highest priority)* | Any MCP tool usage — always active here |
| **n8n Expression Syntax** | Writing `{{ }}` expressions, `$json`, `$node`, `$now`, `$env` |
| **n8n Workflow Patterns** | Building webhook, HTTP API, database, AI, or scheduled workflows |
| **n8n Validation Expert** | Interpreting validation errors; distinguishing genuine vs. false positives |
| **n8n Node Configuration** | Setting up operation-aware nodes, property dependencies |
| **n8n Code JavaScript** | Code nodes — `$input.all()`, `$input.first()`, return format `[{json:{...}}]` |
| **n8n Code Python** | Python Code nodes — limitations (no requests/pandas), standard library only |
| **n8n Code Tool** | Custom Code Tool nodes (different contract than regular Code nodes) |
| **n8n Error Handling** | Per-node error outputs, retry logic, response-code mapping |
| **n8n Binary & Data** | File handling, `$binary` vs `$json` contexts, agent-tool file boundaries |
| **n8n Sub-workflows** | Execute Workflow Trigger, typed inputs, parallelization |
| **n8n AI Agents** | Agent architecture, tool naming, structured output, memory, chat topology |
| **n8n Multi-Instance** | Targeting correct n8n instance in multi-environment setups |
| **n8n Self-Hosting** | Docker Compose + Caddy deployment, queue mode with Redis + Postgres |

---

## 4. Workflow Build Protocol

Follow this sequence for every build or edit. Do not skip steps.

```
1. n8n_health_check               — Confirm API is reachable before anything
2. n8n_list_workflows             — Know what already exists; never create duplicates
3. search_templates               — Check 2,352 templates before building from scratch
4. search_nodes / get_node        — Confirm exact node type names and properties
5. [For edits] n8n_get_workflow   — Get current state; never modify from memory
6. [For edits] deactivate first   — Use n8n_update_partial_workflow with active:false
7. Build / update                 — n8n_create_workflow or n8n_update_partial_workflow
8. validate_workflow              — Validate the JSON locally before deploying
9. n8n_validate_workflow          — Validate the deployed workflow by ID
10. n8n_autofix_workflow          — If validation errors remain, attempt auto-fix
11. n8n_test_workflow             — Execute with a test payload
12. n8n_executions                — Confirm last 3 runs show 0 errors
13. Activate                      — n8n_update_partial_workflow with active:true
```

### Partial Update Syntax

Use `n8n_update_partial_workflow` for targeted changes. Each operation is
a separate object in the operations array:

```json
{
  "type": "addNode",
  "node": { "type": "n8n-nodes-base.code", "name": "Verify Signature", ... }
}

{
  "type": "addConnection",
  "source": "Receive Listing Published",
  "target": "Verify Signature",
  "sourcePort": "main",
  "targetPort": "main"
}
```

For IF node branching, add `"branch": "true"` or `"branch": "false"` to the
connection object. Batch all operations in a single call.

### Validation Levels

Always run all four levels before activating:

| Level | Command | Catches |
|---|---|---|
| 1 — Quick | `validate_node(mode:'minimal')` | Missing required fields |
| 2 — Runtime | `validate_node(mode:'full', profile:'runtime')` | Runtime failures |
| 3 — Full | `validate_workflow(workflow)` | Connections, expressions, AI Agent checks |
| 4 — Deployed | `n8n_validate_workflow({id})` | Post-deployment issues |

---

## 5. Webhook Security — Non-Negotiable

Every workflow that receives an inbound HTTP call from the Next.js app MUST
verify the `x-n8n-signature` header. This Code node goes at position 1,
immediately after the Webhook trigger node, before any other processing.

**Signature verification Code node (JavaScript):**

```javascript
const crypto = require('crypto');
const rawBody = JSON.stringify($input.first().json);
const signature = $input.first().headers['x-n8n-signature'];
const expectedSig = 'sha256=' + crypto
  .createHmac('sha256', $env.N8N_WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex');

if (signature !== expectedSig) {
  throw new Error('INVALID_SIGNATURE — request rejected');
}

return $input.all();
```

A workflow without this check is incomplete. Do not activate it.

The corresponding Next.js verification (for reference — already in the app):

```typescript
// /api/n8n/webhook/route.ts
const sig = req.headers.get('x-n8n-signature');
const expectedSig = crypto
  .createHmac('sha256', process.env.N8N_WEBHOOK_SECRET!)
  .update(rawBody)
  .digest('hex');
if (sig !== `sha256=${expectedSig}`) {
  return Response.json({ error: 'Invalid signature' }, { status: 401 });
}
```

---

## 6. n8n Expression Quick Reference

```
$json                    Current item's JSON data
$json.body               Webhook payload (webhook data lives under .body)
$input.first().json      First input item
$input.all()             All input items (in Code nodes)
$node["NodeName"].json   Data from a specific upstream node
$now                     Current timestamp
$env.VAR_NAME            Environment variable
$vars.varName            Workflow variable
{{ $json.listing_id }}   Expression in a string parameter
```

**Critical gotcha:** In webhook workflows, the payload is always under
`$json.body`, not directly at `$json`.

---

## 7. Node Naming Conventions

| Node Type | Name Format | Example |
|---|---|---|
| Webhook trigger | `Receive [Event]` | `Receive Listing Published` |
| Signature verification | `Verify Signature` | `Verify Signature` |
| Immediate acknowledgment | `Respond 200` | `Respond 200` |
| Data transformation | `Transform [Thing]` | `Transform Listing Payload` |
| HTTP Request (Supabase) | `Supabase — [Action]` | `Supabase — Fetch Listing` |
| HTTP Request (external) | `[Service] — [Action]` | `OneSignal — Push Notification` |
| Conditional / Router | `Route: [Condition]` | `Route: Temperature Sensitive?` |
| Error handler | `Handle Error — [Type]` | `Handle Error — Signature Fail` |
| Code node | `[What It Does]` | `Build Dispatch Payload` |

---

## 8. Error Handling Pattern

Every workflow must handle three failure types:

| Failure | Response | Action |
|---|---|---|
| Signature invalid | Respond 401, stop execution | Log to n8n execution log |
| Supabase query error | Respond 500 to caller | Log full error to execution log |
| External service failure (OneSignal, etc.) | Respond 200 to caller | Log error; do NOT let caller retry endlessly |

**Response timing rule:** Respond to the inbound Next.js webhook within
3 seconds. If downstream work takes longer, respond immediately with
`{ "received": true }` and continue processing asynchronously in subsequent
nodes.

---

## 9. Original Workflow

> **INSTRUCTION FOR USER:** Paste your existing n8n workflow JSON below, or
> describe it in plain English. Include: the trigger, what each node does,
> what external services it calls, and what the expected output is.

```json
[PASTE ORIGINAL WORKFLOW JSON HERE]
```

### Plain-English Summary (fill in)

```
Trigger:
Steps:
External services called:
Expected output:
Known issues or limitations:
```

---

## 10. New Workflow — Requirements & Tweaks

> **INSTRUCTION FOR USER:** Describe every change needed. Use the table below
> for targeted edits, or write prose for a net-new workflow.

### Changes to Existing Nodes

| # | Node Name | What to Change | Why |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |

### New Nodes to Add

```
[DESCRIBE EACH NEW NODE: type, purpose, inputs, outputs, configuration]
```

### Nodes to Remove or Disable

```
[LIST NODES TO REMOVE — be specific about node name]
```

### New Connections / Routing Changes

```
[DESCRIBE ANY CHANGES TO HOW NODES ARE WIRED TOGETHER]
```

### Acceptance Criteria

Every item must be checked before activating the updated workflow:

- [ ] `n8n_health_check` passes before any edits
- [ ] `search_templates` checked — no existing template covers this need
- [ ] Workflow deactivated before edits begin
- [ ] Inbound webhook verifies `x-n8n-signature` as node 1
- [ ] Responds within 3 seconds — async pattern used if downstream is slow
- [ ] No secrets hardcoded in node parameters — all via n8n Credentials
- [ ] No `Wait` / sleep nodes or cron / schedule triggers present
- [ ] Workflow does not write to `listings.status` or `orders.status` directly
- [ ] `validate_workflow` passes (level 3)
- [ ] `n8n_validate_workflow` passes on deployed workflow (level 4)
- [ ] `n8n_test_workflow` with valid payload — completes without error
- [ ] `n8n_test_workflow` with invalid signature — rejected before processing
- [ ] `n8n_test_workflow` with malformed payload — error path fires, no crash
- [ ] `n8n_executions` shows 0 failures across last 3 test runs
- [ ] Workflow reactivated and confirmed active in `n8n_list_workflows`
- [ ] [ADD YOUR SPECIFIC CRITERIA HERE]

---

## 11. FoodLink Cross-Flow Event Map

Use this when deciding which events n8n should handle vs. Inngest:

| App Event | Triggered By | n8n Involved? | Inngest Involved? |
|---|---|---|---|
| Listing goes `live` | Donor confirms (Next.js RPC) | YES — marketplace fan-out | NO |
| Purchase confirmed | `claim_listing()` RPC | YES — secondary notifications | YES — dispatch.initiated event |
| Courier accepts | Courier taps Accept | Possibly — ETA fan-out | YES — 5-min acceptance window |
| Delivery confirmed | `confirm_delivery()` RPC | Possibly — partner callbacks | YES — dispute window + payout |
| Safety expiry | Inngest cold-chain cron | NO | YES — every 5 min |
| Feedback prompt | Inngest 30-min delay | NO | YES |
| Payout release | Inngest 2-hr dispute window | NO | YES |

---

*FoodLink n8n Workflow Builder · ServeAI Initiative · Confidential*
