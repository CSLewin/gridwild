# Heat tile rendering: SVG → Canvas

## Headline

P95 of total main-thread blocking time per pan dropped **44.4%**
(762.65 ms → 424.2 ms) under the stress condition that reproduces
the user-reported lag. Post-pan blocking time fell to zero.

| metric | baseline (3×30 trials) | canvas fix (30 trials) | change |
|---|---:|---:|---:|
| P95 trace-total longtask ms | 762.65 | 424.2 | **−44.4%** |
| Post-pan longtask ms (mean) | 89.6 | 0.0 | **−100%** |
| Heat-pane SVG nodes | 2526 | 0 | n/a (canvas) |
| Wallclock per pan, P95 (ms) | 3260 | 2946 | −9.6% |

Ship gate was max(30%, 3σ); 3σ = 18.98%; threshold = 30%.
Measured improvement (44.4%) exceeds it cleanly.

## What changed

One additive line in `js/initgrid.js`:

```js
const heatCanvas = L.canvas({ pane: "gridHeatPane", padding: 0.1 });
```

Plus passing it as `renderer: heatCanvas` inside `HEAT_TILE_STYLE_BASE`,
which already feeds every heat rectangle. No DOM restructure, no
behavior change in the fog logic, popup, or grid lines. `gridLineLayer`
stays SVG (only ever has one rectangle).

Why it works: the previous setup created 2526 individual `<path>`
elements per pan in a dense fog-off view. On a mid-tier mobile CPU
(simulated here as 10× CPU throttle on this host) Leaflet had to
reposition every one of those elements when the map transformed,
producing a sustained main-thread block that users feel as lag. A
single `<canvas>` redraw replaces all of it.

## What was measured

- Headless Chromium via Playwright (Python).
- Mobile emulation: viewport 390×844, `is_mobile=True`,
  `has_touch=True`. Engages the existing `@media (max-width: 700px)`
  / `(pointer: coarse)` mobile layout path.
- CDP `Emulation.setCPUThrottlingRate` at 10×. The 10× choice came
  from a probe across {1, 4, 10, 20}×: no measurable longtask at
  fog=on at any throttle, no longtask at fog=off + 4×, ~94 ms at
  fog=off + 10×, ~287 ms at fog=off + 20×. 10× is the regime where
  the user complaint actually reproduces. Higher values
  over-dramatize.
- Test location: NW DC near Rock Creek Park (38.9473, −77.0462) —
  the densest cell in `dc_heat.csv` (count = 242). White House
  fallback at the app's default center is too sparse (~6 tiles) to
  exercise the hot path.
- Fog **off**. Default user UX (fog on) shows no measurable
  bottleneck on this host at any throttle. The fix is still a pure
  win there; it's just not a felt one.
- Gesture: real touch events via CDP `Input.dispatchTouchEvent`
  (not `page.mouse`, which dispatches mouse events even with
  `has_touch=True` and would measure the wrong code path).
- Per condition: 5 warmup trials discarded, 30 measured.
- Baseline: 3 consecutive blocks under the same conditions; σ
  estimated from block-to-block P95 stdev.

Honest scope on the numbers:
- This is a **synthetic microbenchmark** on Craig's host CPU at 10×
  throttle. Not a claim about any specific physical mobile device.
- Within-subject improvement ratios should hold across hardware
  classes for an optimization that fundamentally reduces DOM work
  per pan, but actual phone numbers will differ.
- The honest final test is opening the branch in your own browser
  and feeling the difference on your own device.

## Reproducing

```
git fetch origin claude-demo-perf-druid-subdiv
git checkout claude-demo-perf-druid-subdiv

# Bench harness (Python; needs Playwright + chromium):
py -m venv .venv
.venv/Scripts/python -m pip install playwright
.venv/Scripts/python -m playwright install chromium

# Capture three baseline blocks + a fix block (already committed
# under bench/results/ for convenience):
.venv/Scripts/python bench/harness.py --condition baseline_block1 \
    --output bench/results/my_baseline1.json
# (repeat for baseline_block2/3 and canvas_fix)

# Verdict:
.venv/Scripts/python bench/compare.py \
    --baseline bench/results/baseline_block1.json \
               bench/results/baseline_block2.json \
               bench/results/baseline_block3.json \
    --fix      bench/results/canvas_fix.json
```

## What didn't happen

- I noticed `updateGridHeat` at `js/initgrid.js:1043` is dead
  (defined, never called) and `window.updateGridHeatmap` at line
  1073 is a dormant shim for the off-by-default dynamic iNat path.
  Untouched — out of scope for the perf fix and removing them
  isn't the demo.
- `updateHudCladogram` does an async chain on every pan even when
  the center 3×3 macro cell hasn't moved. That's another plausible
  optimization (gate on macro-cell change). Not done — the canvas
  fix already cleared the gate, and stacking optimizations would
  muddy the attribution. Easy follow-up.
- I did not visually verify the canvas heat tiles render
  pixel-identically to the SVG version. The bench confirms node
  count goes 2526→0 and no JS errors fire, but a visual eyeball
  on your branch is the right last check.
