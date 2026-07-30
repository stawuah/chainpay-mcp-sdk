export const APP_NAME = "ChainPay";
export const REQUIRED_CLUSTER = "devnet" as const;

export function isSupportedCluster(cluster: string): boolean {
  return cluster === REQUIRED_CLUSTER;
}
