import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Check, Download, FileUp, Moon, Pause, Play, Plus, RefreshCw, Sun, X } from "lucide-react";
import {
  bufferToWav,
  decodeAudioFile,
  getAudioContext,
  peaksFromBuffer,
  renderAtSpeed,
  reversedCopy,
} from "@/lib/audio/convert";
import {
  formatBytes,
  formatClock,
  formatSpeed,
  modeLabel,
  outputFileName,
  snapSpeed,
  speedRatio,
} from "@/lib/audio/speed";

type Phase = "idle" | "busy" | "ready";
type Theme = "dark" | "light";
type OutputFile = { speed: number; url: string; name: string };
type Engine = {
  ctx: AudioContext | null;
  source: AudioBufferSourceNode | null;
  playing: boolean;
  offset: number;
  startedAt: number;
  rate: number;
  buffer: AudioBuffer | null;
};

const ACCEPT = [
  "audio/*",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  ".mp3",
  ".wav",
  ".wave",
  ".flac",
  ".ogg",
  ".oga",
  ".opus",
  ".m4a",
  ".aac",
  ".mp4",
  ".m4b",
  ".webm",
  ".wma",
  ".amr",
  ".aiff",
  ".aif",
  ".aifc",
  ".caf",
  ".ac3",
  ".mp2",
  ".mka",
  ".ape",
  ".wv",
  ".spx",
  ".3gp",
  ".au",
  ".snd",
  ".w64",
  ".mov",
  ".mkv",
].join(",");

function Spinner() {
  return (
    <svg className="spin size-7 shrink-0" viewBox="0 0 36 36" aria-hidden="true">
      <circle cx="18" cy="18" r="14" fill="none" stroke="var(--track)" strokeWidth="3.5" />
      <circle
        cx="18"
        cy="18"
        r="14"
        fill="none"
        stroke="var(--accent-2)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray="26 88"
      />
    </svg>
  );
}

export function Converter() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [speed, setSpeed] = useState(1);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busyLabel, setBusyLabel] = useState("Reading audio...");
  const [fileInfo, setFileInfo] = useState<{ name: string; size: number } | null>(null);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [usingRender, setUsingRender] = useState(false);
  const [output, setOutput] = useState<OutputFile | null>(null);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [clock, setClock] = useState("00:00 / 00:00");
  const [dragging, setDragging] = useState(false);

  const speedRef = useRef(speed);
  const fileRef = useRef(fileInfo);
  const outputRef = useRef(output);
  const phaseRef = useRef(phase);
  const originalRef = useRef<AudioBuffer | null>(null);
  const reversedRef = useRef<AudioBuffer | null>(null);
  const renderedRef = useRef<AudioBuffer | null>(null);
  const renderedSpeedRef = useRef<number | null>(null);
  const sourcePeaksRef = useRef<number[]>([]);
  const renderedPeaksRef = useRef<number[]>([]);
  const peaksRef = useRef<number[]>([]);
  const jobRef = useRef(0);
  const dirtyRef = useRef(false);
  const dragDepth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engRef = useRef<Engine>({
    ctx: null,
    source: null,
    playing: false,
    offset: 0,
    startedAt: 0,
    rate: 1,
    buffer: null,
  });

  speedRef.current = speed;
  fileRef.current = fileInfo;
  outputRef.current = output;
  phaseRef.current = phase;
  peaksRef.current = peaks;

  function peekTarget(nextSpeed: number): { buffer: AudioBuffer; rate: number } | null {
    const original = originalRef.current;
    if (!original || nextSpeed === 0) return null;
    if (renderedRef.current && renderedSpeedRef.current === nextSpeed) {
      return { buffer: renderedRef.current, rate: 1 };
    }
    if (nextSpeed < 0 && reversedRef.current) {
      return { buffer: reversedRef.current, rate: -nextSpeed };
    }
    return { buffer: original, rate: Math.abs(nextSpeed) };
  }

  function metrics() {
    const eng = engRef.current;
    const nextSpeed = speedRef.current;
    let buffer = eng.buffer;
    let rate = eng.rate || 1;
    let offset = eng.offset;
    if (eng.playing && eng.ctx && buffer) {
      offset = Math.min(buffer.duration, eng.offset + (eng.ctx.currentTime - eng.startedAt) * eng.rate);
    } else {
      const target = peekTarget(nextSpeed);
      if (!target) return { cur: 0, total: 0, ratio: 0 };
      buffer = target.buffer;
      rate = target.rate;
      offset = Math.min(buffer.duration, offset);
    }
    if (!buffer || rate <= 0) return { cur: 0, total: 0, ratio: 0 };
    const ratio = buffer.duration > 0 ? offset / buffer.duration : 0;
    return { cur: offset / rate, total: buffer.duration / rate, ratio };
  }

  function publishClock() {
    const m = metrics();
    setClock(`${formatClock(m.cur)} / ${formatClock(m.total)}`);
    dirtyRef.current = true;
  }

  function drawWave(ratio: number) {
    const canvas = canvasRef.current;
    const data = peaksRef.current;
    if (!canvas || data.length < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w < 2 || h < 2) return;
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }
    const g = canvas.getContext("2d");
    if (!g) return;
    const styles = getComputedStyle(document.documentElement);
    const c1 = styles.getPropertyValue("--wave-1").trim() || "#5b9dff";
    const c2 = styles.getPropertyValue("--wave-2").trim() || "#c084fc";
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    const mid = h / 2;
    const paint = (alpha: number, from: number, to: number) => {
      g.save();
      g.beginPath();
      g.rect(from * w, 0, Math.max(0, (to - from) * w), h);
      g.clip();
      g.globalAlpha = alpha;
      g.beginPath();
      const n = data.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * w;
        const y = mid - data[i] * (mid - 3);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      for (let i = n - 1; i >= 0; i--) {
        const x = (i / (n - 1)) * w;
        const y = mid + data[i] * (mid - 3);
        g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = grad;
      g.fill();
      g.restore();
    };
    paint(0.35, 0, 1);
    if (ratio > 0.002) paint(1, 0, Math.min(1, ratio));
  }

  const apiRef = useRef({ metrics, drawWave });
  apiRef.current = { metrics, drawWave };

  useEffect(() => {
    const saved = localStorage.getItem("uac-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = 0;
    const loop = (t: number) => {
      frame = requestAnimationFrame(loop);
      const eng = engRef.current;
      if (!eng.playing && !dirtyRef.current) return;
      const m = apiRef.current.metrics();
      apiRef.current.drawWave(m.ratio);
      dirtyRef.current = false;
      if (eng.playing && t - last > 100) {
        last = t;
        setClock(`${formatClock(m.cur)} / ${formatClock(m.total)}`);
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    dirtyRef.current = true;
  }, [theme, peaks, usingRender]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => {
      dirtyRef.current = true;
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [peaks.length]);

  useEffect(() => {
    const block = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  useEffect(() => {
    return () => {
      const eng = engRef.current;
      if (eng.source) {
        eng.source.onended = null;
        try {
          eng.source.stop();
        } catch {
          /* already stopped */
        }
      }
      if (outputRef.current) URL.revokeObjectURL(outputRef.current.url);
    };
  }, []);

  function chooseTheme(next: Theme) {
    setTheme(next);
    document.documentElement.classList.toggle("light", next === "light");
    localStorage.setItem("uac-theme", next);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", next === "light" ? "#e8edf7" : "#0c1022");
    dirtyRef.current = true;
  }

  function halt() {
    const eng = engRef.current;
    if (eng.source) {
      eng.source.onended = null;
      try {
        eng.source.stop();
      } catch {
        /* already stopped */
      }
      eng.source.disconnect();
      eng.source = null;
    }
    eng.playing = false;
    setPlaying(false);
  }

  function forgetOutput() {
    if (outputRef.current) URL.revokeObjectURL(outputRef.current.url);
    outputRef.current = null;
    renderedRef.current = null;
    renderedSpeedRef.current = null;
    renderedPeaksRef.current = [];
    setOutput(null);
    setUsingRender(false);
  }

  function clearFile() {
    jobRef.current += 1;
    halt();
    originalRef.current = null;
    reversedRef.current = null;
    forgetOutput();
    setFileInfo(null);
    fileRef.current = null;
    setPeaks([]);
    sourcePeaksRef.current = [];
    setError("");
    setPhase("idle");
    phaseRef.current = "idle";
    setClock("00:00 / 00:00");
    engRef.current.offset = 0;
    engRef.current.buffer = null;
    if (inputRef.current) inputRef.current.value = "";
  }

  function applySpeed(value: number) {
    const next = snapSpeed(value);
    if (engRef.current.playing && engRef.current.ctx && engRef.current.buffer) {
      const pos =
        engRef.current.offset +
        (engRef.current.ctx.currentTime - engRef.current.startedAt) * engRef.current.rate;
      engRef.current.offset = pos;
    }
    halt();
    engRef.current.offset = 0;
    setSpeed(next);
    speedRef.current = next;
    const match = renderedSpeedRef.current === next && Boolean(renderedRef.current);
    setUsingRender(match);
    if (match) setPeaks(renderedPeaksRef.current);
    else if (sourcePeaksRef.current.length) {
      const src = sourcePeaksRef.current;
      setPeaks(next < 0 ? [...src].reverse() : src);
    }
    publishClock();
  }

  async function loadFile(file: File) {
    if (
      file.type.startsWith("image/") ||
      file.type.startsWith("text/") ||
      file.type === "application/pdf" ||
      file.type === "application/zip"
    ) {
      setError("Drop an audio file.");
      return;
    }
    if (file.size > 400 * 1024 * 1024) {
      setError("This file is too large. Try something under 400 MB.");
      return;
    }
    const job = ++jobRef.current;
    halt();
    originalRef.current = null;
    reversedRef.current = null;
    forgetOutput();
    setError("");
    setPeaks([]);
    setClock("00:00 / 00:00");
    const info = { name: file.name, size: file.size };
    setFileInfo(info);
    fileRef.current = info;
    phaseRef.current = "busy";
    setPhase("busy");
    setBusyLabel("Reading audio...");
    engRef.current.offset = 0;
    engRef.current.buffer = null;
    try {
      const buffer = await decodeAudioFile(file, (label, ratio) => {
        if (job !== jobRef.current) return;
        const pct = Math.round(ratio * 100);
        setBusyLabel(pct > 0 && pct < 100 ? `${label.replace(/\.\.\.$/, "")}... ${pct}%` : label);
      });
      if (job !== jobRef.current) return;
      originalRef.current = buffer;
      const nextPeaks = peaksFromBuffer(buffer);
      sourcePeaksRef.current = nextPeaks;
      setPeaks(speedRef.current < 0 ? [...nextPeaks].reverse() : nextPeaks);
      setUsingRender(false);
      engRef.current.buffer = buffer;
      engRef.current.rate = Math.abs(speedRef.current) || 1;
      phaseRef.current = "ready";
      setPhase("ready");
      publishClock();
    } catch (err) {
      if (job !== jobRef.current) return;
      originalRef.current = null;
      setFileInfo(null);
      fileRef.current = null;
      phaseRef.current = "idle";
      setPhase("idle");
      setError(err instanceof Error ? err.message : "Couldn't read this file.");
    }
  }

  async function convert() {
    const original = originalRef.current;
    const nextSpeed = speedRef.current;
    if (!original || phaseRef.current === "busy") return;
    if (nextSpeed === 0) {
      setError("0.0x is silent. Move the slider off zero.");
      return;
    }
    if (renderedRef.current && renderedSpeedRef.current === nextSpeed && outputRef.current) {
      setError("");
      setUsingRender(true);
      setPeaks(renderedPeaksRef.current);
      return;
    }
    const job = ++jobRef.current;
    halt();
    phaseRef.current = "busy";
    setPhase("busy");
    setError("");
    setBusyLabel("Converting... 1%");
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      const rendered = await renderAtSpeed(original, nextSpeed, (ratio) => {
        if (job !== jobRef.current) return;
        const pct = Math.min(92, Math.max(1, Math.round(ratio * 92)));
        setBusyLabel(`Converting... ${pct}%`);
      });
      if (job !== jobRef.current) return;
      const blob = await bufferToWav(rendered, (ratio) => {
        if (job !== jobRef.current) return;
        const pct = Math.min(99, 92 + Math.round(ratio * 8));
        setBusyLabel(`Converting... ${pct}%`);
      });
      if (job !== jobRef.current) return;
      if (outputRef.current) URL.revokeObjectURL(outputRef.current.url);
      const next: OutputFile = {
        speed: nextSpeed,
        url: URL.createObjectURL(blob),
        name: outputFileName(fileRef.current?.name ?? "audio", nextSpeed),
      };
      outputRef.current = next;
      renderedRef.current = rendered;
      renderedSpeedRef.current = nextSpeed;
      const nextPeaks = peaksFromBuffer(rendered);
      renderedPeaksRef.current = nextPeaks;
      setPeaks(nextPeaks);
      setUsingRender(true);
      setOutput(next);
      engRef.current.offset = 0;
      engRef.current.buffer = rendered;
      engRef.current.rate = 1;
      setBusyLabel("Converting... 100%");
      phaseRef.current = "ready";
      setPhase("ready");
      publishClock();
    } catch (err) {
      if (job !== jobRef.current) return;
      const nextPhase = originalRef.current ? "ready" : "idle";
      phaseRef.current = nextPhase;
      setPhase(nextPhase);
      setError(err instanceof Error ? err.message : "Conversion failed.");
    }
  }

  async function togglePlay() {
    const eng = engRef.current;
    if (eng.playing) {
      if (eng.ctx && eng.buffer) {
        const pos = eng.offset + (eng.ctx.currentTime - eng.startedAt) * eng.rate;
        eng.offset = Math.min(eng.buffer.duration, Math.max(0, pos));
      }
      halt();
      publishClock();
      return;
    }
    const nextSpeed = speedRef.current;
    const original = originalRef.current;
    if (!original || nextSpeed === 0 || phase !== "ready") return;
    const usingRendered = Boolean(renderedRef.current && renderedSpeedRef.current === nextSpeed);
    if (nextSpeed < 0 && !usingRendered && !reversedRef.current) {
      reversedRef.current = reversedCopy(original);
    }
    const target = peekTarget(nextSpeed);
    if (!target) return;
    const ctx = getAudioContext();
    await ctx.resume();
    if (eng.offset >= target.buffer.duration - 0.02) eng.offset = 0;
    const src = ctx.createBufferSource();
    src.buffer = target.buffer;
    src.playbackRate.value = target.rate;
    src.connect(ctx.destination);
    src.onended = () => {
      if (eng.source !== src) return;
      eng.source = null;
      eng.playing = false;
      eng.offset = eng.buffer?.duration ?? 0;
      setPlaying(false);
      publishClock();
    };
    const startAt = Math.min(eng.offset, Math.max(0, target.buffer.duration - 0.01));
    src.start(0, startAt);
    eng.source = src;
    eng.ctx = ctx;
    eng.buffer = target.buffer;
    eng.rate = target.rate;
    eng.offset = startAt;
    eng.startedAt = ctx.currentTime;
    eng.playing = true;
    setPlaying(true);
  }

  function seekRatio(ratio: number) {
    const target = peekTarget(speedRef.current);
    if (!target || phase !== "ready") return;
    const wasPlaying = engRef.current.playing;
    halt();
    engRef.current.offset = Math.min(1, Math.max(0, ratio)) * target.buffer.duration;
    publishClock();
    if (wasPlaying) void togglePlay();
  }

  function onDrop(event: ReactDragEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void loadFile(file);
  }

  const busy = phase === "busy";
  const canConvert = Boolean(fileInfo) && phase === "ready" && speed !== 0;
  const canPlay = phase === "ready" && speed !== 0 && peaks.length > 0;
  const downloadReady = Boolean(output && output.speed === speed);
  const showStage = Boolean(fileInfo) && (busy || peaks.length > 0 || usingRender);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 px-4 py-5">
      <header className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 flex-1 truncate text-lg font-extrabold tracking-tight">
          <div className="flex flex-col leading-tight">
            <span className="text-xl font-bold text-white">
            thisisummam
            </span>
            <span className="text-xs font-bold text-gray-400">
            Audio Playback Speed Changer
            </span>
          </div>
        </h1>
        <div className="flex h-11 shrink-0 items-center rounded-full border border-line bg-well p-1" role="group" aria-label="Theme">
          <button
            type="button"
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            onClick={() => chooseTheme("dark")}
            className={`flex size-9 items-center justify-center rounded-full ${theme === "dark" ? "bg-card text-ink" : "text-muted"}`}
          >
            <Moon className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Light theme"
            aria-pressed={theme === "light"}
            onClick={() => chooseTheme("light")}
            className={`flex size-9 items-center justify-center rounded-full ${theme === "light" ? "bg-card text-ink" : "text-muted"}`}
          >
            <Sun className="size-4" />
          </button>
        </div>
      </header>

      <section className="panel p-4">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={onDrop}
          className={`flex min-h-44 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-4 py-6 text-center ${dragging ? "border-accent bg-well" : "border-dash"}`}
        >
          <span className="relative text-muted">
            <FileUp className="size-12" strokeWidth={1.5} />
            <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-card text-ink ring-1 ring-line">
              <Plus className="size-3.5" />
            </span>
          </span>
          <span className="text-sm font-medium text-ink">Drag & drop audio file here</span>
          <span className="rounded-full bg-well px-4 py-2 text-sm font-semibold text-ink">atau Browse File</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label="Browse audio file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void loadFile(file);
          }}
        />
        {fileInfo && (
          <div className="mt-3 flex items-center gap-2 px-1">
            <p className="min-w-0 flex-1 truncate text-sm text-muted" title={fileInfo.name}>
              {fileInfo.name} ({formatBytes(fileInfo.size)})
            </p>
            <button
              type="button"
              onClick={clearFile}
              aria-label="Remove audio file"
              className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted"
            >
              <X className="size-5" />
            </button>
          </div>
        )}
      </section>

      <section className="panel px-4 pt-4 pb-3">
        <h2 className="text-center text-base font-semibold">Adjust Playback Speed</h2>
        <p className={`mt-2 text-center text-5xl font-extrabold tracking-tight ${speed === 0 ? "text-danger" : "speed-num"}`}>
          {formatSpeed(speed)}
        </p>
        <p className="text-center text-sm font-medium text-muted">{modeLabel(speed)}</p>
        <div className="relative mt-3 h-11">
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-track" />
          <div
            className="pointer-events-none absolute top-1/2 left-0 h-1.5 -translate-y-1/2 rounded-full"
            style={{
              width: `${speedRatio(speed) * 100}%`,
              background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
            }}
          />
          <input
            className="speed-range absolute inset-0"
            type="range"
            min={-5}
            max={5}
            step={0.1}
            value={speed}
            disabled={busy}
            aria-label="Playback speed"
            aria-valuetext={`${formatSpeed(speed)}, ${modeLabel(speed)}`}
            onChange={(event) => applySpeed(Number(event.target.value))}
            onDoubleClick={() => applySpeed(1)}
          />
        </div>
        <div className="relative mt-1 h-10 text-xs text-muted tabular-nums">
          <span className="absolute top-0 left-0">-5.0x</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => applySpeed(1)}
            className="absolute top-0 -translate-x-1/2 text-center leading-tight"
            style={{ left: "60%" }}
            aria-label="Reset playback speed to 1.0x normal"
          >
            <span className="block">1.0x</span>
            <span className="block">Normal</span>
          </button>
          <span className="absolute top-0 right-0">+5.0x</span>
        </div>
        <p className="mt-1 text-center text-xs text-muted">Below zero plays in reverse. Pitch changes with speed.</p>
      </section>

      <button
        type="button"
        className="btn-convert flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-base font-extrabold tracking-wide"
        disabled={!canConvert}
        onClick={() => void convert()}
      >
        {busy && peaks.length > 0 ? "CONVERTING..." : "CONVERT AUDIO"}
        <RefreshCw className={`size-5 ${busy && peaks.length > 0 ? "spin" : ""}`} />
      </button>

      {error && (
        <p role="alert" className="text-center text-sm font-medium text-danger">
          {error}
        </p>
      )}

      {showStage && (
        <section className="panel p-4" aria-live="polite">
          {busy && (
            <div className="mb-3 flex items-center justify-center gap-3">
              <Spinner />
              <p className="text-base font-semibold">{busyLabel}</p>
            </div>
          )}
          {!busy && usingRender && output && (
            <div className="mb-3 flex items-center justify-center gap-2">
              <Check className="size-5 text-teal" />
              <p className="text-base font-semibold">
                Converted · {formatSpeed(output.speed)} · WAV
              </p>
            </div>
          )}
          {peaks.length > 0 && (
            <>
              <div
                className="rounded-2xl bg-well px-3 py-4"
                role="slider"
                aria-label="Playback position"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(metrics().ratio * 100)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight") seekRatio(metrics().ratio + 0.02);
                  if (event.key === "ArrowLeft") seekRatio(metrics().ratio - 0.02);
                }}
                onPointerDown={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  seekRatio((event.clientX - rect.left) / rect.width);
                }}
              >
                <canvas ref={canvasRef} className="h-16 w-full" />
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="flex h-11 items-center gap-2 text-sm font-medium"
                  disabled={!canPlay}
                  onClick={() => void togglePlay()}
                >
                  {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
                  Play/Pause
                </button>
                <p className="text-sm font-medium text-muted tabular-nums">{clock}</p>
              </div>
            </>
          )}
        </section>
      )}

      {downloadReady && output ? (
        <a
          className="btn-download flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-sm font-extrabold tracking-wide"
          href={output.url}
          download={output.name}
        >
          <Download className="size-5" />
          DOWNLOAD CONVERTED AUDIO
        </a>
      ) : (
        <button
          type="button"
          disabled
          className="btn-download flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-sm font-extrabold tracking-wide"
        >
          <Download className="size-5" />
          DOWNLOAD CONVERTED AUDIO
        </button>
      )}
    </main>
  );
}
