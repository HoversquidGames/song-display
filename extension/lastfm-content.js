(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  let lastSignature = "";
  let fastTimer = null;
  let slowTimer = null;
  let boundAudio = null;

  function getAudioElement() {
    return document.querySelector("audio");
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
      // Radio / listen player
      ".player-bar--artist a",
      ".player-bar__artist a",
      ".player-bar__artist",
      ".js-player-bar-artist",
      "[data-testid='player-artist']",
      // Now-playing scrobble on profile pages
      ".chartlist-now-playing .chartlist-artist a",
      ".now-scrobbling .artist",
      ".now-playing__artist",
    ]);
  }

  function getSongTitle() {
    return getText([
      // Radio / listen player
      ".player-bar--title-text",
      ".player-bar__title a",
      ".player-bar__title",
      ".js-player-bar-title",
      "[data-testid='player-title']",
      // Now-playing scrobble on profile pages
      ".chartlist-now-playing .chartlist-name a",
      ".now-scrobbling .track",
      ".now-playing__title",
    ]);
  }

  function getThumbnailUrl() {
    const img = document.querySelector(
      ".player-bar--art img, [data-testid='player-art'] img, .player-bar__art img, .now-playing-cover img"
    );
    return img?.src || null;
  }

  // If there's no audio element (e.g. scrobble-only view), treat "now playing"
  // indicator presence as the playing signal.
  function isNowPlayingVisible() {
    return !!(
      document.querySelector(".chartlist-now-playing, .now-scrobbling") ||
      getSongTitle()
    );
  }

  async function sendHeartbeat(force = false) {
    const audio = getAudioElement();
    const artistName = getArtistName();
    const songTitle = getSongTitle();

    if (!artistName || !songTitle) return;

    const currentTime = Number(audio?.currentTime || 0);
    const duration =
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? Number(audio.duration)
        : null;
    const playing = audio
      ? !audio.paused && !audio.ended && audio.readyState > 2
      : isNowPlayingVisible();

    const payload = {
      type: "lastfm-heartbeat",
      source: "lastfm",
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

    const signature = JSON.stringify([
      artistName,
      songTitle,
      Math.floor(currentTime * 4) / 4,
      duration ? Math.floor(duration) : null,
      playing,
    ]);

    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    try {
      await api.runtime.sendMessage(payload);
    } catch (err) {
      console.error("[LastFM] Failed to message background:", err);
    }
  }

  function clearTimers() {
    if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
    if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
  }

  function restartTimers() {
    clearTimers();
    const audio = getAudioElement();
    if (!audio || audio.paused || audio.ended) {
      slowTimer = setInterval(() => sendHeartbeat(false), 1000);
    } else {
      fastTimer = setInterval(() => sendHeartbeat(false), 250);
    }
  }

  function handleAudioEvent() {
    sendHeartbeat(true);
    restartTimers();
  }

  function bindToAudio(audio) {
    if (!audio || audio === boundAudio) return;
    if (boundAudio) {
      const events = ["play", "playing", "pause", "seeking", "seeked", "ended", "loadedmetadata", "timeupdate"];
      for (const e of events) boundAudio.removeEventListener(e, handleAudioEvent, true);
    }
    boundAudio = audio;
    const events = ["play", "playing", "pause", "seeking", "seeked", "ended", "loadedmetadata", "timeupdate"];
    for (const e of events) audio.addEventListener(e, handleAudioEvent, true);
    restartTimers();
    sendHeartbeat(true);
  }

  document.addEventListener("visibilitychange", () => sendHeartbeat(true), true);

  const observer = new MutationObserver(() => {
    const audio = getAudioElement();
    if (audio && audio !== boundAudio) bindToAudio(audio);
    sendHeartbeat(false);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  const audio = getAudioElement();
  if (audio) bindToAudio(audio);
  else restartTimers();
})();
