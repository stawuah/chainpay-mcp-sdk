/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHAINPAY_DEMO_RECEIPT_PDA?: string;
  /** "off" removes the site pet entirely. */
  readonly VITE_CHAINPAY_PET?: string;
  readonly VITE_CHAINPAY_CARD_POLICY_PROGRAM_ID?: string;
  readonly VITE_CHAINPAY_CARD_PARTNER_TOKEN_ACCOUNT?: string;
  /** JSON allowlist entry for MagicBlock's previous TEE build during a rotation (sdk parseMeasurementAllowlist). */
  readonly VITE_CHAINPAY_DEVNET_SEND_RPC_URL?: string;
  readonly VITE_CHAINPAY_TEE_MEASUREMENTS_PREVIOUS?: string;
  /** Card issuer environment shown on the card face. Anything but "production" shows the Sandbox mark. */
  readonly VITE_CHAINPAY_CARD_ISSUER_ENV?: string;
  /** Exactly "true" shows the PayPal sandbox tab (and enables the standalone /paypal build). */
  readonly VITE_CHAINPAY_PAYPAL?: string;
  /** Origin of the separate PayPal service, e.g. https://chainpay-paypal.vercel.app. */
  readonly VITE_CHAINPAY_PAYPAL_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
