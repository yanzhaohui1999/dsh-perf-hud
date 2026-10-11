# dsh-perf-hud

> **Client-side performance HUD**: a floating panel in the bottom-right corner that answers one question —
> *is it janky right now, and whose fault is it?*
> Frames & worst frame · long tasks (with four-leg attribution) · per-plugin callback rate and sync time ·
> DOM growth and writers · JS heap · host event loop & link RTT · an isolation experiment that disables
> plugins one at a time · one-click JSON export · an always-on night-watch recorder that keeps the
> worst few stalls with a full evidence pack.

<p>
<img alt="status" src="https://img.shields.io/badge/status-unpublished-orange" />
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
<img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-4d6bfe" />
</p>

> ⚠️ **Not published to npm yet** (see [REVIEW.md](REVIEW.md)); for now install from a source checkout.
> Docs are maintained in Chinese — [README.md](README.md) is the primary version.

## Night watch: catching the stall you were not looking at

The panel requires you to watch it; intermittent stalls happen exactly when you are not. So the plugin
keeps a recorder on by default, and it patches nothing — it only uses the rAF loop that already runs plus
one `PerformanceObserver` (LoAF, Chrome 123+):

- a per-frame ring buffer (12000 frames ≈ 3.3 minutes at 60fps);
- any frame over **100ms** (or LoAF `blockingDuration` over 100ms) is captured automatically: the
  **10 seconds before** and 3 seconds after are sliced out verbatim;
- retention is the **union of two tiers**: the worst **10** overall plus **one worst-per-day** (at most the
  last 7 days, marked "daily worst" in the list) — ranking by global severity alone lets ten stalls in the
  same hour push yesterday's stall out entirely (measured: `captured 40 · dropped 38`);
- kept incidents are persisted (localStorage, 2MB cap) and survive a reload; `watch().restored` says how many came back;
- stalls that were captured but not good enough to keep are counted
  separately (`dropped`) from stalls never captured;
- multi-second "gaps" from a hidden tab are **not** stalls (rAF was suspended) and are marked `gap`;
- `__perfHud.watch()` · `incidents()` · `report(0)` · `exportIncident(0)` · `capture(note)` · `clearIncidents()`.

An incident pack carries `context.missing` — what this capture does **not** contain (no DevTools trace,
no host CPU profile, platforms without LoAF) and how to get it — and it does no attribution inference.

**Interaction latency** (`event` / `element` timing, only events ≥100ms) goes into the exports only, never the
panel: each record has the end-to-end `ms`, the derived `waitMs` (input delay) and `handlerMs` (the handler
itself), and `isInteraction` marks the real interactions (`interactionId > 0`). **No frame-internal breakdown is
promised** — splitting input delay / processing / presentation needs DevTools' Interactions track. `element`
timing only observes elements carrying the `elementtiming` attribute, which DSH's DOM never sets, so that leg is
**always 0** and is reported as 0 with the reason, never faked.

## What it answers

| Question | What the panel shows |
|---|---|
| Is it smooth right now? | FPS / worst frame / unattributed-per-frame, with a `streaming` or `idle Ns` label as the prerequisite for reading anything else |
| Who caused that stall? | Long-task rows plus four-leg attribution (component, package, DOM writer) |
| Which plugin is quietly busy? | Per-plugin callback rate (`/s`), peak rate, sync time; DOM write counts and writers |
| Is it a plugin, the host, or the link? | Host event-loop p50/p99/max and link RTT/throughput, with threshold colours and an explicit "link ruled out" verdict |
| Did disabling that plugin actually help? | The isolation experiment: 60s off, compared against its nearest baseline, with a noise floor |

## Install

Once published to npm:

```sh
dsh plugin --profile web add dsh-perf-hud
```

From a source checkout (development; `link:` install, client-half edits take effect on reload):

```sh
git clone <repo> && cd dsh-perf-hud
dsh plugin --profile web add "$PWD"
```

Refresh the page and the panel appears. Edits take effect as follows: `client.js` → reload (client HMR also
hot-loads it in dev), `index.js` → **restart the host**, `package.json`'s `dsh.*` → reinstall or restart.

The host half is **optional**: without it the panel still works, and the three host-dependent rows say
"unavailable" with a reason instead of pretending.

## Reading the panel

The plugin has **three tiers**, and the default is the cheapest one — it measures other people's performance,
so it has to be cheap, switchable and reversible itself:

| Tier | When | What it does | Cost |
|---|---|---|---|
| **Night watch** (default) | always on | per-frame ring buffer + LoAF observer + interaction timing; keeps the worst 10 stalls plus one worst-per-day | **zero instrumentation**: only the rAF loop that is already running and two `PerformanceObserver`s; patches nothing |
| **Live view** | you open the panel | overview / top-3 callback attribution / the night-watch line; the other four groups collapse | **the same tier as night watch** — opening the panel does not change what is measured |
| **Deep record** | you press "深录" (deep) | only then are `setTimeout` / `setInterval` / `rAF` and the DOM-write hooks wrapped, and the 12MB combo sourcemap is fetched (precise attribution) | has a cost and must be turned on explicitly; switching it off restores the natives immediately |

The panel is layered: only "is it smooth + whose fault" is always visible; the other four groups
(forensics / DOM & heap / host & link / toolbox) start collapsed, each with a one-line summary in its header.

| Reading | Definition (the same text is in the panel's hover tooltips) |
|---|---|
| **FPS / worst frame** | Its own rAF loop, 1s rolling window. Combined colouring: FPS ≤50 or worst frame ≥120ms → yellow; ≤30 or ≥200ms → red |
| **Long tasks** | `PerformanceObserver({entryTypes:['longtask']})` over the last 60s; hit ratio = long tasks with a name from any leg / total |
| **Unattributed per frame** | The part of the frame gap not explained by instrumented callbacks (style recalc, paint, vsync wait). **CSS animations only show up here** — they never touch the JS scheduler |
| **frame N/M ◀ ▶ ⟲** | Which long animation frame the panel is looking at: out of the last 200, only those with **blocking ≥ 100ms** (the same line the night watch triggers on; borderline frames below it never enter the list, and when nothing reaches it the list falls back to all), worst first. Auto follows the worst (it does not change unless something worse arrives); picking pins it, ⟲ returns to auto; a pinned frame falls back once it leaves the 200-frame ring |
| **Where the frame went** (donut, up to 7 arcs) | The worst long animation frame split by LoAF's three timestamps: script (split again by invoker into up to 4 pieces, one red family dark→light) / the unattributed rest of the task (neutral grey) / render (rAF callback) / style+layout+paint. Arcs are separated by a 1.4px gap (slices too small to afford it keep their full length). **Paint and compositing cannot be separated** — that needs a Chrome trace — so the last slice is "everything else", **not** a style-layout percentage |
| **Script split** | Script time split into exec / forced style+layout / paused; **the three sum to script time** (partitions, not additions). "this frame" is the same frame as the donut above, "window" aggregates the last 200 LoAF entries — same definition, **two denominators** |
| **The window sub-heading** | `window: N long frames · over T · avg script per frame Xms`. The three window rows are a **cumulative** sum (script time across 200 long frames), not the duration of any frame; a longer span means a bigger total, so do not read it as "getting slower". **Only the per-frame average is comparable to the donut** |
| **By source** (one row per scope) | Script time grouped by **LoAF's `invoker`**: what invoked the script (`setTimeout` / rAF, an event handler such as `DOMWebSocket.onmessage`, a promise callback, a script load). It covers every script, so its total equals script time, while "by package" only covers scripts whose package resolved — **the two totals are not meant to match**. `SCRIPT[…]` collapses to `script`, a `:` takes the last segment (`TimerHandler:setTimeout` → `setTimeout`), and a missing invoker falls back to `invokerType`. It answers "which kind of call", **not** "which function inside is slow" — that needs a Chrome trace; there is no in-page sampler |
| **Callback attribution** | `x/s · peak y/s`: EMA (α=0.4) execution rate / single-second maximum; hover shows that second's sync time and the cumulative `N× / Xms`. **A lower bound**: only callbacks scheduled via `setTimeout` / `setInterval` / `rAF` — event handlers, Promises, microtasks and React's own scheduling are not counted |
| **DOM writes** | Exact total plus per-writer `≈` estimates (one stack sample every 10th write, hits scaled by 10). **The HUD's own writes are not counted** |
| **Host event loop** | `perf_hooks.monitorEventLoopDelay({resolution: 1})`, per-second p50/p99/max, 300s ring |
| **Host event arrival** | Commit (`event.time`) → listener invocation lag via the public `ctx.on('session/event')`; not the listener's CPU time |
| **Link RTT** | 1KB cache-busted same-origin probe every 10s, 64KB throughput every 60s. "Link suspected" needs p99 > 300ms, normal FPS and n ≥ 2 |
| **60s frame strip** | In the forensics group: one bar per second, height = the worst frame interval in that second, colours use the **same thresholds as the ASCII frame strip in the export** (≥100ms red / ≥50ms yellow). A second that was all rAF suspension is the shortest grey bar — a gap, not a stall |
| **By package** (one row per scope; "other sources" included) | Script time summed **per package** (the same resolve path as the export's `incident.packages`). "this frame" is the same frame as the donut; "window" aggregates the last 200 LoAF entries — they are labelled so the two denominators are never cross-checked. Without deep recording (precise attribution) a combo batch can only be named by its 58-package URL — deliberate, nothing is guessed |
| **Recorder cost** | In the forensics group: this HUD times its own rAF callback every frame and reports p99 / max / samples over the last 600 frames. This is the measuring tool proving it does not visibly change what it measures — **not** the page's own cost |

**Export JSON** carries a `context` header: scenario / idle seconds / precise-attribution and per-sourcemap-section
state / host route, profile, Node and plugin version / experiment candidates and method / every colouring
threshold / a **cross-session baseline** (one p50/p90/p99/worst/frames/timestamp record per session, last 20 kept).
That list is export-only (the panel never shows it) and is labelled a **rough reference, not a regression verdict** —
sessions differ in load, viewport and whether instrumentation was on, and frame counts can differ by an order of
magnitude. `window.__perfHud.snapshot()` is the same source as the panel's export button.

## Four-leg attribution

Long tasks are attributed by four independent legs, and **when two disagree both are shown** — the pretty one
is not picked for you:

| Leg | Mechanism | Strength / limit |
|---|---|---|
| `fiber` | Walk **up** from the mutated node to the nearest named function component | Good for incremental updates; a whole subtree mounted at once only yields the container |
| `subtree` | Walk **down**, preferring `alternate === null` (React's "mounted this commit" marker) | Covers whole-subtree mounts; bounded BFS |
| `DOM write` | Sampled `appendChild` / `insertBefore` / `setAttribute` (1 in 10), stack captured at the write site | The workhorse when no plugin frame is on the commit stack; estimates are prefixed `≈` |
| `package` | Scheduler instrumentation (`setTimeout` / `setInterval` / `rAF`) overlapped with the long task | Timers and animations; event handlers, Promises and microtasks are **not** included |

The **precise attribution** toggle resolves individual package names from the merged bundle's indexed sourcemap
(lazy; one map fetch per rev).

## Isolation experiment

Each candidate plugin is disabled for 60s, measured, then restored and verified item by item. Every candidate is
compared only against its **nearest baseline** (A/B/A), baseline drift becomes the **noise floor**, and any Δ
below it is reported as "within noise". A window containing streaming is marked "not comparable" and gets **no
conclusion**.

Candidates are **derived from your own bundle list**, never hard-coded: community bundles that are enabled,
removable and not part of the official core — excluding this HUD itself — sorted by name, capped at 4 (each one
costs 90 seconds). If that list comes out empty the experiment says "no third-party plugin to compare against"
instead of running against names that are not installed.

All windows receive the same **synthetic load** (an 8ms burn every 250ms through the uninstrumented native
`setInterval` — CPU only, no DOM, so attribution tables stay clean); comparing idle windows means nothing.
What it measures is **fixed cost** (runaway timers, always-on animation, polling, observers) — not "this plugin
is expensive in some usage", so do not read it as a causal proof.

## Risks and boundaries (please read)

1. **On by default.** The panel shows up immediately and instruments globals: `setTimeout` / `setInterval` /
   `requestAnimationFrame`, plus `Node.prototype.appendChild` / `insertBefore` and `Element.prototype.setAttribute`
   (sampled 1 in 10).
2. **Fully reversible.** The panel's off switch / `window.__perfHud.disable()` restores the native prototypes — and
   only when the current value is still its own wrapper, so it never clobbers someone else's instrumentation.
3. **The isolation experiment temporarily writes your profile's persisted bundle selection**
   (`pluginManager.setBundleEnabled`). It has hard guardrails: `confirm` required, refuses to touch this plugin and
   `session-persistence-jsonl`, records the host's receipt for every step, verifies the restore item by item, and
   restores on abort too. If you would rather not touch config, don't press start.
4. **The host half does two things**: event-loop sampling and one HTTP route (`/api/dsh-perf-hud/host`, protected by
   the host's own auth — no cookie means 401). It registers no services, patches no host prototypes and persists no
   state of its own.
5. **CSS animations are invisible to attribution** — they only appear in FPS / worst frame / unattributed-per-frame.
6. **Hit ratio is inflated by the DOM leg** (streaming almost always produces writes), so always read it together
   with the attribution distribution. The recorder itself is inside the legs' reach too: long tasks attributed to
   this HUD (`PerfHud` / `PerfHudStress` / the package name) are tagged "recorder itself" and listed
   **separately** from the attribution top — it only becomes the culprit when no other candidate explains the task
   (silently dropping it would read as "nothing was working", which is worse than tagging).
7. Panel state lives in `localStorage`; exports are generated locally and sent nowhere.
8. **If your browser is on another machine, a high "link RTT" is real**: over a tunnel to `127.0.0.1:3080` the
   tunnel's own RTT p50 can be tens to hundreds of milliseconds while `curl` on the host takes a few. That is why
   the panel has a "link suspected" verdict and an explicit "link ruled out (host and tunnel both normal)" line —
   the number is not a bug.

## Development

```sh
node tests/attribution.mjs   # 11 assertions: script URL shapes → package name / bundle key
node tests/logic.mjs         # 319 assertions: real functions extracted from client.js + static checks + length budgets
node tests/host.mjs          # 39 assertions: real index.js driven by a fake ctx
# 358 offline assertions total, no running DSH required
```

Live verification (exchange a cookie first, see [AGENTS.md](AGENTS.md) §2.2):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # real indexed sourcemap sections and package names
DSH_COOKIE=… node tests/live-host.mjs        # real route; exit code 3 = host half not loaded yet (restart needed)
```

Development rules, commit conventions, the source-level attribution mechanism and disproven dead ends: [AGENTS.md](AGENTS.md) (§6 mechanism / §8 traps). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
