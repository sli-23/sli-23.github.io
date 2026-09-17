(() => {
  const media = window.matchMedia(
    "(hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference)",
  );
  if (!media.matches) return;

  const cursor = document.createElement("div");
  cursor.className = "site-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.innerHTML = `
    <span class="site-cursor__ring"></span>
    <span class="site-cursor__dot"></span>
  `;
  document.body.appendChild(cursor);
  document.documentElement.classList.add("site-custom-cursor");

  const ring = cursor.querySelector(".site-cursor__ring");
  const dot = cursor.querySelector(".site-cursor__dot");
  const nativeSelector =
    'input:not([type="button"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable="true"]';
  const actionSelector =
    'a[href], button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], summary, label[for], .chef-profile__visual, .zoomable, [data-cursor-action]';

  let pointerX = -100;
  let pointerY = -100;
  let ringX = -100;
  let ringY = -100;
  let hasPosition = false;

  function setMode(mode) {
    cursor.classList.toggle("is-action", mode === "action");
    cursor.classList.toggle("is-drag", mode === "drag");
    cursor.classList.toggle("is-native", mode === "native");
  }

  function modeFor(target) {
    if (!(target instanceof Element)) return "default";
    if (target.closest(nativeSelector)) return "native";

    const explicit = target.closest("[data-cursor-mode]");
    if (explicit?.dataset.cursorMode) return explicit.dataset.cursorMode;
    if (target.closest(actionSelector)) return "action";
    return "default";
  }

  function move(event) {
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!hasPosition) {
      ringX = pointerX;
      ringY = pointerY;
      hasPosition = true;
    }

    setMode(modeFor(event.target));
    cursor.classList.add("is-visible");
  }

  function render() {
    ringX += (pointerX - ringX) * 0.24;
    ringY += (pointerY - ringY) * 0.24;
    ring.style.transform = `translate3d(${ringX}px, ${ringY}px, 0)`;
    dot.style.transform = `translate3d(${pointerX}px, ${pointerY}px, 0)`;
    window.requestAnimationFrame(render);
  }

  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerdown", () => cursor.classList.add("is-pressed"), {
    passive: true,
  });
  document.addEventListener(
    "pointerup",
    () => cursor.classList.remove("is-pressed"),
    { passive: true },
  );
  document.addEventListener(
    "pointercancel",
    () => cursor.classList.remove("is-pressed"),
    { passive: true },
  );
  document.addEventListener("mouseleave", () => cursor.classList.remove("is-visible"));
  window.addEventListener("blur", () => cursor.classList.remove("is-visible"));

  window.requestAnimationFrame(render);
})();
