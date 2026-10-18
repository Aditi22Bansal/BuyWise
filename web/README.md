# BuyWise Web (local demo frontend)

Small Express app over the **real** BuyWise PostgreSQL database. No mocks, no fake
data, no email sending. Everything shown comes from live tables; everything written
goes through the same validation rules as the n8n agents/harnesses.

## Run

```powershell
cd D:\flexi\web
npm install
# .env is read from D:\flexi\.env (never committed, never sent to the browser)
$env:PORT = 8080          # optional, default 8080
npm start                 # open http://localhost:8080
```

Postgres must be reachable (`docker compose up -d postgres` in `D:\flexi`).
Starting a *new* procurement proxies to the live n8n webhook
(`http://localhost:5678/webhook/procurement-request` by default, override with
`N8N_WEBHOOK_URL`), so n8n must be up for that button.

## What you can do

- **Dashboard** — all procurement cases with live status/mode/decision.
- **Case detail** — requirement, products, vendors/offers, quality, ranked
  comparisons, decision, negotiations, re-evaluations, approvals, audit trail.
- **New procurement** — submits the real intake (same validation as n8n).
- **Demo panel** — on a decided case with real offers: switch to DEMO (reason
  required), create a local demo negotiation (nothing sent anywhere), enter a
  manual demo response (labeled `DEMO_HUMAN_ENTERED`), run deterministic
  re-evaluation, then APPROVE / REJECT / REQUEST CHANGES as an explicit human.
- Every demo artifact is badged in the UI. REAL mode behavior is unchanged.

## Security

- Only `.env` values the server needs are loaded (`POSTGRES_*`, `PORT`,
  `N8N_WEBHOOK_URL`); provider API keys are never read and never leave the server.
- The browser never receives secrets (verified by `npm test`).
- Local demo tool: no auth. Do not expose to a network without adding auth first.
