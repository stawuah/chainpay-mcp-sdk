/**
 * Whether an account owned by a token program is a mint or a token account.
 *
 * Length alone cannot tell them apart. A classic SPL mint is 82 bytes and a
 * token account 165, but a Token-2022 account carrying extensions is longer
 * than both and records which it is in the byte after the base token-account
 * length. Devnet PYUSD's mint is 869 bytes, so a length test alone reads it as
 * a token account — and a payment destination checked that way accepts the
 * mint, which can never receive a transfer.
 */
export function tokenProgramAccountType(data: Uint8Array): "mint" | "account" | "unknown" {
  if (data.length === 82) return "mint";
  if (data.length === 165) return "account";
  if (data.length > 165) {
    if (data[165] === 1) return "mint";
    if (data[165] === 2) return "account";
  }
  return "unknown";
}
