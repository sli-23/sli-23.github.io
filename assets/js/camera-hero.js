/**
 * camera-hero.js — a real 3D camera, built from genuine geometry.
 *
 * No SVG is loaded (the old flat-extrusion approach produced that grey slab
 * over the page). Every part is real three.js geometry with real lighting:
 * the body is a bevelled block, the scroll dial is a knurled cylinder that
 * actually rotates on its axis, the shutter physically depresses, and the CCD
 * travels on rails inside the body. Colours are taken verbatim from the design.
 *
 * Layering is unchanged — controls only ever write state:
 *
 *   COMMAND            STATE                 ANIMATION            RENDER
 *   dial drag     ->   wheelState.angle  ->  damped spin      ->  dial.rotation.y
 *                      ui.selectedColumn ->  indicator slide  ->  LCD texture
 *   shutter       ->   zoom.target       ->  eased tween      ->  lens pushes into LCD
 *   menu          ->   zoom.target       ->  eased tween      ->  lens pulls back out
 *   pointermove   ->   pointer.target*   ->  damped follow    ->  body tilt (additive)
 *
 * Nothing writes zoom.pos except updateZoom(); parallax is composed on top
 * at render time so the two can never fight.
 */

// Keep the rendering runtime inside the site bundle. Depending on a third-party
// CDN here made the entire camera disappear whenever that request was blocked
// or slow, because ES modules stop before init() when an import cannot resolve.
import * as THREE from "../vendor/three.module.min.js?v=r170-20260916-1";

/* ------------------------------------------------------------------ *
 * 1. PALETTE — lifted straight from the design file
 * ------------------------------------------------------------------ */

const C = {
  bg: 0x242625,
  bgDark: 0x1d1f1e,
  body: 0xf2efe7,
  bodyShade: 0xe3dfd6,
  bodyEdge: 0xc9c4ba,
  grip: 0xc4c0b7,
  gripDark: 0xa7a39b,
  trim: 0x68655f,
  bezel: 0x171a19,
  lcd: 0x101312,
  gold: 0xe0b85c,
  goldSoft: 0xe0b85c,
  shutter: 0xe0b85c,
  shutterRim: 0x171918,
  dpad: 0xcec7be,
  dpadArrow: 0x97978f,
  hub: 0xdfd9cf,
  // CCD interior, same family
  cavity: 0x22252b,
  sensor: 0x30343a,
  sensorGlass: 0xe0b85c,
  contacts: 0xe0b85c,
  bracket: 0xbbb1a7,
  rail: 0xcec7be,
  cable: 0xb18b2e,
};

const CSS = {
  ink: "#f2eee5",
  dark: "#101312",
  gold: "#e0b85c",
  goldSoft: "#e0b85c",
  lcd: "#101312",
  muted: "#aaa79f",
  faint: "rgba(242,238,229,0.2)",
};

/* ------------------------------------------------------------------ *
 * 2. DIMENSIONS — world units, ~4.9 wide body
 * ------------------------------------------------------------------ */

const D = {
  bodyW: 4.9,
  bodyH: 3.1,
  bodyD: 0.92,
  bodyR: 0.3,

  panelX: 1.72, // centre of the right-hand control column
  panelW: 1.46,

  screenW: 3.05,
  screenH: 2.32,
  screenX: -0.72,
  screenY: -0.05,
  bezelT: 0.17, // frame thickness around the LCD

  dialX: 0.92,
  dialR: 0.46,
  dialH: 0.21, // a low, wide knurled band rather than a tall drum

  // The cluster shifts up 0.095 as a unit so the MENU pill's lower edge lands
  // on the screen's lower edge:
  //   screen bottom = screenY - screenH/2   = -1.21
  //   pill bottom   = menuY - capsuleRadius = -1.105 - 0.105 = -1.21
  shutterY: 0.695,
  dpadY: -0.305,
  menuY: -1.105,
};

const LCD_W = D.screenW - D.bezelT * 2;
const LCD_H = D.screenH - D.bezelT * 2;

const TIMING = {
  zoomDuration: 950,
  zoomOutDuration: 860,
  indicatorEase: 0.18,
  pointerEase: 0.06,
  dialDamping: 0.9,
  pressEase: 0.25,
};

const BODY_Y = -0.84; // lower, bottom-weighted framing that covers the signal-band join

// At full zoom the *whole* screen assembly is visible: the bezel's top and
// bottom edges both stay in frame. Keep this below 1.0 — above it the bezel
// starts cropping and the bottom of the screen is cut off. The right-hand
// controls still fall outside the frame because the viewport is wider than the
// screen's aspect and we're centred on the screen, not the body.
const ZOOM_SCREEN_FILL = 0.96;
const LCD_Z = 0.2; // lcdMesh's z inside bodyGroup

// Deliberately restrained: enough tilt to read as a solid object, not enough
// to swing the camera around when the cursor moves.
const PARALLAX = { yaw: 0.22, pitch: 0.13, rigX: 0.34, rigY: 0.16, ccdX: 0.04, ccdY: 0.07 };

/* ------------------------------------------------------------------ *
 * 3. STATE
 * ------------------------------------------------------------------ */

const ui = {
  columns: [],
  selectedColumn: 0,
  navigating: false,
  pendingRoute: null,
  pendingPagePromise: null,
  pendingHistory: true,
  zoomedPage: false, // true on viewfinder pages: the camera starts pushed in
  inlineShell: false,
  inlineViewfinder: false,
  currentRoute: null,
};

// 0 = wide shot, 1 = pushed all the way into the LCD
const zoom = { pos: 0, start: 0, target: 0, elapsed: 0, duration: 1, state: "idle" };

const wheelState = { notch: 0, angle: 0, velocity: 0 };
const indicator = { x: 0, targetX: 0 };
const pointer = { x: 0, y: 0, targetX: 0, targetY: 0 };
const press = { shutter: 0, shutterTarget: 0, menu: 0, menuTarget: 0, dpad: 0, dpadTarget: 0 };
// eased hover weight per control, so buttons lift under the cursor
const hover = { shutter: 0, menu: 0, dpad: 0, dial: 0 };
// which way the d-pad rocks when pressed; decorative only
const dpadTilt = { x: 0, y: 0, targetX: 0, targetY: 0 };
let hoverName = null;

let reducedMotion = false;
let homeReturnMotionTimer = 0;

/* ------------------------------------------------------------------ *
 * 4. COMMANDS
 * ------------------------------------------------------------------ */

const prefetched = new Set();

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

/** Warm the destination as soon as it is selected, so the page is already in
 *  cache by the time the shutter animation finishes. */
function prefetch(url) {
  if (!url || prefetched.has(url)) return;
  prefetched.add(url);
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = url;
  document.head.appendChild(link);
}

function setColumn(next) {
  const clamped = Math.max(0, Math.min(next, ui.columns.length - 1));
  if (clamped === ui.selectedColumn) return;
  ui.selectedColumn = clamped;
  indicator.targetX = clamped;
  prefetch(ui.columns[clamped].url);
  loadViewfinderPage(ui.columns[clamped].url).catch(() => {});
  screen.markDirty();
}

function selectColumn(index) {
  wheelState.notch = Math.max(0, Math.min(index, ui.columns.length - 1));
  setColumn(index);
}

function nudgeColumn(delta) {
  selectColumn(ui.selectedColumn + delta);
}

/** Continuous dial input -> continuous spin + discrete column. */
function spinDial(pixels) {
  wheelState.velocity += pixels * 0.9;
  wheelState.notch = Math.max(
    0,
    Math.min(wheelState.notch + pixels / 130, ui.columns.length - 1),
  );
  setColumn(Math.round(wheelState.notch));
}

function shoot() {
  if (ui.navigating || ui.zoomedPage || zoom.state !== "idle") return;
  ui.pendingRoute = ui.columns[ui.selectedColumn].url;
  ui.pendingHistory = true;
  ui.pendingPagePromise = loadViewfinderPage(ui.pendingRoute);
  ui.pendingPagePromise.catch(() => {});
  retargetZoom(1, "pushing_in");
}

function retract() {
  if (ui.navigating) return;
  if (zoom.state === "idle" && zoom.pos === 0) return;
  ui.pendingRoute = null;
  screen.setMode("menu");
  retargetZoom(0, "pulling_out");
}

/** Re-aims from wherever the camera currently is, so a mid-travel reversal is
 *  smooth rather than snapping, and travel speed stays constant. */
function retargetZoom(target, state) {
  zoom.start = zoom.pos;
  zoom.target = target;
  zoom.elapsed = 0;
  zoom.state = state;
  const span = Math.abs(target - zoom.start);
  const duration =
    state === "pulling_out" ? TIMING.zoomOutDuration : TIMING.zoomDuration;
  zoom.duration = reducedMotion ? 1 : Math.max(140, duration * span);
  if (ui.inlineShell && target === 1) {
    document.getElementById("homepage-hero")?.classList.add("homepage-hero--zooming");
  }
  wakeLoop();
}

/* ------------------------------------------------------------------ *
 * 5. ANIMATION
 * ------------------------------------------------------------------ */

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function updateZoom(dt) {
  if (zoom.state === "idle") return;
  zoom.elapsed += dt;
  const t = Math.min(zoom.elapsed / zoom.duration, 1);
  const eased = zoom.state === "pulling_out" ? easeInOutQuad(t) : easeInOutCubic(t);
  zoom.pos = zoom.start + (zoom.target - zoom.start) * eased;

  // Swap the on-screen menu for the destination's opening state partway in, so
  // the document swap reads as the screen changing content, not a page load.
  if (zoom.target === 1 && zoom.pos > 0.45) screen.setMode("opening");

  if (t >= 1) {
    zoom.pos = zoom.target;
    zoom.state = "idle";
    if (zoom.target === 1 && ui.pendingRoute) finishZoomIn();
    if (zoom.target === 0) {
      if (ui.pendingRoute) finishZoomOut();
      document.getElementById("homepage-hero")?.classList.remove("homepage-hero--zooming");
    }
  }
}

/** Full navigation is now only a fallback for direct-loaded pages or failed
 * inline requests. The homepage keeps its live WebGL scene across routes. */
function navigate() {
  if (ui.navigating) return;
  ui.navigating = true;
  window.location.href = ui.pendingRoute;
}

function updateSecondary(dt) {
  // real rotational inertia on the dial; selection stays discrete
  wheelState.velocity *= TIMING.dialDamping;
  wheelState.angle += wheelState.velocity * dt * 0.00022;

  indicator.x += (indicator.targetX - indicator.x) * TIMING.indicatorEase;
  if (Math.abs(indicator.targetX - indicator.x) > 0.0005) screen.markDirty();
  else indicator.x = indicator.targetX;

  pointer.x += (pointer.targetX - pointer.x) * TIMING.pointerEase;
  pointer.y += (pointer.targetY - pointer.y) * TIMING.pointerEase;

  press.shutter += (press.shutterTarget - press.shutter) * TIMING.pressEase;
  press.menu += (press.menuTarget - press.menu) * TIMING.pressEase;
  press.dpad += (press.dpadTarget - press.dpad) * TIMING.pressEase;

  Object.keys(hover).forEach((k) => {
    hover[k] += ((hoverName === k ? 1 : 0) - hover[k]) * 0.18;
  });

  dpadTilt.x += (dpadTilt.targetX - dpadTilt.x) * 0.3;
  dpadTilt.y += (dpadTilt.targetY - dpadTilt.y) * 0.3;
}

/* ------------------------------------------------------------------ *
 * 6. LCD — canvas texture, redrawn whenever the selection moves
 * ------------------------------------------------------------------ */

const screen = (() => {
  const W = 1372;
  const H = 1044; // matches LCD_W : LCD_H
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  let dirty = true;
  let mode = "menu"; // "menu" | "opening"
  const FONT = '"Courier New", Courier, monospace';

  const L = {
    title: 184,
    iconY: 414,
    labelY: 642,
    caretY: 574,
    underlineY: 676,
    dividerY: 758,
    captionY: 842,
    openY: 955,
    startX: 300,
    spread: 386,
  };

  function tracked(text, cx, y, size, weight, spacing, color) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.fillStyle = color;
    const chars = [...text];
    let total = -spacing;
    chars.forEach((c) => (total += ctx.measureText(c).width + spacing));
    let x = cx - total / 2;
    chars.forEach((c) => {
      ctx.fillText(c, x, y);
      x += ctx.measureText(c).width + spacing;
    });
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function iconResume(cx, cy, s) {
    const w = 78 * s;
    const h = 100 * s;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const fold = 21 * s;
    ctx.lineWidth = 4.4 * s;
    ctx.strokeStyle = CSS.ink;
    ctx.fillStyle = CSS.lcd;
    ctx.beginPath();
    ctx.moveTo(x + 5 * s, y);
    ctx.lineTo(x + w - fold, y);
    ctx.lineTo(x + w, y + fold);
    ctx.lineTo(x + w, y + h - 5 * s);
    ctx.quadraticCurveTo(x + w, y + h, x + w - 5 * s, y + h);
    ctx.lineTo(x + 5 * s, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - 5 * s);
    ctx.lineTo(x, y + 5 * s);
    ctx.quadraticCurveTo(x, y, x + 5 * s, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + w - fold, y);
    ctx.lineTo(x + w - fold, y + fold);
    ctx.lineTo(x + w, y + fold);
    ctx.stroke();
    ctx.fillStyle = CSS.gold;
    ctx.fillRect(x + 13 * s, y + 21 * s, 35 * s, 12 * s);
    ctx.fillStyle = CSS.ink;
    [44, 57, 70].forEach((oy, i) => {
      ctx.fillRect(x + 13 * s, y + oy * s, (i === 2 ? 33 : 51) * s, 5 * s);
    });
  }

  function iconBlog(cx, cy, s) {
    const w = 84 * s;
    const h = 100 * s;
    const x = cx - w / 2;
    const y = cy - h / 2;
    ctx.lineWidth = 4.4 * s;
    ctx.strokeStyle = CSS.ink;
    ctx.fillStyle = CSS.lcd;
    roundRect(x, y + 4 * s, w - 9 * s, h - 4 * s, 6 * s);
    ctx.fill();
    ctx.stroke();
    roundRect(x + 10 * s, y, w - 10 * s, h - 6 * s, 6 * s);
    ctx.fillStyle = CSS.lcd;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(48,52,58,0.07)";
    roundRect(x + 23 * s, y + 31 * s, w - 42 * s, 27 * s, 5 * s);
    ctx.fill();
    ctx.lineWidth = 3.2 * s;
    ctx.stroke();
    ctx.fillStyle = CSS.ink;
    ctx.fillRect(x + 31 * s, y + 41 * s, 27 * s, 4.4 * s);
    const bx = cx - 5 * s;
    ctx.fillStyle = CSS.gold;
    ctx.beginPath();
    ctx.moveTo(bx, y - 9 * s);
    ctx.lineTo(bx + 21 * s, y - 9 * s);
    ctx.lineTo(bx + 21 * s, y + 21 * s);
    ctx.lineTo(bx + 10.5 * s, y + 13 * s);
    ctx.lineTo(bx, y + 21 * s);
    ctx.closePath();
    ctx.fill();
  }

  function iconInfo(cx, cy, s) {
    const side = 97 * s;
    const x = cx - side / 2;
    const y = cy - side / 2;
    ctx.lineWidth = 4.4 * s;
    ctx.strokeStyle = CSS.ink;
    ctx.fillStyle = CSS.lcd;
    roundRect(x, y, side, side, 11 * s);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = CSS.gold;
    ctx.beginPath();
    ctx.arc(cx, y + 27 * s, 8.5 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = CSS.ink;
    roundRect(cx - 6.5 * s, y + 43 * s, 13 * s, 35 * s, 3 * s);
    ctx.fill();
  }

  const ICONS = { resume: iconResume, blog: iconBlog, info: iconInfo };

  function frameMarks() {
    ctx.strokeStyle = CSS.ink;
    ctx.lineWidth = 3;
    const marks = [
      [54, 54, 1, 1],
      [W - 54, 54, -1, 1],
      [54, H - 54, 1, -1],
      [W - 54, H - 54, -1, -1],
    ];
    marks.forEach(([x, y, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(x, y + dy * 28);
      ctx.lineTo(x, y);
      ctx.lineTo(x + dx * 28, y);
      ctx.stroke();
    });
  }

  function drawHeader(index) {
    tracked(`${String(index + 1).padStart(2, "0")} / 03`, 190, 82, 30, "400", 8, CSS.ink);
    tracked("MENU", W - 165, 82, 28, "400", 9, CSS.ink);
    frameMarks();
  }

  function routePath(column) {
    try {
      const path = new URL(column.url, window.location.href).pathname.replace(/\/+$/, "");
      return (path || "/").toUpperCase();
    } catch {
      return `/${column.label}`;
    }
  }

  /** What the screen shows once the lens has started pushing in: the section
   *  name laid out where the inner page puts its own title, so the handoff to
   *  the real document reads as the screen refreshing. */
  function drawOpening() {
    const col = ui.columns[ui.selectedColumn] || ui.columns[0];
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CSS.lcd;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    drawHeader(ui.selectedColumn);
    (ICONS[col.icon] || iconInfo)(W / 2, H * 0.39, 2.75);
    tracked(col.label, W / 2, H * 0.67, 94, "700", 22, CSS.gold);
    ctx.fillStyle = CSS.gold;
    ctx.fillRect(W / 2 - 170, H * 0.72, 340, 12);
    texture.needsUpdate = true;
  }

  function draw() {
    if (mode === "blank") {
      // the HTML overlay supplies the screen content on viewfinder pages
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = CSS.lcd;
      ctx.fillRect(0, 0, W, H);
      texture.needsUpdate = true;
      return;
    }
    if (mode === "opening") {
      drawOpening();
      return;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = CSS.lcd;
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    drawHeader(ui.selectedColumn);
    tracked("MENU", 190, L.title, 48, "400", 13, CSS.ink);
    ctx.strokeStyle = CSS.ink;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(74, L.title - 36);
    ctx.lineTo(74, L.title - 70);
    ctx.lineTo(116, L.title - 70);
    ctx.stroke();

    ui.columns.forEach((col, i) => {
      const cx = L.startX + L.spread * i;
      const active = Math.abs(indicator.x - i) < 0.5;
      if (active) {
        ctx.fillStyle = CSS.gold;
        roundRect(cx - 116, L.iconY - 122, 232, 218, 10);
        ctx.fill();
      }
      (ICONS[col.icon] || iconInfo)(cx, L.iconY, 2.2);
      tracked(
        col.label,
        cx,
        L.labelY,
        54,
        active ? "700" : "400",
        11,
        active ? CSS.gold : CSS.ink,
      );
    });

    const ix = L.startX + L.spread * indicator.x;
    ctx.fillStyle = CSS.gold;
    ctx.beginPath();
    ctx.moveTo(ix, L.caretY - 24);
    ctx.lineTo(ix - 23, L.caretY + 12);
    ctx.lineTo(ix + 23, L.caretY + 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(ix - 112, L.underlineY, 224, 11);

    ctx.fillStyle = CSS.faint;
    ctx.fillRect(96, L.dividerY, W - 192, 2);

    const col = ui.columns[Math.round(indicator.x)] || ui.columns[0];
    tracked(routePath(col), W / 2, L.captionY, 43, "400", 7, CSS.ink);

    ctx.fillStyle = CSS.gold;
    ctx.fillRect(W / 2 - 250, L.openY - 62, 500, 86);
    tracked(`${col.label}  ↗`, W / 2, L.openY, 45, "700", 8, CSS.dark);

    ctx.strokeStyle = CSS.ink;
    ctx.lineWidth = 2;
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.moveTo(110 + i * 18, 920);
      ctx.lineTo(175 + i * 18, 855);
      ctx.stroke();
    }

    const pageIndex = Math.round(indicator.x);
    for (let i = 0; i < ui.columns.length; i++) {
      ctx.fillStyle = i === pageIndex ? CSS.gold : CSS.faint;
      ctx.fillRect(W - 258 + i * 52, 886, 28, 28);
    }

    texture.needsUpdate = true;
  }

  return {
    texture,
    setMode(next) {
      if (mode === next) return;
      mode = next;
      dirty = true;
    },
    markDirty() {
      dirty = true;
    },
    tick() {
      if (!dirty) return;
      draw();
      dirty = false;
    },
  };
})();

/* ------------------------------------------------------------------ *
 * 7. GEOMETRY HELPERS
 * ------------------------------------------------------------------ */

function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x + r, y + h);
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  return s;
}

/** Rounded only on the right, so the control column merges into the shell
 *  instead of reading as a separate block sitting on top of it. */
function rightRoundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0);
  s.lineTo(x + w, y + h - r);
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  s.lineTo(x, y + h);
  s.lineTo(x, y);
  return s;
}

/** Bevelled slab — reads as a real moulded plastic part under lighting. */
function slab(w, h, r, depth, material, bevel = 0.05) {
  const geo = new THREE.ExtrudeGeometry(roundedShape(w, h, r), {
    depth: Math.max(depth - bevel * 2, 0.01),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 4,
    curveSegments: 24,
  });
  geo.center();
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

/**
 * A slab with a rectangular window cut through it. `offset` moves the hole
 * within the outline, which is what lets the shell carry an off-centre screen
 * aperture so the LCD and CCD can sit genuinely inside the body.
 */
function frame(w, h, r, holeW, holeH, holeR, depth, material, offset = { x: 0, y: 0 }) {
  const shape = roundedShape(w, h, r);
  const hole = roundedShape(holeW, holeH, holeR);
  const pts = hole.getPoints(48).map((p) => new THREE.Vector2(p.x + offset.x, p.y + offset.y));
  shape.holes.push(new THREE.Path(pts.reverse()));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.025,
    bevelSize: 0.025,
    bevelSegments: 3,
    curveSegments: 24,
  });
  geo.center();
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

function matte(color, extra = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.02,
    ...extra,
  });
}

/* A small deterministic material lab for the camera's aged finish. Keeping the
 * textures procedural means there is still no model/texture asset to load, and
 * the first rendered frame cannot be held up by another network request. */
const finishTextureCache = new Map();

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function colorChannels(color) {
  return {
    r: (color >> 16) & 255,
    g: (color >> 8) & 255,
    b: color & 255,
  };
}

function clampChannel(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function finishTexture(texture, colorSpace) {
  texture.colorSpace = colorSpace;
  texture.anisotropy = renderer
    ? Math.min(4, renderer.capabilities.getMaxAnisotropy())
    : 1;
  return texture;
}

function agedColorTexture(color, seed, wear, yellowing) {
  const key = `color-${color}-${seed}-${wear}-${yellowing}`;
  if (finishTextureCache.has(key)) return finishTextureCache.get(key);

  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const base = colorChannels(color);
  const random = seededRandom(seed);
  const waves = Array.from({ length: 3 }, () => ({
    angle: random() * Math.PI * 2,
    frequency: 0.012 + random() * 0.022,
    phase: random() * Math.PI * 2,
  }));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cloud = 0;
      waves.forEach((wave) => {
        const axis = x * Math.cos(wave.angle) + y * Math.sin(wave.angle);
        cloud += Math.sin(axis * wave.frequency + wave.phase);
      });
      cloud /= waves.length;

      const grain = (random() - 0.5) * wear * 2.8;
      const warmth = yellowing * (1.5 + (cloud + 1) * 2.2);
      const shadow = wear * Math.max(0, -cloud) * 2.2;
      const offset = (y * size + x) * 4;
      image.data[offset] = clampChannel(base.r + grain + warmth * 0.48 - shadow);
      image.data[offset + 1] = clampChannel(base.g + grain + warmth * 0.12 - shadow);
      image.data[offset + 2] = clampChannel(base.b + grain - warmth * 0.85 - shadow);
      image.data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Uneven amber drift: aged ABS does not yellow uniformly.
  for (let i = 0; i < 4; i++) {
    const x = random() * size;
    const y = random() * size;
    const radius = 28 + random() * 62;
    const stain = ctx.createRadialGradient(x, y, 0, x, y, radius);
    stain.addColorStop(0, `rgba(177, 116, 27, ${0.06 * yellowing})`);
    stain.addColorStop(1, "rgba(190, 137, 48, 0)");
    ctx.fillStyle = stain;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  const texture = finishTexture(new THREE.CanvasTexture(canvas), THREE.SRGBColorSpace);
  finishTextureCache.set(key, texture);
  return texture;
}

const agedSurfaceProfiles = {
  body: {
    seed: 1701,
    base: 239,
    grain: 0.28,
    micro: 34,
  },
  grip: {
    seed: 2701,
    base: 235,
    grain: 0.44,
    micro: 48,
  },
  control: {
    seed: 3701,
    base: 243,
    grain: 0.16,
    micro: 12,
  },
  painted: {
    seed: 4701,
    base: 247,
    grain: 0.08,
    micro: 0,
  },
};

function agedSurfaceTexture(profileName) {
  const profile = agedSurfaceProfiles[profileName] || agedSurfaceProfiles.body;
  const key = `surface-${profileName}`;
  if (finishTextureCache.has(key)) return finishTextureCache.get(key);

  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(size, size);
  const random = seededRandom(profile.seed);
  const phaseX = random() * Math.PI * 2;
  const phaseY = random() * Math.PI * 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const broad =
        Math.sin(x * 0.035 + phaseX) * 2.2 +
        Math.sin(y * 0.043 + phaseY) * 1.6 +
        Math.sin((x + y) * 0.021 + phaseX - phaseY);
      const grain = (random() - 0.5) * 20 * profile.grain;
      const value = clampChannel(profile.base + broad + grain);
      const offset = (y * size + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  function mouldPore(x, y, radius, depth) {
    const pit = ctx.createRadialGradient(x, y, 0, x, y, radius);
    pit.addColorStop(0, `rgba(24, 24, 24, ${depth})`);
    pit.addColorStop(0.55, `rgba(76, 76, 76, ${depth * 0.5})`);
    pit.addColorStop(0.76, `rgba(255, 255, 255, ${depth * 0.2})`);
    pit.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = pit;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Injection-moulded texture is fine and shallow. It is not a field of impact
  // craters; the larger dings belong only on exposed edges.
  for (let i = 0; i < profile.micro; i++) {
    mouldPore(
      random() * size,
      random() * size,
      0.25 + random() * 0.55,
      0.055 + random() * 0.065,
    );
  }

  const texture = finishTexture(new THREE.CanvasTexture(canvas), THREE.NoColorSpace);
  finishTextureCache.set(key, texture);
  return texture;
}

function agedMatte(
  color,
  seed,
  {
    wear = 0.5,
    yellowing = 0.08,
    roughness = 0.84,
    metalness = 0.01,
    bumpScale = 0.008,
    surface = "body",
    ...extra
  } = {},
) {
  const surfaceTexture = agedSurfaceTexture(surface);
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: agedColorTexture(color, seed, wear, yellowing),
    roughness,
    bumpMap: surfaceTexture,
    bumpScale,
    metalness,
    ...extra,
  });
}

/* ------------------------------------------------------------------ *
 * 8. SCENE
 * ------------------------------------------------------------------ */

let renderer, scene, sceneCamera, rig, bodyGroup;
const restCamera = new THREE.Vector3();
const zoomTarget = new THREE.Vector3();
let dial, shutter, menuBtn, lcdMesh, lcdMaterial, rightControls;
let shellFadeMaterials = [];
const hotspots = {};

function buildCamera() {
  bodyGroup = new THREE.Group();

  const mBody = agedMatte(C.body, 11, {
    wear: 0.5,
    yellowing: 0.12,
    roughness: 0.9,
    bumpScale: 0.008,
    surface: "body",
  });
  const mShade = agedMatte(C.bodyShade, 23, {
    wear: 0.46,
    yellowing: 0.08,
    roughness: 0.91,
    bumpScale: 0.007,
    surface: "body",
  });
  const mEdge = agedMatte(C.bodyEdge, 37, {
    wear: 0.52,
    yellowing: 0.05,
    roughness: 0.93,
    bumpScale: 0.006,
    surface: "grip",
  });
  const mGrip = agedMatte(C.grip, 49, {
    wear: 0.62,
    yellowing: 0.04,
    roughness: 0.94,
    bumpScale: 0.009,
    surface: "grip",
  });
  const mGripDark = agedMatte(C.gripDark, 61, {
    wear: 0.62,
    yellowing: 0.03,
    roughness: 0.93,
    bumpScale: 0.008,
    surface: "grip",
  });
  const mBezel = agedMatte(C.bezel, 73, {
    wear: 0.16,
    yellowing: 0,
    roughness: 0.66,
    bumpScale: 0.001,
    surface: "painted",
  });
  const mDpad = agedMatte(C.dpad, 89, {
    wear: 0.32,
    yellowing: 0,
    roughness: 0.76,
    bumpScale: 0.002,
    surface: "control",
  });
  const mControlOutline = matte(C.bezel, {
    roughness: 0.96,
    metalness: 0,
  });
  shellFadeMaterials = [mBody, mShade, mEdge, mGrip, mGripDark, mDpad];

  /* --- shell, with a real window cut for the screen --- */
  const shell = frame(
    D.bodyW,
    D.bodyH,
    D.bodyR,
    D.screenW,
    D.screenH,
    0.17,
    D.bodyD,
    mBody,
    { x: D.screenX, y: D.screenY },
  );
  bodyGroup.add(shell);

  // solid back wall behind the screen so the aperture is a recess, not a hole
  const backWall = slab(D.screenW, D.screenH, 0.17, 0.05, mBezel, 0);
  backWall.position.set(D.screenX, D.screenY, 0.14);
  bodyGroup.add(backWall);

  // right-hand control column: flush with the shell, only a hair proud, so it
  // reads as a moulding seam rather than a separate block
  // Slightly shorter than the shell: at full height its rounded top corner
  // pokes above the body silhouette and reads as a raised block.
  const panelGeo = new THREE.ExtrudeGeometry(
    rightRoundedShape(D.panelW, D.bodyH - 0.12, D.bodyR - 0.04),
    {
      depth: D.bodyD - 0.24,
      bevelEnabled: true,
      bevelThickness: 0.055,
      bevelSize: 0.055,
      bevelSegments: 4,
      curveSegments: 24,
    },
  );
  panelGeo.center();
  panelGeo.computeVertexNormals();
  const panel = new THREE.Mesh(panelGeo, mShade);
  panel.position.set(D.bodyW / 2 - D.panelW / 2, 0, 0.008);
  bodyGroup.add(panel);

  const seam = slab(0.018, D.bodyH - 0.5, 0.009, D.bodyD + 0.05, mEdge, 0);
  seam.position.set(D.bodyW / 2 - D.panelW, 0, 0.02);
  bodyGroup.add(seam);

  // Printed registration details live on the actual camera body, so they
  // inherit its perspective and motion instead of floating in the page UI.
  const topLegend = decalPlane(cameraTopLegend(), 3.05, 0.25);
  topLegend.position.set(D.screenX, D.screenY + D.screenH / 2 + 0.215, D.bodyD / 2 + 0.04);
  bodyGroup.add(topLegend);

  const serialLegend = decalPlane(cameraSerialLegend(), 1.02, 0.34);
  serialLegend.position.set(D.panelX, 1.275, D.bodyD / 2 + 0.04);
  bodyGroup.add(serialLegend);

  /* --- screen: a real recessed well --- */
  const bezel = frame(
    D.screenW,
    D.screenH,
    0.17,
    LCD_W,
    LCD_H,
    0.05,
    0.3,
    mBezel,
  );
  // the bezel ring fills the aperture and stops flush with the body face
  bezel.position.set(D.screenX, D.screenY, D.bodyD / 2 - 0.15);
  bodyGroup.add(bezel);

  lcdMaterial = new THREE.MeshBasicMaterial({
    map: screen.texture,
    transparent: true,
  });
  lcdMesh = new THREE.Mesh(new THREE.PlaneGeometry(LCD_W, LCD_H), lcdMaterial);
  // recessed well below the bezel lip, but in front of the CCD
  lcdMesh.position.set(D.screenX, D.screenY, 0.2);
  bodyGroup.add(lcdMesh);

  /* --- top deck --- */
  const deckY = D.bodyH / 2;

  // the scroll dial: a genuine knurled cylinder that rotates on its own axis
  dial = new THREE.Group();

  // main band, very slightly waisted like a machined knurl
  const dialBody = new THREE.Mesh(
    new THREE.CylinderGeometry(D.dialR, D.dialR * 0.985, D.dialH, 64),
    mBody,
  );
  dial.add(dialBody);

  // chamfered top rim, so the edge catches the key light
  const rimTop = new THREE.Mesh(
    new THREE.CylinderGeometry(D.dialR * 0.9, D.dialR, 0.035, 64),
    mShade,
  );
  rimTop.position.y = D.dialH / 2 + 0.017;
  dial.add(rimTop);

  // fine knurling: many thin flutes rather than a few chunky ribs
  const RIBS = 44;
  const ribGeo = new THREE.BoxGeometry(0.016, D.dialH * 0.9, 0.032);
  const mRib = agedMatte(C.bodyEdge, 101, {
    wear: 0.48,
    yellowing: 0.02,
    roughness: 0.72,
    bumpScale: 0.003,
    surface: "grip",
  });
  for (let i = 0; i < RIBS; i++) {
    const a = (i / RIBS) * Math.PI * 2;
    const rib = new THREE.Mesh(ribGeo, mRib);
    rib.position.set(Math.cos(a) * D.dialR, 0, Math.sin(a) * D.dialR);
    rib.rotation.y = -a;
    dial.add(rib);
  }

  // recessed top face
  const dialCap = new THREE.Mesh(
    new THREE.CylinderGeometry(D.dialR * 0.86, D.dialR * 0.86, D.dialH * 0.6, 48),
    mShade,
  );
  dialCap.position.y = 0.012;
  dial.add(dialCap);
  // sit the wheel just above the deck: visible and grabbable, but not towering
  dial.position.set(D.dialX, deckY + D.dialH * 0.34, -0.04);
  bodyGroup.add(dial);
  hotspots.dial = dial;

  // flat lever sitting on the deck, top left
  const leverOutline = slab(0.828, 0.166, 0.07, 0.25, mControlOutline, 0.01);
  leverOutline.position.set(-1.5, deckY + 0.012, -0.06);
  bodyGroup.add(leverOutline);
  const lever = slab(0.8, 0.15, 0.055, 0.3, mGrip, 0.012);
  lever.position.set(-1.5, deckY + 0.04, -0.06);
  bodyGroup.add(lever);

  // small round button right of the dial, standing directly on the deck
  const topBtn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.18, 32),
    mGrip,
  );
  topBtn.position.set(1.86, deckY + 0.085, -0.04);
  bodyGroup.add(topBtn);

  // strap lug on the left edge
  const lug = slab(0.15, 0.58, 0.06, 0.34, mGripDark, 0.03);
  lug.position.set(-D.bodyW / 2 - 0.02, -0.3, 0);
  bodyGroup.add(lug);

  /* --- right-hand controls --- */
  // Grouped so they can be hidden once the lens is pushed in: they'd otherwise
  // peek into the frame from the right edge on wide viewports.
  rightControls = new THREE.Group();
  bodyGroup.add(rightControls);
  const cx = D.panelX;
  const face = D.bodyD / 2 + 0.06;

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.334, 0.334, 0.1, 48),
    agedMatte(C.shutterRim, 113, {
      wear: 0.34,
      yellowing: 0.01,
      roughness: 0.7,
      bumpScale: 0.002,
      surface: "painted",
    }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(cx, D.shutterY, face);
  rightControls.add(rim);

  shutter = new THREE.Group();
  const shutterFace = new THREE.Mesh(
    new THREE.CylinderGeometry(0.315, 0.315, 0.17, 48),
    agedMatte(C.shutter, 127, {
      wear: 0.24,
      yellowing: 0,
      roughness: 0.5,
      bumpScale: 0.001,
      surface: "control",
    }),
  );
  shutterFace.rotation.x = Math.PI / 2;
  shutter.add(shutterFace);

  const ghostMark = decalPlane(ghostButtonTexture(), 0.34, 0.34);
  ghostMark.position.z = 0.091;
  ghostMark.renderOrder = 6;
  shutter.add(ghostMark);

  shutter.position.set(cx, D.shutterY, face + 0.07);
  rightControls.add(shutter);
  hotspots.shutter = shutter;

  // d-pad
  const dpad = new THREE.Group();
  const dpadOutline = new THREE.Mesh(
    new THREE.CylinderGeometry(0.434, 0.434, 0.105, 48),
    mControlOutline,
  );
  dpadOutline.rotation.x = Math.PI / 2;
  dpadOutline.position.z = -0.016;
  dpad.add(dpadOutline);
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(0.405, 0.42, 0.13, 64),
    mDpad,
  );
  ring.rotation.x = Math.PI / 2;
  dpad.add(ring);
  const hubOutline = new THREE.Mesh(
    new THREE.CylinderGeometry(0.158, 0.158, 0.15, 32),
    mControlOutline,
  );
  hubOutline.rotation.x = Math.PI / 2;
  hubOutline.position.z = 0.035;
  dpad.add(hubOutline);
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.132, 0.145, 0.16, 48),
    agedMatte(C.hub, 139, {
      wear: 0.28,
      yellowing: 0,
      roughness: 0.72,
      bumpScale: 0.002,
      surface: "control",
    }),
  );
  hub.rotation.x = Math.PI / 2;
  hub.position.z = 0.05;
  dpad.add(hub);
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.068);
  arrowShape.lineTo(-0.06, -0.044);
  arrowShape.lineTo(0.06, -0.044);
  arrowShape.closePath();
  const arrowGeo = new THREE.ShapeGeometry(arrowShape);
  const mArrow = new THREE.MeshBasicMaterial({
    color: C.dpadArrow,
    toneMapped: false,
  });
  [0, 1, 2, 3].forEach((i) => {
    const a = (i * Math.PI) / 2;
    const arrow = new THREE.Mesh(arrowGeo, mArrow);
    arrow.position.set(Math.cos(a) * 0.275, Math.sin(a) * 0.275, 0.068);
    arrow.rotation.z = a - Math.PI / 2;
    dpad.add(arrow);
  });
  dpad.position.set(cx, D.dpadY, face);
  rightControls.add(dpad);
  hotspots.dpad = dpad;

  // MENU legend + pill
  const legend = new THREE.Mesh(
    new THREE.PlaneGeometry(0.72, 0.2),
    new THREE.MeshBasicMaterial({ map: menuLegend(), transparent: true }),
  );
  legend.position.set(cx, D.menuY + 0.235, D.bodyD / 2 + 0.095);
  rightControls.add(legend);

  // A capsule, not an extruded rounded rect: the extrusion's bevel self-
  // intersects where the corner arcs meet and leaves a stray tab on one edge.
  // Flattened in z so it still reads as a flat pill button.
  const menuOutlineGeo = new THREE.CapsuleGeometry(0.116, 0.386, 10, 28);
  menuOutlineGeo.rotateZ(Math.PI / 2);
  const menuOutline = new THREE.Mesh(menuOutlineGeo, mControlOutline);
  menuOutline.scale.z = 0.55;
  menuOutline.position.set(cx, D.menuY, face + 0.004);
  rightControls.add(menuOutline);

  const menuGeo = new THREE.CapsuleGeometry(0.105, 0.38, 10, 28);
  menuGeo.rotateZ(Math.PI / 2);
  menuBtn = new THREE.Mesh(menuGeo, mDpad);
  menuBtn.scale.z = 0.55;
  menuBtn.position.set(cx, D.menuY, face + 0.02);
  rightControls.add(menuBtn);
  hotspots.menu = menuBtn;

  return bodyGroup;
}

function menuLegend() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 142;
  const g = c.getContext("2d");
  g.clearRect(0, 0, c.width, c.height);
  g.font = '400 84px "Courier New", Courier, monospace';
  g.fillStyle = CSS.dark;
  g.textBaseline = "middle";
  const chars = [..."MENU"];
  const sp = 10;
  let total = -sp;
  chars.forEach((ch) => (total += g.measureText(ch).width + sp));
  let x = (c.width - total) / 2;
  chars.forEach((ch) => {
    g.fillText(ch, x, c.height / 2 + 4);
    x += g.measureText(ch).width + sp;
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function decalPlane(texture, width, height) {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.renderOrder = 4;
  return mesh;
}

function drawDecalText(ctx, text, x, y, spacing, color = "#171918") {
  ctx.fillStyle = color;
  let cursor = x;
  [...text].forEach((character) => {
    ctx.fillText(character, cursor, y);
    cursor += ctx.measureText(character).width + spacing;
  });
}

function cameraTopLegend() {
  const canvas = document.createElement("canvas");
  canvas.width = 1800;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";

  ctx.font = '600 55px "Courier New", Courier, monospace';
  drawDecalText(ctx, "SLI-23", 28, 82, 7);
  ctx.fillStyle = "rgba(23,25,24,0.52)";
  ctx.fillRect(390, 42, 2, 80);

  ctx.font = '500 43px "Courier New", Courier, monospace';
  drawDecalText(ctx, "CCD", 448, 82, 11);
  drawDecalText(ctx, "01 / 03", 730, 82, 8);

  ctx.strokeStyle = "#171918";
  ctx.lineWidth = 6;
  ctx.strokeRect(1640, 49, 58, 58);
  ctx.fillStyle = "#171918";
  ctx.fillRect(1640, 49, 29, 29);
  ctx.fillRect(1669, 78, 29, 29);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function cameraSerialLegend() {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 300;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";
  ctx.font = '600 58px "Courier New", Courier, monospace';
  drawDecalText(ctx, "S/N 0023", 90, 150, 8);

  ctx.strokeStyle = "#171918";
  ctx.lineWidth = 8;
  const mark = 58;
  const inset = 24;
  [
    [inset, inset, 1, 1],
    [canvas.width - inset, inset, -1, 1],
    [inset, canvas.height - inset, 1, -1],
    [canvas.width - inset, canvas.height - inset, -1, -1],
  ].forEach(([x, y, dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * mark);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * mark, y);
    ctx.stroke();
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function ghostButtonTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.beginPath();
  ctx.moveTo(62, 204);
  ctx.lineTo(62, 119);
  ctx.bezierCurveTo(62, 68, 91, 42, 128, 42);
  ctx.bezierCurveTo(165, 42, 194, 68, 194, 119);
  ctx.lineTo(194, 204);
  ctx.quadraticCurveTo(178, 184, 162, 204);
  ctx.quadraticCurveTo(145, 181, 128, 204);
  ctx.quadraticCurveTo(111, 181, 94, 204);
  ctx.quadraticCurveTo(78, 184, 62, 204);
  ctx.closePath();
  ctx.fillStyle = "#f2eee5";
  ctx.fill();
  ctx.strokeStyle = "#101312";
  ctx.lineWidth = 9;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.fillStyle = "#101312";
  ctx.beginPath();
  ctx.ellipse(103, 119, 9, 13, 0, 0, Math.PI * 2);
  ctx.ellipse(153, 119, 9, 13, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.arc(128, 157, 8, 0, Math.PI * 2);
  ctx.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ------------------------------------------------------------------ *
 * 9. INPUT
 * ------------------------------------------------------------------ */

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let container, canvas, drag = null;

function pick(event) {
  const rect = canvas.getBoundingClientRect();
  ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(ndc, sceneCamera);
  let best = null;
  let bestDist = Infinity;
  Object.entries(hotspots).forEach(([name, obj]) => {
    const hit = raycaster.intersectObject(obj, true)[0];
    if (hit && hit.distance < bestDist) {
      bestDist = hit.distance;
      best = name;
    }
  });
  return best;
}

function bindInput() {
  canvas.addEventListener("pointermove", (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.targetX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.targetY = ((e.clientY - rect.top) / rect.height) * 2 - 1;

    if (drag) {
      const dx = e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      spinDial(dx);
      return;
    }
    const over = pick(e);
    hoverName = over;
    canvas.style.cursor = over === "dial" ? "ew-resize" : over ? "pointer" : "default";
  });

  canvas.addEventListener("pointerleave", () => {
    pointer.targetX = 0;
    pointer.targetY = 0;
    hoverName = null;
    drag = null;
  });

  canvas.addEventListener("pointerdown", (e) => {
    const target = pick(e);
    if (!target) return;
    canvas.setPointerCapture(e.pointerId);
    if (target === "dial") drag = { lastX: e.clientX };
    else if (target === "shutter") {
      press.shutterTarget = 1;
      prefetch(ui.columns[ui.selectedColumn].url);
      loadViewfinderPage(ui.columns[ui.selectedColumn].url).catch(() => {});
    }
    else if (target === "menu") press.menuTarget = 1;
    else if (target === "dpad") {
      // Deliberately inert on the explore screen: it only has to feel
      // clickable, so it rocks toward the press and springs back.
      press.dpadTarget = 1;
      const c = screenCentre(hotspots.dpad);
      const r = 46; // approx pad radius on screen
      dpadTilt.targetX = Math.max(-1, Math.min((e.clientX - c.x) / r, 1));
      dpadTilt.targetY = Math.max(-1, Math.min((e.clientY - c.y) / r, 1));
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    const target = pick(e);
    press.shutterTarget = 0;
    press.menuTarget = 0;
    press.dpadTarget = 0;
    dpadTilt.targetX = 0;
    dpadTilt.targetY = 0;
    if (drag) {
      drag = null;
      return;
    }
    if (target === "shutter") shoot();
    else if (target === "menu") retract();
  });

  // Scrolling over the hero spins the dial — but only on the menu screen. On
  // viewfinder pages the wheel belongs to the page inside the LCD; this handler
  // used to preventDefault() there and swallow the scroll entirely.
  container.addEventListener(
    "wheel",
    (e) => {
      if (ui.zoomedPage) return;
      if (Math.abs(e.deltaY) < 2 && Math.abs(e.deltaX) < 2) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      spinDial(delta * 0.55);
    },
    { passive: false },
  );

  window.addEventListener("keydown", (e) => {
    // inside the viewfinder the keyboard drives the page, not the camera
    if (ui.zoomedPage) return;
    switch (e.key) {
      case "ArrowRight":
        nudgeColumn(1);
        break;
      case "ArrowLeft":
        nudgeColumn(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        press.shutterTarget = 1;
        window.setTimeout(() => (press.shutterTarget = 0), 130);
        shoot();
        break;
      case "Escape":
      case "ArrowUp":
        retract();
        break;
      default:
        break;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 10. RENDER
 * ------------------------------------------------------------------ */

const labelAnchors = {};
let screenOverlay = null;
let naturalRect = null;
const tmpVec = new THREE.Vector3();

function applyState() {
  // Push the lens toward the LCD. The rest and target positions are recomputed
  // in fitCamera(), so resizing mid-zoom stays correct.
  sceneCamera.position.lerpVectors(restCamera, zoomTarget, zoom.pos);
  lcdMaterial.opacity = 1;

  // During the push-in, a magnified strip of the cream shell used to fill the
  // viewport before the LCD arrived. Fade those neutral materials into the
  // black stage so only the bezel and screen remain visually present.
  const shellFade = THREE.MathUtils.smoothstep(zoom.pos, 0.18, 0.64);
  const shellTone = 1 - shellFade * 0.92;
  shellFadeMaterials.forEach((material) => material.color.setScalar(shellTone));

  // the dial genuinely rotates about its own axis
  dial.rotation.y = wheelState.angle;

  // buttons lift a little under the cursor and sink when pressed
  shutter.position.z =
    D.bodyD / 2 + 0.13 + hover.shutter * 0.035 - press.shutter * 0.085;
  shutter.scale.setScalar(1 + hover.shutter * 0.02 - press.shutter * 0.03);

  menuBtn.position.z = D.bodyD / 2 + 0.08 + hover.menu * 0.025 - press.menu * 0.05;
  menuBtn.scale.setScalar(1 + hover.menu * 0.02 - press.menu * 0.04);

  if (hotspots.dpad) {
    hotspots.dpad.position.z =
      D.bodyD / 2 + 0.06 + hover.dpad * 0.025 - press.dpad * 0.03;
    hotspots.dpad.rotation.y = dpadTilt.x * 0.16 * press.dpad;
    hotspots.dpad.rotation.x = -dpadTilt.y * 0.16 * press.dpad;
  }
  if (dial) dial.scale.setScalar(1 + hover.dial * 0.015);

  // Parallax fades out as we push in: at ~5 units from the LCD the full yaw
  // would swing the screen clean out of frame.
  const p = 1 - zoom.pos;
  const mobileLayout = ui.inlineShell && isMobileLayout();
  const pointerScale = mobileLayout ? 0.75 : 1;
  bodyGroup.rotation.y = pointer.x * PARALLAX.yaw * p * pointerScale;
  bodyGroup.rotation.x = pointer.y * PARALLAX.pitch * p * pointerScale;
  rig.position.x = -pointer.x * PARALLAX.rigX * p * pointerScale;
  rig.position.y = -pointer.y * PARALLAX.rigY * p * pointerScale;

  // Controls leave the frame well before the zoom lands, so hiding them keeps
  // them from clipping in at the right edge regardless of viewport aspect.
  if (rightControls) rightControls.visible = zoom.pos < 0.55;

  // the annotations would slide off screen, so retire them as the zoom starts
  container.style.setProperty("--label-opacity", String(Math.max(0, 1 - zoom.pos * 3)));
}

const lcdCorner = new THREE.Vector3();
// reused for measuring the dial's projected width (drives the arrow label)
const edgeL = new THREE.Vector3();
const edgeR = new THREE.Vector3();

// The homepage and all three viewfinder routes share one live WebGL camera.
// Route documents are fetched early and only their LCD content is committed.
const viewfinderPageCache = new Map();
const viewfinderPageRequests = new Map();
let viewfinderNavigationToken = 0;
let viewfinderCacheVersion = "1";
let homePageState = null;

function viewfinderKey(url) {
  const parsed = new URL(url, window.location.href);
  let path = parsed.pathname.replace(/\/index\.html$/, "/");
  if (!path.endsWith("/")) path += "/";
  return `${path}${parsed.search}`;
}

function viewfinderStorageKey(url) {
  return `camera-viewfinder:${viewfinderCacheVersion}:${viewfinderKey(url)}`;
}

function readStoredViewfinderPage(url) {
  try {
    const raw = sessionStorage.getItem(viewfinderStorageKey(url));
    if (!raw) return null;
    const page = JSON.parse(raw);
    return page?.screen && page?.content ? page : null;
  } catch {
    return null;
  }
}

function storeViewfinderPage(page) {
  try {
    sessionStorage.setItem(viewfinderStorageKey(page.url), JSON.stringify(page));
  } catch {
    // Memory cache still works when storage is unavailable or full.
  }
}

function readViewfinderPage(doc, url) {
  const content = doc.querySelector("[data-viewfinder-content]");
  const screenElement = doc.querySelector(".viewfinder__screen");
  if (!content || !screenElement) throw new Error(`viewfinder content missing for ${url}`);
  return {
    url: new URL(url, window.location.href).href,
    screen: screenElement.outerHTML,
    content: content.innerHTML,
    title: doc.title,
    barTitle: doc.querySelector(".vf-bar__title")?.textContent?.trim() || "",
    description: doc.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
  };
}

function cacheCurrentViewfinderPage() {
  if (!document.querySelector("[data-viewfinder-content]")) return;
  const page = readViewfinderPage(document, window.location.href);
  viewfinderPageCache.set(viewfinderKey(page.url), page);
  storeViewfinderPage(page);
  ui.currentRoute = page.url;
}

async function loadViewfinderPage(url) {
  const key = viewfinderKey(url);
  if (viewfinderPageCache.has(key)) return viewfinderPageCache.get(key);
  if (viewfinderPageRequests.has(key)) return viewfinderPageRequests.get(key);

  const stored = readStoredViewfinderPage(url);
  if (stored) {
    viewfinderPageCache.set(key, stored);
    return stored;
  }

  const request = fetch(url, {
    credentials: "same-origin",
    cache: "force-cache",
  })
    .then((response) => {
      if (!response.ok) throw new Error(`viewfinder request failed: ${response.status}`);
      return Promise.all([response.text(), response.url || url]);
    })
    .then(([html, responseUrl]) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const page = readViewfinderPage(doc, responseUrl);
      viewfinderPageCache.set(key, page);
      storeViewfinderPage(page);
      return page;
    })
    .finally(() => viewfinderPageRequests.delete(key));

  viewfinderPageRequests.set(key, request);
  return request;
}

function warmViewfinderPages() {
  ui.columns.forEach((column) => {
    prefetch(column.url);
    loadViewfinderPage(column.url).catch(() => {});
  });
}

function captureHomePageState() {
  homePageState = {
    url: window.location.href,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
  };
}

function restoreHomeMetadata() {
  if (!homePageState) return;
  document.title = homePageState.title;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute("content", homePageState.description);
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) canonical.setAttribute("href", homePageState.canonical);
}

function setViewfinderMetadata(page) {
  document.title = page.title;

  const title = document.querySelector(".vf-bar__title");
  if (title && page.barTitle) title.textContent = page.barTitle;

  const targetKey = viewfinderKey(page.url);
  document.querySelectorAll(".vf-bar__link").forEach((link) => {
    const active = viewfinderKey(link.href) === targetKey;
    link.classList.toggle("vf-bar__link--active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });

  const description = document.querySelector('meta[name="description"]');
  if (description && page.description) description.setAttribute("content", page.description);

  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && page.canonical) canonical.setAttribute("href", page.canonical);
}

function commitViewfinderPage(page, pushHistory) {
  const content = document.querySelector("[data-viewfinder-content]");
  const scroll = document.querySelector(".viewfinder__scroll");
  if (!content || !scroll) return;

  content.innerHTML = page.content;
  scroll.scrollTop = 0;
  ui.currentRoute = page.url;
  setViewfinderMetadata(page);
  requestAnimationFrame(warmArticleLinks);

  if (pushHistory) {
    const target = new URL(page.url, window.location.href);
    history.pushState({ viewfinder: true }, "", `${target.pathname}${target.search}${target.hash}`);
  }
}

function screenFromPage(page) {
  const template = document.createElement("template");
  template.innerHTML = page.screen.trim();
  const element = template.content.firstElementChild;
  if (!element?.classList.contains("viewfinder__screen")) {
    throw new Error(`invalid viewfinder screen for ${page.url}`);
  }
  return element;
}

let activeViewfinderReveal = null;

function finishViewfinderReveal({ blankScreen = true } = {}) {
  const reveal = activeViewfinderReveal;
  activeViewfinderReveal = null;
  reveal?.animations.forEach((animation) => animation.cancel());

  if (reveal?.overlay === screenOverlay) {
    screenOverlay.style.opacity = "1";
  }
  if (blankScreen) {
    screen.setMode("blank");
    screen.markDirty();
    wakeLoop();
  }
}

function revealViewfinderPage() {
  if (!screenOverlay || reducedMotion) {
    finishViewfinderReveal();
    return;
  }

  const overlay = screenOverlay;
  const scroll = overlay.querySelector(".viewfinder__scroll");
  const duration = 260;
  const easing = "cubic-bezier(0.22, 0.68, 0.2, 1)";
  const animations = [
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration,
      easing,
      fill: "both",
    }),
  ];

  if (scroll) {
    animations.push(
      scroll.animate(
        [
          { opacity: 0.72, transform: "translateY(7px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration, easing, fill: "both" },
      ),
    );
  }

  const reveal = { overlay, animations };
  activeViewfinderReveal = reveal;
  Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (
      activeViewfinderReveal === reveal &&
      screenOverlay === overlay &&
      ui.inlineViewfinder &&
      zoom.state === "idle" &&
      zoom.pos === 1
    ) {
      finishViewfinderReveal();
    }
  });
}

function enterInlineViewfinder(page, pushHistory) {
  screenOverlay?.remove();
  screenOverlay = screenFromPage(page);
  container.appendChild(screenOverlay);

  container.classList.add("viewfinder", "camera-hero--zoomed");
  container.dataset.zoomed = "true";

  ui.zoomedPage = true;
  ui.inlineViewfinder = true;
  ui.currentRoute = page.url;
  ui.pendingRoute = null;
  ui.pendingPagePromise = null;
  ui.navigating = false;

  naturalRect = null;
  layoutScreenOverlay();
  setViewfinderMetadata(page);
  revealViewfinderPage();
  requestAnimationFrame(warmArticleLinks);

  if (pushHistory) {
    const target = new URL(page.url, window.location.href);
    history.pushState(
      { cameraView: "viewfinder" },
      "",
      `${target.pathname}${target.search}${target.hash}`,
    );
  }
  wakeLoop();
}

function leaveInlineViewfinder(pushHistory) {
  finishViewfinderReveal({ blankScreen: false });
  screenOverlay?.remove();
  screenOverlay = null;
  naturalRect = null;

  container.classList.remove("viewfinder", "camera-hero--zoomed");
  delete container.dataset.zoomed;
  screen.setMode("menu");
  screen.markDirty();

  ui.zoomedPage = false;
  ui.inlineViewfinder = false;
  ui.currentRoute = null;
  ui.pendingRoute = null;
  ui.pendingPagePromise = null;
  ui.navigating = false;
  restoreHomeMetadata();

  if (pushHistory && homePageState) {
    const target = new URL(homePageState.url);
    history.pushState(
      { cameraView: "home" },
      "",
      `${target.pathname}${target.search}${target.hash}`,
    );
  }
  wakeLoop();
}

function finishZoomIn() {
  if (!ui.inlineShell) {
    navigate();
    return;
  }
  if (ui.navigating) return;

  ui.navigating = true;
  const route = ui.pendingRoute;
  const request = ui.pendingPagePromise || loadViewfinderPage(route);
  request
    .then((page) => {
      if (route !== ui.pendingRoute) return;
      enterInlineViewfinder(page, ui.pendingHistory);
    })
    .catch((err) => {
      console.warn("camera-hero: inline entry failed", err);
      ui.navigating = false;
      window.location.href = route;
    });
}

function finishZoomOut() {
  if (ui.inlineViewfinder) {
    leaveInlineViewfinder(ui.pendingHistory);
  } else {
    navigate();
  }
}

function startHomeReturnMotion() {
  const hero = document.getElementById("homepage-hero");
  if (!hero) return;

  window.clearTimeout(homeReturnMotionTimer);
  hero.classList.add("homepage-hero--returning");
  homeReturnMotionTimer = window.setTimeout(
    () => hero.classList.remove("homepage-hero--returning"),
    reducedMotion ? 160 : 1080,
  );
}

function beginViewfinderExit(url, { pushHistory = true } = {}) {
  if (ui.navigating || zoom.state !== "idle") return;
  if (!ui.inlineShell) {
    try {
      sessionStorage.setItem("camera-skip-home-entry:v1", "1");
    } catch {
      // Returning home still works when session storage is unavailable.
    }
  } else {
    // Reveal the homepage atmosphere while the camera is still pulling back.
    // This bridges the old gap where the complete camera appeared first and
    // the backdrop popped in only after the zoom animation had finished.
    startHomeReturnMotion();
  }
  finishViewfinderReveal({ blankScreen: false });
  pointer.x = 0;
  pointer.y = 0;
  pointer.targetX = 0;
  pointer.targetY = 0;
  hoverName = null;
  ui.pendingRoute = url;
  ui.pendingHistory = pushHistory;
  ui.pendingPagePromise = null;
  screen.setMode("menu");
  retargetZoom(0, "pulling_out");
}

function beginInlineEntry(url, { pushHistory = true } = {}) {
  if (!ui.inlineShell || ui.navigating || zoom.state !== "idle") return;
  const targetKey = viewfinderKey(url);
  const index = ui.columns.findIndex((column) => viewfinderKey(column.url) === targetKey);
  if (index >= 0) {
    ui.selectedColumn = index;
    wheelState.notch = index;
    indicator.x = index;
    indicator.targetX = index;
    screen.markDirty();
  }
  ui.pendingRoute = url;
  ui.pendingHistory = pushHistory;
  ui.pendingPagePromise = loadViewfinderPage(url);
  ui.pendingPagePromise.catch(() => {});
  retargetZoom(1, "pushing_in");
}

async function navigateViewfinder(url, { pushHistory = true } = {}) {
  const targetKey = viewfinderKey(url);
  if (ui.currentRoute && targetKey === viewfinderKey(ui.currentRoute)) {
    const scroll = document.querySelector(".viewfinder__scroll");
    if (scroll) scroll.scrollTop = 0;
    return;
  }

  const token = ++viewfinderNavigationToken;
  try {
    const page = await loadViewfinderPage(url);
    if (token !== viewfinderNavigationToken) return;
    commitViewfinderPage(page, pushHistory);
  } catch (err) {
    console.warn("camera-hero: inline viewfinder navigation failed", err);
    window.location.href = url;
  }
}

const articlePageCache = new Map();
const articlePageRequests = new Map();
let articleReader = null;
let articleReaderNavigationToken = 0;
let articleReaderReturnHome = false;

function articleKey(url) {
  const parsed = new URL(url, window.location.href);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function readArticlePage(doc, url) {
  const source = doc.querySelector(".post");
  if (!source) throw new Error(`article content missing for ${url}`);

  const post = source.cloneNode(true);
  post.querySelector(".breadcrumb-nav")?.remove();
  post.querySelectorAll("script").forEach((script) => script.remove());
  return {
    url: new URL(url, window.location.href).href,
    html: post.outerHTML,
    title: doc.title,
    description: doc.querySelector('meta[name="description"]')?.getAttribute("content") || "",
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || "",
  };
}

async function loadArticlePage(url) {
  const key = articleKey(url);
  if (articlePageCache.has(key)) return articlePageCache.get(key);
  if (articlePageRequests.has(key)) return articlePageRequests.get(key);

  const request = fetch(url, { credentials: "same-origin", cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error(`article request failed: ${response.status}`);
      return Promise.all([response.text(), response.url || url]);
    })
    .then(([html, responseUrl]) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const page = readArticlePage(doc, responseUrl);
      articlePageCache.set(key, page);
      return page;
    })
    .finally(() => articlePageRequests.delete(key));

  articlePageRequests.set(key, request);
  return request;
}

function warmArticleLinks() {
  document.querySelectorAll("a.post-title, .post-navigation a").forEach((link) => {
    loadArticlePage(link.href).catch(() => {});
  });
}

function setArticleMetadata(page) {
  document.title = page.title;
  const description = document.querySelector('meta[name="description"]');
  if (description && page.description) description.setAttribute("content", page.description);
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && page.canonical) canonical.setAttribute("href", page.canonical);
}

function restoreViewfinderMetadata() {
  if (!ui.currentRoute) return;
  const page = viewfinderPageCache.get(viewfinderKey(ui.currentRoute));
  if (page) setViewfinderMetadata(page);
}

function closeArticleReader() {
  if (!articleReader) return;
  articleReader.remove();
  articleReader = null;
  document.documentElement.classList.remove("camera-reader-active");
  container.inert = false;
  container.removeAttribute("aria-hidden");
  restoreViewfinderMetadata();
}

function createArticleReader() {
  const reader = document.createElement("section");
  reader.className = "camera-reader";
  reader.setAttribute("role", "dialog");
  reader.setAttribute("aria-modal", "true");
  reader.setAttribute("aria-label", "Article reading mode");
  reader.innerHTML = `
    <div class="camera-reader__viewport">
      <nav class="article-return camera-reader__nav" aria-label="Article navigation">
        <a class="article-return__link article-return__back" href="#" data-reader-back>
          <span class="article-return__arrow" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false">
              <path d="M20 12H5M5 12l6-6M5 12l6 6"></path>
            </svg>
          </span>
          <span>Back to blog</span>
        </a>
        <a class="article-return__link article-return__home" href="#" data-reader-home>
          Home
        </a>
      </nav>
      <div class="camera-reader__article" data-reader-article></div>
    </div>
  `;

  const blogUrl =
    ui.columns.find((column) => column.label === "BLOG")?.url ||
    document.querySelector('.vf-bar__link[href*="/blog/"]')?.href ||
    new URL("/blog/", window.location.href).href;
  const homeUrl =
    homePageState?.url ||
    document.querySelector(".vf-bar__menu")?.href ||
    new URL("/", window.location.href).href;
  reader.querySelector("[data-reader-back]").href = blogUrl;
  reader.querySelector("[data-reader-home]").href = homeUrl;

  reader.addEventListener("click", (event) => {
    const link = event.target.closest?.("a");
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    if (link.matches("[data-reader-back]")) {
      event.preventDefault();
      history.back();
    } else if (link.matches("[data-reader-home]")) {
      event.preventDefault();
      articleReaderReturnHome = true;
      beginViewfinderExit(homeUrl);
      history.back();
    } else if (link.closest(".post-navigation")) {
      event.preventDefault();
      openArticleReader(link.href, { historyMode: "replace" });
    }
  });

  document.body.appendChild(reader);
  document.documentElement.classList.add("camera-reader-active");
  container.inert = true;
  container.setAttribute("aria-hidden", "true");
  return reader;
}

function renderArticleReader(page, historyMode) {
  if (!articleReader) articleReader = createArticleReader();
  const article = articleReader.querySelector("[data-reader-article]");
  article.innerHTML = page.html;
  articleReader.scrollTop = 0;
  setArticleMetadata(page);

  if (historyMode === "push") {
    const target = new URL(page.url, window.location.href);
    history.pushState(
      { cameraView: "article", articleUrl: page.url },
      "",
      `${target.pathname}${target.search}${target.hash}`,
    );
  } else if (historyMode === "replace") {
    const target = new URL(page.url, window.location.href);
    history.replaceState(
      { cameraView: "article", articleUrl: page.url },
      "",
      `${target.pathname}${target.search}${target.hash}`,
    );
  }
  warmArticleLinks();
  articleReader.querySelector("[data-reader-back]")?.focus({ preventScroll: true });
}

async function openArticleReader(url, { historyMode = "push" } = {}) {
  const token = ++articleReaderNavigationToken;
  try {
    const page = await loadArticlePage(url);
    if (token !== articleReaderNavigationToken) return;
    finishViewfinderReveal();
    renderArticleReader(page, historyMode);
  } catch (err) {
    console.warn("camera-hero: article reader failed", err);
    rememberArticleOrigin(url);
    window.location.href = url;
  }
}

const CAMERA_ARTICLE_ORIGIN_KEY = "camera-article-origin:v1";
const CAMERA_ARTICLE_HOME_INTENT_KEY = "camera-article-home-intent:v1";

function rememberArticleOrigin(url) {
  try {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) return;

    const scroll = document.querySelector(".viewfinder__scroll");
    sessionStorage.setItem(
      CAMERA_ARTICLE_ORIGIN_KEY,
      JSON.stringify({
        article: `${target.pathname}${target.search}${target.hash}`,
        blog: `${window.location.pathname}${window.location.search}${window.location.hash}`,
        home: homePageState
          ? new URL(homePageState.url).pathname
          : new URL("/", window.location.href).pathname,
        scrollTop: scroll?.scrollTop || 0,
        timestamp: Date.now(),
      }),
    );
  } catch {
    // The article still opens normally if session storage is unavailable.
  }
}

function handleArticleReturnIntent() {
  let returnHome = false;
  let origin = null;
  try {
    returnHome = sessionStorage.getItem(CAMERA_ARTICLE_HOME_INTENT_KEY) === "1";
    sessionStorage.removeItem(CAMERA_ARTICLE_HOME_INTENT_KEY);
    origin = JSON.parse(sessionStorage.getItem(CAMERA_ARTICLE_ORIGIN_KEY) || "null");
  } catch {
    return;
  }

  if (origin && viewfinderKey(origin.blog) === viewfinderKey(window.location.href)) {
    const scroll = document.querySelector(".viewfinder__scroll");
    if (scroll && Number.isFinite(origin.scrollTop)) scroll.scrollTop = origin.scrollTop;
  }

  if (!returnHome || !ui.zoomedPage) return;
  const homeUrl =
    homePageState?.url ||
    document.querySelector(".vf-bar__menu")?.href ||
    new URL("/", window.location.href).href;
  requestAnimationFrame(() => beginViewfinderExit(homeUrl));
}

function bindViewfinderNavigation() {
  container.addEventListener("click", (event) => {
    const link = event.target.closest?.("a");
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    if (link.matches(".vf-bar__link")) {
      event.preventDefault();
      navigateViewfinder(link.href);
    } else if (link.matches(".vf-bar__menu")) {
      event.preventDefault();
      beginViewfinderExit(link.href);
    } else if (link.matches(".post-title")) {
      event.preventDefault();
      openArticleReader(link.href);
    }
  });

  const warmLinkedPage = (event) => {
    const viewfinderLink = event.target.closest?.(".vf-bar__link");
    if (viewfinderLink) loadViewfinderPage(viewfinderLink.href).catch(() => {});

    const articleLink = event.target.closest?.("a.post-title, .post-navigation a");
    if (articleLink) loadArticlePage(articleLink.href).catch(() => {});
  };
  container.addEventListener("pointerover", warmLinkedPage);
  container.addEventListener("focusin", warmLinkedPage);

  window.addEventListener("popstate", (event) => {
    if (event.state?.cameraView === "article") {
      openArticleReader(event.state.articleUrl || window.location.href, {
        historyMode: "none",
      });
      return;
    }

    if (articleReader) {
      closeArticleReader();
      if (articleReaderReturnHome) {
        articleReaderReturnHome = false;
        if (zoom.state === "idle") {
          const homeUrl =
            homePageState?.url ||
            document.querySelector(".vf-bar__menu")?.href ||
            new URL("/", window.location.href).href;
          beginViewfinderExit(homeUrl);
        }
      }
      return;
    }

    const currentKey = viewfinderKey(window.location.href);
    const isViewfinderRoute = ui.columns.some(
      (column) => viewfinderKey(column.url) === currentKey,
    );

    if (isViewfinderRoute && ui.inlineViewfinder) {
      navigateViewfinder(window.location.href, { pushHistory: false });
    } else if (isViewfinderRoute && ui.inlineShell) {
      beginInlineEntry(window.location.href, { pushHistory: false });
    } else if (
      ui.inlineViewfinder &&
      homePageState &&
      currentKey === viewfinderKey(homePageState.url)
    ) {
      beginViewfinderExit(homePageState.url, { pushHistory: false });
    }
  });

  window.addEventListener("pageshow", handleArticleReturnIntent);
}

/** The LCD's on-screen rectangle, in canvas pixels. */
function measureLcdRect() {
  const rect = canvas.getBoundingClientRect();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < 4; i++) {
    lcdCorner.set(
      (i === 0 || i === 3 ? -1 : 1) * (LCD_W / 2),
      (i < 2 ? 1 : -1) * (LCD_H / 2),
      0,
    );
    lcdMesh.localToWorld(lcdCorner).project(sceneCamera);
    const x = ((lcdCorner.x + 1) / 2) * rect.width;
    const y = ((-lcdCorner.y + 1) / 2) * rect.height;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Lay the content panel out ONCE at its resting size. Everything after that is
 * a compositor-only transform — animating width/height each frame reflowed the
 * whole resume 60 times a second, which is what made the zoom-out stutter.
 */
function layoutScreenOverlay() {
  if (!screenOverlay) return;
  const r = measureLcdRect();
  // guard against a bad projection (camera not positioned yet, degenerate
  // viewport): leave the CSS fallback in place rather than covering the page
  const sane =
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    r.w > 40 &&
    r.h > 40 &&
    r.w < canvas.clientWidth * 3 &&
    r.h < canvas.clientHeight * 3;
  if (!sane) return;
  naturalRect = r;
  screenOverlay.style.left = `${naturalRect.x}px`;
  screenOverlay.style.top = `${naturalRect.y}px`;
  screenOverlay.style.width = `${naturalRect.w}px`;
  screenOverlay.style.height = `${naturalRect.h}px`;
  screenOverlay.style.borderRadius = `${(naturalRect.h * 0.05) / LCD_H}px`;
  screenOverlay.style.transformOrigin = "0 0";
  screenOverlay.style.transform = "none";
}

/** Per-frame: transform only, and only while the lens is actually moving. */
function positionScreenOverlay() {
  if (!screenOverlay || !naturalRect) return;
  if (zoom.state === "idle" && zoom.pos === 1) return;

  const r = measureLcdRect();
  const sx = r.w / naturalRect.w;
  const sy = r.h / naturalRect.h;
  screenOverlay.style.transform =
    `translate(${r.x - naturalRect.x}px, ${r.y - naturalRect.y}px) scale(${sx}, ${sy})`;
  // the panel belongs to the screen, so it fades as the lens pulls back
  screenOverlay.style.opacity = String(Math.max(0, (zoom.pos - 0.25) / 0.75));
}

function positionLabels() {
  const rect = canvas.getBoundingClientRect();
  const mobileLayout = ui.inlineShell && isMobileLayout();
  let dialScreenWidth = 0;

  // Project the wheel edges first. The same measurement drives both the
  // double-arrow width and the label's horizontal safe-area clamping.
  if (dial) {
    edgeL.set(-D.dialR, 0, 0);
    edgeR.set(D.dialR, 0, 0);
    dial.localToWorld(edgeL).project(sceneCamera);
    dial.localToWorld(edgeR).project(sceneCamera);
    dialScreenWidth = (Math.abs(edgeR.x - edgeL.x) / 2) * rect.width;
  }

  Object.entries(labelAnchors).forEach(([name, a]) => {
    if (!a.el || !a.object) return;
    if (a.point) {
      tmpVec.copy(a.point);
      a.object.localToWorld(tmpVec);
    } else {
      a.object.getWorldPosition(tmpVec);
    }
    tmpVec.project(sceneCamera);
    let x = ((tmpVec.x + 1) / 2) * rect.width;
    const y = ((-tmpVec.y + 1) / 2) * rect.height;

    if (name === "scroll") {
      const labelWidth = Math.max(a.el.offsetWidth, dialScreenWidth);
      const edgeInset = mobileLayout
        ? Math.max(12, rect.width * 0.035)
        : Math.max(18, rect.width * 0.015);
      x = THREE.MathUtils.clamp(
        x,
        labelWidth / 2 + edgeInset,
        rect.width - labelWidth / 2 - edgeInset,
      );

      const responsiveGap = mobileLayout
        ? THREE.MathUtils.clamp(rect.height * 0.028, 20, 30)
        : THREE.MathUtils.clamp(dialScreenWidth * 0.17, 24, 64);
      a.el.style.setProperty("--scroll-label-gap", `${responsiveGap.toFixed(1)}px`);
    }

    a.el.style.left = `${x}px`;
    a.el.style.top = `${y}px`;
  });

  // Match the arrow to the dial's actual on-screen width instead of guessing.
  const scrollLabel = labelAnchors.scroll && labelAnchors.scroll.el;
  if (scrollLabel && dialScreenWidth > 0) {
    scrollLabel.style.setProperty("--arrow-w", `${dialScreenWidth.toFixed(1)}px`);
  }
}

/* ------------------------------------------------------------------ *
 * 11. BOOTSTRAP
 * ------------------------------------------------------------------ */

function fitCamera() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const aspect = w / h;
  sceneCamera.aspect = aspect;

  const mobileLayout = ui.inlineShell && isMobileLayout();

  if (mobileLayout) {
    // Mobile has its own stable portrait framing. Fit an envelope that includes
    // the top controls and side lug against both viewport axes: this keeps the
    // whole camera visible on tall phones and on short in-app browser windows.
    const half = Math.tan(THREE.MathUtils.degToRad(sceneCamera.fov) / 2);
    const cameraEnvelopeW = D.bodyW + 0.65;
    const cameraEnvelopeH = D.bodyH + 0.7;
    const widthDistance = cameraEnvelopeW / (2 * half * aspect * 0.88);
    const heightDistance = cameraEnvelopeH / (2 * half * 0.46);
    restCamera.set(0, -1.05, Math.max(widthDistance, heightDistance));
  } else {
    // Desktop keeps the original complete-camera framing.
    const fit = Math.max(1, (D.bodyW * 1.28) / aspect / D.bodyH);
    restCamera.set(0, 0, 10.7 * fit);
  }

  // Full zoom: closest distance at which the bezel still fits. Height and width
  // each impose a minimum and the tighter one wins, so the screen is never
  // cropped even on square viewports.
  const half = Math.tan(THREE.MathUtils.degToRad(sceneCamera.fov) / 2);
  const dH = D.screenH / (2 * ZOOM_SCREEN_FILL * half);
  const dW = D.screenW / (2 * ZOOM_SCREEN_FILL * half * aspect);
  // Aim at the screen's WORLD position. D.screenY is body-space; the body is
  // shifted by BODY_Y, and leaving that out aimed the camera above the screen,
  // which pushed the frame down and cropped its bottom edge.
  zoomTarget.set(D.screenX, D.screenY + BODY_Y, LCD_Z + Math.max(dH, dW));

  sceneCamera.updateProjectionMatrix();
}

/** The CSS stage owns the backdrop so decorative layers can sit genuinely
 *  behind the transparent WebGL canvas. */
function setBackground() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  if (scene) scene.background = null;
  if (renderer) renderer.setClearColor(dark ? C.bgDark : C.bg, 0);
  if (container) container.classList.toggle("camera-hero--dark", dark);
}

let loopRunning = false;
let lastFrameTime = performance.now();

function renderLoop(now) {
  if (!renderer) {
    loopRunning = false;
    return;
  }

  const dt = Math.min(now - lastFrameTime, 50);
  lastFrameTime = now;
  updateZoom(dt);
  updateSecondary(dt);
  screen.tick();
  applyState();
  positionLabels();
  positionScreenOverlay();
  renderer.render(scene, sceneCamera);

  if (!ui.zoomedPage || zoom.state !== "idle") {
    requestAnimationFrame(renderLoop);
  } else {
    loopRunning = false;
  }
}

function wakeLoop() {
  if (!renderer || loopRunning) return;
  loopRunning = true;
  lastFrameTime = performance.now();
  requestAnimationFrame(renderLoop);
}

function revealHomeEntry() {
  const hero = document.getElementById("homepage-hero");
  if (!hero || hero.classList.contains("homepage-hero--entered")) return;
  window.clearTimeout(window.__cameraEntryFallback);
  const startedAt = window.__cameraEntryStartedAt || performance.now();
  const delay = Math.max(0, 180 - (performance.now() - startedAt));
  window.setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => hero.classList.add("homepage-hero--entered"));
    });
  }, delay);
}

function init() {
  container = document.getElementById("camera-hero");
  if (!container) return;
  canvas = container.querySelector("canvas");

  try {
    ui.columns = JSON.parse(container.dataset.routes);
  } catch (err) {
    console.error("camera-hero: bad data-routes", err);
    return;
  }
  indicator.targetX = ui.selectedColumn;
  viewfinderCacheVersion = container.dataset.cacheVersion || "1";
  ui.inlineShell = Boolean(document.querySelector(".homepage-hero"));

  document.documentElement.classList.add("camera-shell-active");
  if (ui.inlineShell) {
    captureHomePageState();
    history.replaceState({ cameraView: "home" }, "", window.location.href);
  }

  // Viewfinder pages render the same camera, already pushed in, with the real
  // page content overlaid on the LCD.
  screenOverlay = container.querySelector(".viewfinder__screen");
  if (container.dataset.zoomed === "true") {
    ui.zoomedPage = true;
    zoom.pos = 1;
    zoom.target = 1;
    screen.setMode("blank");
    container.classList.add("camera-hero--zoomed");
    cacheCurrentViewfinderPage();
  }
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  warmViewfinderPages();

  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    // The page content is styled to stand on its own, so just remove the dead
    // canvas and leave the CSS fallback frame in place.
    console.warn("camera-hero: no WebGL, using CSS fallback", err);
    canvas.remove();
    revealHomeEntry();
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  setBackground();

  sceneCamera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);
  rig = new THREE.Group();
  rig.add(sceneCamera);
  scene.add(rig);

  // soft studio lighting: enough shaping to read as 3D, flat enough to keep
  // the design's colours true
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.85);
  key.position.set(-3.2, 5, 6.5);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffe7d2, 0.72);
  fill.position.set(4.5, -1.6, 3.4);
  scene.add(fill);
  const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
  rimLight.position.set(0.5, 2.5, -4);
  scene.add(rimLight);

  const body = buildCamera();
  body.position.y = BODY_Y; // crop the bottom, matching the design's framing
  scene.add(body);

  labelAnchors.scroll = {
    object: hotspots.dial,
    el: container.querySelector('[data-label="scroll"]'),
  };
  labelAnchors.shoot = {
    object: hotspots.shutter,
    point: new THREE.Vector3(0.27, 0.16, 0.1),
    el: container.querySelector('[data-label="shoot"]'),
  };

  screen.markDirty();
  bindInput();
  bindViewfinderNavigation();
  fitCamera();
  window.addEventListener("resize", () => {
    fitCamera();
    layoutScreenOverlay();
    wakeLoop();
  });
  new MutationObserver(() => {
    setBackground();
    wakeLoop();
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  // Order matters here, and getting it wrong is visible:
  //  1. screen.tick() paints the LCD canvas. Without it the first frame samples
  //     a never-drawn (transparent black) texture and the screen flashes dark.
  //  2. applyState() actually moves the camera — fitCamera() only computes the
  //     rest/zoom endpoints. Without it the camera sits at the origin, the LCD
  //     projects to garbage and the overlay covers the whole viewport.
  screen.tick();
  applyState();
  renderer.render(scene, sceneCamera);
  layoutScreenOverlay();
  container.classList.add("camera-hero--ready");
  if (ui.inlineShell) revealHomeEntry();
  handleArticleReturnIntent();
  requestAnimationFrame(warmArticleLinks);
  wakeLoop();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
