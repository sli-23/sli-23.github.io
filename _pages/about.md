---
layout: default
title: ABOUT
permalink: /
---

<div class="homepage-hero" id="homepage-hero">
  <nav class="homepage-nav" aria-label="Main navigation">
    <a href="{{ '/blog/' | relative_url }}" class="homepage-nav__link">BLOG</a>
    <a href="{{ '/projects/' | relative_url }}" class="homepage-nav__link">NOTES</a>
    <button class="homepage-nav__link mode-toggle" id="mode-toggle" aria-label="Toggle theme">
      <span class="mode-toggle__label mode-toggle__label--light">LIGHT</span>
      <span class="mode-toggle__sep">/</span>
      <span class="mode-toggle__label mode-toggle__label--dark">DARK</span>
    </button>
  </nav>
  <div class="artwork-container">
    <div class="artwork-layer artwork-layer--threads">
      {% include red-threads.svg %}
    </div>
    <div class="artwork-layer artwork-layer--anatomy">
      {% include torso-sketch.svg %}
    </div>
    <span class="artwork-credit">after George Bridgman</span>
  </div>
  <div class="homepage-footer">
    &copy; {{ site.time | date: '%Y' }}. Powered by Jekyll with al-folio. Hosted by GitHub Pages.
  </div>
</div>

<script src="{{ '/assets/js/tension-threads.js' | relative_url }}"></script>
<script>
document.getElementById('mode-toggle').addEventListener('click', function() {
  toggleThemeSetting();
});
</script>
