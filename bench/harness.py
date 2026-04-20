"""GridWild performance benchmark harness.

Synthetic, within-subject microbenchmark on mobile-emulated Chromium.
Single gesture (touch drag via CDP). See bench/README.md for what
this measures and what it does not claim.

Usage:
    D:/Repos/gridwild/.venv/Scripts/python bench/harness.py \
        --condition baseline \
        --output bench/results/baseline_block1.json
"""

import argparse
import json
import platform
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


# Test center chosen for density. The top cell in dc_heat.csv
# (count=242) is at ix=-1406947, iy=773315 which unprojects to
# these coords — NW DC / Rock Creek Park vicinity. Benchmarking at
# the densest area stress-tests the hot path; the White House area
# at the app's original fallback center is too sparse (~6 tiles).
DC_LAT = 38.9473
DC_LNG = -77.0462
GRIDWILD_ROOT = Path(__file__).resolve().parent.parent


# Injected via add_init_script so PerformanceObserver is registered
# before any app script runs (Playwright bug #24565 workaround).
INIT_SCRIPT = r"""
(() => {
  window.__gwBench = {
    rafBuffer: [],
    rafActive: false,
    lastRafTs: 0,
    longtasks: [],
    paints: [],
    moveendFired: false,
  };

  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'longtask') {
          window.__gwBench.longtasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        } else if (entry.entryType === 'paint') {
          window.__gwBench.paints.push({
            name: entry.name,
            startTime: entry.startTime,
          });
        }
      }
    });
    obs.observe({ entryTypes: ['longtask', 'paint'] });
  } catch (e) {
    console.warn('PerformanceObserver setup failed', e);
  }

  function tick(ts) {
    if (window.__gwBench.rafActive) {
      window.__gwBench.rafBuffer.push(ts - window.__gwBench.lastRafTs);
      window.__gwBench.rafTimestamps.push(ts);
      window.__gwBench.lastRafTs = ts;
      requestAnimationFrame(tick);
    }
  }

  window.__gwBenchStart = () => {
    window.__gwBench.rafBuffer = [];
    window.__gwBench.rafTimestamps = [];
    window.__gwBench.lastRafTs = performance.now();
    window.__gwBench.rafActive = true;
    window.__gwBench.moveendFired = false;
    window.__gwBench.moveendAt = 0;
    // Marks the start of this trace so we can exclude longtasks
    // that began in a prior recenter's updateGrid but finished
    // during this trace's window.
    window.__gwBench.traceStartAt = performance.now();
    requestAnimationFrame(tick);
  };

  window.__gwBenchStop = () => {
    window.__gwBench.rafActive = false;
  };

  // Register a moveend listener that records the moment moveend
  // fired. rAF continues after moveend so we capture the post-moveend
  // work window — updateStaticGridHeat + updateHudCladogram run
  // there, and that is where user-perceived slowness actually lives
  // (during-gesture frames are GPU-composited and don't bottleneck
  // on CPU throttle).
  window.__gwBenchArmMoveend = () => {
    if (!window.map) {
      window.__gwBench.moveendAt = -1;
      return;
    }
    window.__gwBench.moveendAt = 0;
    window.map.once('moveend', () => {
      window.__gwBench.moveendAt = performance.now();
      window.__gwBench.moveendFired = true;
    });
  };

  window.__gwBenchReset = () => {
    window.__gwBench.longtasks = [];
    window.__gwBench.paints = [];
    window.__gwBench.moveendFired = false;
  };

  window.__gwBenchFullSnapshot = () => ({
    rafDeltas: window.__gwBench.rafBuffer.slice(),
    longtasks: window.__gwBench.longtasks.slice(),
    paints: window.__gwBench.paints.slice(),
    moveendAt: window.__gwBench.moveendAt,
    traceStartAt: window.__gwBench.traceStartAt,
    snapshotAt: performance.now(),
  });

  // Record frame timestamps alongside deltas so we can separate
  // during-gesture from post-moveend frames after the fact.
  window.__gwBench.rafTimestamps = [];

  window.__gwBenchHeatNodeCount = () =>
    document.querySelectorAll('.leaflet-gridHeat-pane path').length;

  window.__gwBenchHeap = () =>
    (performance && performance.memory)
      ? performance.memory.usedJSHeapSize
      : null;
})();
"""


def percentile(values, pct):
    if not values:
        return None
    s = sorted(values)
    k = (len(s) - 1) * (pct / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    frac = k - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def safe(fn, default=None):
    try:
        v = fn()
        return v if v is not None else default
    except (ValueError, TypeError, ZeroDivisionError):
        return default


def find_free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def wait_for_server(port, timeout_s=10.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"http.server did not bind on port {port}")


def git_commit_sha():
    try:
        r = subprocess.run(
            ["git", "-C", str(GRIDWILD_ROOT), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True,
        )
        return r.stdout.strip() or None
    except Exception:
        return None


def git_tree_dirty():
    try:
        r = subprocess.run(
            ["git", "-C", str(GRIDWILD_ROOT), "status", "--porcelain"],
            capture_output=True, text=True, check=True,
        )
        return bool(r.stdout.strip())
    except Exception:
        return None


def playwright_version():
    try:
        import playwright
        return playwright.__version__
    except Exception:
        return None


def cdp_touch_drag(client, start_x, start_y, end_x, end_y, steps=25):
    """Dispatch real touch events via CDP.

    `page.mouse.*` always emits mouse events regardless of has_touch.
    Leaflet has distinct touch handlers; to measure them, we need
    actual touchStart/touchMove/touchEnd.
    """
    client.send("Input.dispatchTouchEvent", {
        "type": "touchStart",
        "touchPoints": [{"x": start_x, "y": start_y, "id": 0}],
    })
    for i in range(1, steps + 1):
        t = i / steps
        x = start_x + (end_x - start_x) * t
        y = start_y + (end_y - start_y) * t
        client.send("Input.dispatchTouchEvent", {
            "type": "touchMove",
            "touchPoints": [{"x": x, "y": y, "id": 0}],
        })
    client.send("Input.dispatchTouchEvent", {
        "type": "touchEnd",
        "touchPoints": [],
    })


def recenter(page):
    """Reset map to a known state. setView triggers the hot path, so
    we give it room to drain before measurement."""
    # Discard setView's return (it's `this`, i.e. the whole Map — under
    # the canvas renderer its object graph exceeds Playwright's
    # serialization depth limit).
    page.evaluate(
        f"window.map.setView([{DC_LAT}, {DC_LNG}], 17, {{animate: false}}); null;"
    )
    # 500ms settle: lets updateGrid + async cladogram fetch finish
    # before the next measured gesture. Not perfect — residual work
    # can still leak — but within-subject comparison absorbs this
    # symmetrically across conditions.
    page.wait_for_timeout(500)


POST_MOVEEND_WINDOW_MS = 1500


def run_gesture(page, client):
    page.evaluate("window.__gwBenchReset()")
    heap_before = page.evaluate("window.__gwBenchHeap()")
    page.evaluate("window.__gwBenchStart()")
    page.evaluate("window.__gwBenchArmMoveend()")
    t_start = time.perf_counter()

    cdp_touch_drag(client, 270, 422, 120, 422, steps=25)

    # Wait for moveend to fire (inertia can last 500ms+).
    moveend_ok = True
    try:
        page.wait_for_function(
            "window.__gwBench.moveendAt > 0",
            timeout=10_000,
        )
    except Exception:
        moveend_ok = False

    # Keep rAF capturing for POST_MOVEEND_WINDOW_MS after moveend.
    # This is where updateStaticGridHeat + updateHudCladogram fire,
    # and where user-perceived slowness lives.
    if moveend_ok:
        page.wait_for_timeout(POST_MOVEEND_WINDOW_MS)
    page.evaluate("window.__gwBenchStop()")

    # Let PerformanceObserver deliver any trailing longtask entries.
    page.wait_for_timeout(80)

    snapshot = page.evaluate("window.__gwBenchFullSnapshot()")
    heap_after = page.evaluate("window.__gwBenchHeap()")
    svg_nodes = page.evaluate("window.__gwBenchHeatNodeCount()")

    t_end = time.perf_counter()

    if not moveend_ok:
        print("  ⚠ trace warning: moveend_timeout", file=sys.stderr)

    longtasks = snapshot["longtasks"]
    moveend_at = snapshot["moveendAt"] or 0
    trace_start_at = snapshot["traceStartAt"] or 0
    raf_deltas = snapshot["rafDeltas"]
    raf_timestamps = page.evaluate("window.__gwBench.rafTimestamps.slice()")

    # Partition rAF into during-gesture vs post-moveend using timestamps.
    during_deltas, post_deltas = [], []
    for delta, ts in zip(raf_deltas, raf_timestamps):
        if moveend_at <= 0 or ts <= moveend_at:
            during_deltas.append(delta)
        else:
            post_deltas.append(delta)

    # Filter out longtasks that started before this trace began (those
    # are prior-recenter contamination). Then partition by moveend.
    trace_lt = [lt for lt in longtasks if lt["startTime"] >= trace_start_at]
    # Phase partition is by longtask startTime — useful as a diagnostic
    # but imperfect, since a task that starts during the gesture and
    # runs past moveend lands wholly in "during." The cleaner primary
    # metric is trace_total_longtask_ms (below): one number per pan.
    during_lt = [lt for lt in trace_lt if lt["startTime"] < moveend_at] if moveend_at > 0 else []
    post_lt = [lt for lt in trace_lt if lt["startTime"] >= moveend_at] if moveend_at > 0 else trace_lt

    return {
        "wallclock_ms": (t_end - t_start) * 1000,
        "moveend_at_ms": moveend_at,
        "moveend_fired": moveend_ok,
        # PRIMARY per-trace metric: total main-thread blocking time
        # attributed to this trace. What a user feels as "lag per pan."
        "trace_total_longtask_ms": sum(lt["duration"] for lt in trace_lt),
        "trace_total_longtask_count": len(trace_lt),
        "trace_max_longtask_ms": max((lt["duration"] for lt in trace_lt), default=0),
        # Diagnostic phase split (imperfect — straddling tasks land
        # wholly on the side where they started, not where they ran).
        "during_gesture": {
            "raf_deltas": during_deltas,
            "longtask_count_gt_50": sum(1 for lt in during_lt if lt["duration"] > 50),
            "longtask_total": len(during_lt),
            "longtask_total_duration_ms": sum(lt["duration"] for lt in during_lt),
        },
        "post_moveend": {
            "raf_deltas": post_deltas,
            "longtask_count_gt_50": sum(1 for lt in post_lt if lt["duration"] > 50),
            "longtask_total": len(post_lt),
            "longtask_total_duration_ms": sum(lt["duration"] for lt in post_lt),
        },
        "svg_heat_node_count": svg_nodes,
        "heap_delta_bytes": (
            (heap_after - heap_before)
            if (heap_before is not None and heap_after is not None)
            else None
        ),
    }


def run_block(page, client, warmup, trials):
    out = []
    total = warmup + trials
    for i in range(total):
        recenter(page)
        t = run_gesture(page, client)
        if i >= warmup:
            out.append(t)
    return out


def run_benchmark(args, port):
    host_info = {
        "platform": platform.platform(),
        "python": sys.version,
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpu_count": platform.os.cpu_count() if hasattr(platform, "os") else None,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "throttle": args.throttle,
        "fog": args.fog,
        "trials": args.trials,
        "warmup": args.warmup,
        "commit_sha": git_commit_sha(),
        "working_tree_dirty": git_tree_dirty(),
        "playwright_version": playwright_version(),
    }

    console_errors = []
    page_errors = []

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        host_info["chromium_version"] = browser.version

        # Mobile emulation: engages @media (max-width: 700px) AND
        # @media (pointer: coarse) in the app's CSS.
        context = browser.new_context(
            geolocation={"latitude": DC_LAT, "longitude": DC_LNG},
            permissions=["geolocation"],
            viewport={"width": 390, "height": 844},
            device_scale_factor=3,
            is_mobile=True,
            has_touch=True,
        )
        page = context.new_page()
        page.add_init_script(INIT_SCRIPT)

        console_warnings = []
        # Capture any console errors or page exceptions — a silently
        # broken fix would otherwise produce numbers with no flag.
        # Warnings captured too (Leaflet/cladogram failures often warn)
        # but don't fail the run.
        def _on_console(msg):
            if msg.type == "error":
                console_errors.append({"type": msg.type, "text": msg.text})
            elif msg.type == "warning":
                console_warnings.append({"type": msg.type, "text": msg.text})
        page.on("console", _on_console)
        page.on("pageerror", lambda err: page_errors.append(str(err)))

        client = context.new_cdp_session(page)
        client.send("Emulation.setCPUThrottlingRate", {"rate": args.throttle})

        page.goto(f"http://127.0.0.1:{port}/")

        # Readiness: static CSV loaded AND geolocation has flowed
        # through handleUserPositionUpdate. The latter is what
        # populates __gwState.lastUserCellKey, which is what the
        # fog-of-war radius check needs to be deterministic.
        page.wait_for_function(
            "window.__staticGridCounts"
            " && window.__staticGridCounts.size > 0"
            " && window.__gwState"
            " && window.__gwState.lastUserCellKey",
            timeout=30_000,
        )
        # Extra settle after readiness: lets the initial flyTo +
        # updateGrid + cladogram async chain finish.
        page.wait_for_timeout(1500)

        # Apply requested fog state. Default user experience is fog=on,
        # but at mobile-realistic CPU throttle on this host the fog=on
        # path has no measurable bottleneck. fog=off is the stress
        # condition where the SVG-rebuild cost actually manifests.
        fog_bool_js = "true" if args.fog == "on" else "false"
        page.evaluate(
            f"window.__gwState.showFog = {fog_bool_js};"
            " if (typeof window.updateGrid === 'function') window.updateGrid();"
            " null;"
        )
        page.wait_for_timeout(500)

        # Record the state of known defaults that affect measurement.
        # If any of these flip between runs, comparisons are invalid.
        host_info["app_defaults"] = page.evaluate(
            "({"
            "  dynamicINatEnabled: window.__gwState?.dynamicINatEnabled,"
            "  dynamicOSMEnabled: window.__gwState?.dynamicOSMEnabled,"
            "  stickyZoomEnabled: window.__gwState?.stickyZoomEnabled,"
            "  showFog: window.__gwState?.showFog,"
            "  logHeat: window.__gwState?.logHeat,"
            "  heatMetric: window.__gwState?.heatMetric"
            "})"
        )

        traces = run_block(page, client, args.warmup, args.trials)

        browser.close()

    return {
        "condition": args.condition,
        "host_info": host_info,
        "summary": summarize(traces),
        "raw": traces,
        "console_errors": console_errors,
        "console_warnings": console_warnings,
        "page_errors": page_errors,
    }


def summarize(traces):
    if not traces:
        return {}

    def phase_summary(phase_key):
        all_raf = [d for t in traces for d in (t.get(phase_key, {}).get("raf_deltas") or [])]
        lt50 = [t.get(phase_key, {}).get("longtask_count_gt_50", 0) for t in traces]
        lt_dur = [t.get(phase_key, {}).get("longtask_total_duration_ms", 0) for t in traces]
        return {
            "raf_delta_ms": {
                "p50": percentile(all_raf, 50),
                "p95": percentile(all_raf, 95),
                "p99": percentile(all_raf, 99),  # diagnostic
                "sample_count": len(all_raf),
            },
            "longtask_count_gt_50_per_trace": {
                "p50": percentile(lt50, 50),
                "p95": percentile(lt50, 95),
                "mean": safe(lambda: sum(lt50) / len(lt50)),
            },
            "longtask_total_duration_ms_per_trace": {
                "p50": percentile(lt_dur, 50),
                "p95": percentile(lt_dur, 95),
                "mean": safe(lambda: sum(lt_dur) / len(lt_dur)),
            },
        }

    nodes = [t.get("svg_heat_node_count", 0) for t in traces]
    wc = [t.get("wallclock_ms", 0) for t in traces]
    trace_total_lt = [t.get("trace_total_longtask_ms", 0) for t in traces]
    trace_max_lt = [t.get("trace_max_longtask_ms", 0) for t in traces]

    return {
        "n_trials": len(traces),
        # PRIMARY headline metric.
        "trace_total_longtask_ms": {
            "p50": percentile(trace_total_lt, 50),
            "p95": percentile(trace_total_lt, 95),
            "p99": percentile(trace_total_lt, 99),
            "mean": safe(lambda: sum(trace_total_lt) / len(trace_total_lt)),
        },
        "trace_max_longtask_ms": {
            "p50": percentile(trace_max_lt, 50),
            "p95": percentile(trace_max_lt, 95),
            "p99": percentile(trace_max_lt, 99),
        },
        # Diagnostic phase split.
        "during_gesture": phase_summary("during_gesture"),
        "post_moveend": phase_summary("post_moveend"),
        "wallclock_ms": {
            "p50": percentile(wc, 50),
            "p95": percentile(wc, 95),
            "p99": percentile(wc, 99),
        },
        "svg_heat_node_count": {
            "p50": percentile(nodes, 50),
            "p95": percentile(nodes, 95),
            "max": safe(lambda: max(nodes)),
        },
    }


def fmt(v, spec=".2f"):
    if v is None:
        return "—"
    try:
        return format(v, spec)
    except (ValueError, TypeError):
        return str(v)


def print_summary(results):
    print(f"\n=== {results['condition']} ===")
    host = results["host_info"]
    print(
        f"  host: {host.get('platform', '?')} / {host.get('processor', '?')}"
    )
    print(
        f"  chromium: {host.get('chromium_version', '?')}"
        f"  throttle: {host.get('throttle', '?')}x"
        f"  commit: {host.get('commit_sha', '?')[:8] if host.get('commit_sha') else '?'}"
    )
    if results.get("console_errors"):
        print(f"  ⚠ {len(results['console_errors'])} console error(s):")
        for e in results["console_errors"][:5]:
            print(f"    {e}")
    if results.get("page_errors"):
        print(f"  ⚠ {len(results['page_errors'])} page error(s):")
        for e in results["page_errors"][:5]:
            print(f"    {e}")
    cw = results.get("console_warnings", [])
    if cw:
        print(f"  ℹ {len(cw)} console warning(s) (non-fatal):")
        for e in cw[:3]:
            print(f"    {e}")

    s = results["summary"]
    if not s:
        print("  no traces captured.")
        return

    wc = s["wallclock_ms"]
    nc = s["svg_heat_node_count"]
    tl = s["trace_total_longtask_ms"]
    tmax = s["trace_max_longtask_ms"]
    print(f"  N={s['n_trials']}")
    print(f"  [PRIMARY] trace total longtask ms  P50={fmt(tl['p50'], '.1f')}  P95={fmt(tl['p95'], '.1f')}  mean={fmt(tl['mean'], '.1f')}")
    print(f"            trace max longtask ms   P50={fmt(tmax['p50'], '.1f')}  P95={fmt(tmax['p95'], '.1f')}")

    for phase_label, phase in [("during gesture", s["during_gesture"]), ("post-moveend  ", s["post_moveend"])]:
        raf = phase["raf_delta_ms"]
        lt = phase["longtask_count_gt_50_per_trace"]
        ltd = phase["longtask_total_duration_ms_per_trace"]
        print(f"  [{phase_label}]  rAF samples={raf['sample_count']}")
        print(
            f"    rAF delta ms    P50={fmt(raf['p50'])}  P95={fmt(raf['p95'])}"
            f"  (P99={fmt(raf['p99'])}, diag)"
        )
        print(
            f"    longtasks >50ms P50={fmt(lt['p50'], '.1f')}   P95={fmt(lt['p95'], '.1f')}"
            f"   mean={fmt(lt['mean'], '.2f')}"
        )
        print(
            f"    longtask ms     P50={fmt(ltd['p50'], '.1f')}   P95={fmt(ltd['p95'], '.1f')}"
            f"   mean={fmt(ltd['mean'], '.1f')}"
        )

    print(f"  wallclock ms   P50={fmt(wc['p50'], '.1f')}   P95={fmt(wc['p95'], '.1f')}")
    print(f"  SVG nodes      P50={fmt(nc['p50'], '.0f')}   P95={fmt(nc['p95'], '.0f')}   max={fmt(nc['max'])}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--condition", required=True, help="label for this run")
    ap.add_argument("--output", required=True, help="path to JSON output")
    # Throttle default 10x, fog default off: these are the stress
    # condition where the SVG-rebuild bottleneck is actually measurable.
    # At fog=on the default UX has no bottleneck on realistic mobile
    # hardware; at 4x throttle on this host, even fog=off has no
    # bottleneck. See DEMO_PLAN.md v7 for the rationale.
    ap.add_argument("--throttle", type=float, default=10.0)
    ap.add_argument("--fog", choices=["on", "off"], default="off")
    ap.add_argument("--port", type=int, default=0, help="0 = auto")
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--warmup", type=int, default=5)
    args = ap.parse_args()

    port = args.port or find_free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "-d", str(GRIDWILD_ROOT), str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )

    try:
        try:
            wait_for_server(port)
        except Exception:
            stderr = server.stderr.read().decode("utf-8", errors="replace") if server.stderr else ""
            print(f"server failed to start. stderr:\n{stderr}", file=sys.stderr)
            raise

        results = run_benchmark(args, port)

        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(results, indent=2))
        print(f"wrote {out_path}")
        print_summary(results)

        if results.get("console_errors") or results.get("page_errors"):
            print("\n⚠ WARNING: page had errors during the run. Numbers may not reflect a working condition.")
            return 2
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main() or 0)
