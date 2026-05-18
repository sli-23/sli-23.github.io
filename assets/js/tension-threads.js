(function () {
  'use strict';

  let heroEl, artworkContainer;
  let threadPaths = [];
  let extensions = [];
  let mouse = { x: -9999, y: -9999 };
  let isMobile = window.innerWidth < 768;

  // Edge connection points where trajectories exit the artwork frame.
  // Expressed as percentage of artwork dimensions (0-1).
  // outDir = direction the line travels OUTWARD from the artwork.
  const EDGE_POINTS = [
    // TOP — only right one
    { x: 0.809, y: 0.005, outDirX: 0.617, outDirY: -0.787 },
    // LEFT
    { x: 0.000, y: 0.300, outDirX: -0.957, outDirY: -0.291 },
    { x: 0.000, y: 0.476, outDirX: -0.999, outDirY: -0.047 },
    // RIGHT — smoother directions, less abrupt angles
    { x: 1.000, y: 0.225, outDirX: 1.000, outDirY: 0.000 },
    { x: 1.000, y: 0.543, outDirX: 0.998, outDirY: 0.060 },
    // BOTTOM
    { x: 0.184, y: 1.000, outDirX: -0.424, outDirY: 0.906 },
  ];

  function init() {
    heroEl = document.getElementById('homepage-hero');
    if (!heroEl) return;

    artworkContainer = heroEl.querySelector('.artwork-container');
    const threadGroup = heroEl.querySelector('#red-threads');
    if (!threadGroup) return;

    threadPaths = Array.from(threadGroup.querySelectorAll('path'));
    createExtensions();
    startAmbientMotion();
    if (!isMobile) setupCursorInteraction();
  }

  function createExtensions() {
    const extLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    extLayer.classList.add('thread-extensions');
    extLayer.setAttribute('aria-hidden', 'true');
    heroEl.appendChild(extLayer);

    const artRect = artworkContainer.getBoundingClientRect();
    const heroRect = heroEl.getBoundingClientRect();
    const w = heroRect.width;
    const h = heroRect.height;

    const artX = artRect.left - heroRect.left;
    const artY = artRect.top - heroRect.top;
    const artW = artRect.width;
    const artH = artRect.height;

    EDGE_POINTS.forEach((ep) => {
      // Convert artwork-relative to hero-absolute
      const startX = artX + ep.x * artW;
      const startY = artY + ep.y * artH;

      // Normalize direction
      const mag = Math.sqrt(ep.outDirX * ep.outDirX + ep.outDirY * ep.outDirY);
      const dirX = ep.outDirX / mag;
      const dirY = ep.outDirY / mag;

      // Extend line in direction until hitting any screen edge
      let endX, endY;
      let tMin = Infinity;

      // Check intersection with all 4 edges, pick closest
      if (dirX > 0.001) { const t = (w - startX) / dirX; if (t > 0 && t < tMin) tMin = t; }
      if (dirX < -0.001) { const t = -startX / dirX; if (t > 0 && t < tMin) tMin = t; }
      if (dirY > 0.001) { const t = (h - startY) / dirY; if (t > 0 && t < tMin) tMin = t; }
      if (dirY < -0.001) { const t = -startY / dirY; if (t > 0 && t < tMin) tMin = t; }

      if (tMin === Infinity) return;
      endX = startX + dirX * tMin;
      endY = startY + dirY * tMin;

      // Length of extension
      const extLen = Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2);
      if (extLen < 30) return;

      // Nearly straight — like a taut string pulled to the wall.
      // Only the tiniest sag to feel organic, not mechanical.
      const perpX = -dirY;
      const perpY = dirX;
      const bowAmount = extLen * 0.015;
      const bowSide = (ep.outDirX * ep.outDirY > 0) ? 1 : -1;

      const cp1X = startX + dirX * extLen * 0.33 + perpX * bowAmount * bowSide;
      const cp1Y = startY + dirY * extLen * 0.33 + perpY * bowAmount * bowSide;
      const cp2X = startX + dirX * extLen * 0.66 + perpX * bowAmount * bowSide;
      const cp2Y = startY + dirY * extLen * 0.66 + perpY * bowAmount * bowSide;

      // Ink-style taper: thick at figure → thin at edge, smooth continuous stroke
      const segments = 5;
      const paths = [];

      for (let s = 0; s < segments; s++) {
        const seg = document.createElementNS('http://www.w3.org/2000/svg', 'path');

        // Thin at figure, gradually thicker toward the edge
        const t = s / (segments - 1);
        const sw = 0.7 + t * 0.3; // 0.7 → 1.0

        seg.setAttribute('stroke-width', sw.toFixed(2));
        seg.setAttribute('stroke', '#d51515');
        seg.setAttribute('fill', 'none');
        seg.setAttribute('stroke-linecap', 'round');
        extLayer.appendChild(seg);
        paths.push(seg);
      }

      // Short vertical scratch marks at the exact junction point
      const scratches = [];
      const scratchCount = 4 + Math.floor(Math.random() * 3);
      const pX = -dirY;
      const pY = dirX;

      for (let sc = 0; sc < scratchCount; sc++) {
        const scratch = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        // Tightly packed, overlapping at the junction
        const offset = (sc - scratchCount / 2) * 0.8 + (Math.random() - 0.5) * 0.5;
        const ptX = startX + dirX * offset;
        const ptY = startY + dirY * offset;
        // Short perpendicular (vertical relative to the string)
        const scratchLen = 4 + Math.random() * 4;
        scratch.setAttribute('x1', (ptX + pX * scratchLen / 2).toFixed(1));
        scratch.setAttribute('y1', (ptY + pY * scratchLen / 2).toFixed(1));
        scratch.setAttribute('x2', (ptX - pX * scratchLen / 2).toFixed(1));
        scratch.setAttribute('y2', (ptY - pY * scratchLen / 2).toFixed(1));
        scratch.setAttribute('stroke', 'var(--figure-color, #1a1a1a)');
        scratch.setAttribute('stroke-width', (0.5 + Math.random() * 0.3).toFixed(2));
        scratch.setAttribute('stroke-linecap', 'round');
        scratch.style.opacity = 1;
        extLayer.appendChild(scratch);
        scratches.push(scratch);
      }

      extensions.push({
        paths: paths,
        scratches: scratches,
        startX, startY, endX, endY,
        cp1X, cp1Y, cp2X, cp2Y,
        origCp1X: cp1X, origCp1Y: cp1Y,
        origCp2X: cp2X, origCp2Y: cp2Y,
      });

      updateExt(extensions[extensions.length - 1]);
    });
  }

  function startAmbientMotion() {
    threadPaths.forEach((path) => {
      const dur = 18 + Math.random() * 12;
      const delay = Math.random() * 5;
      gsap.to(path, {
        x: (Math.random() - 0.5) * 0.5,
        y: (Math.random() - 0.5) * 0.4,
        duration: dur,
        repeat: -1,
        yoyo: true,
        delay: delay,
        ease: 'sine.inOut',
      });
    });

    // Pre-compute wave parameters for each extension
    // Left/right lines get more movement than top/bottom
    extensions.forEach((ext, i) => {
      const dx = ext.endX - ext.startX;
      const dy = ext.endY - ext.startY;
      const len = Math.sqrt(dx * dx + dy * dy);
      ext.perpX = -dy / len;
      ext.perpY = dx / len;
      ext.origEndX = ext.endX;
      ext.origEndY = ext.endY;

      // Detect if mostly horizontal (left/right exit) by checking direction
      const isHorizontal = Math.abs(dx) > Math.abs(dy);
      const ampScale = isHorizontal ? 2.5 : 1;

      ext.wave = {
        amp1: (8 + Math.random() * 6) * ampScale,
        amp2: (10 + Math.random() * 8) * ampScale,
        ampEnd: (12 + Math.random() * 6) * ampScale,
        speed1: (0.4 + Math.random() * 0.3) * (isHorizontal ? 1.3 : 1),
        speed2: (0.3 + Math.random() * 0.25) * (isHorizontal ? 1.3 : 1),
        speedEnd: (0.2 + Math.random() * 0.15) * (isHorizontal ? 1.2 : 1),
        phase1: Math.random() * Math.PI * 2,
        phase2: Math.random() * Math.PI * 2,
        phaseEnd: Math.random() * Math.PI * 2,
      };
    });

    // Single ticker updates all extensions every frame
    gsap.ticker.add(function () {
      const t = Date.now() / 1000;
      extensions.forEach((ext) => {
        const w = ext.wave;
        const sin1 = Math.sin(t * w.speed1 + w.phase1);
        const sin2 = Math.sin(t * w.speed2 + w.phase2);
        const sinEnd = Math.sin(t * w.speedEnd + w.phaseEnd);

        ext.cp1X = ext.origCp1X + ext.perpX * sin1 * w.amp1;
        ext.cp1Y = ext.origCp1Y + ext.perpY * sin1 * w.amp1;
        ext.cp2X = ext.origCp2X + ext.perpX * sin2 * w.amp2;
        ext.cp2Y = ext.origCp2Y + ext.perpY * sin2 * w.amp2;
        ext.endX = ext.origEndX + ext.perpX * sinEnd * w.ampEnd;
        ext.endY = ext.origEndY + ext.perpY * sinEnd * w.ampEnd;
        updateExt(ext);
      });
    });
  }

  function updateExt(ext) {
    const segments = ext.paths.length;
    for (let s = 0; s < segments; s++) {
      const t0 = s / segments;
      const t1 = (s + 1) / segments;
      const p0 = cubicPoint(ext, t0);
      const p1 = cubicPoint(ext, t1);
      // Use two intermediate points for smoother sub-curves
      const pA = cubicPoint(ext, t0 + (t1 - t0) * 0.33);
      const pB = cubicPoint(ext, t0 + (t1 - t0) * 0.66);
      ext.paths[s].setAttribute('d',
        `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} C${pA.x.toFixed(1)},${pA.y.toFixed(1)} ${pB.x.toFixed(1)},${pB.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`
      );
    }
  }

  function cubicPoint(ext, t) {
    const u = 1 - t;
    return {
      x: u*u*u*ext.startX + 3*u*u*t*ext.cp1X + 3*u*t*t*ext.cp2X + t*t*t*ext.endX,
      y: u*u*u*ext.startY + 3*u*u*t*ext.cp1Y + 3*u*t*t*ext.cp2Y + t*t*t*ext.endY,
    };
  }

  function setupCursorInteraction() {
    let ticking = false;
    heroEl.addEventListener('mousemove', (e) => {
      const rect = heroEl.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(() => {
          applyCursorEffect();
          ticking = false;
        });
      }
    });

    heroEl.addEventListener('mouseleave', () => {
      mouse.x = -9999;
      mouse.y = -9999;
      extensions.forEach((ext) => {
        gsap.to(ext, {
          cp1X: ext.origCp1X, cp1Y: ext.origCp1Y,
          cp2X: ext.origCp2X, cp2Y: ext.origCp2Y,
          duration: 2.5,
          ease: 'elastic.out(1, 0.3)',
          overwrite: 'auto',
          onUpdate: () => updateExt(ext),
        });
      });
    });
  }

  function applyCursorEffect() {
    const radius = 70;
    const force = 3;

    extensions.forEach((ext) => {
      // Check proximity to both control points
      const dx1 = ext.cp1X - mouse.x;
      const dy1 = ext.cp1Y - mouse.y;
      const dist1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);

      const dx2 = ext.cp2X - mouse.x;
      const dy2 = ext.cp2Y - mouse.y;
      const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

      if (dist1 < radius && dist1 > 0) {
        const strength = (1 - dist1 / radius) * force;
        const angle = Math.atan2(dy1, dx1);
        gsap.to(ext, {
          cp1X: ext.origCp1X + Math.cos(angle) * strength,
          cp1Y: ext.origCp1Y + Math.sin(angle) * strength,
          duration: 0.6,
          ease: 'power2.out',
          overwrite: 'auto',
          onUpdate: () => updateExt(ext),
        });
      }

      if (dist2 < radius && dist2 > 0) {
        const strength = (1 - dist2 / radius) * force;
        const angle = Math.atan2(dy2, dx2);
        gsap.to(ext, {
          cp2X: ext.origCp2X + Math.cos(angle) * strength,
          cp2Y: ext.origCp2Y + Math.sin(angle) * strength,
          duration: 0.6,
          ease: 'power2.out',
          overwrite: 'auto',
          onUpdate: () => updateExt(ext),
        });
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
