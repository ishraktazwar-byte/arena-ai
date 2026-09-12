# Arena AI — implementation progress

Updated for V0.2.13. This is a capability ledger, not a percentage or a promise that
all the original instructions are complete. The remaining social/economic and
world-building systems are much larger than individual completed tools.

## Implemented and covered by automated tests

- Persistent Mineflayer body runtime, Alice/Bob data-driven profiles, structured
  diagnostics, explicit action ownership, cancellation and stale-command guards.
- Basic eating, conservative risk gates, bounded flat-ground escape and stable
  local melee behavior. Local reflexes outrank strategic actions.
- Optional free-only OpenRouter planning, validated tool catalog, bounded retries,
  shared daily request budget and read-only fallback. No required local inference.
- Scoped persistent event memory, bounded retrieval, migration/backup handling;
  advisory needs and per-controller failed-action cooldowns.
- Visible resource scanning; approved-region single-block mining; independent
  approved-region dropped-item pickup with inventory evidence; guarded starter
  crafting; independently approved crafting-table placement/use.
- V0.2.13: guarded planting/replanting using carried reserves, empty farmland
  site observations, server seedling reports and verified seed/produce consumption.
- V0.2.12: visible crop maturity discovery and guarded harvesting of one mature
  wheat/carrot/potato/beetroot plant, without yield or replanting assumptions.
- V0.2.11: typed supply objectives persist across planning cycles/restarts, with
  scoped retention, current-inventory assessment and fresh planning instead of replay.
- V0.2.10: cloud-selected plans of up to four typed steps with re-observation,
  full permission validation and fail-stop/lifecycle-invalidated tails.
- V0.2.9: one-time autonomous-world deployment makes all implemented gathering,
  navigation and workspace mutations available without per-area setup; restricted
  mode remains optional for shared servers. This is not complete strategic autonomy.
- V0.2.8: independently approved six-block local routing around known obstacles,
  with twelve-leg/time budgets and safety checks during movement.
- V0.2.7: bounded persistent resource sightings with world/dimension isolation,
  age limits, duplicate-cell updates and explicit current-vs-historical status.
- Windows CMD setup instructions, local-only secrets and one tested/pushed release
  at a time. No anti-idle/shutdown-avoidance feature.

## Partial systems — important limitations

- Survival/combat is conservative, not complete: ranged combat, shield tactics,
  broader hazards, sophisticated recovery and equipment policies remain.
- Movement now includes bounded obstacle-aware local flat-ground routes, not
  general navigation, stairs, jumps or long-distance gathering.
- Gathering has bounded component tools, not a complete autonomous supply chain.
  Crafting covers a starter subset, not full recipes, smelting or food production.
- Needs are advisory thresholds, not learned motivations. Resource memory is a
  sparse sighting index, not a complete terrain/resource map or ownership model.
- Typed single actions, bounded ephemeral plans and persistent supply intentions
  exist. Broader long-horizon goals, learned skills and recovery/replanning
  orchestration remain incomplete. Action sequences do not resume automatically.
- Two starter profiles exist. The requested larger population, social coordination
  and genuinely interacting civilizations are not yet implemented.

## Not implemented

- Soil preparation, sustainable harvest/pickup/seed-reservation loops, growing
  management, cooking and complete food-production systems; wider building and
  settlement skills. Separate harvesting and planting/replanting skills now exist.
- Relationships, trust/reputation, social roles and durable interpersonal memory.
- Resource accounting, trade, economies, institutions and diplomacy.
- Multi-civilization emergence and end-to-end acceptance of the full platform.

## Verification and working agreement

V0.2.12 baseline: 352 tests passed on Ubuntu/Windows with Node 22/24. V0.2.13
verification of crop planting/replanting is recorded in
[V0.2.13.md](V0.2.13.md). These are automated/simulated and pinned API-contract tests,
not a live Minecraft or real cloud-provider validation claim.

Continue implementing coherent versions, test each, fix discovered issues and push
without approval checkpoints. Do not start live testing yet. Reach a substantially
more mature implementation before the agreed live-test/fix phase. The suggested
GitHub-disconnection networking workaround remains unverified. No exact overall
completion percentage is asserted.

## Direction correction

Autonomy is the target, not manually managed activity rectangles. In a dedicated
agent world the user establishes operating policy once; agents choose actions
and locations within their current skills. Safety determines HOW, not manual
approval of WHAT. Per-area policy remains an optional shared-server safeguard.
No fixed civilization story or hard-coded life progression is introduced.
