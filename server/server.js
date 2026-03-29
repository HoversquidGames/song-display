import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs, { createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const app = express();
const PORT = 4317;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

const videoMetaCache = new Map();
const latestByTab = new Map();
const logStream = createWriteStream(path.join(__dirname, "captures.ndjson"), { flags: "a" });
const sseClients = new Set();
let ytDlpPathPromise = null;

async function resolveYtDlpPath() {
    const candidates = process.platform === "win32"
    ? [
        process.env.YT_DLP_PATH,
        path.join(__dirname, "bin", "yt-dlp.exe"),
        "yt-dlp.exe",
        "yt-dlp"
    ].filter(Boolean)
    : [
        process.env.YT_DLP_PATH,
        path.join(__dirname, "bin", "yt-dlp"),
        "yt-dlp"
    ].filter(Boolean);
    
    for (const candidate of candidates) {
        // Absolute or relative file path candidate
        if (candidate.includes("\\") || candidate.includes("/") || path.isAbsolute(candidate)) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
            continue;
        }
        
        // PATH lookup
        try {
            const lookupCmd = process.platform === "win32" ? "where" : "which";
            const { stdout } = await execFileAsync(
                ytDlpPath,
                [
                    "--ignore-config",
                    "--js-runtimes",
                    `node:${process.execPath}`,
                    "-J",
                    "--no-warnings",
                    "--skip-download",
                    url
                ],
                { maxBuffer: 20 * 1024 * 1024 }
            );
            const found = stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find(Boolean);
            
            if (found) return found;
        } catch {
            // Try next candidate
        }
    }
    
    throw new Error(
        "Could not find yt-dlp. Set YT_DLP_PATH to the full path of your yt-dlp executable."
    );
}

async function getYtDlpPath() {
    if (!ytDlpPathPromise) {
        ytDlpPathPromise = resolveYtDlpPath();
    }
    
    try {
        return await ytDlpPathPromise;
    } catch (err) {
        ytDlpPathPromise = null;
        throw err;
    }
}

function parseTimestampToSeconds(ts) {
    const parts = ts.split(":").map(Number);
    if (parts.some(Number.isNaN)) return null;
    
    if (parts.length === 2) {
        const [m, s] = parts;
        return m * 60 + s;
    }
    
    if (parts.length === 3) {
        const [h, m, s] = parts;
        return h * 3600 + m * 60 + s;
    }
    
    return null;
}

function parseDescriptionChapters(description) {
    const lines = description.split(/\r?\n/);
    const chapters = [];
    
    for (const line of lines) {
        const match = line.match(/^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—|]?\s*(.+?)\s*$/);
        if (!match) continue;
        
        const start = parseTimestampToSeconds(match[1]);
        const title = match[2]?.trim();
        
        if (start == null || !title) continue;
        chapters.push({ title, start, end: Number.POSITIVE_INFINITY });
    }
    
    chapters.sort((a, b) => a.start - b.start);
    
    for (let i = 0; i < chapters.length - 1; i++) {
        chapters[i].end = chapters[i + 1].start;
    }
    
    return chapters;
}

// async function loadVideoInfo(videoId) {
//   const url = `https://www.youtube.com/watch?v=${videoId}`;

//   const { stdout } = await execFileAsync(
//     "yt-dlp",
//     ["-J", "--no-warnings", "--skip-download", url],
//     { maxBuffer: 20 * 1024 * 1024 }
//   );

//   return JSON.parse(stdout);
// }

async function loadVideoInfo(videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const ytDlpPath = await getYtDlpPath();
    
    const { stdout } = await execFileAsync(
        ytDlpPath,
        ["-J", "--no-warnings", "--skip-download", url],
        { maxBuffer: 20 * 1024 * 1024 }
    );
    
    return JSON.parse(stdout);
}

async function getVideoMeta(videoId) {
    if (videoMetaCache.has(videoId)) {
        return videoMetaCache.get(videoId);
    }
    
    const info = await loadVideoInfo(videoId);
    
    let chapters = Array.isArray(info.chapters)
    ? info.chapters.map((c) => ({
        title: c.title,
        start: Number(c.start_time ?? 0),
        end: Number(c.end_time ?? Number.POSITIVE_INFINITY)
    }))
    : [];
    
    if (!chapters.length && typeof info.description === "string") {
        chapters = parseDescriptionChapters(info.description);
    }
    
    const duration =
    Number.isFinite(info.duration) && info.duration > 0 ? Number(info.duration) : null;
    
    const meta = { chapters, duration };
    videoMetaCache.set(videoId, meta);
    return meta;
}

function resolveChapter(chapters, currentTime) {
    if (!Array.isArray(chapters) || !chapters.length) return null;
    
    for (const chapter of chapters) {
        if (currentTime >= chapter.start && currentTime < chapter.end) {
            return chapter;
        }
    }
    
    const last = chapters[chapters.length - 1];
    if (last && currentTime >= last.start) return last;
    
    return null;
}

function chooseCurrentRecord() {
    const records = Array.from(latestByTab.values());
    if (!records.length) return null;
    
    const visiblePlaying = records
    .filter((r) => r.playing && r.visible)
    .sort((a, b) => b.sentAt - a.sentAt);
    
    if (visiblePlaying.length) return visiblePlaying[0];
    
    const playing = records
    .filter((r) => r.playing)
    .sort((a, b) => b.sentAt - a.sentAt);
    
    if (playing.length) return playing[0];
    
    return records.sort((a, b) => b.sentAt - a.sentAt)[0];
}

function buildProgress(record) {
    const currentTime = Number(record.currentTime || 0);
    const duration =
    Number.isFinite(record.duration) && record.duration > 0 ? Number(record.duration) : null;
    
    let mode = "video";
    let start = 0;
    let end = duration;
    let title = null;
    
    if (record.chapterRange && typeof record.chapterRange.start === "number") {
        mode = "chapter";
        start = Number(record.chapterRange.start || 0);
        const rawEnd = record.chapterRange.end;
        
        if (Number.isFinite(rawEnd)) {
            end = Number(rawEnd);
        } else if (duration != null) {
            end = duration;
        } else {
            end = null;
        }
        
        title = record.chapterTitle || null;
    }
    
    let elapsed = Math.max(0, currentTime - start);
    let total = end != null ? Math.max(0, end - start) : null;
    
    if (total != null) {
        elapsed = Math.min(elapsed, total);
    }
    
    const ratio =
    total != null && total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : null;
    
    return {
        mode,
        title,
        start,
        end,
        elapsed,
        total,
        ratio
    };
}

function getCurrentPayload() {
    const record = chooseCurrentRecord();

    if (!record) {
        return {
            ok: true,
            active: false,
            source: null,
            videoTitle: null,
            chapterTitle: null,
            thumbnailUrl: null,
            duration: null,
            chapterRange: null,
            currentTime: null,
            progress: null,
            playing: false,
            visible: false
        };
    }

    return {
        ok: true,
        active: true,
        source: record.source || "youtube",
        videoTitle: record.videoTitle || null,
        chapterTitle: record.chapterTitle || null,
        thumbnailUrl: record.thumbnailUrl || null,
        playing: record.playing,
        visible: record.visible,
        videoId: record.videoId,
        currentTime: Number(record.currentTime || 0),
        duration:
        Number.isFinite(record.duration) && record.duration > 0 ? Number(record.duration) : null,
        chapterRange: record.chapterRange || null,
        progress: buildProgress(record)
    };
}

function broadcastCurrent() {
    const payload = `data: ${JSON.stringify(getCurrentPayload())}\n\n`;
    
    for (const client of sseClients) {
        client.write(payload);
    }
}

app.post("/capture", async (req, res) => {
    try {
        const {
            tabId,
            href,
            source = "youtube",
            // YouTube fields
            videoId,
            videoTitle,
            uploaderName,
            chapterFromDom,
            // SoundCloud / Last.FM fields
            artistName,
            songTitle,
            thumbnailUrl,
            // Common fields
            currentTime,
            duration,
            playing,
            visible,
            sentAt
        } = req.body ?? {};

        const isYoutube = source === "youtube";

        if (typeof currentTime !== "number") {
            return res.status(400).json({ ok: false, error: "numeric currentTime is required" });
        }
        if (isYoutube && !videoId) {
            return res.status(400).json({ ok: false, error: "videoId is required for YouTube" });
        }
        if (!isYoutube && (!artistName || !songTitle)) {
            return res.status(400).json({ ok: false, error: "artistName and songTitle are required for non-YouTube sources" });
        }

        // Derive unified fields
        const effectiveVideoId = isYoutube
            ? videoId
            : `${source}::${artistName}::${songTitle}`;
        let effectiveVideoTitle = isYoutube ? (videoTitle || "Unknown Video") : artistName;

        let chapterTitle = null;
        let chapterRange = null;
        let effectiveDuration = Number.isFinite(duration) && duration > 0 ? Number(duration) : null;

        if (isYoutube) {
            let meta = { chapters: [], duration: null };
            try {
                meta = await getVideoMeta(videoId);
            } catch (err) {
                console.error("yt-dlp lookup failed:", err);
            }

            chapterTitle = chapterFromDom?.trim() || null;
            const resolved = resolveChapter(meta.chapters, currentTime);
            if (resolved) {
                chapterTitle = chapterTitle || resolved.title;
                chapterRange = { start: resolved.start, end: resolved.end };
            }

            // No chapters: show uploader as main title, video title as chapter text.
            if (!chapterTitle && uploaderName) {
                chapterTitle = effectiveVideoTitle;
                effectiveVideoTitle = uploaderName;
            }

            if (!effectiveDuration) {
                effectiveDuration = Number.isFinite(meta.duration) && meta.duration > 0
                    ? Number(meta.duration)
                    : null;
            }
        } else {
            // Artist name is the main title; song title is shown in the chapter slot
            chapterTitle = songTitle;
        }

        const record = {
            capturedAt: new Date().toISOString(),
            tabId,
            href,
            source,
            videoId: effectiveVideoId,
            videoTitle: effectiveVideoTitle,
            thumbnailUrl: thumbnailUrl || null,
            currentTime: Number(currentTime || 0),
            duration: effectiveDuration,
            playing: Boolean(playing),
            visible: Boolean(visible),
            chapterTitle,
            chapterRange,
            sentAt: typeof sentAt === "number" ? sentAt : Date.now()
        };

        const dedupeKey = String(tabId ?? effectiveVideoId);
        const last = latestByTab.get(dedupeKey);

        const changed =
        !last ||
        last.videoId !== record.videoId ||
        last.playing !== record.playing ||
        last.chapterTitle !== record.chapterTitle ||
        last.duration !== record.duration ||
        last.visible !== record.visible ||
        Math.abs((last.currentTime || 0) - record.currentTime) >= (record.playing ? 0.25 : 0.05);

        latestByTab.set(dedupeKey, record);

        if (changed) {
            logStream.write(JSON.stringify(record) + "\n");
            broadcastCurrent();
        }

        res.json({ ok: true, chapterTitle, chapterRange });
    } catch (err) {
        console.error(err);
        res.status(500).json({ ok: false, error: String(err) });
    }
});

app.get("/current", (req, res) => {
    res.json(getCurrentPayload());
});

app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }
    
    res.write(`data: ${JSON.stringify(getCurrentPayload())}\n\n`);
    
    sseClients.add(res);
    
    const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
    }, 15000);
    
    req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(res);
        res.end();
    });
});

app.get("/latest", (req, res) => {
    res.json({
        ok: true,
        tabs: Array.from(latestByTab.values())
    });
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Listening on http://127.0.0.1:${PORT}`);
});