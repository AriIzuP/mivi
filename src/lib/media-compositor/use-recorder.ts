import { useState, useCallback, useRef } from "react";

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
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
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

      const recordingPromise = supportsModernExport
        ? runRecorder(resources, onProgress, signal)
        : supportsLegacyExport
          ? runLegacyRecorder(resources, onProgress, signal)
          : runRecorder(resources, onProgress, signal);

      return recordingPromise
        .then((file) => {
          if (signal.aborted) return;

          const url = URL.createObjectURL(file);

          const exportName =
            midiTracks?.name ?? audioSource.name ?? "audio";

          const extension = file.type.includes("webm")
            ? "webm"
            : rendererConfig.format;

          const fileName = `mivi-${exportName}.${extension}`;

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

          // Beri waktu kepada Android/WebView untuk memproses unduhan.
          window.setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
          }, 10000);
        })
        .catch((error) => {
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
