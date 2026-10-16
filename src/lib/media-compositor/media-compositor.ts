import {
  ALL_FORMATS,
  BlobSource,
  CanvasSource,
  Conversion,
  Input,
  Output,
  Quality,
  StreamTarget,
  type ConversionAudioOptions,
  type StreamTargetChunk,
} from "mediabunny";

import { precomputeFFTData, getFrameAtTime } from "@/lib/audio/fft-precompute";
import { OUTPUT_FORMATS, type OutputFormatConfig } from "@/lib/muxer/output-format";
import { createRenderer } from "@/lib/renderers/create-renderer";
import { drawFrame } from "@/lib/renderers/draw-frame";

import { RecorderResources } from "./recorder-resources";

const keyFrameEveryFrames = 60;
const audioLeadSeconds = 1;
const videoBitrate = 10_000_000;
const mp4VideoBitrate = 3_000_000;
const audioBitrate = 192_000;

export type ExportPhase = "FFT" | "Audio" | "Video Render" | "Video Encode";

export interface ExportPhasePlan {
  name: ExportPhase;
  total: number;
}

export type PhaseProgressListener = (phase: ExportPhase, completed: number) => void;

export class MediaCompositor {
  readonly #resources: RecorderResources;
  readonly #outputFormat: OutputFormatConfig;
  readonly #canvas: OffscreenCanvas;
  readonly #output: Output;
  readonly #video: CanvasSource;
  readonly #listeners = new Set<PhaseProgressListener>();
  readonly phases: readonly ExportPhasePlan[];

  #audioConversion: Conversion | undefined;
  #encodedVideoFrames = 0;

  constructor(
    resources: RecorderResources,
    writable: WritableStream<StreamTargetChunk>,
  ) {
    this.#resources = resources;

    this.phases = [
      { name: "FFT", total: this.#totalVideoFrames },
      { name: "Audio", total: this.#duration },
      { name: "Video Render", total: this.#totalVideoFrames },
      { name: "Video Encode", total: this.#totalVideoFrames },
    ];

    const { resolution, format } = this.#rendererConfig;

    this.#outputFormat = OUTPUT_FORMATS[format];

    const selectedBitrate =
      format === "mp4" ? mp4VideoBitrate : videoBitrate;

    this.#canvas = new OffscreenCanvas(
      resolution.width,
      resolution.height,
    );

    this.#video = new CanvasSource(this.#canvas, {
      codec: this.#outputFormat.videoCodec,
      quality: new Quality({ bitrate: selectedBitrate }),
      fullCodecString: this.#outputFormat.videoCodecString(
        resolution,
        this.#fps,
      ),
      keyFrameInterval: keyFrameEveryFrames / this.#fps,
      onEncodedPacket: () =>
        this.#emit("Video Encode", ++this.#encodedVideoFrames),
    });

    this.#output = new Output({
      format: this.#outputFormat.outputFormat,
      target: new StreamTarget(writable),
    });

    this.#output.addVideoTrack(this.#video, {
      frameRate: this.#fps,
    });
  }

  // PENTING:
  // Pertahankan semua method lain dari file aslimu
  // mulai dari sini sampai akhir file.
}
