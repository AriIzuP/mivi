import { computeFFTAtTime } from "@/lib/audio/fft-precompute";
import type { RecorderResources } from "./recorder-resources";
import { createRenderer } from "@/lib/renderers/create-renderer";
import { drawFrame } from "@/lib/renderers/draw-frame";
import { runLegacyRecorder } from "./legacy-recorder";
export async function runLegacyRecorder(
resources: RecorderResources,
onProgress: (progress: number) => void,
signal: AbortSignal,
): Promise<Blob> {
if (
typeof MediaRecorder === "undefined" ||
typeof HTMLCanvasElement.prototype.captureStream !== "function"
) {
throw new Error(
"Browser ini belum mendukung MediaRecorder atau canvas.captureStream. Coba browser yang lebih baru.",
);
}

if (signal.aborted) {
throw new Error("Export cancelled");
}

const { audioSource, rendererConfig, midiTracks, backgroundImageBitmap } =
resources;

const canvas = document.createElement("canvas");
canvas.width = rendererConfig.resolution.width;
canvas.height = rendererConfig.resolution.height;

const ctx = canvas.getContext("2d");
if (!ctx) {
throw new Error("Tidak bisa membuat canvas untuk ekspor.");
}

const renderer = createRenderer(rendererConfig.type, ctx);
const tracks = midiTracks?.tracks ?? [];
const midiOffset = midiTracks?.midiOffset ?? 0;

const canvasStream = canvas.captureStream(rendererConfig.fps);
const audioContext = new AudioContext();
let animationFrame = 0;
let source: AudioBufferSourceNode | undefined;
let recorder: MediaRecorder | undefined;

try {
const fileBuffer = await audioSource.file.arrayBuffer();
const audioBuffer = await audioContext.decodeAudioData(fileBuffer);

if (signal.aborted) {
  throw new Error("Export cancelled");
}

const audioDestination = audioContext.createMediaStreamDestination();
source = audioContext.createBufferSource();
source.buffer = audioBuffer;
source.connect(audioDestination);

const combinedStream = new MediaStream([
  ...canvasStream.getVideoTracks(),
  ...audioDestination.stream.getAudioTracks(),
]);

const mimeType = MediaRecorder.isTypeSupported(
  "video/webm;codecs=vp8,opus",
)
  ? "video/webm;codecs=vp8,opus"
  : "video/webm";

recorder = new MediaRecorder(combinedStream, { mimeType });

const chunks: Blob[] = [];

const result = new Promise<Blob>((resolve, reject) => {
  recorder!.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder!.onerror = () => {
    reject(new Error("Gagal merekam video."));
  };

  recorder!.onstop = () => {
    if (signal.aborted) {
      reject(new Error("Export cancelled"));
      return;
    }

    if (chunks.length === 0) {
      reject(new Error("Video kosong. Coba ekspor lagi."));
      return;
    }

    resolve(
      new Blob(chunks, {
        type: recorder!.mimeType || "video/webm",
      }),
    );
  };
});

const abortRecording = () => {
  try {
    source?.stop();
  } catch {
    // Sumber audio mungkin sudah berhenti.
  }

  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
};

signal.addEventListener("abort", abortRecording, { once: true });

try {
  await audioContext.resume();

  if (signal.aborted) {
    throw new Error("Export cancelled");
  }

  recorder.start(1000);

  const duration = audioBuffer.duration;
  let startedAt = 0;

  source.onended = () => {
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  source.start();
  startedAt = audioContext.currentTime;

  const draw = () => {
    if (signal.aborted) return;

    const time = Math.min(
      audioContext.currentTime - startedAt,
      duration,
    );

    const audioVisualizerConfig =
      rendererConfig.audioVisualizerConfig;

    const frequencyData =
      audioVisualizerConfig.style === "none"
        ? null
        : computeFFTAtTime(audioSource.serialized, time, {
            fftSize: audioVisualizerConfig.fftSize,
          });

    drawFrame(ctx, {
      config: rendererConfig,
      renderer,
      tracks,
      currentTime: time + midiOffset,
      frequencyData,
      backgroundImageBitmap,
    });

    onProgress(Math.min(time / duration, 0.99));

    if (time < duration && !signal.aborted) {
      animationFrame = requestAnimationFrame(draw);
    }
  };

  draw();

  const blob = await result;
  onProgress(1);
  return blob;
} finally {
  signal.removeEventListener("abort", abortRecording);
}

} finally {
cancelAnimationFrame(animationFrame);

try {
  source?.stop();
} catch {
  // Sumber audio mungkin sudah berhenti.
}

for (const track of canvasStream.getTracks()) {
  track.stop();
}

await audioContext.close().catch(() => {});

}
}
