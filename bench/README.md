# bench/

Performance measurement harness for Gridwild. Synthetic,
within-subject microbenchmark on mobile-emulated Chromium. **Not a
claim about user-perceived speed** — that's Andrew's own test on
the branch.

## What it measures

Per condition (baseline vs. candidate fix), single gesture (touch
drag dispatched via CDP `Input.dispatchTouchEvent`):

- **During-gesture** frame interval via `requestAnimationFrame`
  deltas, with rAF capture stopped on `moveend` (not later), so
  only the gesture window's frames are measured.
- **Longtasks** via `PerformanceObserver` registered before
  navigation (Playwright bug #24565 workaround): count of tasks
  >50 ms per trace, and total longtask duration per trace.
- Peak SVG node count inside `.leaflet-gridHeatPane` (diagnostic).
- Heap delta (diagnostic).

Reports P50 and P95 over N=30 measured trials (plus 5 warmup,
discarded). P99 diagnostic only — noise-dominated at N=30.

## Target: mobile

Viewport 390×844 with `is_mobile=True, has_touch=True` (iPhone 14
class). Engages the app's `@media (max-width: 700px)` AND
`@media (pointer: coarse)` mobile layout path.

Gridwild's deployment target is mobile; desktop benchmarks would
measure the wrong configuration.

## Why touch events, not mouse events

`page.mouse.*` always dispatches mouse events regardless of
`has_touch=True`. Leaflet routes mouse and touch through distinct
handlers. The harness dispatches real `touchStart`/`touchMove`/
`touchEnd` via CDP so the mobile Leaflet code path is what's
measured.

## Determinism caveats addressed

- **Fog-of-war radius** at `initgrid.js:3` gates cell rendering via
  `lastFix`-derived center cell. The harness waits for
  `__gwState.lastUserCellKey` to be populated (which means
  Playwright's mocked geolocation has flowed through
  `handleUserPositionUpdate`) before any gesture — otherwise the
  fog check short-circuits to "render all."
- **rAF-start race**: `lastRafTs` is primed with `performance.now()`
  at start, so the first gesture frame isn't discarded.
- **Settle leakage**: rAF capture is stopped the instant `moveend`
  fires, not after the post-move rAFs that would bleed idle frames
  into the measurement.
- **Recenter contamination**: `setView` fires the hot path we're
  measuring. The harness allows a 500 ms drain between recenter and
  the next gesture. Residual work is acknowledged; within-subject
  comparison absorbs it symmetrically.
- **Console errors**: captured and reported. If a candidate fix has a
  silent error (typo, missing function), the harness exits with a
  warning and non-zero code.

## Host machine caveat

CPU throttle via CDP `Emulation.setCPUThrottlingRate` at 4× is
**relative to the host CPU**. It does not approximate any physical
device. Comparisons across conditions on the same host are valid;
absolute numbers are not portable. Lighthouse defaults to 6× for
mobile; 4× is kept here for signal-to-noise, overridable via
`--throttle`.

The harness records a `host_info` block (platform, cpu_count,
chromium_version, throttle, timestamp, **git commit SHA**) alongside
results so runs are traceable and reproducible.

## Running

```
D:/Repos/gridwild/.venv/Scripts/python D:/Repos/gridwild/bench/harness.py \
    --condition baseline \
    --output D:/Repos/gridwild/bench/results/baseline_block1.json
```

Flags:
- `--condition <label>`: free-form label; recorded in output.
- `--output <path>`: JSON results file.
- `--throttle <N>`: CPU throttle rate (default 4).
- `--port <N>`: local http.server port (0 = auto-assign, default).
- `--trials <N>`: measured trials (default 30).
- `--warmup <N>`: warmup trials discarded (default 5).

Exit codes: 0 = clean; 2 = page had errors (numbers suspect); 1 =
fatal.

## Computing ship/no-ship

The plan's ship criterion is:

    ship if P95(fix) improves by >= max(30%, 3σ)
    where σ = baseline-to-baseline standard deviation of P95

`compare.py` requires **≥3 baseline runs** (the σ estimate with N=2 has
~order-of-magnitude CI; N=3 is still noisy but usable). It verifies
host, chromium version, throttle, app defaults, and commit SHA match
across inputs, then computes σ via `statistics.stdev`, applies the
threshold, and prints a verdict JSON.

```
python D:/Repos/gridwild/bench/compare.py \
    --baseline results/baseline_block1.json \
               results/baseline_block2.json \
               results/baseline_block3.json \
    --fix      results/fix_v1.json
```

Exit codes:
- `0` = SHIP
- `3` = NO-SHIP (improvement below threshold)
- `1` = error (comparability check failed, missing fields, etc.)
