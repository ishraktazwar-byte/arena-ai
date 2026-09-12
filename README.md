# Arena AI

An autonomous Minecraft-agent platform under development.

**Current: V0.2.1 — persistent memory and validated strategy foundation.**

> The LLM chooses goals. The local body decides how to execute them safely.

## What works in automated tests

- Alice/Bob profiles and a persistent Mineflayer body.
- Action ownership, cancellation, timeouts and stale-command guards.
- Basic eating, conservative risk gates and bounded flat-ground escape.
- Stable melee targets, equipment selection, safe approach and final attack checks.
- Persistent local observations, deaths and goal outcomes with bounded retrieval.
- Validated `scan`, `wait`, and `move_step` strategic tools—no generated JavaScript.
- Optional OpenRouter free-router planning, timeout/retry handling and a shared
  daily request budget. With AI off/unavailable, strategy falls back to scanning;
  local eating, combat and escape do not need an API key.

**This is not a finished civilization simulation or live-validated survival bot.**
There is no ranged combat, shield tactic, resource gathering, settlement, economy
or diplomacy system yet. Memory currently stores local events, not a complete
resource map, social model or learned skill system. No idle-shutdown avoidance.

## Windows CMD setup

Use Node 24 (Node >=22 is supported). Run from the project directory:

```bat
cd /d E:\agents\mc-agents-main
npm ci
copy .env.example .env
notepad .env
npm run check
npm test
node bot.js alice
```

Set `MC_HOST`, the server's current `MC_PORT`, `MC_VERSION=1.21.1`, and `MC_AUTH`.
Use `offline` only when the owner has explicitly enabled/permitted that mode.
This project's owner confirmed offline/cracked mode; other servers may differ.
Aternos DynIP/ports can change after restart; do not assume the example is current.

For authenticated servers, set `MC_AUTH=microsoft` and `MC_USERNAME` locally.
Complete device authentication on your own machine. Never share login codes or
cached tokens. Each simultaneous online-mode bot needs its own authorized account.

Bob in a second CMD window:

```bat
node bot.js bob
```

In Microsoft mode, set the second account's `MC_USERNAME` in that window first.
Offline mode uses profile names; Microsoft mode uses the account's player identity.

### Optional cloud planning

Leave `AI_ENABLED=false` until ready. To enable it, set `AI_ENABLED=true` and put
`OPENROUTER_API_KEY` **only in your local `.env`**. The model is fixed to
`openrouter/free`; no paid-model fallback is configured. Free availability is not
guaranteed. `AGENT_AI_INTERVAL_MS` defaults to five minutes per agent.

`AI_DAILY_REQUEST_LIMIT=24` caps requests, including retries, across processes
launched from this project directory. The budget persists under `runtime/shared`.
This conservative default means not every scheduled plan gets a cloud request.
Do not use different configured limits for bots sharing one account. An orphaned
budget lock fails closed: after stopping **all** agents, inspect and remove only
`runtime/shared/request-budget.lock` if a prior process crashed. Do not delete the
budget JSON to bypass a used quota.

### Persistent memory

`MC_WORLD_ID=arena-world-1` identifies the actual world, not its temporary network
address. Keep it unchanged across DynIP/port changes. **Change it after a world
reset or when connecting to another world**, so old coordinates are not recalled
as current knowledge. If unset, it defaults to `host:port` (less reliable on Aternos).

Each agent stores up to 500 structured records in:

```text
runtime/agents/alice/memory.json
runtime/agents/alice/memory.backup.json
```

The planner receives at most eight records from the current world and dimension,
ranked using recency, distance and event importance. Restart does not replay old
actions. Successful/failed/interrupted goal results are historical evidence only.
No chat, arbitrary model reasoning, API keys or environment contents are stored.
When cloud AI is enabled, retrieved local records are sent as planning context.
These files still contain private gameplay history/locations; keep them local.

A lock prevents two processes from writing the same agent's memory. Clean exit
waits for queued writes and releases the lock. After a crash, **stop all instances
of that agent first**, then remove only its `memory.lock` directory if it is
orphaned. Never remove an active process's lock. A corrupt primary can recover
from the previous valid backup; both corrupt files cause startup to fail without
silently replacing the history. Unsupported future schemas also fail closed.
See the version document for retention/recovery limits.

### Operator commands

`status`, `step`, `stop`, `quit`.

- `step` is an operator-only 250ms raw forward-input smoke test, **not** safe
  navigation. Only use on clear, flat ground.
- `stop` cancels the current action; it is **not** a permanent pause of automation.
- `quit` stops the runtime and disconnects.

Do not leave this release unattended in a dangerous world. Escape only handles
known, flat, full-block terrain. It does not swim out of drowning/lava, jump cliffs,
or guarantee survival against creepers. Melee uses conservative heuristics and
is not a complete competent-player combat model.

## Validation and release history

| Version | Increment | Automated tests |
|---|---|---:|
| V0.1.0 | Runtime and cancellable actions | 6 |
| V0.1.1 | Risk gates and eating | 17 |
| V0.1.2 | Bounded ground escape | 29 |
| V0.1.3 | Stable local melee | 45 |
| V0.2.0 | Validated goals and optional provider | 62 |
| V0.2.1 | Persistent structured memory and retrieval | 81 |

See `docs/V0.2.1.md` for current validation, `docs/V0.1.0.md` for live connection
attempts, and other version documents for individual changes and limitations.
CI runs syntax/tests on Windows and Ubuntu with Node 22 and 24. A passing test
matrix does not prove real server combat or cloud-provider behavior.

Secrets and token caches are ignored (`.env`, `runtime/`). Never distribute them
in ZIPs. Dependencies are locked; the known six moderate authentication-chain
audit findings are documented in V0.1.0 and remain unresolved.
