const api = typeof browser !== "undefined" ? browser : chrome;
const SERVER_BASE = "http://127.0.0.1:4317";

const KNOWN_TYPES = new Set(["yt-heartbeat", "sc-heartbeat", "lastfm-heartbeat"]);

const lastForwardedByTab = new Map();

api.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || !KNOWN_TYPES.has(msg.type)) return;

  const tabId = sender.tab?.id ?? -1;
  const prev = lastForwardedByTab.get(tabId);

  const trackId = msg.videoId ?? `${msg.artistName}::${msg.songTitle}`;
  const prevTrackId = prev?.videoId ?? `${prev?.artistName}::${prev?.songTitle}`;

  const stateChanged =
    !prev ||
    prev.type !== msg.type ||
    prevTrackId !== trackId ||
    prev.playing !== msg.playing ||
    prev.chapterFromDom !== msg.chapterFromDom ||
    prev.songTitle !== msg.songTitle ||
    prev.duration !== msg.duration ||
    prev.visible !== msg.visible;

  const timeChangedEnough =
    !prev ||
    Math.abs((prev.currentTime || 0) - (msg.currentTime || 0)) >= (msg.playing ? 0.25 : 0.05);

  if (!stateChanged && !timeChangedEnough) return;

  lastForwardedByTab.set(tabId, msg);

  try {
    const response = await fetch(`${SERVER_BASE}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tabId, ...msg })
    });

    const data = await response.json();
    if (msg.type === "yt-heartbeat") {
      console.log("Resolved chapter:", data.chapterTitle ?? "(none)");
    }
  } catch (err) {
    console.error("Failed to post to local server:", err);
  }
});