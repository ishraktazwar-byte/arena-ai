# Arena AI

An autonomous Minecraft-agent platform under development.

**Current: V0.2.2 — resource scanning and guarded single-block mining.**

> The LLM chooses goals. The local body decides how to execute them safely.

## What works in automated tests

- Alice/Bob profiles and a persistent Mineflayer body.
- Action ownership, cancellation, timeouts and stale-command guards.
- Basic eating, conservative risk gates and bounded flat-ground escape.
- Stable melee targets, equipment selection, safe approach and final attack checks.
- Persistent local observations, deaths and goal outcomes with bounded retrieval.
- A runtime tool catalog: `scan`, `scan_resources`, `wait`, `move_step`, and opt-in
  `mine`—no generated JavaScript.
- Visible nearby resource observations and region-limited single-block mining
  with equipment, geometry, cancellation and server-confirmation checks.
- Optional OpenRouter free-router planning, timeout/retry handling and a shared
  daily request budget. With AI off/unavailable, strategy falls back to scanning;
  local eating, combat and escape do not need an API key.

**This is not a finished civilization simulation or live-validated survival bot.**
There is no ranged combat, shield tactic, complete gathering workflow, crafting,
farming, settlement, economy or diplomacy system yet. Memory currently stores local events, not a complete
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

### Resource scanning and mining permission

Observations now include at most 16 sampled line-of-sight resource blocks within
four blocks of the eye position. `scan_resources` is read-only. The search is
bounded and excludes hidden resources from planning context.

`mine` is **disabled by default**, and is not advertised to the planner while
disabled. To use it, configure an owner-approved resource area in local `.env`:

```text
MC_MINING_ENABLED=true
MC_MINING_DIMENSION=overworld
MC_MINING_AREA=minX,minY,minZ,maxX,maxY,maxZ
```

Replace those six placeholders with integer block bounds. There is deliberately
no authorized area by default. Exclude homes, shared storage and player builds:
block type cannot prove ownership or distinguish natural stone/logs from placed
blocks. The active tool catalog includes the approved bounds and dimension;
model arguments cannot expand them.

Mining attempts **one already-visible block**, without movement or repeat loops.
It rejects below-foot/above-head targets, the body column, unsupported terrain,
nearby threats, insufficient equipment, nearby fluids/falling blocks, and unknown
neighbors. It rechecks after equipping/aiming and while digging. Only supported
logs, stone variants and overworld ores are eligible.

The result distinguishes a server `block_change` reporting air from Mineflayer's
optimistic local cache. A server using only another packet form may yield an
unconfirmed/failed result even after a real break. Inventory increases are reported
as observations, **not** guaranteed drops from this action. No automatic collection,
crafting, ore expedition, tunnel creation or multi-agent block reservation yet.

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
Memory schema v2 reads v1 snapshots and upgrades on the next write; older releases
will refuse v2 rather than silently interpreting newer tool history. Resource
locations appear in current observations but are not yet persisted as a world map.
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
| V0.2.2 | Resource scanning, tool registry and guarded mining | 107 |

See `docs/V0.2.2.md` for current validation, `docs/V0.1.0.md` for live connection
attempts, and other version documents for individual changes and limitations.
CI runs syntax/tests on Windows and Ubuntu with Node 22 and 24. A passing test
matrix does not prove real server combat or cloud-provider behavior.

Secrets and token caches are ignored (`.env`, `runtime/`). Never distribute them
in ZIPs. Dependencies are locked; the known six moderate authentication-chain
audit findings are documented in V0.1.0 and remain unresolved.
