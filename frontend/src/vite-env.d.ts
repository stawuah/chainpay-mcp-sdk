/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAINPAY_DEMO_RECEIPT_PDA?: string;
  /** "off" removes the site pet entirely. */
  readonly VITE_CHAINPAY_PET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
