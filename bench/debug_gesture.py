"""Quick diagnostic: does ANY gesture cause moveend?

Tries three approaches in sequence and reports which one works:
1. page.mouse drag (desktop event path — wrong for mobile but diagnostic)
2. CDP Input.dispatchTouchEvent (what harness.py currently uses)
3. JS-dispatched TouchEvent from inside the page
"""

import socket
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

DC_LAT = 38.9072
DC_LNG = -77.0369
GRIDWILD_ROOT = Path(__file__).resolve().parent.parent


def find_free_port():
    with socket.socket() as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def wait_for_server(port, timeout_s=5.0):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"http.server did not bind on port {port}")


def try_gesture(page, client, label, do_it):
    """Run a gesture, see if moveend fires within 5s."""
    # Prime the moveend listener
    page.evaluate("""() => {
        window.__moveendFired = false;
        window.map.once('moveend', () => { window.__moveendFired = true; });
    }""")

    t0 = time.perf_counter()
    do_it(page, client)
    # Wait up to 5s for moveend
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if page.evaluate("window.__moveendFired"):
            t1 = time.perf_counter()
            print(f"  [{label}]  moveend fired after {(t1-t0)*1000:.0f} ms")
            return True
        time.sleep(0.05)
    print(f"  [{label}]  NO moveend within 5s")
    return False


def gesture_mouse(page, client):
    page.mouse.move(270, 422)
    page.mouse.down()
    page.mouse.move(120, 422, steps=25)
    page.mouse.up()


def gesture_cdp_touch(page, client):
    client.send("Input.dispatchTouchEvent", {
        "type": "touchStart",
        "touchPoints": [{"x": 270, "y": 422, "id": 0}],
    })
    for i in range(1, 26):
        t = i / 25
        x = 270 + (120 - 270) * t
        client.send("Input.dispatchTouchEvent", {
            "type": "touchMove",
            "touchPoints": [{"x": x, "y": 422, "id": 0}],
        })
    client.send("Input.dispatchTouchEvent", {
        "type": "touchEnd",
        "touchPoints": [],
    })


def gesture_js_touch(page, client):
    """Dispatch real TouchEvent objects from within the page."""
    page.evaluate("""() => {
      const el = document.querySelector('#map');
      const makeTouch = (id, x, y) => new Touch({
        identifier: id, target: el,
        clientX: x, clientY: y,
        pageX: x, pageY: y, screenX: x, screenY: y,
        radiusX: 1, radiusY: 1,
      });
      const tStart = makeTouch(0, 270, 422);
      el.dispatchEvent(new TouchEvent('touchstart', {
        touches: [tStart], targetTouches: [tStart], changedTouches: [tStart],
        bubbles: true, cancelable: true,
      }));
      for (let i = 1; i <= 25; i++) {
        const f = i / 25;
        const x = 270 + (120 - 270) * f;
        const t = makeTouch(0, x, 422);
        el.dispatchEvent(new TouchEvent('touchmove', {
          touches: [t], targetTouches: [t], changedTouches: [t],
          bubbles: true, cancelable: true,
        }));
      }
      const tEnd = makeTouch(0, 120, 422);
      el.dispatchEvent(new TouchEvent('touchend', {
        touches: [], targetTouches: [], changedTouches: [tEnd],
        bubbles: true, cancelable: true,
      }));
    }""")


def main():
    port = find_free_port()
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "-d", str(GRIDWILD_ROOT), str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        wait_for_server(port)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                geolocation={"latitude": DC_LAT, "longitude": DC_LNG},
                permissions=["geolocation"],
                viewport={"width": 390, "height": 844},
                device_scale_factor=3,
                is_mobile=True,
                has_touch=True,
            )
            page = context.new_page()
            client = context.new_cdp_session(page)

            page.on("console", lambda m: print(f"  [page:{m.type}] {m.text}"))
            page.on("pageerror", lambda e: print(f"  [pageerror] {e}"))

            page.goto(f"http://127.0.0.1:{port}/")
            page.wait_for_function(
                "window.__staticGridCounts && window.__staticGridCounts.size > 0"
                " && window.__gwState && window.__gwState.lastUserCellKey",
                timeout=30_000,
            )
            page.wait_for_timeout(1500)

            # Report diagnostic state
            state = page.evaluate("""() => ({
                mapExists: !!window.map,
                dragEnabled: window.map && window.map.dragging && window.map.dragging.enabled(),
                mapSize: window.map ? window.map.getSize() : null,
                mapCenter: window.map ? window.map.getCenter() : null,
                zoom: window.map ? window.map.getZoom() : null,
                gridCellsSize: window.__staticGridCounts ? window.__staticGridCounts.size : 0,
                lastFix: typeof lastFix !== 'undefined' ? lastFix : '<undefined in global scope>',
                lastUserCellKey: window.__gwState && window.__gwState.lastUserCellKey,
                heatPaneNodes: document.querySelectorAll('.leaflet-gridHeatPane path').length,
                heatPaneNodesAll: document.querySelectorAll('.leaflet-gridHeatPane *').length,
                heatPaneExists: !!document.querySelector('.leaflet-gridHeatPane'),
                mapBounds: window.map ? window.map.getBounds().toBBoxString() : null,
            })""")
            print("\n=== diagnostic state ===")
            for k, v in state.items():
                print(f"  {k}: {v}")

            print("\n=== gesture tests ===")
            # Recenter before each test
            for label, fn in [
                ("mouse drag (page.mouse)", gesture_mouse),
                ("CDP touch (Input.dispatchTouchEvent)", gesture_cdp_touch),
                ("JS TouchEvent dispatch", gesture_js_touch),
            ]:
                page.evaluate(f"window.map.setView([{DC_LAT}, {DC_LNG}], 17, {{animate: false}})")
                page.wait_for_timeout(400)
                try_gesture(page, client, label, fn)

            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=3)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    main()
