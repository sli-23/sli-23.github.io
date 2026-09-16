(() => {
  const ORIGIN_KEY = "camera-article-origin:v1";
  const HOME_INTENT_KEY = "camera-article-home-intent:v1";
  const MAX_AGE = 2 * 60 * 60 * 1000;

  const backLink = document.querySelector("[data-article-back]");
  const homeLink = document.querySelector("[data-article-home]");
  if (!backLink || !homeLink) return;

  function warmBlogPage() {
    const prefetch = document.createElement("link");
    prefetch.rel = "prefetch";
    prefetch.as = "document";
    prefetch.href = backLink.href;
    document.head.append(prefetch);
  }

  function currentPath() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  function readOrigin() {
    try {
      const origin = JSON.parse(sessionStorage.getItem(ORIGIN_KEY) || "null");
      if (
        !origin ||
        origin.article !== currentPath() ||
        Date.now() - origin.timestamp > MAX_AGE ||
        window.history.length < 2
      ) {
        return null;
      }
      return origin;
    } catch {
      return null;
    }
  }

  function returnHomeThroughCamera(event) {
    const origin = readOrigin();
    if (!origin) return;

    event.preventDefault();
    try {
      sessionStorage.setItem(HOME_INTENT_KEY, "1");
    } catch {
      window.location.href = homeLink.href;
      return;
    }
    window.history.back();
  }

  // "Back to blog" remains a normal explicit /blog/ link. Only Camera Home
  // uses history restoration so it can animate through the existing camera.
  homeLink.addEventListener("click", returnHomeThroughCamera);
  warmBlogPage();

  // If the reader moves to the previous/next article, keep the same contextual
  // return path instead of dropping them into the global site navigation.
  document.querySelectorAll(".post-navigation a").forEach((link) => {
    link.addEventListener("click", () => {
      const origin = readOrigin();
      if (!origin) return;
      try {
        const target = new URL(link.href, window.location.href);
        origin.article = `${target.pathname}${target.search}${target.hash}`;
        origin.timestamp = Date.now();
        sessionStorage.setItem(ORIGIN_KEY, JSON.stringify(origin));
      } catch {
        // Normal navigation remains available.
      }
    });
  });
})();
