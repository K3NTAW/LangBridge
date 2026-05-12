/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIFT_AI_URL?: string;
  readonly VITE_PLAN_DATA_RESIDENCY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
