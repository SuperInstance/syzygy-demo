# syzygy-rack — the multi-provider key-rack

A single Cloudflare Worker that holds the fleet's provider keys as Worker
**secrets** (never in code, never in git) and lends them to the public
Syzygy demo under strict economics: Workers are cheap when calls are
*occasional little scripts*, so every route is paced per caller and capped
per day. When a cap is spent, the route answers "resting" and the demo page
falls back to a recorded real session — the page never goes dead.

**Live:** https://syzygy-rack.casey-digennaro.workers.dev

## Routes

| Route | Provider | What it does |
|---|---|---|
| `GET /health` | — | Which house providers are configured, caps, today's admitted counts. |
| `POST /perceive` | MiniMax | Body `{promptId:"frozen-v1", grid:[rows], session?}`. The Worker assembles the frozen perception prompt server-side (byte-identical to `lib/prompt.txt`) and returns `{raw, latencyMs, mode}`; the client parses/validates. |
| `POST /judge` | Typesafe (Jev) | Body `{session, state, question:{type, instructions, criteria}}`. The session id rides inside the judged state, so every visitor session gets its own judgment battery — no accounts. Returns the provider's answers. |
| `POST /moth` | Moth Quantum | Body `{session?, engine_id, params}`. Submits a job and polls briefly (~16 s); slower jobs return `{status:"pending", job_id}`. |
| `GET /moth/status?job=<id>` | Moth Quantum | Job status/result. |
| `GET /moth/engines` | Moth Quantum | Engine list (used by the page's probe button). |

## Economics (defaults, all plain vars)

- **Pacing:** one admitted call per caller (hash of IP + session) per
  **2.5 s** (`PACE_MS`), enforced with an in-isolate fast path plus a KV
  backstop (KV is eventually consistent; the two layers together bind
  bursts). Note: pacing keys on caller identity — a caller behind a
  rotating egress (some corporate/sandbox proxies) presents a new identity
  per call, so for them the daily cap is the binding rail.
- **Daily caps (house key only):** `/perceive` 600/day, `/judge` 250/day,
  `/moth` 50/day (`*_DAILY_CAP`). Counters are per-route per-UTC-day keys
  in the `SYZ_RACK_COUNTERS` KV namespace — counts only, never payloads.
  Nothing about request bodies is logged anywhere.
- **BYO keys** are paced but do not consume house caps.
- On the Workers free plan, KV writes (~1,000/day) are the ceiling behind
  these numbers (each admitted call writes a pacing stamp + a counter).
  Raise the caps if the account moves to a paid plan.
- Failure posture is **closed**: KV errors or a spent cap answer
  `503 daily_cap` / `503 rack_unavailable` and the page replays a recording.

## CORS

Only origins in `ALLOWED_ORIGINS` receive `Access-Control-Allow-Origin`
(default: `https://superinstance.github.io` + localhost dev origins).

## Bring-your-own key

A caller may send `x-syz-byo-minimax` / `x-syz-byo-typesafe` /
`x-syz-byo-moth` with their own provider key. It is used for that single
provider call only — never stored, never logged. The demo page stores such
keys only in the visitor's own `localStorage`.

## Deploy

```sh
python3 deploy.py     # API route via the Cloudflare skill credential
# or: wrangler deploy (wrangler.toml carries the same bindings/vars)
```

## Seating the house keys (the one manual step)

The fleet reaches these providers through connector credentials on its own
machines; those cannot be exported into a Worker. The house keys must be
real provider API keys, set once by the account owner:

```sh
cd worker
wrangler secret put MINIMAX_API_KEY     # key from the MiniMax console
wrangler secret put TYPESAFE_API_KEY    # key from the Typesafe console
wrangler secret put MOTH_API_KEY        # key from the Moth Quantum console
```

(or dashboard: Workers & Pages → `syzygy-rack` → Settings → Variables and
Secrets → Add secret.)

Until a given secret is set, its route answers
`503 provider_not_configured` and the page degrades honestly (replay for
perception, explanatory feed lines for judge/moth). Setting a secret needs
no redeploy and no code change — the page probes `/health` on load and
lights up live mode automatically.

## Verification performed at deployment (2026-10-11)

- `/health` shape, caps, counters — live.
- Each provider route with a deliberately invalid BYO key returned the
  provider's real `401` (mapped to `provider_auth`) — proving each route
  genuinely reaches its provider with the caller's credential.
- House path exercised with a temporary dummy secret (not a real key):
  daily cap fired at the seeded limit; admitted calls incremented the
  counter 5 → 8; the dummy secret was then deleted and all smoke-test KV
  keys wiped. The rack was left with **no secrets seated** and counters
  at zero.
