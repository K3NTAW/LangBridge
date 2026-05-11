/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CUT_AI_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
