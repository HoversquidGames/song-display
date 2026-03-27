(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;

  let lastHref = location.href;
  let lastSignature = "";
  let boundVideo = null;
  let fastTimer = null;
  let slowTimer = null;
  let mutationObserver = null;

  function getVideoElement() {
    return document.querySelector("video.html5-main-video, video");
  }

  function getVideoId() {
    const url = new URL(location.href);
    return url.searchParams.get("v");
  }

  function getVideoTitle() {
    const candidates = [
      "ytd-watch-metadata h1 yt-formatted-string",
      "h1.ytd-watch-metadata",
      "h1.title",
      "title"
    ];

    for (const selector of candidates) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return text.replace(/\s+-\s+YouTube$/, "");
    }

    return null;
  }

  function getCurrentChapterFromDom() {
    const selectors = [
      ".ytp-chapter-title-content",
      "ytd-macro-markers-list-item-renderer[is-active] #title-text",
      "ytd-macro-markers-list-item-renderer[active] #title-text"
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return text;
    }

    return null;
  }

  async function sendHeartbeat(force = false) {
    const video = getVideoElement();
    const videoId = getVideoId();

    if (!video || !videoId) return;

    const duration =
      Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration) : null;

    const currentTime = Number(video.currentTime || 0);
    const playing = !video.paused && !video.ended && video.readyState > 2;

    const payload = {
      type: "yt-heartbeat",
      href: location.href,
      videoId,
      videoTitle: getVideoTitle(),
      currentTime,
      duration,
      playing,
      visible: document.visibilityState === "visible",
      chapterFromDom: getCurrentChapterFromDom(),
      sentAt: Date.now()
    };

    const signature = JSON.stringify([
      payload.videoId,
      Math.floor(payload.currentTime * 4) / 4, // quarter-second precision
      payload.duration ? Math.floor(payload.duration) : null,
      payload.playing,
      payload.chapterFromDom,
      payload.visible
    ]);

    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    try {
      await api.runtime.sendMessage(payload);
    } catch (err) {
      console.error("Failed to message background script:", err);
    }
  }

  function clearTimers() {
    if (fastTimer) {
      clearInterval(fastTimer);
      fastTimer = null;
    }
    if (slowTimer) {
      clearInterval(slowTimer);
      slowTimer = null;
    }
  }

  function restartTimers() {
    clearTimers();

    const video = getVideoElement();
    if (!video) return;

    if (!video.paused && !video.ended) {
      fastTimer = setInterval(() => {
        sendHeartbeat(false);
      }, 250);
    } else {
      slowTimer = setInterval(() => {
        sendHeartbeat(false);
      }, 1000);
    }
  }

  function handleVideoEvent() {
    sendHeartbeat(true);
    restartTimers();
  }

  function bindToVideo(video) {
    if (!video || video === boundVideo) return;

    if (boundVideo) {
      unbindFromVideo(boundVideo);
    }

    boundVideo = video;

    const events = [
      "play",
      "playing",
      "pause",
      "seeking",
      "seeked",
      "ended",
      "loadedmetadata",
      "ratechange",
      "timeupdate"
    ];

    for (const eventName of events) {
      video.addEventListener(eventName, handleVideoEvent, true);
    }

    restartTimers();
    sendHeartbeat(true);
  }

  function unbindFromVideo(video) {
    const events = [
      "play",
      "playing",
      "pause",
      "seeking",
      "seeked",
      "ended",
      "loadedmetadata",
      "ratechange",
      "timeupdate"
    ];

    for (const eventName of events) {
      video.removeEventListener(eventName, handleVideoEvent, true);
    }

    if (video === boundVideo) {
      boundVideo = null;
    }
  }

  function maybeResetOnNavigation() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastSignature = "";
      bindToVideo(getVideoElement());
      sendHeartbeat(true);
    }
  }

  function watchForVideoReplacement() {
    if (mutationObserver) mutationObserver.disconnect();

    mutationObserver = new MutationObserver(() => {
      maybeResetOnNavigation();
      const currentVideo = getVideoElement();
      if (currentVideo !== boundVideo) {
        bindToVideo(currentVideo);
      }
    });

    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  document.addEventListener("visibilitychange", () => sendHeartbeat(true), true);
  window.addEventListener("focus", () => sendHeartbeat(true), true);
  window.addEventListener("blur", () => sendHeartbeat(true), true);

  bindToVideo(getVideoElement());
  watchForVideoReplacement();

  setInterval(() => {
    maybeResetOnNavigation();
    const currentVideo = getVideoElement();
    if (currentVideo !== boundVideo) {
      bindToVideo(currentVideo);
    }
  }, 500);
})();