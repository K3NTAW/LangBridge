/**
 * `useEngineProject` — the small custom hook that owns the engine
 * client lifecycle for the App.
 *
 * This is the one place in the UI that:
 *
 * - Calls `info()` once at mount.
 * - Tracks the project's head (op-id, n_ops, can_undo, can_redo).
 * - Holds the current on-disk path of the project, if any (so a
 *   subsequent Cmd-S re-saves to the same file without prompting).
 * - Surfaces the most recent engine error so the UI can render it.
 *
 * The hook deliberately keeps state minimal — the engine owns the
 * project; React just mirrors a small `HeadResult`-shaped projection
 * so the UI re-renders. Mutating actions return their typed engine
 * response (or `{ ok: false, error }` on failure) so consumers — notably the
 * transcript editor — can reconcile their own derived state without
 * a follow-up `head()` round-trip.
 */
import { useCallback, useEffect, useState } from "react";

import {
  EngineError,
  getEngineClient,
  type ApplyBatchOutcome,
  type ApplyResult,
  type EngineInfo,
  type HeadResult,
  type ProxyGenerateResult,
  type RedoResult,
  type RenderRangesResult,
  type UndoResult,
} from "./engineClient";
import type { Op } from "./ops";
import { pickOpenPath, pickSavePath } from "./projectFile";

interface State {
  info: EngineInfo | null;
  head: HeadResult | null;
  path: string | null;
  error: string | null;
  busy: boolean;
}

const INITIAL: State = {
  info: null,
  head: null,
  path: null,
  error: null,
  busy: false,
};

export interface UseEngineProject extends State {
  /** Convenience: `head?.can_undo ?? false`. */
  canUndo: boolean;
  /** Convenience: `head?.can_redo ?? false`. */
  canRedo: boolean;

  newProject(): Promise<void>;
  openProject(): Promise<void>;
  saveProject(): Promise<void>;
  saveProjectAs(): Promise<void>;

  apply(op: Op): Promise<ApplyResult | null>;
  applyBatch(ops: Op[], options?: { group_undo?: boolean }): Promise<ApplyBatchOutcome>;
  /**
   * Build preview proxy + `source_set_proxy`. Updates mirrored head so
   * preview re-queries `preview_decode_path` (proxy-first scrub).
   */
  proxyGenerate(sourceId: string, maxWidth?: number): Promise<ProxyGenerateResult | null>;
  /**
   * Same as [`proxyGenerate`], but failures do **not** set the hook's global engine error (optional ingest step).
   */
  proxyGenerateOptional(sourceId: string, maxWidth?: number): Promise<ProxyGenerateResult | null>;
  clearHistory(): Promise<void>;
  undo(): Promise<UndoResult | null>;
  redo(): Promise<RedoResult | null>;
  renderRanges(): Promise<RenderRangesResult | null>;
}

export function useEngineProject(): UseEngineProject {
  const [state, setState] = useState<State>(INITIAL);

  const setError = useCallback((message: string | null) => {
    setState((s) => ({ ...s, error: message, busy: false }));
  }, []);

  // Most engine calls return the same shape (head, n_ops, can_undo,
  // can_redo). We project that into our `HeadResult` and update.
  const setHeadFrom = useCallback(
    (resp: { head: string | null; n_ops: number; can_undo: boolean; can_redo: boolean } | null,
     fallbackProjectId?: string) => {
      setState((s) => {
        if (resp === null) {
          return { ...s, head: null, busy: false, error: null };
        }
        const projectId =
          fallbackProjectId ?? s.head?.project_id ?? "";
        return {
          ...s,
          head: {
            project_id: projectId,
            head: resp.head,
            n_ops: resp.n_ops,
            can_undo: resp.can_undo,
            can_redo: resp.can_redo,
          },
          busy: false,
          error: null,
        };
      });
    },
    [],
  );

  const refreshHead = useCallback(async () => {
    try {
      const head = await getEngineClient().head();
      setState((s) => ({ ...s, head, error: null, busy: false }));
    } catch (e) {
      const ee = e as EngineError;
      if (ee.code === -32002) {
        // No project loaded — that's fine, we just haven't called `new` yet.
        setState((s) => ({ ...s, head: null, error: null, busy: false }));
        return;
      }
      setError(ee.message);
    }
  }, [setError]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await getEngineClient().info();
        if (!cancelled) setState((s) => ({ ...s, info }));
      } catch (e) {
        const ee = e as EngineError;
        if (!cancelled) setError(`couldn't reach engine: ${ee.message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setError]);

  const newProject = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await getEngineClient().newProject();
      setState((s) => ({
        ...s,
        path: null,
        head: {
          project_id: r.project_id,
          head: null,
          n_ops: 0,
          can_undo: false,
          can_redo: false,
        },
        busy: false,
        error: null,
      }));
    } catch (e) {
      setError((e as EngineError).message);
    }
  }, [setError]);

  const openProject = useCallback(async () => {
    const path = await pickOpenPath();
    if (!path) return;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      await getEngineClient().load(path);
      setState((s) => ({ ...s, path }));
      await refreshHead();
    } catch (e) {
      setError((e as EngineError).message);
    }
  }, [setError, refreshHead]);

  const doSaveTo = useCallback(
    async (path: string) => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        await getEngineClient().save(path);
        setState((s) => ({ ...s, path, busy: false }));
      } catch (e) {
        setError((e as EngineError).message);
      }
    },
    [setError],
  );

  const saveProjectAs = useCallback(async () => {
    const path = await pickSavePath();
    if (!path) return;
    await doSaveTo(path);
  }, [doSaveTo]);

  const saveProject = useCallback(async () => {
    if (state.path) {
      await doSaveTo(state.path);
    } else {
      await saveProjectAs();
    }
  }, [doSaveTo, saveProjectAs, state.path]);

  const apply = useCallback(
    async (op: Op): Promise<ApplyResult | null> => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const r = await getEngineClient().apply(op);
        setHeadFrom(r);
        return r;
      } catch (e) {
        setError((e as EngineError).message);
        return null;
      }
    },
    [setError, setHeadFrom],
  );

  const applyBatch = useCallback(
    async (
      ops: Op[],
      options?: { group_undo?: boolean },
    ): Promise<ApplyBatchOutcome> => {
      if (ops.length === 0) {
        return {
          ok: true,
          result: {
            applied: 0,
            heads: [],
            head: state.head?.head ?? null,
            n_ops: state.head?.n_ops ?? 0,
            can_undo: state.head?.can_undo ?? false,
            can_redo: state.head?.can_redo ?? false,
          },
        };
      }
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const r = await getEngineClient().applyBatch(ops, options);
        setHeadFrom(r);
        return { ok: true, result: r };
      } catch (e) {
        const msg =
          e instanceof EngineError && e.message.trim().length > 0
            ? e.message
            : e instanceof Error
              ? e.message
              : String(e);
        setError(msg);
        return { ok: false, error: msg };
      }
    },
    [setError, setHeadFrom, state.head],
  );

  const clearHistory = useCallback(async () => {
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await getEngineClient().clearHistory();
      setHeadFrom(r);
    } catch (e) {
      setError((e as EngineError).message);
    }
  }, [setError, setHeadFrom]);

  const undo = useCallback(async (): Promise<UndoResult | null> => {
    if (!state.head?.can_undo) return null;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await getEngineClient().undo();
      setHeadFrom(r);
      return r;
    } catch (e) {
      setError((e as EngineError).message);
      return null;
    }
  }, [setError, setHeadFrom, state.head]);

  const redo = useCallback(async (): Promise<RedoResult | null> => {
    if (!state.head?.can_redo) return null;
    setState((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await getEngineClient().redo();
      setHeadFrom(r);
      return r;
    } catch (e) {
      setError((e as EngineError).message);
      return null;
    }
  }, [setError, setHeadFrom, state.head]);

  const renderRanges = useCallback(
    async (): Promise<RenderRangesResult | null> => {
      try {
        return await getEngineClient().renderRanges();
      } catch (e) {
        setError((e as EngineError).message);
        return null;
      }
    },
    [setError],
  );

  const proxyGenerate = useCallback(
    async (sourceId: string, maxWidth?: number): Promise<ProxyGenerateResult | null> => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const r = await getEngineClient().proxyGenerate(sourceId, maxWidth);
        setHeadFrom(r);
        return r;
      } catch (e) {
        setError((e as EngineError).message);
        return null;
      }
    },
    [setError, setHeadFrom],
  );

  const proxyGenerateOptional = useCallback(
    async (sourceId: string, maxWidth?: number): Promise<ProxyGenerateResult | null> => {
      setState((s) => ({ ...s, busy: true, error: null }));
      try {
        const r = await getEngineClient().proxyGenerate(sourceId, maxWidth);
        setHeadFrom(r);
        return r;
      } catch {
        setState((s) => ({ ...s, busy: false }));
        return null;
      }
    },
    [setHeadFrom],
  );

  return {
    ...state,
    canUndo: state.head?.can_undo ?? false,
    canRedo: state.head?.can_redo ?? false,
    newProject,
    openProject,
    saveProject,
    saveProjectAs,
    apply,
    applyBatch,
    proxyGenerate,
    proxyGenerateOptional,
    clearHistory,
    undo,
    redo,
    renderRanges,
  };
}
