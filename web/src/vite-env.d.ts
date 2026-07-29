/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BROWSER_NATIVE?: string;
  readonly VITE_HASH_ROUTER?: string;
  readonly VITE_FREENET_WS_URL?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
