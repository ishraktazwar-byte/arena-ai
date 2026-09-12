# Arena AI

Minecraft civilization experiment. **V0.1.2 — bounded ground escape and basic eating (offline-tested).**

LLM chooses goals; the local body executes them safely. This release has basic automatic eating, emergency interruption, and conservative
one-block ground escape. It has no LLM, combat, reconnect loop, or idle-shutdown avoidance.
Do not leave these agents unattended in survival mode yet.

## Windows CMD setup

Node 24 is the deployment target; Node >=22 is supported by the dependencies.

```bat
cd /d E:\agents\mc-agents-main
npm ci
copy .env.example .env
notepad .env
npm run check
npm test
node bot.js alice
```

Set `MC_AUTH` explicitly. Use `microsoft` for authenticated accounts and set
`MC_USERNAME` locally. Follow the authentication library's device login flow on
your own machine; never share login codes or token caches. Each simultaneous
online-mode bot needs its own authorized account. For Bob in a second CMD window,
set that account's `MC_USERNAME` in the window before launching `node bot.js bob`.
Use `offline` only when the server owner has explicitly configured and permitted
that mode. Do not change server authentication just to bypass account requirements.

Profiles: `agents/alice.json`, `agents/bob.json`. Offline mode uses profile names;
Microsoft mode uses the authenticated account's Minecraft identity.

Commands: `status`, `step`, `stop`, `quit`. `step` is a single 250ms forward input
for an operator-supervised test on clear, flat ground. It does NOT avoid cliffs,
lava, or enemies. There is no recurring movement or anti-idle behavior.

Secrets belong only in local `.env`; token caches belong in ignored `runtime/`.
Never distribute either in ZIPs. Run from the project directory.

## Validation

`npm run check` checks syntax. `npm test` covers configuration, action ownership,
preemption, timeout, stale callbacks, cleanup, and death/respawn behavior with a
simulated body. See `docs/V0.1.2.md` for current validation and limitations;
`docs/V0.1.0.md` records the unresolved live connection issue.

Ground escape requires known, flat, full-block support and a safer adjacent step.
It does **not** escape lava or drowning and is not guaranteed to outrun a creeper.
Unknown or unsafe terrain causes a halt. Stay supervised.
