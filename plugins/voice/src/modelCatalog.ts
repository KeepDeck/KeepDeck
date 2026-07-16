import type {
  DownloadIntegrity,
  DownloadSource,
  DownloadTarget,
  SpeechEngine,
} from "@keepdeck/plugin-api";

export interface VoiceModelSpec {
  id: string;
  label: string;
  sizeMb: number;
  engine: SpeechEngine;
  retired: boolean;
  target: DownloadTarget;
  source?: DownloadSource;
  integrity?: DownloadIntegrity;
}

export interface VoiceModelInfo extends VoiceModelSpec {
  installed: boolean;
}

export const MODEL_CATALOG: readonly VoiceModelSpec[] = [
  {
    id: "whisper-base-q5_1",
    label: "Whisper Base — fastest, good for short commands",
    sizeMb: 60,
    engine: "whisper",
    retired: true,
    target: { kind: "file", path: "models/ggml-base-q5_1.bin" },
    integrity: {
      kind: "sha256",
      digest: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
    },
  },
  {
    id: "whisper-small-q5_1",
    label: "Whisper Small — balanced",
    sizeMb: 190,
    engine: "whisper",
    retired: true,
    target: { kind: "file", path: "models/ggml-small-q5_1.bin" },
    integrity: {
      kind: "sha256",
      digest: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
    },
  },
  {
    id: "whisper-small",
    label: "Whisper Small — good for short commands",
    sizeMb: 465,
    engine: "whisper",
    retired: false,
    source: { url: "https://blob.handy.computer/ggml-small.bin" },
    target: { kind: "file", path: "models/ggml-small.bin" },
    integrity: {
      kind: "sha256",
      digest: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
      bytes: 487_601_967,
    },
  },
  {
    id: "whisper-large-v3-turbo-q5_0",
    label: "Whisper Large v3 Turbo — best accuracy, for dictation",
    sizeMb: 574,
    engine: "whisper",
    retired: false,
    source: {
      url: "https://blob.handy.computer/ggml-large-v3-turbo-q5_0.bin",
    },
    target: {
      kind: "file",
      path: "models/ggml-large-v3-turbo-q5_0.bin",
    },
    integrity: {
      kind: "sha256",
      digest: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
      bytes: 574_041_195,
    },
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B v3 — fast and accurate, commands and dictation",
    sizeMb: 456,
    engine: "parakeet",
    retired: false,
    source: { url: "https://blob.handy.computer/parakeet-v3-int8.tar.gz" },
    target: {
      kind: "tarGz",
      path: "models/parakeet-tdt-0.6b-v3",
      expectedFiles: [
        "vocab.txt",
        "nemo128.onnx",
        "encoder-model.int8.onnx",
        "decoder_joint-model.int8.onnx",
      ],
      stripSingleRoot: true,
    },
    integrity: {
      kind: "sha256",
      digest: "43d37191602727524a7d8c6da0eef11c4ba24320f5b4730f1a2497befc2efa77",
      bytes: 478_517_071,
    },
  },
] as const;

export function modelById(id: string): VoiceModelSpec | null {
  return MODEL_CATALOG.find((model) => model.id === id) ?? null;
}
