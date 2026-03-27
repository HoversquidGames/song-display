(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  let lastSignature = "";

  // The time element text looks like "Current time: 31 seconds0:31" —
  // extract the trailing timestamp (m:ss or h:mm:ss).
  function extractTimeFromText(text) {
    if (!text) return null;
    const match = text.match(/(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (!match) return null;
    const parts = match[1].split(":").map(Number);
    if (parts.some(isNaN)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function getText(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const text = el?.textContent?.trim();
      if (text) return text;
    }
    return null;
  }

  function getArtistName() {
    return getText([
      ".playbackSoundBadge__lightLink",
      ".playbackSoundBadge__user a",
      ".sc-link-secondary.sc-truncate",
    ]);
  }

  function getSongTitle() {
    return getText([
      ".playbackSoundBadge__titleLink span[aria-hidden]",
      ".playbackSoundBadge__titleLink",
      ".playbackSoundBadge__title span",
    ]);
  }

  // The currently playing track's artwork is the LAST sndcdn.com background-image in the DOM.
  function getThumbnailUrl() {
    const all = Array.from(document.querySelectorAll("[style*='sndcdn.com']"));
    for (let i = all.length - 1; i >= 0; i--) {
      const style = all[i].getAttribute("style") || "";
      const match = style.match(/url\(["']?(https?[^"')]+sndcdn\.com[^"')]+)["']?\)/);
      if (match) return match[1].replace(/-t\d+x\d+\./, "-t500x500.");
    }
    return null;
  }

  // SoundCloud shows a Pause button (any element) only when playing.
  function detectPlayingFromDom() {
    return !!document.querySelector(
      '[aria-label="Pause"], [title="Pause"], [aria-label*="pause" i], [title*="pause" i]'
    );
  }

  async function sendHeartbeat(force = false) {
    const artistName = getArtistName();
    const songTitle = getSongTitle();
    if (!artistName || !songTitle) return;

    const timeEl = document.querySelector(".playbackTimeline__timePassed");
    const durEl  = document.querySelector(".playbackTimeline__duration");
    const currentTime = extractTimeFromText(timeEl?.textContent) ?? 0;
    const duration = extractTimeFromText(durEl?.textContent);
    const playing = detectPlayingFromDom();

    const payload = {
      type: "sc-heartbeat",
      source: "soundcloud",
      href: location.href,
      artistName,
      songTitle,
      thumbnailUrl: getThumbnailUrl(),
      currentTime,
      duration,
      playing,
      visible: document.visibilityState === "visible",
      sentAt: Date.now(),
    };

    // 1-second granularity matches the DOM time display update rate.
    const signature = JSON.stringify([
      artistName,
      songTitle,
      Math.floor(currentTime),
      duration,
      playing,
    ]);

    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    try {
      await api.runtime.sendMessage(payload);
    } catch (err) {
      console.error("[SC] Failed to message background:", err);
    }
  }

  document.addEventListener("visibilitychange", () => sendHeartbeat(true), true);

  // Watch for DOM mutations (time display changes every second, song changes swap elements).
  const observer = new MutationObserver(() => sendHeartbeat(false));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // Periodic fallback in case mutations are batched or missed.
  setInterval(() => sendHeartbeat(false), 1000);

  sendHeartbeat(true);
})();
