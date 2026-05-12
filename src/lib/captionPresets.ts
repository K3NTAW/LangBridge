import type { CaptionBuildOptions } from "./captionsSrt";
import { TICKS_PER_SECOND } from "./time";

/** Visual + cue-density preset for sidecar captions and burn-in `force_style`. */
export type CaptionStylePresetId = "clean" | "large" | "compact";

export const CAPTION_STYLE_PRESETS: Record<
  CaptionStylePresetId,
  { label: string; hint: string; options: CaptionBuildOptions; burnInForceStyle: string }
> = {
  clean: {
    label: "Clean",
    hint: "Default readable size",
    options: {
      maxLineChars: 42,
      maxWordsPerCue: 12,
      gapTicksNewCue: TICKS_PER_SECOND / 2n,
    },
    burnInForceStyle: "FontSize=20,Outline=1,OutlineColour=&H80000000",
  },
  large: {
    label: "Large",
    hint: "Bigger text for social",
    options: {
      maxLineChars: 36,
      maxWordsPerCue: 10,
      gapTicksNewCue: TICKS_PER_SECOND / 2n,
    },
    burnInForceStyle: "FontSize=28,Outline=2,OutlineColour=&H80000000",
  },
  compact: {
    label: "Compact",
    hint: "More words per cue",
    options: {
      maxLineChars: 52,
      maxWordsPerCue: 16,
      gapTicksNewCue: TICKS_PER_SECOND / 3n,
    },
    burnInForceStyle: "FontSize=16,Outline=1,OutlineColour=&H80000000",
  },
};

/** Export video scaling preset for `/v1/recut` ``scale_max_height``. */
export type ExportVideoPresetId = "match_source" | "height_1080" | "height_720";

export function scaleMaxHeightForPreset(p: ExportVideoPresetId): number | null {
  if (p === "height_1080") return 1080;
  if (p === "height_720") return 720;
  return null;
}

export const EXPORT_VIDEO_PRESET_LABELS: Record<ExportVideoPresetId, string> = {
  match_source: "Match source",
  height_1080: "Max height 1080p",
  height_720: "Max height 720p",
};

export type CaptionSidecarFormat = "srt" | "vtt";
