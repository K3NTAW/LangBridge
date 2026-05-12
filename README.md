# sift-app

The Tauri shell. Hosts the React UI and (in Phase 0) bridges to the
[`sift-engine`](../sift-engine) subprocess over a UNIX domain socket.

## Status

**Foundation scaffold.**

- Tauri 2 host with one stub command (`engine_info`).
- React + TypeScript + Tailwind UI shell with placeholder panels:
  top bar, media pool, preview, timeline, Cmd-K palette.
- TypeScript mirror of the Op language ([`src/lib/ops.ts`](./src/lib/ops.ts))
  and tick arithmetic ([`src/lib/time.ts`](./src/lib/time.ts)).
- Stub engine client that returns canned `apply` success.

What's deliberately *not* here yet, per [Plan §6](../REFINED-PLAN.md):

- Real engine subprocess + IPC.
- WebGPU timeline renderer.
- Drag-and-drop import.
- Anything that touches actual video.

## Build

You'll need:

- **Node** ≥ 22
- **Rust** ≥ 1.85
- **Tauri 2 system dependencies** — see <https://tauri.app/start/prerequisites/>

```bash
npm install
npm run typecheck       # Vite + TS
npm run tauri dev       # spawns the desktop window
```

`npm run dev` (Vite-only) lets you iterate the UI in the browser without
the Tauri binding — useful for hot reload, but `engine_info()` will hit
the stub.

## Project layout

```
src/
├── main.tsx               # React root
├── App.tsx                # top-level layout
├── index.css              # Tailwind directives + small overrides
├── lib/
│   ├── time.ts            # Tick arithmetic (mirror of sift-engine/time.rs)
│   ├── ops.ts             # Op language (mirror of sift-engine/ops.rs)
│   ├── engineClient.ts    # JSON-RPC client (stub)
│   └── cn.ts              # clsx + tailwind-merge helper
└── components/
    ├── TopBar.tsx
    ├── MediaPoolPane.tsx
    ├── PreviewPane.tsx
    ├── TimelinePane.tsx
    └── CommandPalette.tsx
src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── build.rs
├── capabilities/default.json
└── src/
    ├── main.rs
    └── lib.rs
```

## TS ↔ Rust drift

`src/lib/ops.ts` is a hand-mirror of `sift-engine/src/ops.rs`. When you
add an op variant in Rust, mirror it here in the same change. A CI
contract test (Phase 0) round-trips every variant through both sides
and fails if the JSON shape diverges.
# LangBridge
