# dsh-perf-hud

> **Client-side performance HUD**: a floating panel in the bottom-right corner that answers one question —
> *is it janky right now, and whose fault is it?*
> Frames & worst frame · long tasks (with four-leg attribution) · per-plugin callback rate and sync time ·
> DOM growth and writers · JS heap · host event loop & link RTT · an isolation experiment that disables
> plugins one at a time · one-click JSON export · an always-on night-watch recorder that keeps the
> worst few stalls with a full evidence pack.

<p>
<img alt="status" src="https://img.shields.io/badge/status-v0.6.0%20%C2%B7%20released-green" />
<img alt="license" src="https://img.shields.io/badge/license-MIT-blue" />
<img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.1--rc.1-4d6bfe" />
</p>

> ✅ **v0.6.0 is on npm** — install with `dsh plugin --profile web add dsh-perf-hud` (release gates and
> open debts: [REVIEW.md](REVIEW.md)).
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
- **"how often it happened" and "how many scenes were kept" are two different numbers** (product plan §3.A): the
  retention list is capacity-limited, so **its length cannot answer "how many stalls lately"** — a stall pushed out
  was still a stall. So there is a separate lightweight counter: one bucket per minute kept for the last 24 hours,
  plus a 30-day daily rollup, persisted across reloads. Three names, all spelled out in the panel's hover:
  - **seen = triggered** — how many captures were started. One stall is usually a burst of triggers, and **the whole
    burst counts once**; the triggers merged into the same pending capture (or falling inside an already-covered
    window) are **not** a new one;
  - **merged triggers (coalesced)** — how many triggers were merged into that burst. It is a **density, not a
    count**: adding the two together turns a single stall into a dozen (measured on a real page: a 3-second
    post-window triggers on every frame);
  - **evidence kept = the length of the retention list** — capacity-limited (worst 10 + one per day), **not** the
    number of stalls;
  - **lost = (triggered − captured) + dropped + trimmed + failed** — captures that never became a scene / captured
    but not worth keeping / dropped by the byte cap / failed to persist; listed separately, never folded into "seen".
  The collapsed pill's `seen N` cell is the **last 24 hours** (persisted), not the retention count.
- multi-second "gaps" from a hidden tab are **not** stalls (rAF was suspended) and are marked `gap`;
- `__perfHud.watch()` · `incidents()` · `report(0)` · `exportIncident(0)` · `capture(note)` · `clearIncidents()` ·
  `tally(ms?)` · `tallyOfDay(day)` · `clearTally()`.

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

## 🧭 Division of labour with DSH's built-in developer tools

DSH ships an experimental **Developer Tools** bundle (official group in the plugin manager: `NodeJS Inspector` / `Session data inspector`). It is a **foreground microscope**: breakpoints, Host console, network capture, raw session logs and the Cordis tree. This plugin is a **dashcam**: always-on, records frames / LoAF / event timing, and hands you an incident pack afterwards.

| Question | Use |
|---|---|
| Why is it slow right now / breakpoints / network / session log / Cordis tree | Developer Tools |
| How slow was that stall, who did it, can I review it afterwards | this plugin |

They do not depend on each other. Developer Tools' Performance panel profiles the **Host CPU only**; on the Client side it offers Console evaluation and read-only Sources, **not a page rendering trace or frame data**. So this plugin's `devtools-trace` gap stays honest — installing Developer Tools does not close it. It also captures **every Host fetch, secrets included**, while this plugin's exports are redacted by subtraction; the two data models are deliberately separate.

Shortcut: `Cmd/Ctrl+Shift+U` expands or collapses the HUD (macOS / Windows; Linux web does not allow this combination, so it is unbound; toggling does not steal focus from the composer).

## Install

From npm:

```sh
dsh plugin --profile web add dsh-perf-hud
```

The npm install follows `latest`. dsh-plugin.market also prints a `github:…/dsh-perf-hud#<40-char sha>` command — that pins the exact commit the scanner looked at (so the installed code matches the evidence); it is not the everyday install path. To pin a release from GitHub without pasting a sha, use a tag:

```sh
dsh plugin --profile web add github:yanzhaohui1999/dsh-perf-hud#v0.6.0
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

## 🧭 Interface structure (scheme 1: full-screen views)

The panel has **four views**, one at a time (only the view name is persisted, never any reading):

| View | For | Answers |
|---|---|---|
| **Overview** (default) | everyday users | Is it smooth right now / how long was the last stall and when / what might have caused it (each candidate with its **support and limits**) / how many stalls in the last hour or 24 hours and whether a lead repeats; the two primary actions are "view this stall" and "export the diagnostic report" |
| **Stall detail** | looking at that one stall | Its own screen with a back arrow ("←", hover says "back to the overview"); **the conclusion layer only** — window scope, attribution state, the real timeline with its navigation (◀ prev / next ▶ plus an "only bad" filter) and the two actions for this incident (copy summary / export pack). **All technical readings sit in a collapsed "technical details" group** (frame breakdown / script split / overlapping long tasks / suspect scripts / package × source / definitions); the data still comes from **its own** incident pack |
| **Developer details** | developers | 5 tabs: **Frames & blame** / **DOM & heap** / **Host & link** / **Toolbox** / **Raw data** — nothing was removed, it moved from one long screen with folded groups into one group per tab (the "deep" switch lives in this screen's title bar and in Settings) |
| **Settings** | everyone | Capture mode (night watch always on / deep recording explicit), retention policy, privacy and redaction |

The default screen never shows LoAF / p99 / RTT / package rankings / frame indices — those live in developer details. Collapsed, it is the pill in the bottom-right corner (fps / worst frame / stalls detected in the last 24 hours); expanding it returns to the overview.

### The four views at a glance

| **Overview** (default) | **Stall detail** | **Settings** |
|---|---|---|
| <img src="docs/images/01-main.png" width="330"> | <img src="docs/images/08-incident.png" width="330"> | <img src="docs/images/07-settings.png" width="330"> |

The five tabs of **developer details** (nothing was removed, it is just split into tabs):

| **Frames & blame** | **DOM & heap** | **Host & link** |
|---|---|---|
| <img src="docs/images/02-dev-frames.png" width="330"> | <img src="docs/images/03-dev-dom.png" width="330"> | <img src="docs/images/04-dev-host.png" width="330"> |

| **Toolbox** | **Raw data** | Collapsed it is the bottom-right **pill** |
|---|---|---|
| <img src="docs/images/05-dev-tools.png" width="330"> | <img src="docs/images/06-dev-raw.png" width="330"> | <img src="docs/images/09-pill.png" width="330"> |

### How to reach each screen

1. **Expand** the pill with `+` → the **overview** (the pill shows fps / worst frame / stalls detected in the last 24 hours);
2. **That one stall**: "view this stall" → **stall detail** ("←" returns to the overview);
3. **Technical data**: "developer details" at the bottom → five tabs; the "settings" button in the header → settings;
4. **Hand it to an AI**: "export diagnostic report" → a **preview card** first (four files + zip size + "notes: blanked") → "generate and export" downloads **one zip**;
5. **Local debugging**: developer details · raw data has "full technical export (keeps notes)" — that one **keeps** the notes you typed, it is not redacted, so do not hand it out as-is.

> Screenshots are generated by `node tools/shots.mjs` (each shot pins the view state and reloads, so images map 1:1 to
> the code; re-run to refresh them all). They live in `docs/images/` and are **not** in `package.json#files`, so they are
> GitHub-only (the npm page will show them broken until they are added to the whitelist).

## Reading the panel

> ⚠️ The line-level notes below describe the blocks inside **developer details** (see the interface structure
> section above). The default screen is the **overview**: current status / most recent stall / possible cause /
> recent trend plus two primary actions — no package names, frame indices, LoAF, p99 or RTT. Screenshots and
> step-by-step instructions come after the new UI passes real-device acceptance.

The plugin has **three tiers**, and the default is the cheapest one — it measures other people's performance,
so it has to be cheap, switchable and reversible itself:

| Tier | When | What it does | Cost |
|---|---|---|---|
| **Night watch** (default) | always on | per-frame ring buffer + LoAF observer + interaction timing; keeps the worst 10 stalls plus one worst-per-day | **zero instrumentation**: only the rAF loop that is already running and two `PerformanceObserver`s; patches nothing |
| **Live view** | you open the panel | overview / worst event / top-3 callback attribution / the night-watch line; the other five groups collapse | **the same tier as night watch** — opening the panel does not change what is measured |
| **Deep record** | the "deep" switch in the Developer-details tab row / Settings | only then are `setTimeout` / `setInterval` / `rAF` and the DOM-write hooks wrapped, and the 12MB combo sourcemap is fetched (precise attribution) | has a cost and must be turned on explicitly; switching it off restores the natives immediately |

The panel is layered: only "is it smooth + whose fault" is always visible; the other **five** groups
(forensics / technical details / pkg × source / DOM & heap / host & link / toolbox — "pkg × source" is nested inside
"forensics") start collapsed, each with a one-line summary in its header. Collapsed groups are **genuinely
lazy**: `group()` accepts a function as its children, so while collapsed not even the function body runs —
the derived statistics in "forensics" (per-package scripts / cross table / frame strip) are not recomputed
every tick.

| Reading | Definition (the same text is in the panel's hover tooltips) |
|---|---|
| **FPS / worst frame** | Its own rAF loop, 1s rolling window. Combined colouring: FPS ≤50 or worst frame ≥120ms → yellow; ≤30 or ≥200ms → red |
| **Long tasks** | `PerformanceObserver({entryTypes:['longtask']})` over the last 60s; hit ratio = long tasks with a name from any leg / total |
| **Unattributed per frame** | The part of the frame gap not explained by instrumented callbacks (style recalc, paint, vsync wait). **CSS animations only show up here** — they never touch the JS scheduler |
| **frame N/M ◀ ▶ ⟲** | Which long animation frame the panel is looking at: out of the last 200, those with **frame duration ≥ 100ms**. Both the filter and the ranking use `frameSeverity = max(blocking, frame duration)` (the same line the night watch triggers on; borderline frames below it never enter the list, and when nothing reaches it the list falls back to all), worst first — **blocking is only a supplement**: ranking by blocking alone would put a 92ms frame ahead of a 300ms one. Auto follows the worst (it does not change unless something worse arrives); picking pins it, ⟲ returns to auto; a pinned frame falls back once it leaves the 200-frame ring |
| **Worst event** (first screen) | The worst incident the night watch kept, **ranked by severity, not by time** ("worst" is not "latest"). Title row `id · cause · wall-clock time`; the value has **three states**: not recording → `not recording`, nothing caught yet → `nothing caught yet (≥100ms)` (the threshold lives on this row), incident present → **severity as text *and* token colour** (`≥200ms` severe / `≥100ms` warning, the same line the panel's colouring uses) + milliseconds + `auto · worst` / `auto · latest` / `selected` (a "latest / worst" toggle on the right of the title row switches which one auto follows and clears the manual pick); then whether there is **JS evidence**, the **main owner** (the top package-aggregate first, else `topScripts[0].pkg`, else "unblamed"), and the **window row** (frames / LoAF entries / package coverage `resolved/total`, with its denominator). The sub-line under it **only** reports "restored / trimmed / persist failed" — never repeats "nothing caught yet". The button here only performs a **context switch**: on the live side it is **View this frame** = switch to the **incident** context: select it + expand "forensics" + select the **worst frame** of that incident (frames, breakdown and evidence all come from the frames the incident pack **itself stored**, so a cross-session incident is just as replayable frame by frame; it says so honestly when the pack holds no frame records); once you are already in the incident context the same spot offers **Back to live**. "Export incident pack / Copy summary" are **not** here — they are what you do *with* the incident and belong to the Stall-detail screen's own action row (a self-describing handoff: verdict + definitions + the "suspect scripts" evidence lines (up to 4, the same lines as the panel, built from the **stored capture-time location** so they are still there after a reload) + "interactions ≥100ms in the window" (end-to-end only, explicitly not a frame breakdown) + what is missing, so someone else can keep digging; the full JSON is the incident pack) |
| **Toolbox incident list** | The list is **severity-ordered and clickable**: the selected entry is prefixed `●` and bold, and clicking one moves the first-screen "worst event" block and switches the forensics block to the **incident** context (selecting that incident's worst frame; one shared selection context, storing the **incident id** rather than an index; a selection pushed out of the retained list falls back to auto). Two layout buttons sit under it, and each **only appears when it means something**: **Collapse all** (only while some group is open; collapses every group, leaving the frame pick and the incident selection alone) and **Reset layout** (only when the layout/context differs from the default — a group open, a pinned frame, a hand-picked incident, auto scope not "worst", or a one-shot note showing; all groups collapsed + frame pick back to auto + incident selection back to auto, plus it clears the two one-shot notes "copied / copy failed" and "could not locate a frame"); when neither applies the whole row is not rendered |
| **Where the frame went** (donut, exactly 4 arcs) | The worst long animation frame split by LoAF's three timestamps: script (red) / the unattributed rest of the task (neutral grey) / render (rAF callback, orange) / style+layout+paint (blue). The donut carries **one** dimension only: where the frame's time went. Arcs are separated by a 1.4px gap (slices too small to afford it keep their full length). **Paint and compositing cannot be separated** — that needs a Chrome trace — so the last slice is "everything else", **not** a style-layout percentage |
| **Script split** | Script time split into exec / forced style+layout / paused; **the three sum to script time** (partitions, not additions). "this frame" is the same frame as the donut above, "window" aggregates the last 200 LoAF entries — same definition, **two denominators** |
| **The window sub-heading** | `window: N long frames · over T · avg script per frame Xms`. The three window rows are a **cumulative** sum (script time across 200 long frames), not the duration of any frame; a longer span means a bigger total, so do not read it as "getting slower". **Only the per-frame average is comparable to the donut** |
| **By source / By package** (two 100% stacked bars) | The same script time sliced two ways, each a full-width bar: the line above it still gives names + milliseconds (absolute values), the bar gives the shares (top 3 + rest, width = share within that dimension). Hover a segment for `name ms · share`. Sources are blue, packages green. Each **named** row of the little table is **clickable** — it copies "name + milliseconds" to the clipboard and reports honestly either way (`copied` / `copy failed: <message>`); the **bar segments themselves are not clickable** (they used to show a pointer with no behaviour at all — a fake button, now removed). **Hover linkage is disabled and its helper code has been deleted** (see "Risks and boundaries" item 9) |
| **pkg × source · window** (collapsed by default) | The two dimensions **crossed**: rows = package (or "other source"), columns = invoker, cells = milliseconds (hover for the share). Only top 3 × top 3 is expanded, the rest is folded into a "rest" row/column by subtraction, and the four blocks add up to the script total. The group title states the scope is the **window**, and its hint says this is the **cumulative** total of the last 200 long animation frames (the same data as the two "· window" rows above) — **not a single frame**. It answers "**which of this package's callbacks** is burning the time" — two separate leaderboards never can |
| **Suspect scripts** (inside "forensics") | Lands the chain "**incident → frame → invoker → package → file / line**" on **individual scripts**: the blocks above answer "which package / which kind of call burned the time" (ranking), this one answers "**which file, which function**" (locating). Up to **4** rows by descending cost, and **only locatable rows** are listed (at least one of function name / package / file — a lone line number does **not** count: in a combo batch it says nothing about which package owns it; a row with no locator at all no longer takes a slot); each row is `<function> @ <package>` + milliseconds, its hover gives the full evidence line, and **clicking the row copies** "function @ package · file(:line) · cost · invoker" to the clipboard (reported honestly either way). ⚠️ **A combo batch never joins the two into `file:line`**: there the line number belongs to the **merged big file** while the file only answers "which package owns this code" — two different coordinate systems, so it is shown as `file · line in merged script 25580` (the line is a separate field, saying it only holds inside the merged script). The scope is in the title: **incident first** (`suspect scripts · incident i84 · in window` — the incident's scripts are the in-window slice, at most 5, and **still there after a reload**: their package / file / line are the locations **stored in the pack at capture time**, not recomputed, so a reload or switching deep recording off cannot turn them into `null`), falling back to `suspect scripts · this frame` only when there is no incident script. The bottom line gives **only the denominator plus a hover hint** (`11 scripts · named 1/11 · hover for scope & gaps` — the denominator counts **all** scripts, not just the rows shown, so "nothing named" is never hidden); the full definition and what is missing live in the **hover** (`evidenceFooterTitle`, the same wording as "Copy summary") — the panel renders plain text, not markdown, so `**` and backticks in the body would only be noise. When nothing is locatable at all the block collapses to one line `suspect scripts: 0 named (11 scripts in window) · needs deep`, with the same hover for scope and gaps |
| **Suspect scripts: three tiers of definiteness** | ① **Measured**: the function name (`sourceFunctionName`) and milliseconds (`duration`) come from LoAF itself. ② **Inferred**: the package / file path / line are **inferred** from the URL and the sourcemap sections (hover a row to see which: read directly / inferred from sections / not a plugin script / resolution failed / not there yet). ③ **Unavailable**: the original-source (TS/TSX) line, the call stack and function-level cost — none of these can be obtained. ⚠️ **The line is a line in the script text itself** (single-package URL = that file; combo batch = the merged big file), **not an original-source line** — that would need the inner section `mappings` (VLQ), which this project does not do. So this layer narrows things to "which package, which file, which region", it **cannot point at a root cause**. **File and line need deep recording**: by default (uninstrumented) a combo batch's package cannot be resolved, so the block honestly says "needs deep". **The function name is often missing** — LoAF frequently omits `sourceFunctionName` in merged/minified scripts, and the panel writes "no function name" rather than inventing one. **On the incident side the location is the one stored at capture time**: the panel and "Copy summary" build those evidence lines with the **same function**, so "it is on the panel but not in the copy" cannot happen; only an old pack (captured before `file` / `line` / `lineVia` / `invoker` existed) falls back to recomputing — which needs the current session's precise attribution and in-memory script text / section cache, both empty after a reload, which is exactly why the stored copy must win |
| **By source** (one row per scope) | Script time grouped by **LoAF's `invoker`**: what invoked the script (`setTimeout` / rAF, an event handler such as `DOMWebSocket.onmessage`, a promise callback, a script load). It covers every script, so its total equals script time, while "by package" only covers scripts whose package resolved — **the two totals are not meant to match**. `SCRIPT[…]` collapses to `script`, a `:` takes the last segment (`TimerHandler:setTimeout` → `setTimeout`), and a missing invoker falls back to `invokerType`. It answers "which kind of call", **not** "which function inside is slow" — that needs a Chrome trace; there is no in-page sampler |
| **Callback attribution (time · lower bound)** | This block is **always on the first screen**: without "deep" it is a single row — label `attribution (time · lower bound)`, value `needs deep` (the top-3 and "rest (N)" rows are not rendered, and it **never writes `0ms/s`**, which would read as "no cost"); once instrumented it gives `x/s · peak y/s` (EMA α=0.4 execution rate / single-second maximum), and only then is `0ms/s` real (no callback did run). Hover shows that second's sync time and the cumulative `N× / Xms`. **A lower bound**: only callbacks scheduled via `setTimeout` / `setInterval` / `rAF` — event handlers, Promises, microtasks and React's own scheduling are not counted |
| **DOM writes** (in the "DOM & heap" group) | Exact total plus per-writer `≈` estimates (one stack sample every 10th write, hits scaled by 10); **hidden unless deep recording is on** (the count is always 0 and it would read as "no cost"). **The HUD's own writes are not counted**. It moved from "forensics" to "DOM & heap": writers belong to the DOM, not to "where this frame's time went" |
| **Host event loop** | `perf_hooks.monitorEventLoopDelay({resolution: 1})`, per-second **p50 / p99 / max all three given** — p99 alone hides an occasional multi-second stall (max is "how long the worst one lasted"); the host half samples once a second with a 300s ring. An older host half without the `max` field is reported honestly as p50/p99 only |
| **Host event arrival** | Commit (`event.time`) → listener invocation lag via the public `ctx.on('session/event')`; not the listener's CPU time |
| **Link RTT** | 1KB cache-busted same-origin probe every 10s, 64KB throughput every 60s. "Link suspected" needs p99 > 300ms, normal FPS and n ≥ 2 |
| **60s frame strip** (first item in the forensics group) | A full-width block (≈365px, ≈6px per cell), one bar per second, height = the worst frame interval in that second, colours use the **same thresholds as the ASCII frame strip in the export** (≥100ms red / ≥50ms yellow). Each cell's hover gives the wall-clock time + that second's worst frame + **whether it is clickable**: only cells where that second **really has a long animation frame** (present in the LoAF ring) can be clicked, and clicking moves the frame picker to that frame; cells that cannot be clicked are given no pointer cursor and say so in the title. A second that was all rAF suspension is the shortest grey bar — a gap, not a stall |
| **Two diagnostic contexts** (the **only** switching point of the forensics block) | The panel serves exactly one context at a time: **live** (the current frame in the live ring) or **incident** (one history frame of the selected incident). Enter the incident context with "Show frame" on the incident card or by clicking an incident in the toolbox list; go back with "Back to live". Switching only switches the data source — live capture and the other side's selection are untouched, and switching back restores them. Which context you are in is written in the first line of the detail area (`live · current frame` / `incident i12 · history frame 3/305`) and the collapsed group title carries the incident id. **A reload keeps you on the same frame of the same incident** (the context is persisted; a missing incident or frame falls back to auto). The two contexts **share components but never share data**: the incident side reads only `incident.frames` / `incident.loaf` / `longTasks`. |
| **Incident replay · history frame timeline** (in the incident context) | Draws the **selected incident's** captured window as a **clickable** frame timeline, labelled with which incident and how long it spans (e.g. `incident replay · i84 · 13s`). Its data comes **entirely from the incident pack** (`incident.frames` / `incident.loaf` / `summary` / `longTasks` / `urls`), so it **survives a reload** and adds **zero collection cost**; it is deliberately kept separate from the **live** 60s strip (each states its own scope, and the incident side never reads the live frame ring). The x axis is **time**, split into at most 240 columns, **each column keeping the worst frame in it** (spikes are never averaged away) and holding a reference to that frame — a click always selects a frame that **really exists** in `incident.frames` (asserted: every non-empty cell's frame is in the array), and stretches where rAF was suspended or sampling was lost stay blank (nothing is fabricated). The levels use the **same function** `sparkLevel` and the same theme tokens as the live strip. The selected frame is a blue marker line, with its level and **two arrows plus one filter** (prev-next frame in **time** order; the **"only bad"** filter restricts the step to frames whose interval is at or over the night-watch trigger — it is a navigation filter, not a second pair of arrows; buttons are **disabled** when there is nothing to step to). Frame index and duration are printed once, in the context title above. Selecting a frame updates the whole forensics block **for that frame**: the same four-way split (script / task / render / style+layout+paint, summing to that frame's duration), the **long tasks** overlapping it, and **that frame's script evidence** (stored capture-time locations, so it still resolves after a reload). A **scope** row (span / frames / p50 / p99 / worst frame / gaps) and a **scope footnote** (this is the captured stretch, not now) close the block. A reload restores the same incident **and** the same selected frame; "Back to live" restores the live strip and the live readings. ⚠️ Real limits: it **does not order execution within a frame** (LoAF gives no per-script start/end) and there is **no complete function-level timeline**; the panel only shows the fields the pack already stored, and the raw/detailed data still goes through "Export incident" + `tools/inspect-incident.mjs`. It lives in the "forensics" group and is **not computed while the group is collapsed**; **a cross-session incident can still be replayed frame by frame** (the data is in the pack) |
| **By package** (one row per scope; "other sources" included) | Script time summed **per package** (the same resolve path as the export's `incident.packages`). "this frame" is the same frame as the donut; "window" aggregates the last 200 LoAF entries — they are labelled so the two denominators are never cross-checked. Without deep recording (precise attribution) a combo batch can only be named by its 58-package URL — deliberate, nothing is guessed. The "this frame" and "window" rows use **two different hints** (the "this frame" one talks about that frame only and no longer mislabels itself as the window). When nothing resolves at all, the "by package" bar is neither blank nor a "0 resolved" line: it is fed `whoRows(tally)`, so you see the **cause-named "other sources" segments with name and milliseconds** — `plugin batch (not split by sourcemap)` / `no URL (inline script)` / the shell bundle's filename |
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
7. Panel state lives in `localStorage`; exports are generated locally and sent nowhere — and **every export is
   redacted first** (see the next item).
8. **Exports are redacted, and the file states exactly what was removed**: an export is meant to be read by people
   and handed to an external AI, so `snapshot()` / `report(id)` — (a) keep only `origin + path` for the page URL and
   **drop the query string entirely** (DSH opens as `http://127.0.0.1:3080/?token=…`, so that is where credentials
   live); (b) strip scheme and host from script URLs while keeping the path and `rev`, and replace the **value** of
   `token` / `api_key` / `secret` / `password` / `signature` / `code` and friends with `<redacted>` (keys stay, so a
   reader can see what used to be there); (c) turn `/Users/<name>`, `/home/<name>` and `C:\Users\<name>` into `~`;
   (d) reduce `userAgent` to browser major version + OS. The file's `context.redaction` lists `applied` / `kept` /
   `neverCollected` (chat text, prompts, cookies, tokens and request headers are never collected at all). **This is
   subtraction, not anonymisation** — do not treat an export as anonymised data. Free text you typed yourself (the
   incident `note`, scene marks) is kept in the local raw export; the AI diagnostic pack
   (`report(id, { dropFreeText: true })`) blanks them and marks `noteDropped: true`.
9. **If your browser is on another machine, a high "link RTT" is real**: over a tunnel to `127.0.0.1:3080` the
   tunnel's own RTT p50 can be tens to hundreds of milliseconds while `curl` on the host takes a few. That is why
   the panel has a "link suspected" verdict and an explicit "link ruled out (host and tunnel both normal)" line —
   the number is not a bug.
10. **Host snapshots go stale; an incident window can be incomplete.** Host data arrives every 10s; after 25s it is
    labelled "stale" and the verdict is downgraded, and with zero samples the panel never says "link ruled out".
    `incident.integrity.captureComplete=false` means the capture itself dropped records (ring overflow or the
    pre-window rolled out), and `manifest.complete` is `false` too — the file is still readable, but it is not the
    complete 13 seconds; `hiddenGaps` is separate (rAF suspension, not data loss).
11. **All three hover linkages stay disabled, and their helper code has been deleted** (donut ↔ by-source/by-package
   stacked bars ↔ cross table): the 2026-10-08 symptom was that moving a real mouse over the cross table's row
   labels made the **shell deactivate the whole panel entry** (the panel disappears, with `errors` empty,
   `window.onerror` silent and `__perfHud.enabled` still `true`) — it does **not** go through our own error
   boundary, so we cannot even get the original error text; on 2026-10-11 it **could not be reproduced on the
   current code**: a real mouse swept across **163** elements inside the cross table (plus **153** JS-dispatched
   `mouseover` events), the entry stayed alive, `errors: 0`, the ring was unchanged and the console was silent —
   so we can neither prove the root cause nor prove it is fixed. It therefore **stays disabled**, and the helper
   code (`hot` / `setHot` / `hotProps` / `hotStyle` and every `hot === …`) has been **deleted outright**, leaving
   no half-live dead code. **Click interactions are unaffected** (list selection, copying, frame-strip clicks and
   collapsing have all been verified).

## 📦 Diagnostic pack (readable by people and by AI)

`__perfHud.pack(id)` turns one incident into **four files** (nothing downloads; `preview(id)` returns only the
manifest, `exportPack(id)` downloads **a single store-only zip** containing all four):

| File | What it is |
|---|---|
| `manifest.json` | Entry point: format version, platform, capture tier, the **capability matrix** (which layer was captured, which was not, why, and its provenance), the redaction note, and what is **not** included |
| `summary.md` | Human digest in a fixed five-part shape: summary → most likely hypotheses (each with **support / limits / provenance**) → missing evidence → how to verify next → meta |
| `incident.json` | Structured raw evidence (the same document as the panel's "export incident") |
| `README.md` | What the pack is, how to read it, and the privacy stance |

Three calibers, asserted in the offline suites as well:

- **A candidate cause is not a culprit**: candidates come from fields that were actually captured (script time per
  package / long-task attribution / host event loop); each carries `limits`, and those limits always include
  "this only narrows it down, it does not locate the root cause". With no JS blocking evidence the verdict is
  "not enough evidence" — throttling is only suggested when `suspectedThrottle` actually holds.
- **Provenance in three buckets**: `measured` / `inferred` (URL, sourcemap sections, time overlap, sampling
  extrapolation) / `unknown`. Every capability leaf and every candidate is tagged.
- **Missing evidence says why**: `capabilityMissing()` is derived from the capability matrix (not a hand-written
  chain of `if`s), so "why was this not captured" has exactly one source.

The pack is built by **pure functions** (`buildPack` / `manifestFor` / `diagnosticSummary`) with no DOM dependency, so
the offline suites assert its shape directly — a future UI rewrite or MCP server will not have to change it.

## Development

```sh
node tests/attribution.mjs   # 11 assertions: script URL shapes → package name / bundle key
node tests/logic.mjs         # 582 assertions: real functions extracted from client.js + static checks + length budgets
node tests/host.mjs          # 41 assertions: real index.js driven by a fake ctx
# 634 offline assertions total, no running DSH required
```

The i18n dictionary now has **402 keys per language** (the two dictionaries must have identical key sets, and every key must be referenced — keys left behind when a UI element is removed are reported by an assertion).

Live verification (exchange a cookie first, see [verification](docs/verification.md)):

```sh
DSH_COOKIE=… node tests/live-sourcemap.mjs   # real indexed sourcemap sections and package names
DSH_COOKIE=… node tests/live-host.mjs        # real route; exit code 3 = host half not loaded yet (restart needed)
```

Development rules, commit conventions and boundaries: [AGENTS.md](AGENTS.md); source-level attribution: [docs/mechanisms.md](docs/mechanisms.md); disproven dead ends: [docs/dead-ends.md](docs/dead-ends.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
