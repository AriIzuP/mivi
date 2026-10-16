import { useState, useCallback, useRef } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";

import { toast } from "@/components/ui/toast";
import { useAppContext } from "@/contexts/app-context";
import { errorLogWithToast } from "@/lib/error-toast";
import {
  RecordingStatus,
  ReadyState,
  RecordingState,
} from "@/lib/media-compositor/recording-status";

import type { ActivePhase } from "./export-progress-tracker";
import { runRecorder } from "./run-recorder-worker";
import { runLegacyRecorder } from "./legacy-recorder";

interface VideoSaverPlugin {
  beginSave(options: {
    fileName: string;
    contentType: string;
  }): Promise<{ uri: string }>;

  appendChunk(options: {
    base64Data: string;
  }): Promise<void>;

  finishSave(): Promise<void>;

  cancelSave(): Promise<void>;
}

const VideoSaver =
  registerPlugin<VideoSaverPlugin>("VideoSaver");

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Gagal membaca potongan video."));
        return;
      }

      const separator = reader.result.indexOf(",");

      if (separator < 0) {
        reject(new Error("Format potongan video tidak valid."));
        return;
      }

      resolve(reader.result.slice(separator + 1));
    };

    reader.onerror = () => {
      reject(new Error("Gagal membaca potongan video."));
    };

    reader.readAsDataURL(blob);
  });
}

async function saveVideoInChunks(
  file: Blob,
  fileName: string,
  contentType: string,
  signal: AbortSignal,
): Promise<{ uri: string }> {
  try {
    const destination = await VideoSaver.beginSave({
      fileName,
      contentType,
    });

    // Kirim video sedikit demi sedikit untuk mengurangi lonjakan RAM.
    const chunkSize = 128 * 1024;

    for (
      let offset = 0;
      offset < file.size;
      offset += chunkSize
    ) {
      if (signal.aborted) {
        throw new Error("EXPORT_CANCELLED");
      }

      const chunk = file.slice(
        offset,
        Math.min(offset + chunkSize, file.size),
      );

      const base64Data = await blobToBase64(chunk);

      if (signal.aborted) {
        throw new Error("EXPORT_CANCELLED");
      }

      await VideoSaver.appendChunk({ base64Data });
    }

    if (signal.aborted) {
      throw new Error("EXPORT_CANCELLED");
    }

    await VideoSaver.finishSave();

    return destination;
  } catch (error) {
    try {
      await VideoSaver.cancelSave();
    } catch {
      // Abaikan kesalahan saat membersihkan penyimpanan.
    }

    throw error;
  }
}

export function useRecorder() {
  const {
    midiTracksStore,
    rendererConfigStore,
    fileStore,
  } = useAppContext();

  const [recordingState, setRecordingState] =
    useState<RecordingStatus>(new ReadyState());

  const abortControllerRef =
    useRef<AbortController | null>(null);

  const toggleRecording = useCallback(async () => {
    if (!recordingState.isRecording) {
      const midiTracks = midiTracksStore.getSnapshot();
      const rendererConfig = rendererConfigStore.getSnapshot();
      const audio = fileStore.audio.getSnapshot();

      const audioSource =
        audio.file && audio.decoded
          ? {
              name: audio.file.name,
              file: audio.file,
              serialized: audio.decoded,
            }
          : undefined;

      const backgroundImageBitmap =
        fileStore.backgroundImage.getSnapshot().decoded;

      const rendererType = rendererConfig.type;
      const audioVisualizerStyle =
        rendererConfig.audioVisualizerConfig.style;

      if (!audioSource) {
        errorLogWithToast("Please select an audio file.");
        return;
      }

      const needsMidi = rendererType !== "none";
      const hasAudioVisualizer = audioVisualizerStyle !== "none";

      if (needsMidi && !midiTracks) {
        errorLogWithToast("Please select a MIDI file.");
        return;
      }

      if (!needsMidi && !hasAudioVisualizer) {
        errorLogWithToast(
          "Please enable audio visualizer or select a MIDI visualization style.",
        );
        return;
      }

      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const signal = abortController.signal;

      setRecordingState(new RecordingState(0));

      const onProgress = (
        progress: number,
        activePhase?: ActivePhase,
      ) => {
        setRecordingState(
          progress < 1
            ? new RecordingState(progress, activePhase)
            : new ReadyState(),
        );
      };

      const resources = {
        midiTracks,
        audioSource,
        rendererConfig,
        backgroundImageBitmap,
      };

      const supportsModernExport =
        "VideoEncoder" in window &&
        "AudioEncoder" in window &&
        "OffscreenCanvas" in window &&
        "FileSystemWritableFileStream" in window;

      const supportsLegacyExport =
        typeof MediaRecorder !== "undefined" &&
        typeof HTMLCanvasElement !== "undefined" &&
        typeof HTMLCanvasElement.prototype.captureStream === "function";

      const recordingPromise = supportsModernExport
        ? runRecorder(resources, onProgress, signal)
        : supportsLegacyExport
          ? runLegacyRecorder(resources, onProgress, signal)
          : runRecorder(resources, onProgress, signal);

      return recordingPromise
        .then(async (file) => {
          if (signal.aborted) return;

          console.log(
            "[MiVI Export] Platform:",
            Capacitor.getPlatform(),
          );
          console.log("[MiVI Export] Size:", file.size);
          console.log("[MiVI Export] Type:", file.type);

          if (file.size < 10000) {
            errorLogWithToast(
              `Video terlalu kecil: ${file.size} bytes. Ekspor kemungkinan gagal.`,
            );
            return;
          }

          const exportName =
            midiTracks?.name ?? audioSource.name ?? "audio";

          const safeName = exportName.replace(
            /[\\/:*?"<>|]/g,
            "_",
          );

          const extension = file.type.includes("webm")
            ? "webm"
            : rendererConfig.format;

          const fileName = `mivi-${safeName}.${extension}`;

          if (Capacitor.isNativePlatform()) {
            toast.add({
              title: "Menyiapkan video untuk disimpan...",
              type: "info",
            });

            const result = await saveVideoInChunks(
              file,
              fileName,
              file.type || "video/webm",
              signal,
            );

            console.log(
              "[MiVI Export] Saved URI:",
              result.uri,
            );

            toast.add({
              title: "Video berhasil disimpan",
              type: "success",
            });

            return;
          }

          const url = URL.createObjectURL(file);

          const a = document.createElement("a");
          a.href = url;
          a.download = fileName;
          a.style.display = "none";

          document.body.appendChild(a);
          a.click();

          toast.add({
            title: "Export completed",
            type: "success",
          });

          window.setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
          }, 10000);
        })
        .catch((error) => {
          console.error("[MiVI Export] Error:", error);

          const errorMessage =
            error instanceof Error
              ? error.message
              : String(error);

          if (
            signal.aborted ||
            errorMessage.includes("SAVE_CANCELLED") ||
            errorMessage.includes("EXPORT_CANCELLED")
          ) {
            toast.add({
              title: "Export cancelled",
              type: "info",
            });
            return;
          }

          errorLogWithToast(
            "Failed during recording or saving",
            error,
          );
        })
        .finally(() => {
          abortControllerRef.current = null;
          setRecordingState(new ReadyState());
        });
    } else {
      abortControllerRef.current?.abort(
        new Error("Cancelled"),
      );

      setRecordingState(new ReadyState());
    }
  }, [
    recordingState.isRecording,
    midiTracksStore,
    rendererConfigStore,
    fileStore,
  ]);

  return { recordingState, toggleRecording };
}
