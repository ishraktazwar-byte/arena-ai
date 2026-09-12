# Arena AI — implementation progress

Updated for V0.2.8. This is a capability ledger, not a percentage or a promise that
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
- Typed single-action goals exist; reusable long-horizon plans, learned skills and
  resilient multi-step task orchestration are not complete.
- Two starter profiles exist. The requested larger population, social coordination
  and genuinely interacting civilizations are not yet implemented.

## Not implemented

- Farming/food-production systems and wider building/settlement skills.
- Relationships, trust/reputation, social roles and durable interpersonal memory.
- Resource accounting, trade, economies, institutions and diplomacy.
- Multi-civilization emergence and end-to-end acceptance of the full platform.

## Verification and working agreement

V0.2.8: 259 tests passed on Ubuntu/Windows with Node 22/24, including local-navigation
regressions; exact implementation and hosted CI proof are in
[V0.2.8.md](V0.2.8.md). These are automated/simulated and pinned API-contract tests,
not a live Minecraft or real cloud-provider validation claim.

Continue implementing coherent versions, test each, fix discovered issues and push
without approval checkpoints. Do not start live testing yet. Reach a substantially
more mature implementation before the agreed live-test/fix phase. The suggested
GitHub-disconnection networking workaround remains unverified. No exact overall
completion percentage is asserted.
