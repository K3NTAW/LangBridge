import { EngineError, getEngineClient, type ApplyBatchOutcome } from "./engineClient";
import { modKeySymbol } from "./modKey";
import type { Op } from "./ops";
import { asId, type ClipId, type SourceId, type TrackId } from "./ops";
import { previewProbe, type PreviewProbePayload } from "./previewProbe";
import { secondsToTicksApprox, TICKS_PER_SECOND } from "./time";
import { ulidLite } from "./ulid";

function isNoVideoTrackRenderError(err: unknown): boolean {
  if (!(err instanceof EngineError)) return false;
  return err.message.toLowerCase().includes("no video track");
}

/**
 * Import one media file as a single full-span clip at timeline tick `0`.
 *
 * **v0 rule:** refuses when the primary video track already has clips
 * (same constraint as preview/export single-source mode). New project
 * (modifier+N) + import, or Transcript for word-level timelines.
 */
export type ImportMediaFullClipOk = {
  ok: true;
  /** Proxy step: skipped when no `proxyGenerate`; otherwise reflects callback result (full-res decode remains if failed). */
  proxyOutcome: "skipped" | "success" | "failed";
};

export type ImportMediaFullClipResult = ImportMediaFullClipOk | { ok: false; message: string };

export async function importMediaFullClip(
  mediaPath: string,
  applyBatch: (ops: Op[]) => Promise<ApplyBatchOutcome>,
  options?: {
    /** Prefer preview proxy after import; return false or throw if proxy did not attach (full-res decode remains). */
    proxyGenerate?: (sourceId: SourceId) => Promise<boolean>;
    /** Called after `applyBatch` succeeds and before optional proxy generation (UI progress). */
    onAfterBatch?: () => void;
  },
): Promise<ImportMediaFullClipResult> {
  let probe: PreviewProbePayload;
  try {
    probe = await previewProbe(mediaPath);
  } catch {
    return { ok: false, message: "Could not probe media file (FFmpeg)." };
  }

  const durationSecs =
    probe.duration_seconds !== null && probe.duration_seconds > 0 ? probe.duration_seconds : 3600;

  let durationTicks = secondsToTicksApprox(durationSecs);
  if (durationTicks <= 0n) {
    durationTicks = TICKS_PER_SECOND / 1000n > 0n ? TICKS_PER_SECOND / 1000n : 1n;
  }

  const srcIn = 0n;
  const srcOut = durationTicks;

  const ops: Op[] = [];
  const sourceId = asId<"SourceId">(ulidLite()) as SourceId;
  ops.push({
    kind: "source_import",
    source_id: sourceId,
    path: mediaPath,
    hash: `pool-${ulidLite()}`,
  });

  let trackId: TrackId;

  try {
    const rr = await getEngineClient().renderRanges();
    if (rr.ranges.length > 0) {
      const mod = modKeySymbol();
      return {
        ok: false,
        message:
          `Timeline already has clips. Start a new project (${mod}+N) to import a full-length clip, or use Transcript for word-level cuts.`,
      };
    }
    if (!rr.track_id) {
      return { ok: false, message: "Engine returned no video track id." };
    }
    trackId = asId<"TrackId">(rr.track_id) as TrackId;
  } catch (e) {
    if (!isNoVideoTrackRenderError(e)) {
      return { ok: false, message: e instanceof EngineError ? e.message : String(e) };
    }
    const newTrackId = asId<"TrackId">(ulidLite()) as TrackId;
    ops.push({
      kind: "track_add",
      track_id: newTrackId,
      track_kind: "video",
      index: 0,
    });
    trackId = newTrackId;
  }

  const clipId = asId<"ClipId">(ulidLite()) as ClipId;
  ops.push({
    kind: "clip_insert",
    clip_id: clipId,
    track_id: trackId,
    source_id: sourceId,
    src_in: srcIn,
    src_out: srcOut,
    timeline_at: 0n,
  });

  const outcome = await applyBatch(ops);
  if (!outcome.ok) {
    return { ok: false, message: outcome.error };
  }
  options?.onAfterBatch?.();
  const pg = options?.proxyGenerate;
  let proxyOutcome: ImportMediaFullClipOk["proxyOutcome"] = "skipped";
  if (pg !== undefined) {
    try {
      const ok = await pg(sourceId);
      proxyOutcome = ok ? "success" : "failed";
    } catch {
      proxyOutcome = "failed";
    }
  }
  return { ok: true, proxyOutcome };
}
