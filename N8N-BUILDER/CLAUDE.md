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
5. n8n is cloud-hosted at arjunpasham.app.n8n.cloud. Use the
   n8n native MCP server tools to create, update, activate, and
   inspect workflows — do NOT export/import JSON by hand unless
   explicitly instructed.
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
Stripe Connect Separate Charges+Transfers / Inngest / n8n (cloud at
arjunpasham.app.n8n.cloud, webhooks only) / Gemini 2.5 Flash / Twilio
Verify / OneSignal / Google Routes API / Smarty**

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

### 3.1 n8n Native MCP Server (Active Configuration)

n8n cloud exposes a built-in MCP server endpoint. This is what Claude uses
to interact with workflows directly.

**Instance:** `https://arjunpasham.app.n8n.cloud`  
**MCP endpoint:** `https://arjunpasham.app.n8n.cloud/mcp-server/http`  
**Transport:** HTTP with Bearer token auth

#### `.mcp.json` (project root — DO NOT commit the real token to git)

```json
{
  "mcpServers": {
    "n8n-mcp": {
      "type": "http",
      "url": "https://arjunpasham.app.n8n.cloud/mcp-server/http",
      "headers": {
        "Authorization": "Bearer <N8N_MCP_TOKEN>"
      }
    }
  }
}
```

Store the actual token in your local environment or Claude Code settings,
not in the committed file. Rotate the token at:
`https://arjunpasham.app.n8n.cloud` → Settings → API → MCP Server.

#### Available MCP Tools (n8n native)

The n8n native MCP server exposes tools for interacting directly with
workflows and executions on your cloud instance. Call the MCP server's
built-in tool list at session start to confirm available tools, as n8n
updates them with each release. Common capabilities include:

| Capability | What to Expect |
|---|---|
| List workflows | Enumerate all workflows, names, active status, IDs |
| Get workflow | Retrieve full workflow JSON by ID |
| Create / update workflow | Push a new or modified workflow definition |
| Execute workflow | Trigger a test run by workflow ID |
| Get executions | Retrieve recent execution history and error logs |
| Manage credentials | Create, read, update credential records |

**At the start of every session, call the MCP tools list first** to see
exactly what tool names and parameters n8n exposes — they may differ from
the above as n8n updates their cloud MCP server.

---

### 3.2 czlonkowski/n8n-mcp — Documentation & Validation Layer

The native MCP server handles instance management. The czlonkowski package
adds documentation search, node validation, and template discovery on top.
Use both together.

**Repository:** https://github.com/czlonkowski/n8n-mcp  
**Install (run once in terminal):**

```bash
claude mcp add n8n-mcp-docs \
  -e MCP_MODE=stdio \
  -e LOG_LEVEL=error \
  -e DISABLE_CONSOLE_OUTPUT=true \
  -- npx n8n-mcp
```

#### Documentation Tools (no API key needed)

| Tool | Use For |
|---|---|
| `tools_documentation` | Read first — get docs for any MCP tool |
| `search_nodes` | Find nodes by name/capability; `includeExamples:true` for patterns |
| `get_node` | Node details; modes: `docs`, `search_properties`, `versions`, `compare` |
| `validate_node` | Validate node config; modes: `minimal`/`full`; profiles: `runtime`, `strict` |
| `validate_workflow` | Validate full workflow JSON including AI Agent checks |
| `search_templates` | Search 2,352 templates — always check before building from scratch |
| `get_template` | Get template JSON; modes: `nodes_only`, `structure`, `full` |

---

### 3.3 n8n-skills Claude Code Plugin

**Repository:** https://github.com/czlonkowski/n8n-skills  
**Install (run once in Claude Code):**

```
/plugin install czlonkowski/n8n-skills
```

Skills activate automatically from context and compose for complex
requests — e.g., "build and validate a webhook workflow" fires Workflow
Patterns + Validation Expert + MCP Tools Expert simultaneously.

#### Available Skills (14 total)

| Skill | When It Activates |
|---|---|
| **n8n MCP Tools Expert** *(highest priority)* | Any MCP tool usage — always active here |
| **n8n Expression Syntax** | Writing `{{ }}` expressions, `$json`, `$node`, `$now`, `$env` |
| **n8n Workflow Patterns** | Building webhook, HTTP API, database, AI, or scheduled workflows |
| **n8n Validation Expert** | Interpreting validation errors; genuine vs. false positives |
| **n8n Node Configuration** | Operation-aware node setup, property dependencies |
| **n8n Code JavaScript** | Code nodes — `$input.all()`, return format `[{json:{...}}]` |
| **n8n Code Python** | Python Code nodes — limitations, standard library only |
| **n8n Code Tool** | Custom Code Tool nodes (different contract than regular Code nodes) |
| **n8n Error Handling** | Per-node error outputs, retry logic, response-code mapping |
| **n8n Binary & Data** | File handling, `$binary` vs `$json`, agent-tool file boundaries |
| **n8n Sub-workflows** | Execute Workflow Trigger, typed inputs, parallelization |
| **n8n AI Agents** | Agent architecture, tool naming, structured output, memory |
| **n8n Multi-Instance** | Targeting correct instance in multi-environment setups |
| **n8n Self-Hosting** | Docker Compose + Caddy, queue mode with Redis + Postgres |

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

## 9. Original Workflow (DEPRECATED — Do Not Extend)

> ⛔ The original workflow is fully deprecated. It was built for a
> different prototype with a different data model. It cannot be patched.
> It must be replaced entirely by the new workflows in Section 10.
> The JSON is preserved here for reference only.

### What the Original Was Doing (Plain English)

The original was a simple food-ordering CRUD system for a school cafeteria
prototype — not a three-sided marketplace. n8n was acting as the entire
backend directly in front of Postgres.

| Webhook Path | Node Name | What It Did |
|---|---|---|
| `POST /insert-order` | insertOrder | Insert a food listing row into `orders` table |
| `GET /orders` | getOrders | `SELECT * FROM orders` — return all listings |
| `POST /submit-order` | submitOrder | Decrement quantity; if 0 delete row, else update; insert into `confirmed_orders` |
| `POST /session-orders` | getSessionOrders | `SELECT * FROM confirmed_orders WHERE ordered_by = session_id` |
| `POST /session-listings` | getSessionListings | `SELECT * FROM orders WHERE listed_by = session_id` |
| `POST /upload-images` | Webhook1 | Upload binary to Supabase, call Gemini, return food classifications |
| `POST /upload-images-disabled` | Webhook | Old disabled image pipeline |
| `POST /start-session` | startSession | Stub — never wired to any DB node |

**External services called:** Supabase Storage (project `emzuapltkphvkhxoeqxj`,
bucket `order-images`), Gemini 1.5 Flash via hardcoded API key in workflow JSON.

### Why It Cannot Be Used or Extended

**Problem 1 — Tables don't exist.**
The original wrote to `orders` (used as a listings table) and
`confirmed_orders`. Neither exists in the new schema. The new `orders` table
is a purchase-transaction table, not a food-listings table. `confirmed_orders`
was deleted entirely.

**Problem 2 — Every field is wrong.**

| Original field | Original table | Status in new schema | New equivalent |
|---|---|---|---|
| `food_name` | orders | Renamed | `listings.detected_item TEXT` |
| `quantity` | orders | Replaced | `listings.estimated_quantity_lbs NUMERIC(8,2)` — in pounds, not generic count |
| `school_name` | orders | Deleted | No equivalent — FoodLink is not school-specific |
| `address` | orders | Moved to profiles | Donor: `donor_profiles.address`; Consumer: `consumer_profiles.delivery_address` |
| `order_id` | orders | Repurposed | `orders.id UUID` is purchase transaction ID, not listing ID |
| `listed_by` | orders | Renamed + retyped | `listings.donor_id UUID REFERENCES users(id)` — must be UUID FK, not session string |
| `session_id` | webhook payload | Deleted | Replaced by Supabase Auth JWT — identity comes from token, not body |
| `perishable` | orders | Renamed | `listings.temperature_sensitive BOOLEAN` |
| `image_url` | orders | Still exists, wrong bucket | `listings.image_url TEXT` — bucket is now `listing-photos`, not `order-images` |
| `ordered_by` | confirmed_orders | Renamed + retyped | `orders.consumer_id UUID REFERENCES users(id)` |
| `amount_ordered` | confirmed_orders | Deleted | Consumers buy the whole listing — no partial quantity in new model |

The new `listings` table has 26 fields, most NOT NULL, including the entire
pricing engine (`base_commodity_price_cents`, `suggested_donor_payout_cents`,
`donor_payout_cents`, `consumer_price_cents`, `platform_fee_cents`,
`courier_fee_cents`), the state machine (`status`), food safety fields
(`safety_attested`, `prepared_at`, `safety_expires_at`), and AI output fields
(`confidence_score`, `usda_category`). The original workflow populated 8 fields.

**Problem 3 — Wrong Gemini model, wrong prompt, wrong output shape.**
Original: `gemini-1.5-flash`, direct HTTP with hardcoded API key, returns
`{itemName: {quantity, perishable, image_url}}`.
Required: `gemini-2.5-flash`, called from Next.js server action (not n8n),
returns `{detected_item, estimated_quantity_lbs, confidence_score,
temperature_sensitive, usda_category}`. n8n is not involved in AI scan at all.

**Problem 4 — Wrong Supabase project and bucket.**
Original uploads to `emzuapltkphvkhxoeqxj.supabase.co`, bucket `order-images`.
New architecture uses a different project, bucket `listing-photos`, private
RLS-protected with signed URLs generated server-side. n8n does not handle
image uploads in the new architecture.

**Problem 5 — Hardcoded secrets.**
`AIzaSyAAnZm6jVT8Eqr7wf8j5BAiRlONJyzrFdo` is hardcoded in the HTTP Request
node. This API key must be considered compromised and rotated immediately.
No secrets are ever stored in workflow node parameters.

**Problem 6 — No state machine, no audit log, no pricing, no courier dispatch.**
The original had none of these. The new architecture requires all of them.
n8n workflows must never write listing/order status directly — that is owned
by PostgreSQL RPCs with mandatory audit_log inserts.

### Original Workflow JSON (Reference Only)

```json
{
  "nodes": [
    {
      "parameters": {
        "schema": { "__rl": true, "mode": "list", "value": "public" },
        "table": { "__rl": true, "value": "orders", "mode": "list", "cachedResultName": "orders" },
        "columns": {
          "mappingMode": "defineBelow",
          "value": {
            "food_name": "={{$json[\"body\"][\"food_name\"]}}",
            "quantity": "={{$json[\"body\"][\"quantity\"]}}",
            "school_name": "={{$json[\"body\"][\"school_name\"]}}",
            "address": "={{$json[\"body\"][\"address\"]}}",
            "order_id": "={{$json[\"body\"][\"order_id\"]}}",
            "listed_by": "={{ $json[\"body\"][\"session_id\"] }}",
            "image_url": "={{ $json[\"body\"][\"image_url\"] }}",
            "perishable": "={{ $json[\"body\"][\"perishable\"] }}"
          },
          "matchingColumns": ["id"]
        },
        "options": {}
      },
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [272, 832],
      "id": "65cdfd82-e3b8-44ea-8176-01b6326a8a90",
      "name": "Insert rows in a table"
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT * FROM orders;\n",
        "options": {}
      },
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [224, 1024],
      "id": "34051abf-8405-47e9-9bc6-59455098f0ae",
      "name": "Execute a SQL query",
      "alwaysOutputData": true
    },
    {
      "parameters": { "respondWith": "allIncomingItems", "options": {} },
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.4,
      "position": [448, 1024],
      "id": "d8449d84-10b1-4898-afbe-60029936d544",
      "name": "Respond to Webhook"
    },
    {
      "parameters": {
        "respondWith": "text",
        "responseBody": "Added Successfully.",
        "options": {}
      },
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.4,
      "position": [480, 832],
      "id": "945ac1f4-5c2d-4f92-b76a-5fa9742ecf6f",
      "name": "Respond to Webhook1"
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "SELECT quantity\nFROM orders\nWHERE order_id = '{{ $json['body']['order-id'] }}'",
        "options": {}
      },
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [1152, 880],
      "id": "c84f169d-028b-4b4d-b4c2-8fb1fc711e5f",
      "name": "SqlQueryAmt"
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "insert-order",
        "responseMode": "responseNode",
        "options": {}
      },
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 832],
      "id": "7100d46e-c966-44b6-9780-7aca8e3fa231",
      "name": "insertOrder",
      "webhookId": "df79c2ce-f9b3-401f-a66f-5d8a9d64bb14"
    },
    {
      "parameters": {
        "path": "orders",
        "responseMode": "responseNode",
        "options": {}
      },
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 1024],
      "id": "0c0e2710-b9a5-405a-9794-45aef2014068",
      "name": "getOrders",
      "webhookId": "1c2a0e2e-19df-42a8-9807-8a23d880bb7e"
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "submit-order",
        "responseMode": "lastNode",
        "responseData": "noData",
        "options": {}
      },
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [992, 880],
      "id": "15592105-9f99-4814-b06e-3f643972901c",
      "name": "submitOrder",
      "webhookId": "31304d37-af6d-4e96-9b98-889747b8eec4"
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "upload-images",
        "responseMode": "responseNode",
        "options": { "binaryPropertyName": "images" }
      },
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [32, 624],
      "id": "cb5dc917-a46d-4173-9094-336d1e134e53",
      "name": "Webhook1",
      "webhookId": "df79c2ce-f9b3-401f-a66f-5d8a9d64bb14"
    }
  ],
  "meta": {
    "instanceId": "a77c7fd1f79e9f6039c9655776b9d695516273cc4656df8472d0796f7fcb2dd3"
  }
}
```

*(Full JSON abridged for readability — the original had 35 nodes. The
complete original JSON was reviewed and is fully deprecated.)*

---

## 10. New Workflow — What Needs to Be Built

> ⚠️ The full spec document was truncated in the handoff. The section below
> captures everything confirmed from the TRD (Layer 2) and the deprecation
> analysis. The user should paste the remainder of the spec doc here.

### Architecture Decisions Already Confirmed

1. **n8n is webhooks only.** No Gemini calls, no image uploads, no direct DB
   writes of status fields. Those moved to Next.js Server Actions.
2. **Identity = Supabase Auth JWT.** No `session_id` in any payload. Claude
   must extract user identity from the Authorization header or Supabase
   session, not from request body fields.
3. **New Supabase project.** The prototype project `emzuapltkphvkhxoeqxj` is
   gone. All DB and storage calls must use the new project credentials stored
   in n8n's Credential store.
4. **New image bucket.** `listing-photos`, private, RLS-protected. n8n does
   not upload images. Next.js handles uploads via signed URLs.
5. **No `confirmed_orders` table.** Consumer purchases write to the `orders`
   table via the `claim_listing()` PostgreSQL RPC — never via n8n.

### Core Architecture Rule

n8n is a **downstream notification and event-routing layer**. The primary
business logic — listing creation, purchase, dispatch, payments, expiry —
runs inside Next.js Server Actions, Inngest functions, and Stripe webhooks.
n8n receives events from Next.js **after** the primary database writes have
already committed. It does not own any tables, does not execute purchase
logic, does not run the AI scan, and does not handle payments.

---

### Workflow 1 — Listing Published → Update Marketplace Feed

**Webhook path:** `POST /listing-published`

**Trigger:** Next.js fires after `listings.status` transitions `draft → live`
(after the atomic RPC commits successfully).

**Inbound payload from Next.js:**
```json
{
  "listing_id": "uuid",
  "donor_id": "uuid",
  "detected_item": "string",
  "estimated_quantity_lbs": 12.5,
  "consumer_price_cents": 840,
  "temperature_sensitive": true,
  "safety_expires_at": "2026-06-29T20:00:00Z",
  "image_url": "string (signed URL)",
  "published_at": "2026-06-29T18:00:00Z"
}
```

**What n8n does:**
1. Verify `x-n8n-signature` — reject 401 if invalid
2. Respond 200 immediately to Next.js caller
3. Query `listings WHERE status = 'live' ORDER BY published_at DESC` via
   Supabase HTTP API to get updated feed snapshot
4. Push updated marketplace feed to subscribed consumer clients via OneSignal

**What n8n does NOT do:**
- Does not write to `listings` table — status is already `live`
- Does not call Gemini
- Does not handle pricing

---

### Workflow 2 — Listing Expired → Notify Donor

**Webhook path:** `POST /listing-expired`

**Trigger:** Inngest's `cold-chain-check` cron function sets
`listings.status = 'hidden'`, then fires this webhook to n8n.

**Inbound payload:**
```json
{
  "listing_id": "uuid",
  "donor_id": "uuid",
  "detected_item": "string",
  "safety_expires_at": "2026-06-29T20:00:00Z"
}
```

**What n8n does:**
1. Verify `x-n8n-signature` — reject 401 if invalid
2. Respond 200 immediately
3. Send push notification to donor via OneSignal:
   `"Your [detected_item] listing has been removed — it reached its food
   safety window."`

**What n8n does NOT do:**
- Does not touch `listings.status` — already set to `hidden` by Inngest

---

### Workflow 3 — Order Placed → Notify Courier Pool

**Webhook path:** `POST /order-placed`

**Trigger:** Next.js fires after consumer purchase is confirmed and Stripe
payment is captured (`claim_listing()` RPC succeeded + `payment_intent.succeeded`
Stripe webhook processed).

**Inbound payload:**
```json
{
  "order_id": "uuid",
  "listing_id": "uuid",
  "consumer_id": "uuid",
  "donor_id": "uuid",
  "pickup_address": "string",
  "delivery_address": "string",
  "pickup_lat": 33.749,
  "pickup_lng": -84.388,
  "consumer_price_cents": 840,
  "courier_fee_cents": 350,
  "temperature_sensitive": true,
  "handling_notes": "string or null"
}
```

**What n8n does:**
1. Verify `x-n8n-signature` — reject 401 if invalid
2. Respond 200 immediately
3. Query `courier_profiles WHERE is_available = true` via Supabase HTTP API
   (filter `insulated_transport_capable = true` if `temperature_sensitive = true`)
4. Route dispatch notification to eligible couriers via OneSignal with:
   pickup address, delivery address, item summary, handling notes,
   confirmed `courier_fee_cents`, and a 5-minute acceptance window reminder

**What n8n does NOT do:**
- Does not write `orders.courier_id` — courier acceptance happens through
  the Next.js app via a Server Action
- Does not write `orders.status` — that is the PostgreSQL RPC
- Does not handle the 5-minute acceptance window timer — that is Inngest

---

### Workflow 4 — Delivery Confirmed → Notification Layer

**Webhook path:** `POST /delivery-confirmed`

**Trigger:** Next.js fires after `confirm_delivery()` RPC succeeds and
`orders.status` transitions to `delivered`.

**Inbound payload:**
```json
{
  "order_id": "uuid",
  "listing_id": "uuid",
  "donor_id": "uuid",
  "courier_id": "uuid",
  "delivered_at": "2026-06-29T19:45:00Z"
}
```

**What n8n does:**
1. Verify `x-n8n-signature` — reject 401 if invalid
2. Respond 200 immediately
3. Send confirmation notification to consumer via OneSignal:
   `"Your delivery has arrived. You have 2 hours to report any issues."`
4. Log event for monitoring purposes

**What n8n does NOT do:**
- Does not execute the 2-hour dispute window timer — that is Inngest
  `dispute-window` function (triggered by the `delivery/confirmed` Inngest event
  fired by Next.js)
- Does not execute Stripe transfers — that is Inngest `payout-release`
- Does not write to `audit_log`

---

### Fields n8n Must Never Write

These fields exist in the new schema and are owned exclusively by Next.js
Server Actions, PostgreSQL RPCs, or Inngest. n8n must never INSERT or UPDATE:

| Field | Owner |
|---|---|
| `listings.status` | `claim_listing()` RPC, `confirm_listing` Server Action, Inngest cold-chain |
| `listings.confidence_score` | Gemini scan Server Action (`actions/ai-scan.ts`) |
| `listings.safety_attested` | Donor attestation checkbox — Server Action |
| `listings.safety_expires_at` | Computed server-side from `prepared_at` |
| All `*_cents` pricing fields | Pricing engine in `actions/listing.ts` |
| `orders.stripe_payment_intent_id` | Stripe webhook handler |
| `orders.donor_transfer_id` | Inngest `payout-release` |
| `orders.courier_transfer_id` | Inngest `payout-release` |
| `audit_log.*` | Written atomically inside every PostgreSQL RPC |

---

### Immediate Security Remediation Required

Before any new workflow is built, confirm these two items are resolved:

1. **Rotate the Gemini API key.** The original workflow hardcodes
   `AIzaSyAAnZm6jVT8Eqr7wf8j5BAiRlONJyzrFdo` in the HTTP Request node URL.
   This key must be rotated in Google Cloud Console immediately. In the new
   architecture, the Gemini key is `GEMINI_API_KEY` in Next.js server-only
   env — never in any workflow or document.

2. **Remove Supabase prototype project references.** The original hardcodes
   project ID `emzuapltkphvkhxoeqxj` in both the Storage upload URL and the
   `binaryConstruction` Code node. All references to this project must be
   gone from n8n. The new project credentials live only in the n8n Credential
   store.

---

### Acceptance Criteria (All Four New Workflows)

- [ ] Old deprecated workflow **deactivated** (not deleted — keep for reference)
- [ ] Gemini API key rotated in Google Cloud Console before build starts
- [ ] All `emzuapltkphvkhxoeqxj` references removed from n8n
- [ ] `n8n_health_check` passes before any workflow is created
- [ ] Each workflow verifies `x-n8n-signature` as its first node (node 1)
- [ ] Each workflow responds to Next.js within 3 seconds
- [ ] No secrets in node parameters — Supabase and OneSignal via Credential store
- [ ] No `Wait`, sleep, schedule, or cron trigger nodes anywhere
- [ ] No writes to `listings.status`, `orders.status`, or `audit_log`
- [ ] No Gemini API calls in any node
- [ ] No image upload nodes
- [ ] No `session_id` in any expression — identity comes from payload UUIDs
- [ ] `validate_workflow` passes for each workflow (level 3)
- [ ] `n8n_validate_workflow` passes on each deployed workflow (level 4)
- [ ] `n8n_test_workflow` with valid payload — succeeds for each
- [ ] `n8n_test_workflow` with invalid signature — 401 for each
- [ ] `n8n_executions` shows 0 failures across 3 consecutive runs per workflow
- [ ] All 4 workflows active and visible in `n8n_list_workflows`

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
