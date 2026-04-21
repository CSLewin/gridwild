"""Take a mobile-viewport screenshot of the app.

Geolocation spoofed to Georgetown Medical Center so no real location
permission is needed. Assumes a local HTTP server is already serving
the repo at http://localhost:8765/.

Usage:
    python bench/screenshot_skin.py --label after
    python bench/screenshot_skin.py --label before   # with skin <link> disabled
"""

import argparse
from pathlib import Path
from playwright.sync_api import sync_playwright

LAT = 38.9115   # Georgetown University Medical Center (Reservoir Rd NW)
LNG = -77.0760
URL = "http://localhost:8765/"
OUT_DIR = Path(__file__).resolve().parent / "screenshots"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="",
                    help='Filename suffix, e.g. "before" or "after"')
    args = ap.parse_args()
    suffix = f"_{args.label}" if args.label else ""
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            geolocation={"latitude": LAT, "longitude": LNG},
            permissions=["geolocation"],
            viewport={"width": 390, "height": 844},
            device_scale_factor=2,
            is_mobile=True,
            has_touch=True,
        )
        page = context.new_page()
        console_errors = []
        page.on("console", lambda m: console_errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"[pageerror] {e}"))

        page.goto(URL)
        page.wait_for_function(
            "window.__staticGridCounts && window.__staticGridCounts.size > 0"
            " && window.__gwState && window.__gwState.lastUserCellKey",
            timeout=30_000,
        )
        page.wait_for_timeout(1500)  # let cladogram + tiles settle

        shot1 = OUT_DIR / f"rpg_skin_hud{suffix}.png"
        page.screenshot(path=str(shot1))
        print(f"wrote {shot1}")

        # Open the sidebar
        page.click("#sidebarToggle")
        page.wait_for_timeout(500)

        shot2 = OUT_DIR / f"rpg_skin_sidebar{suffix}.png"
        page.screenshot(path=str(shot2))
        print(f"wrote {shot2}")

        if console_errors:
            print("CONSOLE ERRORS:")
            for e in console_errors:
                print(" ", e)
        browser.close()


if __name__ == "__main__":
    main()
