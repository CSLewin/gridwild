// Static heatmap store (when I introduced static assets)
window.__staticGridCounts = new Map();
const FOG_RADIUS_CELLS = 10;

function getCurrentUserCellIndices() {
  if (typeof lastFix === "undefined" || !lastFix) return null;

  const p = map.options.crs.project(
    L.latLng(lastFix.latitude, lastFix.longitude)
  );

  return {
    ix: Math.floor(p.x / GRID_SIZE_M),
    iy: Math.floor(p.y / GRID_SIZE_M)
  };
}

// 100x100 ft grid overlay + heat-tinted tiles
// Uses EPSG:3857 meters via map.project/unproject

// Heat tiles under the grid lines, but above base map tiles
map.createPane("gridHeatPane");
map.getPane("gridHeatPane").style.zIndex = 415;
map.getPane("gridHeatPane").style.pointerEvents = "none";

// Grid lines pane (above heat tiles)
map.createPane("gridPane");
map.getPane("gridPane").style.zIndex = 420;
map.getPane("gridPane").style.pointerEvents = "none";

// Canvas renderer for heat tiles. With fog off in a dense area, SVG
// would render thousands of <path> elements per pan and repaint them
// on pointer drag; on a mid-tier mobile CPU that's the "slow as shit"
// complaint. A single canvas draw sidesteps the per-element DOM cost.
const heatCanvas = L.canvas({ pane: "gridHeatPane", padding: 0.1 });

// Layer containers
const gridHeatLayer = L.layerGroup([], { pane: "gridHeatPane" }).addTo(map);
const gridLineLayer = L.layerGroup([], { pane: "gridPane" }).addTo(map);

// 20 ft in meters
const GRID_SIZE_M = 20 * 0.3048;

// // // // // define helpers for the central 3×3 macro square

const CENTER_MACRO_SIZE_CELLS = 3;
const CENTER_MACRO_SIZE_M = GRID_SIZE_M * CENTER_MACRO_SIZE_CELLS;

function getCenterFineCell() {
  const c = map.getCenter();
  const p = map.options.crs.project(c);
  return {
    ix: Math.floor(p.x / GRID_SIZE_M),
    iy: Math.floor(p.y / GRID_SIZE_M)
  };
}

function getCenterMacroAnchor() {
  const { ix, iy } = getCenterFineCell();

  // Anchor the macro block so the user’s current fine cell is the middle of a 3x3 block
  return {
    ix0: ix - 1,
    iy0: iy - 1
  };
}

function fineCellBoundsLL(ix, iy) {
  const x0 = ix * GRID_SIZE_M;
  const y0 = iy * GRID_SIZE_M;
  const sw = map.options.crs.unproject(L.point(x0, y0));
  const ne = map.options.crs.unproject(L.point(x0 + GRID_SIZE_M, y0 + GRID_SIZE_M));
  return { sw, ne };
}

function macroCellBoundsLL(ix0, iy0) {
  const x0 = ix0 * GRID_SIZE_M;
  const y0 = iy0 * GRID_SIZE_M;
  const sw = map.options.crs.unproject(L.point(x0, y0));
  const ne = map.options.crs.unproject(
    L.point(x0 + CENTER_MACRO_SIZE_M, y0 + CENTER_MACRO_SIZE_M)
  );
  return { sw, ne };
}

// // // // ///

function getCenterMacroCellKeys() {
  const { ix0, iy0 } = getCenterMacroAnchor();
  const keys = [];

  for (let dx = 0; dx < CENTER_MACRO_SIZE_CELLS; dx++) {
    for (let dy = 0; dy < CENTER_MACRO_SIZE_CELLS; dy++) {
      keys.push(`${ix0 + dx},${iy0 + dy}`);
    }
  }
  return keys;
}

function summarizeCenterMacroSquare() {

  const counts = window.__staticGridCounts;
  if (!(counts instanceof Map) || counts.size === 0) {
    return null;
  }

  const keys = getCenterMacroCellKeys();

  let nCells = 0;
  let nNonzero = 0;
  let sumObs = 0;
  let sumSpecies = 0;
  let sumObservers = 0;

  let maxObs = 0;
  let maxSpecies = 0;
  let maxObservers = 0;

  for (const key of keys) {
    nCells += 1;

    const m = counts.get(key);
    if (!m) continue;

    const obs = m.count || 0;
    const species = m.species || 0;
    const observers = m.observers || 0;

    if (obs > 0 || species > 0 || observers > 0) nNonzero += 1;

    sumObs += obs;
    sumSpecies += species;
    sumObservers += observers;

    if (obs > maxObs) maxObs = obs;
    if (species > maxSpecies) maxSpecies = species;
    if (observers > maxObservers) maxObservers = observers;
  }


  // COOL CUSTOM FANCY METRICS!
  const speciesDensity = sumObs > 0 ? (sumSpecies / sumObs) : 0;
  //const discoveryScore = sumSpecies / (sumObservers + 1);
  const discoveryScore =  sumSpecies / Math.max(1, sumObservers); // smooth



  return {
    nCells,
    nNonzero,
    sumObs,
    sumSpecies,
    sumObservers,
    meanObsPerCell: nCells ? sumObs / nCells : 0,
    meanSpeciesPerCell: nCells ? sumSpecies / nCells : 0,
    meanObserversPerCell: nCells ? sumObservers / nCells : 0,
    maxObs,
    maxSpecies,
    maxObservers,
    speciesDensity,
    discoveryScore
  };
}

function getCenterSquareLabel() {
  const n = CENTER_MACRO_SIZE_CELLS;
  const widthFeet = Math.round((n * GRID_SIZE_M) / 0.3048);
  return `Center square (${n}×${n} cells ≈ ${widthFeet} ft × ${widthFeet} ft)`;
}

window.updateHudCenterSummary = function updateHudCenterSummary() {
  const el = document.getElementById("gwSummaryBody");
  if (!el) return;

  const titleEl = document.querySelector("#gwSummaryPane .gw-summary-title");
if (titleEl) {
  titleEl.textContent = getCenterSquareLabel();
}

  const s = summarizeCenterMacroSquare();
  if (!s) {
    el.textContent = "No center-square data loaded yet.";
    return;
  }

  el.innerHTML = `
    <div class="gw-summary-grid">
    
      <div class="gw-summary-k">Discovery</div>
      <div class="gw-summary-v">${s.discoveryScore.toFixed(2)}</div>

      <div class="gw-summary-k">Observations</div>
      <div class="gw-summary-v">${s.sumObs}</div>

      <div class="gw-summary-k">Species</div>
      <div class="gw-summary-v">${s.sumSpecies}</div>

      <div class="gw-summary-k">Species density</div>
      <div class="gw-summary-v">${s.speciesDensity.toFixed(2)}</div>

      <div class="gw-summary-k">Observers</div>
      <div class="gw-summary-v">${s.sumObservers}</div>

      <div class="gw-summary-k">Mean obs/cell</div>
      <div class="gw-summary-v">${s.meanObsPerCell.toFixed(1)}</div>

      <div class="gw-summary-k">Cells</div>
      <div class="gw-summary-v">${s.nCells}</div>

      <div class="gw-summary-k">Active cells</div>
      <div class="gw-summary-v">${s.nNonzero}</div>

    </div>
  `;
};

function mergeSquareGeneraRecords(squareRecords) {
  const genusCounts = new Map();

  for (const rec of squareRecords) {
    const genera = Array.isArray(rec?.genera) ? rec.genera : [];
    for (const g of genera) {
      const genusName = g?.genus_name;
      if (!genusName) continue;

      const n = Math.max(1, Number(g.count) || 1);
      genusCounts.set(genusName, (genusCounts.get(genusName) || 0) + n);
    }
  }

  return {
    genera: Array.from(genusCounts.entries()).map(([genus_name, count]) => ({
      genus_name,
      count
    }))
  };
}




// // // // // // // // // // // // // // // // // // // // // // // // // // // // // // 

// ─────────────────────────────────────────────────────────────
// Taxonomy dictionary + square genera superchunk caches
// ─────────────────────────────────────────────────────────────
window.__genusTaxonomyDict = window.__genusTaxonomyDict || null;
window.__squareGeneraSuperchunkCache = window.__squareGeneraSuperchunkCache || new Map();

const GENERA_SUPERCHUNK_SIZE = 32; // must match your MATLAB writer
const GENERA_SUPERCHUNK_BASE = "assets/square_genera_superchunks";
const GENUS_TAXONOMY_DICT_URL = "assets/genus_taxonomy_dictionary.json";

async function loadGenusTaxonomyDictionary() {
  if (window.__genusTaxonomyDict) return window.__genusTaxonomyDict;

  const resp = await fetch(GENUS_TAXONOMY_DICT_URL);
  if (!resp.ok) {
    throw new Error(`Failed to load genus taxonomy dictionary: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  window.__genusTaxonomyDict = data;
  return data;
}

function getGeneraSuperchunkKey(ix, iy) {
  const super_ix = Math.floor(ix / GENERA_SUPERCHUNK_SIZE);
  const super_iy = Math.floor(iy / GENERA_SUPERCHUNK_SIZE);
  return `${super_ix}_${super_iy}`;
}

function getGeneraSuperchunkUrl(ix, iy) {
  const key = getGeneraSuperchunkKey(ix, iy);
  const url = `${GENERA_SUPERCHUNK_BASE}/super_${key}.json`;
  //console.log("GENERA url", { ix, iy, key, url });
  return url;
}

async function loadGeneraSuperchunk(ix, iy) {
  const key = getGeneraSuperchunkKey(ix, iy);
  const cache = window.__squareGeneraSuperchunkCache;

  if (cache.has(key)) {
    const data = cache.get(key);
    //console.log("GENERA cache hit", key);
    //console.log("GENERA cached keys sample", Object.keys(data?.squares || {}).slice(0, 20));
    return data;
  }

  const url = getGeneraSuperchunkUrl(ix, iy);
  const resp = await fetch(url);
  //console.log("GENERA fetch", url, resp.status);

  if (!resp.ok) {
    throw new Error(`Failed to load square genera superchunk: HTTP ${resp.status} for ${url}`);
  }

  const data = await resp.json();
//  console.log("GENERA loaded keys sample", Object.keys(data?.squares || {}).slice(0, 20));
  cache.set(key, data);
  return data;
}

function encodeGeneraSquareId(ix, iy) {
  const enc = (n) => (n < 0 ? `m${Math.abs(n)}` : `p${n}`);
  return `sq_${enc(ix)}_${enc(iy)}`;
}

async function getSquareGeneraRecord(ix, iy) {
  const squareId = encodeGeneraSquareId(ix, iy);
  //console.log("GENERA squareId wanted", squareId);

  try {
    const chunk = await loadGeneraSuperchunk(ix, iy);
    const rec = chunk?.squares?.[squareId] || null;
    //console.log("GENERA record found?", !!rec, rec);
    return rec;
  } catch (err) {
    console.warn("No square genera record available:", err);
    return null;
  }
}

window.__genusNameToTaxonomyEntry = window.__genusNameToTaxonomyEntry || null;

function buildGenusNameToTaxonomyEntryIndex(genusDict) {
  const idx = Object.create(null);

  for (const [genusId, entry] of Object.entries(genusDict || {})) {
    const name = entry?.name;
    if (!name) continue;

    idx[name] = {
      genus_id: genusId,
      ...entry
    };
  }

  return idx;
}

async function loadGenusNameToTaxonomyEntryIndex() {
  if (window.__genusNameToTaxonomyEntry) {
    return window.__genusNameToTaxonomyEntry;
  }

  const genusDict = await loadGenusTaxonomyDictionary();
  const idx = buildGenusNameToTaxonomyEntryIndex(genusDict);
  window.__genusNameToTaxonomyEntry = idx;
  return idx;
}

function buildTaxonomyTreeFromSquareRecord(squareRec, genusNameIndex) {
  const root = {
    name: "Life",
    children: new Map(),
    weight: 0,
    genusCount: 0,
    depth: 0
  };

  const genera = Array.isArray(squareRec?.genera) ? squareRec.genera : [];
  const seenGeneraPerNode = new Map();

  function markGenus(node, genusName) {
    if (!seenGeneraPerNode.has(node)) {
      seenGeneraPerNode.set(node, new Set());
    }
    const s = seenGeneraPerNode.get(node);
    if (!s.has(genusName)) {
      s.add(genusName);
      node.genusCount = (node.genusCount || 0) + 1;
    }
  }

  for (const g of genera) {
    const genusName = g?.genus_name;
    if (!genusName) continue;

    const n = Math.max(1, Number(g.count) || 1);
    const entry = genusNameIndex?.[genusName];

    const pathNames = Array.isArray(entry?.path_names) ? entry.path_names : [];
    const pathRanks = Array.isArray(entry?.path_ranks) ? entry.path_ranks : [];

    let cappedPath = [];

    if (pathNames.length && pathRanks.length && pathNames.length === pathRanks.length) {
      for (let i = 0; i < pathNames.length; i++) {
        cappedPath.push(pathNames[i]);
        if (String(pathRanks[i]).toLowerCase() === "order") break;
      }
    } else {
      // fallback if ranks are missing
      cappedPath = pathNames.slice(0, 5);
    }

    if (!cappedPath.length) {
      cappedPath = ["Unmapped"];
    }

    let node = root;
    node.weight += n;
    markGenus(node, genusName);

    cappedPath.forEach((part, depthIdx) => {
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          children: new Map(),
          weight: 0,
          genusCount: 0,
          depth: depthIdx + 1
        });
      }

      node = node.children.get(part);
      node.weight += n;
      markGenus(node, genusName);
    });
  }

  return root;
}


function finalizeTree(node, parent = null, out = []) {
  const kids = Array.from(node.children.values())
    .sort((a, b) =>
      (b.genusCount || 0) - (a.genusCount || 0) ||
      (b.weight || 0) - (a.weight || 0) ||
      a.name.localeCompare(b.name)
    );

  const finalized = {
    name: node.name,
    weight: node.weight || 0,
    genusCount: node.genusCount || 0,
    depth: node.depth || 0,
    parent,
    children: kids.map(child => finalizeTree(child, node.name, out))
  };

  out.push(finalized);
  return finalized;
}

function getLeafCount(node) {
  if (!node.children || node.children.length === 0) return 1;
  return node.children.reduce((s, c) => s + getLeafCount(c), 0);
}

function assignTreeLayout(root) {
  let maxDepth = 0;

  function prep(node, depth = 0) {
    node.depth = depth;
    maxDepth = Math.max(maxDepth, depth);

    const kids = node.children || [];
    if (kids.length === 0) {
      node._leafCount = 1;
      return 1;
    }

    let total = 0;
    kids.forEach((child) => {
      total += prep(child, depth + 1);
    });

    node._leafCount = Math.max(1, total);
    return node._leafCount;
  }

  prep(root, 0);

  function assignSpan(node, x0, x1) {
    node._x0 = x0;
    node._x1 = x1;
    node._x = 0.5 * (x0 + x1);

    const kids = node.children || [];
    if (kids.length === 0) return;

    const totalLeaves = kids.reduce((s, c) => s + (c._leafCount || 1), 0) || 1;
    let cursor = x0;

    kids.forEach((child) => {
      const frac = (child._leafCount || 1) / totalLeaves;
      const w = (x1 - x0) * frac;
      assignSpan(child, cursor, cursor + w);
      cursor += w;
    });
  }

  // Use a normalized 0..1 horizontal domain
  assignSpan(root, 0, 1);

  return {
    leafCount: Math.max(1, root._leafCount || 1),
    maxDepth
  };
}


function flattenTree(root) {
  const nodes = [];
  const edges = [];

  function walk(node, parent = null) {
    nodes.push(node);
    if (parent) edges.push({ source: parent, target: node });
    (node.children || []).forEach(child => walk(child, node));
  }

  walk(root);
  return { nodes, edges };
}


function slugifyCladoName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "node";
}

function annotateTreePaths(node, parentPath = "root") {
  const myPath = node.depth === 0
    ? "root"
    : `${parentPath}/${slugifyCladoName(node.name)}`;

  node._path = myPath;
  (node.children || []).forEach(child => annotateTreePaths(child, myPath));
  return node;
}



// ─────────────────────────────────────────────────────────────
// Simple pie-navigation state
// ─────────────────────────────────────────────────────────────
window.__gwCladoState = window.__gwCladoState || {
  fullTree: null,
  currentNodePath: "root",
  pathStack: []
};

function findNodeByPath(node, path) {
  if (!node) return null;
  if (node._path === path) return node;

  for (const child of (node.children || [])) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}

function getCurrentPieNode() {
  const state = window.__gwCladoState || {};
  return findNodeByPath(state.fullTree, state.currentNodePath || "root");
}

function colorForPieDepth(depth, frac = 0.5) {
  const hue = 120 + depth * 38 + frac * 30;
  const sat = 58;
  const light = 52 - Math.min(depth * 2, 10);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

function colorForPieSlice(child, diversityFrac, siblingIndexFrac = 0.5) {
  // Keep hue mostly stable within a view, with a slight spread across siblings
  const baseHue = 120 + 18 * siblingIndexFrac;

  // Diversity drives vividness and a bit of darkness
  const sat = 28 + 58 * diversityFrac;     // low diversity = duller
  const light = 70 - 20 * diversityFrac;   // high diversity = a bit darker/richer

  return `hsl(${baseHue}, ${sat}%, ${light}%)`;
}


function polarToCartesian(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return {
    x: cx + r * Math.cos(a),
    y: cy + r * Math.sin(a)
  };
}

function describeArc(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const p1 = polarToCartesian(cx, cy, rOuter, startAngle);
  const p2 = polarToCartesian(cx, cy, rOuter, endAngle);
  const p3 = polarToCartesian(cx, cy, rInner, endAngle);
  const p4 = polarToCartesian(cx, cy, rInner, startAngle);

  const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;

  return [
    `M ${p1.x} ${p1.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${p2.x} ${p2.y}`,
    `L ${p3.x} ${p3.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${p4.x} ${p4.y}`,
    "Z"
  ].join(" ");
}

const TAXON_COMMON_NAMES = {
  Diptera: "Flies",
  Lepidoptera: "Butterflies & Moths",
  Coleoptera: "Beetles",
  Hymenoptera: "Bees, Wasps & Ants",
  Hemiptera: "True Bugs",
  Orthoptera: "Grasshoppers & Crickets",
  Odonata: "Dragonflies & Damselflies",
  Araneae: "Spiders"
};

function getDisplayName(node) {
  return TAXON_COMMON_NAMES[node.name] || node.name;
}

function renderPieSvg(node) {
  const W = 260;
  const H = 260;
  const cx = 130;
  const cy = 120;   // try 115–125 range
  const rOuter = 92;
  const rInner = 28;

  const kids = (node?.children || []).slice();

  if (!kids.length) {
    return `
      <svg id="gwCladoSvg" class="gw-clado-svg" viewBox="0 0 ${W} ${H}">
        <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="rgba(80,120,80,0.08)" stroke="rgba(0,0,0,0.08)" />
        <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white" stroke="rgba(0,0,0,0.08)" />
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="13" font-weight="700">${escapeHtml(node?.name || "Node")}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="11" opacity="0.65">Leaf node</text>
      </svg>
    `;
  }

  const total = kids.reduce((s, k) => s + Math.max(1, k.weight || 1), 0) || 1;
  const maxDiversity = Math.max(...kids.map(k => k.genusCount || 0), 1);

  let cursor = 0;
  const slices = kids.map((child, i) => {
    const value = Math.max(1, child.weight || 1);
    const frac = value / total;
    const startAngle = cursor * 360;
    const endAngle = (cursor + frac) * 360;
    cursor += frac;

    const mid = 0.5 * (startAngle + endAngle);
    const labelPt = polarToCartesian(cx, cy, 62, mid);
    
    // const fill = colorForPieDepth(child.depth || 1, i / Math.max(1, kids.length - 1));
    const diversityFrac = (child.genusCount || 0) / maxDiversity;
    const fill = colorForPieSlice(
      child,
      diversityFrac,
      i / Math.max(1, kids.length - 1)
    );


    return `
      <g class="gw-pie-slice-group" data-node-path="${escapeHtml(child._path || "")}">
        <title>
        ${getDisplayName(child)} (${child.name}) • ${child.weight} obs • ${child.genusCount} genera
        </title>
        <path
          class="gw-pie-slice"
          d="${describeArc(cx, cy, rOuter, rInner, startAngle, endAngle)}"
          fill="${fill}"
          stroke="rgba(255,255,255,0.95)"
          stroke-width="1.5"
        />
        ${frac > 0.06 ? `
          <text
            x="${labelPt.x}"
            y="${labelPt.y}"
            text-anchor="middle"
            dominant-baseline="middle"
            font-size="10.5"
            font-weight="600"
            fill="rgba(0,0,0,0.78)"
            pointer-events="none"
          >${escapeHtml(getDisplayName(child))}</text>
        ` : ""}
      </g>
    `;
  }).join("");

  return `
    <svg id="gwCladoSvg" class="gw-clado-svg" viewBox="0 0 ${W} ${H}">
      <circle
        id="gwPieBackHit"
        cx="${cx}" cy="${cy}" r="${rOuter + 18}"
        fill="transparent"
        pointer-events="all"
      />
      ${slices}
      <circle cx="${cx}" cy="${cy}" r="${rInner}" fill="white" stroke="rgba(0,0,0,0.10)" />
      <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="12.5" font-weight="800">
        ${escapeHtml(node.name)}
      </text>
      <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10.5" opacity="0.64">
        dbl-click slice to drill in
      </text>
    </svg>
  `;
}

function rerenderCladogram() {
  const state = window.__gwCladoState || {};
  const el = document.getElementById("gwCladoBody");
  if (!el || !state.fullTree) return;

  const node = getCurrentPieNode();
  if (!node) return;

  el.className = "";
  el.innerHTML = renderPieSvg(node);
  bindCladogramInteractions();
}

function bindCladogramInteractions() {
  const svg = document.getElementById("gwCladoSvg");
  if (!svg) return;

  const state = window.__gwCladoState || {};

  // Drill down on slice dbl-click
  svg.querySelectorAll(".gw-pie-slice-group").forEach((g) => {
    g.addEventListener("dblclick", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();

      const nodePath = g.dataset.nodePath;
      if (!nodePath) return;

      const nextNode = findNodeByPath(state.fullTree, nodePath);
      if (!nextNode) return;
      if (!nextNode.children || nextNode.children.length === 0) return;

      state.pathStack = state.pathStack || [];
      state.pathStack.push(state.currentNodePath || "root");
      state.currentNodePath = nodePath;

      rerenderCladogram();
    });
  });

  // Step back when dbl-clicking outside slices
  svg.addEventListener("dblclick", (evt) => {
    const hitSlice = evt.target.closest(".gw-pie-slice-group");
    if (hitSlice) return;

    evt.preventDefault();
    evt.stopPropagation();

    if (state.pathStack && state.pathStack.length > 0) {
      state.currentNodePath = state.pathStack.pop();
      rerenderCladogram();
    }
  });
}

function getCladoElements() {
  return {
    wrap: document.getElementById("gwCladoWrap"),
    svg: document.getElementById("gwCladoSvg")
  };
}


function getPointerDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function getPointerMidpoint(a, b) {
  return {
    clientX: 0.5 * (a.clientX + b.clientX),
    clientY: 0.5 * (a.clientY + b.clientY)
  };
}




function formatViewBox(vb) {
  return `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
}

function setSvgViewBox(vb) {
  const svg = document.getElementById("gwCladoSvg");
  if (!svg) return;
  svg.setAttribute("viewBox", formatViewBox(vb));
  window.__gwCladoState.currentViewBox = formatViewBox(vb);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

window.updateHudCladogram = async function updateHudCladogram() {
  const el = document.getElementById("gwCladoBody");
  if (!el) return;

  try {
    const subtitleEl = document.querySelector("#gwCladoPane .gw-clado-subtitle");
    if (subtitleEl) {
      subtitleEl.textContent =
      `Center ${CENTER_MACRO_SIZE_CELLS}×${CENTER_MACRO_SIZE_CELLS} square taxonomy through Order; slice size = observations, color vividness = genus diversity`;
    }
  const keys = getCenterMacroCellKeys();

    const squareRecords = await Promise.all(
      keys.map((key) => {
        const [ixStr, iyStr] = key.split(",");
        return getSquareGeneraRecord(Number(ixStr), Number(iyStr));
      })
    );

    //console.log("CLADO keys", keys);
    //console.log("CLADO squareRecords", squareRecords);
    const mergedRecord = mergeSquareGeneraRecords(squareRecords.filter(Boolean));
    //console.log("CLADO mergedRecord", mergedRecord);

    if (!Array.isArray(mergedRecord.genera) || mergedRecord.genera.length === 0) {
      el.className = "gw-clado-empty";
      el.innerHTML = `No genus data for the current center ${CENTER_MACRO_SIZE_CELLS}×${CENTER_MACRO_SIZE_CELLS} square.`;
      return;
    }
const genusNameIndex = await loadGenusNameToTaxonomyEntryIndex();
const rawTree = buildTaxonomyTreeFromSquareRecord(mergedRecord, genusNameIndex);
const tree = annotateTreePaths(finalizeTree(rawTree));

window.__gwCladoState.fullTree = tree;
window.__gwCladoState.currentNodePath = "root";
window.__gwCladoState.pathStack = [];

el.className = "";
el.innerHTML = renderPieSvg(tree);
bindCladogramInteractions();


  } catch (err) {
    console.warn("Failed to update cladogram:", err);
    el.className = "gw-clado-empty";
    el.innerHTML = "Could not load taxonomy data.";
  }
};

function findNodeByPath(node, path) {
  if (!node) return null;
  if (node._path === path) return node;

  for (const child of (node.children || [])) {
    const found = findNodeByPath(child, path);
    if (found) return found;
  }
  return null;
}


// Optional: style (grid lines)
const GRID_LINE_STYLE = {
  pane: "gridPane",
  interactive: false,
  weight: .8,
  opacity: 0.25
  // color: "#000"   // uncomment if you want to force a color
};

// Optional: style (heat tiles)
const HEAT_TILE_STYLE_BASE = {
  pane: "gridHeatPane",
  renderer: heatCanvas,
  interactive: false,
  weight: 0,
  stroke: false
};

// How far beyond the viewport to draw (avoids edge gaps)
const GRID_PAD_PX = 200;

// Heat scale cap ( max color at 25)
const HEAT_MAX_COUNT = 5;

// Cache the last iNat results so heat can redraw on pan/zoom
window.__inatLastResults = window.__inatLastResults || [];

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function snapDown(x, step) {
  return Math.floor(x / step) * step;
}
function snapUp(x, step) {
  return Math.ceil(x / step) * step;
}
function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

// NEW
function countToFill(count) {
  if (!count || count <= 0) return null;

  //const maxCount = HEAT_MAX_COUNT;
  const maxCount = getHeatCap(); // dynamic
  const logDen = Math.log1p(maxCount);
  const tLinear = Math.min(count, maxCount) / maxCount;
  const tLog = Math.log1p(Math.min(count, maxCount)) / logDen;

  const useLog = window.__gwState?.logHeat ?? true;
  const t = useLog ? tLog : tLinear;

  const hue = 200 + (20 - 200) * t;
  const sat = 85;
  const light = 60 - 12 * t;
  const fillColor = `hsl(${hue.toFixed(1)}, ${sat}%, ${light.toFixed(1)}%)`;
  const fillOpacity = 0.10 + 0.55 * Math.pow(t, 0.85);

  return { fillColor, fillOpacity };
}

// BLENDED COLORMAP!!!!!
function metricsToFill(metrics) {
  if (!metrics) return null;

  const obs = metrics.count || 0;
  const species = metrics.species || 0;
  const observers = metrics.observers || 0;

  if (obs <= 0) return null;

  // caps (tweak later)
  const OBS_CAP = 30;
  const SPECIES_CAP = 15;
  const OBSERVER_CAP = 6;

// make room for log scaling on the colormap...
//  const tObs = Math.min(obs, OBS_CAP) / OBS_CAP;
const logDen = Math.log1p(OBS_CAP);
const tObsLinear = Math.min(obs, OBS_CAP) / OBS_CAP;
const tObsLog = Math.log1p(Math.min(obs, OBS_CAP)) / logDen;
const useLog = window.__gwState?.logHeat ?? true;
const tObs = useLog ? tObsLog : tObsLinear;

// make room for log scaling of species... :\
//  const tSpecies = Math.min(species, SPECIES_CAP) / SPECIES_CAP;
const logDenSpecies = Math.log1p(SPECIES_CAP);
const tSpeciesLinear = Math.min(species, SPECIES_CAP) / SPECIES_CAP;
const tSpeciesLog = Math.log1p(Math.min(species, SPECIES_CAP)) / logDenSpecies;
const tSpecies = useLog ? tSpeciesLog : tSpeciesLinear;

  const tObservers = Math.min(observers, OBSERVER_CAP) / OBSERVER_CAP;

  // observers control hue
  const hue = 200 + (20 - 200) * tObservers;

  // species control saturation
  const sat = 40 + 50 * tSpecies;

  // observations control lightness
  const light = 65 - 20 * tObs;

  const fillColor = `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;

  const fillOpacity = 0.15 + 0.65 * Math.pow(tObs, 0.8);

  return { fillColor, fillOpacity };
}

window.metricsToFill = metricsToFill;

function getPaddedBoundsMeters() {
  const z = map.getZoom();

  const b = map.getBounds();
  const nw = map.project(b.getNorthWest(), z);
  const se = map.project(b.getSouthEast(), z);

  const paddedNW = L.point(nw.x - GRID_PAD_PX, nw.y - GRID_PAD_PX);
  const paddedSE = L.point(se.x + GRID_PAD_PX, se.y + GRID_PAD_PX);

  const llNW = map.unproject(paddedNW, z);
  const llSE = map.unproject(paddedSE, z);

  const pNWm = map.options.crs.project(llNW);
  const pSEm = map.options.crs.project(llSE);

  const minX = Math.min(pNWm.x, pSEm.x);
  const maxX = Math.max(pNWm.x, pSEm.x);
  const minY = Math.min(pNWm.y, pSEm.y);
  const maxY = Math.max(pNWm.y, pSEm.y);

  const startX = snapDown(minX, GRID_SIZE_M);
  const endX   = snapUp(maxX, GRID_SIZE_M);
  const startY = snapDown(minY, GRID_SIZE_M);
  const endY   = snapUp(maxY, GRID_SIZE_M);

  return { startX, endX, startY, endY };
}

function obsResultsToGridCounts(results) {
  const counts = new Map();
  if (!Array.isArray(results)) return counts;

  for (const obs of results) {
    const coords = obs?.geojson?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const oLng = coords[0];
    const oLat = coords[1];

    const p = map.options.crs.project(L.latLng(oLat, oLng)); // meters
    const ix = Math.floor(p.x / GRID_SIZE_M);
    const iy = Math.floor(p.y / GRID_SIZE_M);
    const key = `${ix},${iy}`;

    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return counts;
}

// Grid heat rendering
function getHeatCap() {
  const metric = window.__gwState?.heatMetric ?? "count";

  if (metric === "species") return 20;
  if (metric === "observers") return 5;
  return 30;
}

function updateGridHeat(results) {
  gridHeatLayer.clearLayers();

  const counts = obsResultsToGridCounts(results);
  const { startX, endX, startY, endY } = getPaddedBoundsMeters();

  for (let x = startX; x < endX; x += GRID_SIZE_M) {
    for (let y = startY; y < endY; y += GRID_SIZE_M) {
      const ix = Math.floor(x / GRID_SIZE_M);
      const iy = Math.floor(y / GRID_SIZE_M);

      const key = `${ix},${iy}`;
      const metrics = counts.get(key) || null;
//      const value = getHeatValueForCell(metrics);
//      const style = countToFill(value);
const style = metricsToFill(metrics);

      if (!style) continue; // 0 obs => transparent => skip drawing

      const sw = map.options.crs.unproject(L.point(x, y));
      const ne = map.options.crs.unproject(L.point(x + GRID_SIZE_M, y + GRID_SIZE_M));

      L.rectangle([sw, ne], {
        ...HEAT_TILE_STYLE_BASE,
        ...style
      }).addTo(gridHeatLayer);
    }
  }
}

window.updateGridHeatmap = function(results) {
  // Keep caching results for popup logic, etc.
  window.__inatLastResults = Array.isArray(results) ? results : [];
};


// Grid lines rendering
function updateGridLines() {
  gridLineLayer.clearLayers();

  const { ix0, iy0 } = getCenterMacroAnchor();
  const { sw, ne } = macroCellBoundsLL(ix0, iy0);

  // Draw only ONE big square = the central 3x3 block
  L.rectangle([sw, ne], {
    pane: "gridPane",
    interactive: false,
    color: "#000",
    opacity: 0.45,
    weight: 3,
    fill: false
  }).addTo(gridLineLayer);
}

// this now renders the static assets
function updateGrid() {
  updateGridLines();
  updateStaticGridHeat();
    if (typeof window.updateHudCenterSummary === "function") {
    window.updateHudCenterSummary();
  }

  if (typeof window.updateHudCladogram === "function") {
    window.updateHudCladogram();
  }

}

map.on("zoomend resize moveend", updateGrid);
updateGrid();


loadStaticHeatmapCsv("assets/dc_heat.csv");

// RPG-style grid cell popup on double click
// Disable Leaflet dblclick-to-zoom so we can use dblclick for UI
map.doubleClickZoom.disable();

// One-time CSS inject for the RPG popup
(function injectRPGPopupCSS() {
  if (document.getElementById("rpg-popup-css")) return;

  const css = `
    .rpg-popup .leaflet-popup-content-wrapper{
      border-radius: 14px;
      padding: 0;
      background: rgba(18,18,22,0.95);
      color: #f3f3f7;
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      border: 1px solid rgba(255,255,255,0.10);
      backdrop-filter: blur(6px);
    }
    .rpg-popup .leaflet-popup-tip{
      background: rgba(18,18,22,0.95);
      border: 1px solid rgba(255,255,255,0.10);
    }
    .rpg-card{
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      width: 260px;
      padding: 12px 12px 10px 12px;
    }
    .rpg-title{
      display:flex; align-items:center; justify-content:space-between;
      gap: 10px;
      font-weight: 800;
      letter-spacing: 0.3px;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .rpg-badge{
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.10);
      border: 1px solid rgba(255,255,255,0.12);
      white-space: nowrap;
    }
    .rpg-statgrid{
      display:grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 8px;
    }
    .rpg-stat{
      border-radius: 10px;
      padding: 8px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.10);
    }
    .rpg-k{
      font-size: 10px;
      opacity: 0.85;
      margin-bottom: 4px;
    }
    .rpg-v{
      font-size: 13px;
      font-weight: 700;
      line-height: 1.1;
    }
    .rpg-mini{
      font-size: 10px;
      opacity: 0.75;
      margin-top: 8px;
    }
  `;

  const style = document.createElement("style");
  style.id = "rpg-popup-css";
  style.textContent = css;
  document.head.appendChild(style);
})();

// Optional: highlight rectangle for the clicked cell (auto-fades)
let __gridClickHighlight = null;
function flashGridCell(swLL, neLL) {
  if (__gridClickHighlight) {
    map.removeLayer(__gridClickHighlight);
    __gridClickHighlight = null;
  }

  __gridClickHighlight = L.rectangle([swLL, neLL], {
    weight: 2,
    opacity: 0.9,
    fill: false
  }).addTo(map);

  setTimeout(() => {
    if (__gridClickHighlight) {
      map.removeLayer(__gridClickHighlight);
      __gridClickHighlight = null;
    }
  }, 900);
}

function metersToGridIndex(pMeters) {
  const ix = Math.floor(pMeters.x / GRID_SIZE_M);
  const iy = Math.floor(pMeters.y / GRID_SIZE_M);
  return { ix, iy };
}

function gridIndexToBoundsLL(ix, iy) {
  const x0 = ix * GRID_SIZE_M;
  const y0 = iy * GRID_SIZE_M;

  const swLL = map.options.crs.unproject(L.point(x0, y0));
  const neLL = map.options.crs.unproject(L.point(x0 + GRID_SIZE_M, y0 + GRID_SIZE_M));

  return { swLL, neLL };
}

function countObsInCell(ix, iy, results) {
  if (!Array.isArray(results) || results.length === 0) return 0;

  let c = 0;
  for (const obs of results) {
    const coords = obs?.geojson?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const oLng = coords[0];
    const oLat = coords[1];
    const p = map.options.crs.project(L.latLng(oLat, oLng));

    const jx = Math.floor(p.x / GRID_SIZE_M);
    const jy = Math.floor(p.y / GRID_SIZE_M);

    if (jx === ix && jy === iy) c++;
  }
  return c;
}

function classifyCell(count) {
  if (count <= 0) return { label: "Undiscovered", badge: "FOG" };
  if (count < 5)  return { label: "Lightly Scouted", badge: "SCOUT" };
  if (count < 15) return { label: "Active Zone", badge: "ACTIVE" };
  return { label: "Hotspot", badge: "HOT" };
}

// ─────────────────────────────────────────────────────────────
// Superchunk taxonomy store
// ─────────────────────────────────────────────────────────────

function getStaticMetricsForCell(ix, iy) {
  const m = window.__staticGridCounts?.get(`${ix},${iy}`);
  return {
    count: Number(m?.count) || 0,
    species: Number(m?.species) || 0,
    observers: Number(m?.observers) || 0
  };
}

function summarizeSquareGenera(squareRec) {
  const genera = Array.isArray(squareRec?.genera) ? squareRec.genera : [];

  const nGenera = genera.length;
  const totalGenusObs = genera.reduce((s, g) => s + (Number(g.count) || 0), 0);

  const topGenera = genera
    .slice(0, 5)
    .map(g => `${g.genus_name} (${g.count})`)
    .join(", ");

  return {
    nGenera,
    totalGenusObs,
    topGenera: topGenera || "—"
  };
}

function buildRPGPopupHTML({ ix, iy, centerLL, metrics, genusSummary }) {
  const cls = classifyCell(metrics.count);

  const cellFeet = (GRID_SIZE_M / 0.3048).toFixed(0);
  const lat = centerLL.lat.toFixed(6);
  const lng = centerLL.lng.toFixed(6);

  return `
    <div class="rpg-card">
      <div class="rpg-title">
        <div>Tile ${ix},${iy}</div>
        <div class="rpg-badge">${cls.badge}</div>
      </div>

      <div style="font-size:11px; opacity:0.9;">
        ${cls.label} • ${cellFeet}ft × ${cellFeet}ft
      </div>

      <div class="rpg-statgrid">
        <div class="rpg-stat">
          <div class="rpg-k">Observations</div>
          <div class="rpg-v">${metrics.count}</div>
        </div>

        <div class="rpg-stat">
          <div class="rpg-k">Species</div>
          <div class="rpg-v">${metrics.species}</div>
        </div>

        <div class="rpg-stat">
          <div class="rpg-k">Observers</div>
          <div class="rpg-v">${metrics.observers}</div>
        </div>

        <div class="rpg-stat">
          <div class="rpg-k">Genera</div>
          <div class="rpg-v">${genusSummary.nGenera}</div>
        </div>

        <div class="rpg-stat">
          <div class="rpg-k">Center lat</div>
          <div class="rpg-v">${lat}</div>
        </div>

        <div class="rpg-stat">
          <div class="rpg-k">Center lon</div>
          <div class="rpg-v">${lng}</div>
        </div>
      </div>

      <div class="rpg-mini" style="margin-top:10px;">
        Top genera: ${escapeHtml(genusSummary.topGenera)}
      </div>
    </div>
  `;
}

// The function you asked for: attach the dblclick behavior
window.enableGridRPGPopup = function enableGridRPGPopup() {
  map.off("dblclick", __onGridDblClick);
  map.on("dblclick", __onGridDblClick);
};

async function __onGridDblClick(e) {
  if (e?.originalEvent?.preventDefault) e.originalEvent.preventDefault();
  if (e?.originalEvent?.stopPropagation) e.originalEvent.stopPropagation();

  const pMeters = map.options.crs.project(e.latlng);
  const { ix, iy } = metersToGridIndex(pMeters);

  const { swLL, neLL } = gridIndexToBoundsLL(ix, iy);
  flashGridCell(swLL, neLL);

  const centerLL = L.latLng(
    (swLL.lat + neLL.lat) / 2,
    (swLL.lng + neLL.lng) / 2
  );

  // Pull precomputed square metrics from static heat store
  const metrics = getStaticMetricsForCell(ix, iy);

  // Load optional genus record from superchunk asset
  const squareGeneraRec = await getSquareGeneraRecord(ix, iy);
  const genusSummary = summarizeSquareGenera(squareGeneraRec);

  const html = buildRPGPopupHTML({
    ix,
    iy,
    centerLL,
    metrics,
    genusSummary
  });

  L.popup({
    className: "rpg-popup",
    closeButton: true,
    autoPan: true,
    maxWidth: 320
  })
    .setLatLng(e.latlng)
    .setContent(html)
    .openOn(map);
}

// Enable by default
window.enableGridRPGPopup();

// Allow UI SIDEBAR to toggle the heat overlay
window.setHeatVisible = function (visible) {
  if (visible) {
    if (!map.hasLayer(gridHeatLayer)) gridHeatLayer.addTo(map);
  } else {
    if (map.hasLayer(gridHeatLayer)) map.removeLayer(gridHeatLayer);
  }
};
// End allow  UI to toggle the heat overlay


// Load static CSV: ix,iy,count -- when I added static assets
async function loadStaticHeatmapCsv(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const text = await resp.text();
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);

    if (lines.length < 2) {
      console.warn("Static heat CSV is empty or header-only.");
      return;
    }

    const header = lines[0].trim().toLowerCase();
//    if (header !== "ix,iy,count,species,observers") {
 //     console.warn(`Unexpected CSV header: ${header}`);
 //   }
 const allowedHeaders = new Set([
  "ix,iy,count,species,observers",
  "ix,iy,count,n_species,n_observers"
]);

if (!allowedHeaders.has(header)) {
  console.warn(`Unexpected CSV header: ${header}`);
}

    const counts = new Map();

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 5) continue;

      const ix = Number(parts[0]);
      const iy = Number(parts[1]);
      const count = Number(parts[2]);
      const species = Number(parts[3]);
      const observers = Number(parts[4]);

      if (
        !Number.isFinite(ix) ||
        !Number.isFinite(iy) ||
        !Number.isFinite(count) ||
        !Number.isFinite(species) ||
        !Number.isFinite(observers)
      ) {
        continue;
      }

      counts.set(`${ix},${iy}`, {
        count,
        species,
        observers
      });
    }

    window.__staticGridCounts = counts;

    console.log(`Loaded static heatmap cells: ${counts.size}`);

    // updating the static grid heat
    updateStaticGridHeat();

    if (typeof window.updateHudCenterSummary === "function") {
      window.updateHudCenterSummary();
    }

    if (typeof window.updateHudCladogram === "function") {
      window.updateHudCladogram();
    }

  
  } catch (err) {
    console.error("Failed to load static heat CSV:", err);
  }
}

// more for static assets -- Render precomputed static heatmap
function isWithinFogRadius(ix, iy, cx, cy, radiusCells = 25) {
  return Math.abs(ix - cx) <= radiusCells && Math.abs(iy - cy) <= radiusCells;
}

// render which heat metric?
function getHeatValueForCell(cellMetrics) {
  if (!cellMetrics) return 0;

  const metric = window.__gwState?.heatMetric ?? "count";

  if (metric === "species") return cellMetrics.species || 0;
  if (metric === "observers") return cellMetrics.observers || 0;

  return cellMetrics.count || 0;
}

function updateStaticGridHeat() {
  gridHeatLayer.clearLayers();

  const fogOn = window.__gwState?.showFog ?? true;
  const centerCell = getCurrentUserCellIndices();

  const counts = window.__staticGridCounts;
  if (!(counts instanceof Map) || counts.size === 0) return;

  const { startX, endX, startY, endY } = getPaddedBoundsMeters();

  for (let x = startX; x < endX; x += GRID_SIZE_M) {
    for (let y = startY; y < endY; y += GRID_SIZE_M) {
      const ix = Math.floor(x / GRID_SIZE_M);
      const iy = Math.floor(y / GRID_SIZE_M);

      if (fogOn && centerCell) {
        if (!isWithinFogRadius(ix, iy, centerCell.ix, centerCell.iy, FOG_RADIUS_CELLS)) {
          continue;
        }
      }

      const key = `${ix},${iy}`;
      const metrics = counts.get(key) || 0;
      //const value = getHeatValueForCell(metrics);
      //const style = countToFill(value);
      const style = metricsToFill(metrics);
      if (!style) continue;

      const sw = map.options.crs.unproject(L.point(x, y));
      const ne = map.options.crs.unproject(L.point(x + GRID_SIZE_M, y + GRID_SIZE_M));

      L.rectangle([sw, ne], {
        ...HEAT_TILE_STYLE_BASE,
        ...style
      }).addTo(gridHeatLayer);
    }
  }
}

//

function latLngToDisplayCellKey(lat, lng) {
  const p = map.options.crs.project(L.latLng(lat, lng));
  const ix = Math.floor(p.x / GRID_SIZE_M);
  const iy = Math.floor(p.y / GRID_SIZE_M);
  return `${ix},${iy}`;
}

function latLngToStaticChunkKey(lat, lng) {
  const chunkSize = window.__gwState?.staticChunkSizeM ?? 500;
  const p = map.options.crs.project(L.latLng(lat, lng));
  const cx = Math.floor(p.x / chunkSize);
  const cy = Math.floor(p.y / chunkSize);
  return `${cx},${cy}`;
}

function staticChunkUrlFromKey(chunkKey) {
  return `assets/chunks/${chunkKey}.csv`;
}

window.handleUserPositionUpdate = async function(lat, lng, force = false) {
  const cellKey = latLngToDisplayCellKey(lat, lng);

  const state = window.__gwState || {};
  const now = Date.now();

  const suspendUntil = state.suspendAutoCenterUntil ?? 0;

  const autoCenterAllowed =
      state.lockToLocation === true &&
      suspendUntil !== Number.POSITIVE_INFINITY &&
      now >= (suspendUntil ?? 0);

  const enteredNewCell = force || (cellKey !== state.lastUserCellKey);
  state.lastUserCellKey = cellKey;

  if (autoCenterAllowed) {
    const TARGET_ZOOM = 18;

    if (!state.hasDoneInitialZoom) {
      state.hasDoneInitialZoom = true;
      map.flyTo([lat, lng], TARGET_ZOOM, { duration: 1.0 });
    } else if (enteredNewCell) {
      map.flyTo([lat, lng], map.getZoom(), { duration: 0.5 });
    }
  }

  if (enteredNewCell) {
    updateStaticGridHeat();
    updateGridLines();

    if (typeof window.updateHudCenterSummary === "function") {
      window.updateHudCenterSummary();
    }

    if (typeof window.updateHudCladogram === "function") {
      window.updateHudCladogram();
    }

    if (typeof window.maybeRefreshDynamicINat === "function") {
      window.maybeRefreshDynamicINat(false, cellKey);
    }
  }
};


// // //
function getCenterMacroBoundsForCurrentLocation() {
  const { ix0, iy0 } = getCenterMacroAnchor();
  const { sw, ne } = macroCellBoundsLL(ix0, iy0);
  return L.latLngBounds(sw, ne);
}

function getStickyZoomTarget() {
  const bounds = getCenterMacroBoundsForCurrentLocation();

  // Fit so the macro square spans the screen width as closely as Leaflet allows
  return map.getBoundsZoom(bounds, false);
}

function applyStickyZoom(force = false) {
  const state = window.__gwState || {};
  if (!state.stickyZoomEnabled) return;

  const targetZoom = getStickyZoomTarget();
  const currentZoom = map.getZoom();
  const tol = state.stickyZoomTolerance ?? 0.35;

  if (!force && Math.abs(currentZoom - targetZoom) > tol) return;
  if (Math.abs(currentZoom - targetZoom) < 0.001) return;

  state.stickyZoomAnimating = true;
  map.setZoom(targetZoom, { animate: true });

  setTimeout(() => {
    state.stickyZoomAnimating = false;
  }, 250);
}

// add sticky zoom enable
map.on("zoomend", applyStickyZoom);

function parseViewBox(svg) {
  const vb = (svg.getAttribute("viewBox") || "0 0 260 280").trim().split(/\s+/).map(Number);
  return { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
}

function setCurrentCladoViewBox(vb) {
  window.__gwCladoState.currentViewBox = `${vb.x} ${vb.y} ${vb.w} ${vb.h}`;
}

function clampCladoViewBox(vb, baseW, baseH) {
  // ------------------------------------------------------------
  // Zoom limits
  // ------------------------------------------------------------
  vb.w = Math.max(baseW * 0.18, Math.min(baseW, vb.w));
  vb.h = Math.max(baseH * 0.18, Math.min(baseH, vb.h));

  // ------------------------------------------------------------
  // Extra pan margin so you can reach edge labels / strokes
  // Give MUCH more room at the bottom so the leaf tips/labels
  // can be dragged fully into view.
  // ------------------------------------------------------------
  const padLeft   = Math.max(18, baseW * 0.10);
  const padRight  = Math.max(24, baseW * 0.16);
  const padTop    = Math.max(18, baseH * 0.10);
  const padBottom = Math.max(150, baseH * 0.88);   // <- bigger bottom allowance

  const minX = -padLeft;
  const maxX = baseW - vb.w + padRight;

  const minY = -padTop;
  const maxY = baseH - vb.h + padBottom;

  vb.x = Math.max(minX, Math.min(maxX, vb.x));
  vb.y = Math.max(minY, Math.min(maxY, vb.y));

  return vb;
}

function clientToSvgCoords(svg, clientX, clientY, vb) {
  const rect = svg.getBoundingClientRect();
  const px = (clientX - rect.left) / rect.width;
  const py = (clientY - rect.top) / rect.height;
  return {
    x: vb.x + px * vb.w,
    y: vb.y + py * vb.h
  };
}