import type { client, Principal } from "../../paypal/client";

/** The same request function the standalone PayPal workspace components take. */
export type PaypalApi = ReturnType<typeof client>;

export type PaypalConnection = {
  api: PaypalApi;
  principal: Principal;
  /** The Solana wallet the PayPal session was opened for. */
  wallet: string;
  /** Epoch ms, or null when the service did not say. */
  expiresAt: number | null;
};

/**
 * Where the PayPal tab gets its session and data. Live: the separate PayPal
 * service, reached by trading the wallet session for a PayPal one (kept in
 * memory only). Fixture: an in-memory sandbox for the design harness and tests.
 */
export type PaypalSource = {
  mode: "live" | "fixture";
  /** Opens, or reuses, a PayPal session for the signed-in wallet. */
  connect(): Promise<PaypalConnection>;
  /** Forgets the in-memory PayPal session. */
  disconnect(): void;
};

export class PaypalNotConfiguredError extends Error {
  constructor(message = "PayPal isn't set up on this site yet.") {
    super(message);
    this.name = "PaypalNotConfiguredError";
  }
}

let override: PaypalSource | null = null;

/** Harness and tests only: replace the live source with fixtures. */
export function setPaypalSourceOverride(source: PaypalSource | null) {
  override = source;
}

export function paypalSourceOverride(): PaypalSource | null {
  return override;
}
