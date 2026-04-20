"""Probe where the actual hot-path cost lives across conditions.

Tries (throttle × fog) combinations and reports post-moveend longtask
totals — the cost of updateGrid's work after a pan.
"""

import socket, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

GRIDWILD = Path("D:/Repos/gridwild")


def find_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


INIT = r"""
window.__probe = { longtasks: [], moveendAt: 0, ready: false };
try {
  const o = new PerformanceObserver(l => {
    for (const e of l.getEntries())
      if (e.entryType === 'longtask')
        window.__probe.longtasks.push({start: e.startTime, dur: e.duration});
  });
  o.observe({entryTypes: ['longtask']});
} catch (e) {}
window.__probeArm = () => {
  window.__probe.longtasks = [];
  window.__probe.moveendAt = 0;
  window.__probe.ready = false;
  window.map.once('moveend', () => {
    window.__probe.moveendAt = performance.now();
    setTimeout(() => { window.__probe.ready = true; }, 1500);
  });
};
"""


def drag(client):
    client.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 270, "y": 422, "id": 0}]})
    for j in range(1, 26):
        t = j / 25
        client.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": 270 + (120 - 270) * t, "y": 422, "id": 0}]})
    client.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})


def probe_one(page, client, throttle, fog_on):
    client.send("Emulation.setCPUThrottlingRate", {"rate": throttle})
    page.evaluate(f"window.__gwState.showFog = {'true' if fog_on else 'false'}; window.updateGrid && window.updateGrid();")
    page.wait_for_timeout(500)

    # Run a few trials, return aggregate
    results = []
    for _ in range(3):
        page.evaluate("window.__probeArm()")
        drag(client)
        page.wait_for_function("window.__probe.ready", timeout=15000)
        data = page.evaluate("""({
            tiles: document.querySelectorAll('.leaflet-gridHeat-pane path').length,
            moveendAt: window.__probe.moveendAt,
            longtasks: window.__probe.longtasks.slice(),
        })""")
        m = data["moveendAt"]
        post = [lt for lt in data["longtasks"] if lt["start"] >= m - 50]
        results.append({
            "tiles": data["tiles"],
            "post_lt_count": len(post),
            "post_lt_ms_total": sum(lt["dur"] for lt in post),
            "post_lt_ms_max": max((lt["dur"] for lt in post), default=0),
        })
        page.evaluate(f"window.map.setView([38.9473, -77.0462], 17, {{animate: false}})")
        page.wait_for_timeout(500)
    return results


def main():
    port = find_port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", "-d", str(GRIDWILD), str(port)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True)
            ctx = b.new_context(
                geolocation={"latitude": 38.9473, "longitude": -77.0462},
                permissions=["geolocation"],
                viewport={"width": 390, "height": 844},
                device_scale_factor=3,
                is_mobile=True, has_touch=True,
            )
            page = ctx.new_page()
            page.add_init_script(INIT)
            client = ctx.new_cdp_session(page)
            page.goto(f"http://127.0.0.1:{port}/")
            page.wait_for_function(
                "window.__staticGridCounts && window.__staticGridCounts.size > 0"
                " && window.__gwState && window.__gwState.lastUserCellKey",
                timeout=30000,
            )
            page.wait_for_timeout(1500)

            print(f"{'condition':<25} {'tiles':>6} {'post-LT#':>10} {'post-LT-ms':>12} {'post-LT-max':>12}")
            print("-" * 70)
            for throttle in [1, 4, 10, 20]:
                for fog in [True, False]:
                    label = f"throttle={throttle}x fog={fog}"
                    results = probe_one(page, client, throttle, fog)
                    t_mean = sum(r["tiles"] for r in results) / len(results)
                    lc_mean = sum(r["post_lt_count"] for r in results) / len(results)
                    lm_mean = sum(r["post_lt_ms_total"] for r in results) / len(results)
                    lx_mean = sum(r["post_lt_ms_max"] for r in results) / len(results)
                    print(f"{label:<25} {t_mean:>6.0f} {lc_mean:>10.1f} {lm_mean:>12.1f} {lx_mean:>12.1f}")
            b.close()
    finally:
        server.terminate()
        try: server.wait(timeout=3)
        except subprocess.TimeoutExpired: server.kill()


if __name__ == "__main__":
    main()
