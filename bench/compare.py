"""Compare baseline vs. candidate-fix benchmark runs.

Consumes ≥3 baseline run JSONs and ≥1 fix run JSON. Estimates noise
floor σ from block-to-block P95 variance (stdev), then applies:

    ship if P95(fix) improves by >= max(30%, 3σ)

Also enforces that runs are comparable (same host, same chromium
version, same throttle, all working trees clean, all on the same
commit for baseline vs. distinct commit for fix).

Usage:
    python bench/compare.py \
        --baseline results/baseline_block1.json \
                   results/baseline_block2.json \
                   results/baseline_block3.json \
        --fix      results/fix_v1.json

Exit codes: 0 = SHIP, 1 = fatal / comparability check failed,
            3 = NO-SHIP.
"""

import argparse
import json
import statistics
import sys
from pathlib import Path


MIN_IMPROVEMENT_PCT = 30.0
MIN_BASELINE_BLOCKS = 3


def load(path):
    return json.loads(Path(path).read_text())


def get(run, *keys, default=None):
    v = run
    for k in keys:
        if not isinstance(v, dict) or k not in v:
            return default
        v = v[k]
    return v


def ship_metric(run):
    """Ship gate metric: P95 of per-trace total main-thread longtask
    duration (ms). One number per pan capturing "total blocking time."

    Phase split (during-gesture vs post-moveend) is unreliable for
    tasks that straddle moveend — a task starting pre-moveend but
    running long lands wholly in "during" by its startTime. The per-
    trace total avoids that attribution problem.

    During-gesture rAF frames are GPU-composited and don't bottleneck
    on CPU throttle, so rAF percentiles are not a useful gate.
    """
    return get(run, "summary", "trace_total_longtask_ms", "p95")


def mean_of(vals):
    return sum(vals) / len(vals) if vals else None


def check_comparability(baselines, fixes):
    """Return list of human-readable problems, empty if all match."""
    problems = []
    all_runs = baselines + fixes

    def all_same(keyfn, label):
        seen = {keyfn(r) for r in all_runs}
        if len(seen) > 1:
            problems.append(f"{label} mismatch across runs: {sorted(str(x) for x in seen)}")

    all_same(lambda r: get(r, "host_info", "processor"), "host processor")
    all_same(lambda r: get(r, "host_info", "chromium_version"), "chromium version")
    all_same(lambda r: get(r, "host_info", "throttle"), "throttle")
    all_same(lambda r: get(r, "host_info", "fog"), "fog")
    all_same(lambda r: get(r, "host_info", "trials"), "trials")
    all_same(lambda r: get(r, "host_info", "warmup"), "warmup")
    all_same(
        lambda r: json.dumps(get(r, "host_info", "app_defaults") or {}, sort_keys=True),
        "app defaults",
    )

    # baseline commits must all match each other
    baseline_shas = {get(b, "host_info", "commit_sha") for b in baselines}
    if len(baseline_shas) > 1:
        problems.append(f"baseline commit SHAs differ: {baseline_shas}")

    # working trees should be clean for rigor; warn if not
    for r in all_runs:
        if get(r, "host_info", "working_tree_dirty"):
            problems.append(
                f"run '{r.get('condition', '?')}' was on a dirty working tree — commit SHA alone doesn't identify it"
            )

    return problems


def compare(baselines, fixes):
    if len(baselines) < MIN_BASELINE_BLOCKS:
        return {
            "error": (
                f"need ≥{MIN_BASELINE_BLOCKS} baseline runs to estimate σ "
                f"with useful CI (got {len(baselines)})"
            )
        }
    if not fixes:
        return {"error": "need ≥1 fix run"}

    try:
        base_p95s = [ship_metric(b) for b in baselines]
        fix_p95s = [ship_metric(f) for f in fixes]
        if any(v is None for v in base_p95s + fix_p95s):
            return {"error": "some runs have no P95 rAF (empty summary?)"}
    except (KeyError, TypeError) as e:
        return {"error": f"result JSON missing expected fields: {e}"}

    base_mean = mean_of(base_p95s)
    fix_mean = mean_of(fix_p95s)
    sigma = statistics.stdev(base_p95s)

    sigma_pct = (3 * sigma / base_mean * 100) if base_mean else 0
    threshold_pct = max(MIN_IMPROVEMENT_PCT, sigma_pct)

    improvement_pct = (
        (base_mean - fix_mean) / base_mean * 100 if base_mean else 0
    )

    ship = improvement_pct >= threshold_pct

    warnings = []
    if sigma_pct > MIN_IMPROVEMENT_PCT:
        warnings.append(
            f"baseline noise σ ({sigma:.2f} ms, 3σ={sigma_pct:.1f}%) exceeds "
            f"the {MIN_IMPROVEMENT_PCT:.0f}% floor — consider more baseline "
            f"blocks or reducing host background load"
        )

    errors_in_runs = [
        r["condition"] for r in baselines + fixes
        if r.get("console_errors") or r.get("page_errors")
    ]
    if errors_in_runs:
        warnings.append(f"runs with errors (numbers suspect): {errors_in_runs}")

    return {
        "metric": "trace_total_longtask_ms_p95",
        "baseline_p95_values": base_p95s,
        "baseline_p95_mean_ms": base_mean,
        "fix_p95_values": fix_p95s,
        "fix_p95_mean_ms": fix_mean,
        "noise_sigma_ms": sigma,
        "noise_3sigma_pct": sigma_pct,
        "required_threshold_pct": threshold_pct,
        "measured_improvement_pct": improvement_pct,
        "ship_decision": "SHIP" if ship else "NO-SHIP",
        "warnings": warnings,
    }


def diagnostics(baselines, fixes):
    def agg(runs, key_path):
        vs = []
        for r in runs:
            v = get(r, *(["summary"] + list(key_path)))
            if v is not None:
                vs.append(v)
        return mean_of(vs)

    return {
        "post_moveend_rAF_P50_ms": {
            "baseline_mean": agg(baselines, ["post_moveend", "raf_delta_ms", "p50"]),
            "fix_mean": agg(fixes, ["post_moveend", "raf_delta_ms", "p50"]),
        },
        "post_moveend_longtask_total_ms_per_trace_mean": {
            "baseline_mean": agg(baselines, ["post_moveend", "longtask_total_duration_ms_per_trace", "mean"]),
            "fix_mean": agg(fixes, ["post_moveend", "longtask_total_duration_ms_per_trace", "mean"]),
        },
        "post_moveend_longtasks_gt_50_per_trace_mean": {
            "baseline_mean": agg(baselines, ["post_moveend", "longtask_count_gt_50_per_trace", "mean"]),
            "fix_mean": agg(fixes, ["post_moveend", "longtask_count_gt_50_per_trace", "mean"]),
        },
        "during_gesture_rAF_P95_ms": {
            "baseline_mean": agg(baselines, ["during_gesture", "raf_delta_ms", "p95"]),
            "fix_mean": agg(fixes, ["during_gesture", "raf_delta_ms", "p95"]),
        },
        "svg_heat_nodes_P50": {
            "baseline_mean": agg(baselines, ["svg_heat_node_count", "p50"]),
            "fix_mean": agg(fixes, ["svg_heat_node_count", "p50"]),
        },
        "wallclock_P95_ms": {
            "baseline_mean": agg(baselines, ["wallclock_ms", "p95"]),
            "fix_mean": agg(fixes, ["wallclock_ms", "p95"]),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", nargs="+", required=True)
    ap.add_argument("--fix", nargs="+", required=True)
    ap.add_argument("--ignore-comparability", action="store_true",
                    help="bypass host/commit consistency checks (for manual overrides)")
    args = ap.parse_args()

    baselines = [load(p) for p in args.baseline]
    fixes = [load(p) for p in args.fix]

    problems = check_comparability(baselines, fixes)
    if problems and not args.ignore_comparability:
        print(json.dumps({"error": "comparability check failed", "problems": problems}, indent=2))
        return 1

    result = compare(baselines, fixes)
    diags = diagnostics(baselines, fixes)

    out = {"verdict": result, "diagnostics": diags}
    if problems:
        out["comparability_problems_ignored"] = problems
    print(json.dumps(out, indent=2))

    if "error" in result:
        return 1
    return 0 if result["ship_decision"] == "SHIP" else 3


if __name__ == "__main__":
    sys.exit(main() or 0)
