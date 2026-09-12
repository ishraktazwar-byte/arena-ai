# Arena AI

An autonomous Minecraft-agent platform under development.

**Current: V0.2.13 — guarded crop planting and replanting with inventory evidence.**

> The LLM chooses goals. The local body decides how to execute them safely.

## Intended operation: an autonomous agent world

For a dedicated world where the agents may independently gather and build, set
these values once in your local `.env`:

```dotenv
MC_OPERATING_MODE=autonomous_world
MC_WORLD_ID=your-stable-agent-world-id
AI_ENABLED=true
```

Keep the OpenRouter key only in local `.env`, as described below. The existing
free-only provider and shared request budget remain unchanged. This mode exposes
all implemented navigation, mining, collection, crop harvesting/planting and crafting-workspace skills in
the Overworld, Nether and End **without drawing or approving individual areas**.
The planner selects actions; there is no per-action approval prompt or fixed
house/farm/king sequence. Bounded attempts and local survival checks still apply.

`MC_MINING_*`, `MC_COLLECTION_*`, `MC_WORKSPACE_*`, `MC_NAVIGATION_*` and `MC_FARMING_*` area
settings are ignored in this mode, including old `ENABLED=false` values. Startup
reports the effective mode and whether those settings were ignored. Change
`MC_WORLD_ID` after a reset. Use this mode only for a world where these actions
are permitted; ownership detection and player-property protection do not yet exist.

`restricted` remains an optional deployment mode for shared servers. It is also
the default when the setting is missing, so upgrading an existing installation
never silently expands permission. **The per-area instructions later in this
README apply to restricted mode only.** With AI off, unavailable or out of budget,
strategy still falls back to observation; world scope alone does not invent goals.

This corrects the deployment model, not all missing autonomy features. Long-term
plans, general navigation, production and civilization systems remain unfinished.

## What works in automated tests

- Alice/Bob profiles and a persistent Mineflayer body.
- Action ownership, cancellation, timeouts and stale-command guards.
- Basic eating, conservative risk gates and bounded flat-ground escape.
- Independently opt-in `navigate_local`: obstacle-aware routing on known flat terrain,
  with live step rechecks and strict distance/time/leg limits.
- Stable melee targets, equipment selection, safe approach and final attack checks.
- Persistent local observations, deaths and goal outcomes with bounded retrieval.
- Typed supply objectives survive planning cycles/restarts without replaying actions;
  progress is reassessed against current carried inventory.
- Bounded resource-location memory, scoped by world/dimension; historical sightings
  remain distinct from current observations and never authorize mining.
- A runtime tool catalog: `scan`, `scan_resources`, `craft_options`, `craft`,
  `wait`, `move_step`, `workspace_options`, opt-in `mine`,
  `place_crafting_table`, `craft_at_table`, `scan_items` and opt-in `collect_items`—no generated JavaScript.
- Visible mature-crop discovery and guarded one-plant harvesting; immature crops
  are refused. Yield and pickup are not assumed.
- Guarded planting/replanting on observed empty farmland cells using carried
  reserves, a server-reported seedling and verified inventory consumption.
- Visible nearby resource observations and region-limited single-block mining
  with equipment, geometry, cancellation and server-confirmation checks.
- Single-batch starter crafting with guarded clicks, bounded waits and
  authoritative inventory verification.
- Approved-area crafting-table placement and automatic opening/crafting/closing,
  without manual window setup. Late opening replies are fenced from later tasks.
- Separate approved-area dropped-item collection, using short terrain-checked steps
  and both pickup reports and authoritative inventory deltas.
- Advisory safety, recovery, nutrition, food reserve, inventory-space and gathering-tool
  needs; exact failed-action cooldowns prevent immediate repetition without scripting
  a fixed progression or expanding tool permissions.
- Optional plans of up to four typed actions per planning request, re-observed
  between steps; failure or interruption discards the tail rather than replaying it.
- Optional OpenRouter free-router planning, timeout/retry handling and a shared
  daily request budget. With AI off/unavailable, strategy falls back to scanning;
  local eating, combat and escape do not need an API key.

**This is not a finished civilization simulation or live-validated survival bot.**
There is no ranged combat, shield tactic, complete gathering workflow, farming,
settlement, economy or diplomacy system yet. Memory stores local events and bounded resource sightings, not a complete
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
ore expedition, tunnel creation or multi-agent block reservation yet.

### Starter crafting

`craft_options` reports starter recipes that can use the current main inventory.
`craft` accepts one allowlisted item name and makes **one recipe batch** (for
example, one log produces four planks). It never accepts model-written recipes,
shift-clicks to craft repeatedly, or automatically chains a production plan.

Supported outputs: eight overworld wood plank types, sticks, crafting tables,
and wooden/stone pickaxes, axes, shovels, swords and hoes. The 2×2 player grid
handles planks/sticks/tables. `craft` requires an already-open table for 3×3
recipes; `craft_at_table` opens an approved nearby table, crafts one batch, and
closes it within the same interruptible action.

Ingredients and the output destination must be in main inventory slots below 36;
hotbar-only ingredients are deliberately not used because the pinned Mineflayer
click helper can delay hotbar clicks internally. One empty main slot is required.
Occupied grids/cursors, unsupported windows, danger, insufficient ingredients and
unsupported protocol versions are refused. Craft execution is pinned to 1.21.1.

Each click checks action ownership and safety. Interrupted crafting stops further
clicks; synchronous session cleanup requests closure of the owned window before
another action begins (not after death/disconnect or if a different window opened).
A later crafting attempt must resynchronize and see a clean server grid/cursor
before retrying. The code does not explicitly toss items; server behavior when
closing a full inventory or interrupting a craft still needs live testing.

Success requires a fresh whole-window server snapshot showing the expected
output gain, ingredient consumption and empty grid/cursor—not just optimistic
local inventory updates. Results describe observed changes rather than proving
exclusive causation. Interrupted crafting can already have consumed materials;
it is not a rollback transaction or an item-loss guarantee.

### Approved crafting workspaces

Workspace tools are opt-in and independent of mining permission:

```text
MC_WORKSPACE_ENABLED=true
MC_WORKSPACE_DIMENSION=overworld
MC_WORKSPACE_AREA=minX,minY,minZ,maxX,maxY,maxZ
```

Replace the six bounds with an owner-approved area that excludes player builds
and important paths. There is no authorized area by default. `workspace_options`
lists up to eight visible tables and eight passing placement candidates.

- `place_crafting_table` places one carried table into a known empty cell on
  inert, full-block ground. It refuses body/entity overlap, occupied/head-blocked
  cells, unsafe terrain and placement that removes every known flat escape step.
  It requires a server block packet reporting the table; inventory counts are
  reported separately rather than assumed to prove consumption.
- A table in main inventory can be staged with one guarded number-key swap into
  an **empty** hotbar slot. The helper never overwrites a full hotbar or tosses
  items to make room.
- `craft_at_table` selects an empty hotbar slot, revalidates and interacts with one
  nearby approved table, waits for server-backed window data, runs the guarded
  starter crafting handler, then closes the owned window. It does not move or
  place a missing table. An empty hotbar slot is required when the hand is full.

World interactions are pinned to the 1.21.1 packet format and sent only after
explicit guarded aiming. There are no internal asynchronous placement/opening
helper calls that can send an interaction after cancellation.

**An unresolved opening response disables further workspace interactions until
reconnect.** Minecraft window replies do not identify the originating request.
This prevents a delayed old reply from being used for a new craft. Late windows
are closed through a separate priority-2000 window-safety action; it may briefly
preempt movement/combat. Other local reflexes can continue, but the runtime does
not automatically reconnect or resume the uncertain workspace operation.

An already-sent placement may still occur after interruption. There is no world
rollback, ownership/claims detection, automatic table removal or continuous
production script. Even with all offline tests passing, live server behavior
and plugin/anti-cheat compatibility remain unverified.

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
Memory schema v10 reads v1–v9 snapshots and upgrades on the next write; older releases
refuse unsupported newer schemas rather than silently interpreting newer tool history. Up to 128
resource sightings share the 500-record memory budget. The planner receives at most
eight resource memories separately from event history, with age and recheck flags.
This is a bounded landmark index, not a complete map or proof of remaining supply.
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
| V0.2.3 | Starter crafting, guarded clicks and inventory verification | 130 |
| V0.2.4 | Approved table placement/opening and late-window safety | 163 |
| V0.2.5 | Approved dropped-item collection and pickup verification | 191 |
| V0.2.6 | Needs-aware planning and failed-action cooldowns | 215 |
| V0.2.7 | Persistent resource sightings and scoped recall | 236 |
| V0.2.8 | Bounded local navigation with guarded route execution | 259 |
| V0.2.9 | Autonomous-world scope with optional restricted deployment | 281 |
| V0.2.10 | Bounded multi-step planning and step revalidation | 304 |
| V0.2.11 | Persistent supply intentions and fresh progress assessment | 327 |
| V0.2.12 | Mature-crop discovery and guarded harvest | 352 |
| V0.2.13 | Guarded planting/replanting and seed consumption evidence | 381 |

See `docs/V0.2.13.md` for current validation, `docs/V0.1.0.md` for live connection
attempts, and other version documents for individual changes and limitations.
CI runs syntax/tests on Windows and Ubuntu with Node 22 and 24. A passing test
matrix does not prove real server combat or cloud-provider behavior.

Secrets and token caches are ignored (`.env`, `runtime/`). Never distribute them
in ZIPs. Dependencies are locked; the known six moderate authentication-chain
audit findings are documented in V0.1.0 and remain unresolved.

## V0.2.5 collection permission

`scan_items` is read-only and always available. To authorize collection, set
`MC_COLLECTION_ENABLED=true`, `MC_COLLECTION_DIMENSION=overworld` and
`MC_COLLECTION_AREA=minX,minY,minZ,maxX,maxY,maxZ` in your local `.env`. Use actual
integer bounds for a small owner-approved flat test area, including the feet/drop
Y level. Mining and workspace permissions do **not** authorize collection.
Dropped-item ownership is not observable, so do not approve a shared area without
its owners’ consent. Minecraft can automatically pick up nearby items even during
a failed/cancelled attempt; this tool cannot disable incidental pickups.

See [V0.2.5 release notes and pending live checks](docs/V0.2.5.md).

## V0.2.6 planning maturity

The planner receives deterministic advisory needs, not a prescribed life story.
Safety, recovery and nutrition remain owned by local reflexes. Supply needs do not
authorize mining, collection, crafting workspaces, inventory disposal or new skills.
A failed/blocked action at the same origin block, dimension and exact arguments
gets a 10-minute cooldown, rising to 20 then at most 30 minutes on repeat failures.
A repeated proposal during cooldown becomes a read-only scan, with no extra cloud
request. Cancellation is not treated as failure. Retry history is bounded, local
to the running controller and cleared on process restart; it is not durable world
knowledge. See [V0.2.6 notes](docs/V0.2.6.md) for limits and automated verification.

Live testing is deferred while implementation matures; passing offline tests is
not a claim that the complete civilization platform is ready.

## V0.2.7 resource memory

Visible allowlisted resource locations observed at spawn and before strategy
planning are remembered locally. Repeat sightings update the same location.
A missing item in a truncated scan is **not** marked depleted. Recall distinguishes
`historical_recheck_required` from `matches_current_observation`, and both require
execution-time checks. Mining permissions, tool checks and reach limits still apply.
Seven-day-old or future-dated sightings are excluded from recall; memory bounds can
evict them earlier. Reset `MC_WORLD_ID` after a world reset to isolate old knowledge.
No shared cross-agent map or travel/navigation skill is added in this version.

See [V0.2.7 notes](docs/V0.2.7.md) and the [implementation progress ledger](docs/PROGRESS.md).

## V0.2.8 local navigation

`navigate_local` is absent by default. To allow it, set `MC_NAVIGATION_ENABLED=true`,
`MC_NAVIGATION_DIMENSION=overworld` and six integer bounds in `MC_NAVIGATION_AREA`
for an owner-approved flat area, including the feet Y level. It targets an empty
cell center within six blocks, not the inside of a remembered resource block.
The tool searches known same-floor cells, routes around obstacles and rechecks
each short movement. Unknown terrain, cliffs, stairs, jumps and digging are excluded.

This permission applies only to the new tool; it is not a global movement fence
for emergency survival, `move_step` or operator actions. It grants no mining or
collection permission. Automatic Minecraft pickups may still occur while walking.
Arrival is a local position estimate, not server-confirmed position or resource
availability. See [V0.2.8 notes](docs/V0.2.8.md). Live testing remains deferred.

## V0.2.10 short plans

The planner may return one typed goal or a sequence of one to four goals. Every
step must belong to the active catalog; the body re-observes and checks the next
action before executing it. Failed, blocked, cancelled or cooling-down steps stop
the plan. New danger, missing vitals, hunger, health loss, a dimension change or
lifecycle invalidation also prevents follow-up steps.

A sixty-second admission window limits when another step may begin; an action
already running retains its own tool timeout, up to fifteen seconds. Plans are
not stored or resumed after death/restart. Only actual outcomes enter memory.
There are no loops, generated code or invented future entity IDs. One request
can support several compatible skills without an extra cloud call per step, but
request budgets, free-only routing and the 400-token response limit are unchanged.
See [V0.2.10 notes](docs/V0.2.10.md). This is not yet durable long-term planning.

## V0.2.11 supply objectives

A cloud plan may include `objective: {item, count}` using the advertised finite
item vocabulary and a target of 1–64 carried units. Omit it to retain the current
objective; use `objective: null` to abandon it. One objective per world/dimension
is retained, with up to eight contexts pinned inside the 500-record memory cap.
An objective can survive a restart, but **its old action sequence is never saved
or resumed**. The next planning cycle receives the objective and fresh inventory
assessment, then chooses new actions under the current deployment policy.

These are stock targets: satisfaction is temporary and can reverse after supplies
are consumed. Unknown inventory means unknown progress; a completed action is not
proof of objective completion. Objectives expire from recall after 24 hours and
are explicitly labelled cloud intent, not observed world facts. No free text,
model rationale or generated commands are persisted. See [V0.2.11 notes](docs/V0.2.11.md).

## V0.2.12 crop harvesting

`scan_crops` observes up to 16 visible supported plants and their maturity.
`harvest_crop` removes one ripe wheat, carrot, potato or beetroot plant with an
empty hand, from nearby safe ground, and requires inbound server removal evidence.
It does not walk onto farmland, predict yield, collect drops or replant.

Autonomous-world mode enables this skill without per-area approval. Restricted
mode uses `MC_FARMING_ENABLED`, `MC_FARMING_DIMENSION` and `MC_FARMING_AREA`,
independently of mining/collection permissions. Mature shared-server crops must
not be assumed unowned: permission is deployment policy, not ownership detection.

Harvesting is allowed while hungry because it is motionless; it still requires
known vitals, health at least 8, NORMAL risk and safe footing. Collection and other
skills retain their existing separate preconditions. Replanting, soil preparation,
cooking and a complete food-production loop remain unfinished. See
[V0.2.12 notes](docs/V0.2.12.md). No live testing is requested at this stage.

## V0.2.13 planting and replanting

`plant_crop` plants one supported crop above existing farmland, using carried
wheat seeds, carrots, potatoes or beetroot seeds as appropriate. Crop scans now
include up to eight observed empty farmland sites and carried planting-item options.
A site observation is not a guarantee that planting remains safe or feasible.

The skill checks the empty target, soil, body and hand before interacting, and
requires both a server-reported age-zero plant and a raw inventory decrease of
one planting item. It never overwrites an occupied cell, tills soil, moves onto
farmland, or invents seeds. Autonomous-world farming scope includes it directly;
restricted mode uses the existing farming permission, not another approval setting.

A short planner-chosen harvest → replant sequence can use carried reserves, but
harvested drops are not automatically recovered or reserved. Sustainable farming,
soil preparation, cooking and general farmland navigation remain unfinished.
See [V0.2.13 notes](docs/V0.2.13.md). Live testing remains deferred.
