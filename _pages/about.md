---
layout: default
title: ABOUT
permalink: /
---

<script>
window.__cameraSkipEntry = false;
try {
  window.__cameraSkipEntry = sessionStorage.getItem('camera-skip-home-entry:v1') === '1';
  sessionStorage.removeItem('camera-skip-home-entry:v1');
} catch (error) {
  window.__cameraSkipEntry = false;
}
if (window.__cameraSkipEntry) {
  document.documentElement.classList.add('camera-returning-home');
}
</script>

<style>
  .mobile-home-clock {
    display: none;
  }

  @media (max-width: 768px) {
    .homepage-hero .mission-backdrop__clock {
      display: none !important;
    }

    .homepage-hero .mobile-home-clock {
      position: absolute;
      top: max(1.25rem, calc(env(safe-area-inset-top) + 0.75rem));
      left: 1rem;
      z-index: 30;
      display: block !important;
      color: #f2eee5;
      font-family: "Arial Black", "Helvetica Neue", Arial, sans-serif;
      font-size: clamp(3.8rem, 16vw, 5.2rem);
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.045em;
      line-height: 1;
      white-space: nowrap;
      pointer-events: none;
    }

    .homepage-hero .mobile-experience-note {
      position: absolute;
      top: max(6.75rem, calc(env(safe-area-inset-top) + 6.25rem));
      left: 1rem;
      bottom: auto;
      z-index: 30;
      display: block !important;
      width: max-content;
      max-width: calc(100% - 2rem);
      margin: 0;
      padding: 0.68rem 0.82rem 0.62rem;
      border: 1px solid #f2eee5;
      background: rgba(16, 19, 18, 0.94);
      box-shadow: 0.15rem 0.18rem 0 rgba(242, 238, 229, 0.3);
      color: #f2eee5;
      font-family: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.72rem;
      font-weight: 400;
      letter-spacing: 0.11em;
      line-height: 1.25;
      text-align: center;
      white-space: nowrap;
      transform: none;
      pointer-events: none;
    }

    .homepage-hero .mobile-experience-note::before {
      display: none;
    }
  }
</style>

<div class="homepage-hero" id="homepage-hero">
  <div class="mission-backdrop" aria-hidden="true">
    <time class="mission-backdrop__clock" data-seattle-clock>--:--:--</time>
    <span class="mission-backdrop__band mission-backdrop__band--primary"></span>
    <span class="mission-backdrop__band mission-backdrop__band--signal"></span>
    <span class="mission-backdrop__grid"></span>
    <span class="mission-backdrop__plus"></span>
    <span class="mission-backdrop__pixels"></span>
    <span class="mission-backdrop__barcode"></span>
  </div>

  <time class="mobile-home-clock" data-seattle-clock aria-label="Current Seattle time">--:--:--</time>

  <div class="camera-entry" aria-hidden="true">
    <div class="camera-entry__status">
      <span class="camera-entry__reticle">
        <span class="camera-entry__dot"></span>
      </span>
      <span class="camera-entry__label">LOADING</span>
    </div>
  </div>

  <div
    class="camera-hero"
    id="camera-hero"
    data-cache-version="{{ site.time | date: '%s' }}"
    data-routes='[
      {"label":"RESUME","icon":"resume","url":"{{ '/cv/' | relative_url }}"},
      {"label":"BLOG","icon":"blog","url":"{{ '/blog/' | relative_url }}"},
      {"label":"INFO","icon":"info","url":"{{ '/info/' | relative_url }}"}
    ]'
  >
    <canvas aria-label="Interactive 3D camera navigation" role="img"></canvas>
    <span class="camera-label camera-label--scroll" data-label="scroll">
      <span class="camera-label__copy camera-label__copy--desktop">DRAG TO SCROLL</span>
      <span class="camera-label__copy camera-label__copy--mobile">SWIPE DIAL</span>
    </span>
    <span class="camera-label camera-label--shoot" data-label="shoot">
      <span class="camera-label__copy camera-label__copy--desktop">CLICK TO CAPTURE</span>
      <span class="camera-label__copy camera-label__copy--mobile">TAP TO OPEN</span>
    </span>
    <div class="camera-fallback">
      <a href="{{ '/cv/' | relative_url }}">RESUME</a>
      <a href="{{ '/blog/' | relative_url }}">BLOG</a>
      <a href="{{ '/info/' | relative_url }}">INFO</a>
    </div>
  </div>

  <p class="mobile-experience-note" role="note">BEST EXPERIENCED ON DESKTOP.</p>
</div>

<script>
var seattleClocks = document.querySelectorAll('[data-seattle-clock]');
if (seattleClocks.length) {
  var seattleTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  var updateSeattleClock = function() {
    var currentTime = seattleTime.format(new Date());
    seattleClocks.forEach(function(clock) {
      clock.textContent = currentTime;
    });
    window.setTimeout(updateSeattleClock, 1000 - (Date.now() % 1000) + 20);
  };
  updateSeattleClock();
}

window.__cameraEntryStartedAt = performance.now();
var homepageHero = document.getElementById('homepage-hero');
if (window.__cameraSkipEntry) {
  if (homepageHero) {
    homepageHero.classList.add('homepage-hero--entered');
  }
  document.documentElement.classList.remove('camera-returning-home');
} else {
  window.__cameraEntryFallback = window.setTimeout(function() {
    if (homepageHero) {
      homepageHero.classList.add('homepage-hero--entered');
    }
  }, 1200);
}
</script>
<script type="module" src="{{ '/assets/js/camera-hero.js' | relative_url | bust_file_cache }}"></script>
