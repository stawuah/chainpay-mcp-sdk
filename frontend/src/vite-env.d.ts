/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAINPAY_DEMO_RECEIPT_PDA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
