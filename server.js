import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import "dotenv/config";

// --- Configurar ffmpeg ---
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/outputs", express.static(path.join(__dirname, "outputs")));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.get("/", (_req, res) => {
  res.send("✅ RedditToReels API funcionando. Usa POST /api/generate");
});

/* ===========================
   FUNCIONES AUXILIARES
=========================== */

// Lee texto de Reddit
async function fetchRedditText(redditUrl) {
  try {
    const fixed = redditUrl.endsWith("/") ? redditUrl + ".json" : redditUrl + "/.json";
    const res = await fetch(fixed, { headers: { "User-Agent": "RedditToReels/1.0" } });
    if (!res.ok) throw new Error("No se pudo leer el post de Reddit");
    const data = await res.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    const title = post?.title || "Reddit Story";
    const selftext = post?.selftext || "";
    const topComment = data?.[1]?.data?.children?.find(c => c?.data?.body)?.data?.body || "";
    const script = (selftext || topComment || title).trim();
    return { title, script };
  } catch (e) {
    console.error("fetchRedditText:", e.message);
    return { title: "Reddit Story", script: "" };
  }
}

/* ===========================
   TTS (Text-to-Speech con Polly)
=========================== */

async function ttsPolly(text, uiVoice, outPath) {
  const voiceMap = {
    "female-calm": "Lucia",
    "female-enthusiastic": "Lucia",
    "male-deep": "Enrique",
    "male-energetic": "Miguel"
  };
  const voiceId = voiceMap[uiVoice] || "Lucia";

  const { PollyClient, SynthesizeSpeechCommand } = await import("@aws-sdk/client-polly");
  const client = new PollyClient({ region: process.env.AWS_REGION || "us-east-1" });

  const cmd = new SynthesizeSpeechCommand({
    OutputFormat: "mp3",
    Text: text,
    VoiceId: voiceId,
    Engine: "standard"
  });

  const resp = await client.send(cmd);

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(outPath);
    resp.AudioStream.pipe(ws);
    resp.AudioStream.on("error", reject);
    ws.on("finish", resolve);
    ws.on("error", reject);
  });

  return outPath;
}

/* ===========================
   SUBTÍTULOS
=========================== */

function makeSrtFromText(text, audioDurationSec, outSrtPath) {
  const sentences = text.replace(/\n+/g, " ").match(/[^.!?。¡¿]+[.!?。]?/g) || [text];
  const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;
  let cursor = 0, idx = 1;
  const lines = [];

  const toTimestamp = (sec) => {
    const ms = Math.floor(sec * 1000);
    const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    const ms3 = String(ms % 1000).padStart(3, "0");
    return `${h}:${m}:${s},${ms3}`;
  };

  sentences.forEach((s) => {
    const portion = s.length / totalChars;
    const dur = Math.max(1.2, audioDurationSec * portion);
    const start = cursor;
    const end = Math.min(audioDurationSec, cursor + dur);
    lines.push(`${idx++}\n${toTimestamp(start)} --> ${toTimestamp(end)}\n${s.trim()}\n`);
    cursor = end;
  });

  fs.writeFileSync(outSrtPath, lines.join("\n"), "utf8");
}

function getAudioDurationSec(audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, meta) => {
      if (err) return reject(err);
      resolve(meta?.format?.duration || 0);
    });
  });
}

/* ===========================
   VIDEO
=========================== */

// Busca fuentes locales (si existen)
function getFontFile() {
  const tryPaths = [
    path.join(__dirname, "assets", "fonts", "Inter-Regular.ttf"),
    path.join(__dirname, "assets", "fonts", "Roboto-Regular.ttf"),
    path.join(__dirname, "assets", "fonts", "Arial.ttf"),
  ];
  for (const p of tryPaths) if (fs.existsSync(p)) return p;
  return null;
}

// Detecta si ffmpeg soporta drawtext
async function supportsDrawtext() {
  let ok = true;
  const probeOut = path.join(__dirname, ".__probe_ignore.mp4");
  await new Promise((resolve) => {
    ffmpeg()
      .on("stderr", (l) => { if (/No such filter: 'drawtext'|freetype/i.test(l)) ok = false; })
      .on("error", () => resolve())
      .on("end", () => resolve())
      .input("color=black:s=16x16:r=1").inputOptions(["-f", "lavfi"])
      .complexFilter("drawtext=text=hi:fontcolor=white")
      .frames(1)
      .save(probeOut);
  });
  try { fs.unlinkSync(probeOut); } catch {}
  return ok;
}

// Render del video (a prueba de fallos)
async function renderVideo({ bgKey, audioPath, srtPath, title, outMp4, maxDurationSec }) {
  const bgMap = {
    gaming:   "assets/bg/gaming.mp4",
    abstract: "assets/bg/abstract.mp4",
    city:     "assets/bg/city.mp4",
    nature:   "assets/bg/nature.mp4"
  };

  const wantsSolid = String(bgKey || "").toLowerCase() === "solid";
  const requested  = bgMap[bgKey] || bgMap["abstract"];
  const usable     = wantsSolid ? false : (requested && fs.existsSync(requested));

  const fontFile = getFontFile();
  const hasDraw  = fontFile ? await supportsDrawtext() : false;

  const titleRaw  = title || "RedditToReels";
  const titleSafe = titleRaw
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");

  const fontPosix = fontFile ? fontFile.replace(/\\/g, "/").replace(/:/g, "\\:") : null;

  return new Promise((resolve, reject) => {
    let cmd = ffmpeg();

    if (usable) {
      cmd = cmd.input(requested);
    } else {
      cmd = cmd.input("color=c=0x0a0f1f:s=1080x1920:r=30").inputOptions(["-f", "lavfi"]);
    }

    const base = `[0:v]scale=1080:1920,setsar=1,format=yuv420p`;

    const overlay = (fontPosix && hasDraw)
      ? `,drawbox=x=80:y=100:w=920:h=160:color=black@0.4:t=filled` +
        `,drawtext=fontfile=${fontPosix}:text='${titleSafe}':fontcolor=white:fontsize=52:` +
        `x=(w-text_w)/2:y=130:shadowx=2:shadowy=2`
      : ``;

    const filter = `${base}${overlay}[v]`;

    cmd
      .input(audioPath)
      .complexFilter(filter)
      .outputOptions([
        "-map", "[v]", "-map", "1:a",
        "-shortest",
        "-r", "30",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-crf", "23",
        ...(maxDurationSec ? ["-t", String(maxDurationSec)] : [])
      ])
      .on("error", (e) => reject(e))
      .on("end", () => resolve(outMp4))
      .save(outMp4);
  });
}

/* ===========================
   ENDPOINT PRINCIPAL
=========================== */

app.post("/api/generate", async (req, res) => {
  try {
    const { mode, redditUrl, storyTitle, script, voice, background, duration } = req.body || {};
    let title = storyTitle || "RedditToReels";
    let bodyText = script || "";

    if (mode === "url") {
      const { title: t, script: s } = await fetchRedditText(redditUrl);
      title = t || title;
      if (!bodyText) bodyText = s;
    }

    if (!bodyText?.trim()) return res.status(400).json({ error: "No hay texto para narrar." });

    const id = uuidv4();
    const workDir = path.join(__dirname, "outputs", id);
    await fs.promises.mkdir(workDir, { recursive: true });

    const audioPath = path.join(workDir, "voice.mp3");
    const srtPath   = path.join(workDir, "captions.srt");
    const outMp4    = path.join(workDir, "video.mp4");

    await ttsPolly(bodyText, voice, audioPath);

    const dur = await getAudioDurationSec(audioPath);
    makeSrtFromText(bodyText, dur, srtPath);

    const maxDurationSec = duration ? Number(duration) : undefined;
    await renderVideo({ bgKey: background, audioPath, srtPath, title, outMp4, maxDurationSec });

    res.json({
      id,
      downloadUrl: `${BASE_URL}/outputs/${id}/video.mp4`,
      srtUrl: `${BASE_URL}/outputs/${id}/captions.srt`,
      audioUrl: `${BASE_URL}/outputs/${id}/voice.mp3`
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Error generando video" });
  }
});

app.listen(PORT, () => console.log(`✅ API lista en ${BASE_URL}`));
