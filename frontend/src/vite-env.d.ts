/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAINPAY_DEMO_RECEIPT_PDA?: string;
  /** "off" removes the site pet entirely. */
  readonly VITE_CHAINPAY_PET?: string;
  readonly VITE_CHAINPAY_CARD_POLICY_PROGRAM_ID?: string;
  readonly VITE_CHAINPAY_CARD_PARTNER_TOKEN_ACCOUNT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
