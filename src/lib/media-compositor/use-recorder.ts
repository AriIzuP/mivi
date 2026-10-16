import { useState, useCallback, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";

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

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onloadend = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Gagal membaca hasil video."));
        return;
      }

      resolve(reader.result.split(",")[1]);
    };

    reader.onerror = () => {
      reject(new Error("Gagal mengubah video."));
    };

    reader.readAsDataURL(blob);
  });
}

export function useRecorder() {
  const { midiTracksStore, rendererConfigStore, fileStore } = useAppContext();

  const [recordingState, setRecordingState] =
    useState<RecordingStatus>(new ReadyState());

  const abortControllerRef = useRef<AbortController | null>(null);

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

      console.log("[MiVI Export] Platform:", Capacitor.getPlatform());
      console.log("[MiVI Export] Modern:", supportsModernExport);
      console.log("[MiVI Export] Legacy:", supportsLegacyExport);

      const recordingPromise = supportsModernExport
        ? runRecorder(resources, onProgress, signal)
        : supportsLegacyExport
          ? runLegacyRecorder(resources, onProgress, signal)
          : runRecorder(resources, onProgress, signal);

      return recordingPromise
        .then(async (file) => {
          if (signal.aborted) return;

          console.log("[MiVI Export] Size:", file.size);
          console.log("[MiVI Export] Type:", file.type);

          toast.add({
            title: `DEBUG: ${Capacitor.getPlatform()} | ${file.size} bytes`,
            type: "info",
          });

          if (file.size < 10000) {
            errorLogWithToast(
              `Video terlalu kecil: ${file.size} bytes. Ekspor kemungkinan gagal.`,
            );
            return;
          }

          const exportName =
            midiTracks?.name ?? audioSource.name ?? "audio";

          const extension = file.type.includes("webm")
            ? "webm"
            : rendererConfig.format;

          const fileName = `mivi-${exportName}.${extension}`;

          if (Capacitor.isNativePlatform()) {
            toast.add({
              title: "DEBUG: Mulai mengubah video",
              type: "info",
            });

            const base64Data = await blobToBase64(file);

            toast.add({
              title: "DEBUG: Mulai menyimpan video",
              type: "info",
            });

            const savedFile = await Filesystem.writeFile({
              path: fileName,
              data: base64Data,
              directory: Directory.Cache,
            });

            console.log("[MiVI Export] Saved URI:", savedFile.uri);

            toast.add({
              title: "DEBUG: File berhasil disimpan",
              type: "success",
            });

            toast.add({
              title: "DEBUG: Membuka menu berbagi",
              type: "info",
            });

            await Share.share({
              title: "Video MiVI",
              text: "Video hasil ekspor MiVI",
              files: [savedFile.uri],
              dialogTitle: "Simpan atau bagikan video",
            });

            toast.add({
              title: "Video siap dibagikan",
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

          if (signal.aborted) {
            toast.add({
              title: "Export cancelled",
              type: "info",
            });
            return;
          }

          errorLogWithToast("Failed during recording", error);
        })
        .finally(() => {
          abortControllerRef.current = null;
          setRecordingState(new ReadyState());
        });
    } else {
      abortControllerRef.current?.abort(new Error("Cancelled"));
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
