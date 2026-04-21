# Cell subdivision — design note

A survey of three ways GridWild could make the heat map's spatial
unit better match how the observations are actually generated. No
recommendation — the choice depends on answers only Andrew has.

## The problem

Observations are aggregated into square cells of side
`GRID_SIZE_M = 20 * 0.3048 ≈ 6.1 m` (`js/initgrid.js:42`),
measured in Web Mercator projected meters, so the actual ground
size at DC's latitude is about **4.7 m** after the
`cos(latitude)` correction. That's at or below the scale at which
individual consumer-phone GPS positions are reliably
distinguishable. The bundled `assets/dc_heat.csv` is already
**pre-aggregated** — its rows are `ix,iy,count,n_species,n_observers`
(201,155 data rows, 4.6 MB), and raw per-observation records aren't
in `assets/`.

Visually: a naturalist walks a trail, drops twenty observations along
50 m of path, and they scatter across ~8–10 different cells, most of
which end up at count=1 surrounded by neighbors at count=0. The
spatial unit of the display (cell) doesn't match the spatial unit of
the data-generating process (linear path, not grid).

## Three approaches

### 1. Quarter-tile square subdivision

Halve `GRID_SIZE_M` to 3 m; each existing cell becomes four. The
binning math stays identical; tile count quadruples; `dc_heat.csv`
has to be regenerated at the finer resolution from the raw
observations.

**Honest weakness.** 3 m ground cells sit *below* what phone GPS
typically resolves, so the extra resolution would tend to show
patterns that are position noise, not biology — false precision.
It also still doesn't notice paths; a diagonal trail still splits
across all four quadrants.

### 2. Hex grid with directional edge cue

Use a hexagonal grid (H3 is the obvious addressing scheme, with a
browser build) at a resolution chosen to *match* the current cell
footprint, not subdivide below it. Within each hex, track the
centroid of its observations, and brighten the edge nearest that
centroid as a weak visual hint at sub-cell structure.

**Honest weakness.** This fixes the geometry (hex is near-isotropic;
squares over-weight horizontal/vertical neighbors) and gestures at
the path-linear structure, but doesn't *name* it. The edge-hint tells
you roughly where in the hex the cluster sits; it doesn't tell you
whether you're looking at a trail, a pond, or a parking lot.

### 3. OSM-path-aware virtual sub-cells

For each observation, find the nearest OSM `highway` way within a
threshold (say 10 m) and attribute it to that path segment, or tag
it as "off-path." Render the path as a linear heat (per-segment
color on the line itself) and keep a coarser square-cell heat for
off-path.

**The plumbing is already partly in place.** `js/osmoverlay.js`
(107 LOC) already queries Overpass for `highway` + `building` ways
in the viewport bbox, has in-flight abort + debounce, and renders
them on a dedicated z-indexed pane. It's **currently `TEMP DISABLED`**
at `index.html:737`. The missing pieces are (a) the point-to-line
distance attribution (a handful of lines with `turf.js` or
hand-rolled), (b) a per-segment color renderer, and (c) UX for the
off-path bucket.

**Honest weakness.** Biggest lift of the three, and the visualization
semantics change — heat now means "intensity along this specific
path" rather than "density in this region." Users and Andrew have to
agree that's the right frame. Also: OSM coverage of social trails is
uneven; a real but unmapped trail would misattribute its observations
to "off-path."

## Tradeoffs

|  | 1. Quarter-tile | 2. Hex + edge cue | 3. OSM path-aware |
|---|---|---|---|
| Code change | Small | Medium | Largest by LOC, smaller by *new* LOC |
| New dep | None | `h3-js` | `turf.js` or equivalent |
| CSV format change | Yes | Yes | Needs raw points, not just cell totals |
| Post-Track-A perf headroom | Good | OK (more vertices per tile) | Depends on Overpass caching |
| Below GPS noise floor? | **Yes** | No | No |
| Models the data-generating process? | No | No | Yes |
| Partly built already? | No | No | **Yes** — `js/osmoverlay.js` |

## Questions only Andrew can answer

1. **Why is `js/osmoverlay.js` shelved as `TEMP DISABLED`?** Was it
   Overpass rate-limits, perf on pan/zoom, UX, or something else?
   The answer dominantly decides whether approach 3 is viable.
2. **Is `dc_heat.csv` re-generatable from raw iNat records?** All
   three approaches require re-aggregation. Approach 3 additionally
   needs the raw point coordinates, not just cell totals.
3. **When a user stares at a hot patch, what's the question in their
   head?** "Is this dense because of a trail or because of the
   habitat?" is the question approach 3 answers natively. If that
   question isn't what users actually ask, the investment doesn't
   pay back.

## What this doc does not do

No recommendation: approach 1 is the smallest change but pushes
resolution below the data's noise floor; approach 2 is a clean
engineering improvement that doesn't touch the underlying mismatch
between the display's spatial unit and the data's; approach 3 is
the only one that models the data-generating process and is less
greenfield than it looks — but Andrew's answer to question 1 above
would swing the call. No POC attempted here; the deliverable was
the tradeoff survey.
