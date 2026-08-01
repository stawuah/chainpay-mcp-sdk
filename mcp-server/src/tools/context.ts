import type {
  ChainPayClient,
  PaymentSubmissionAdapter,
} from "@chainpay/sdk";

export type ChainPayMcpContext = {
  client: ChainPayClient;
  /** Optional Rust backend URL used for signed-transaction relay and status tracking. */
  backendUrl?: string;
  backendAuthToken?: string;
  /**
   * Optional transaction bridge. It may be backed by a wallet adapter,
   * backend signer service, or agent signer, but MCP never receives key
   * material directly.
   */
  paymentExecutor?: PaymentSubmissionAdapter;
};
