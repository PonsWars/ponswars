/**
 * The calldata for `SecretStockVault.claim` (§8.5).
 *
 * A selector and nothing else: the vault pays `msg.sender` exactly what it
 * reserved for them, so a client cannot name a wrong amount or a wrong
 * recipient even by mistake. Written out rather than encoded through an ABI
 * library for the same reason the rewards claim is; the test encodes the same
 * call with viem and compares the bytes.
 *
 *   claim()
 */

/** `keccak256("claim()")[:4]`. */
export const SECRET_CLAIM_CALLDATA = '0x4e71d92d' as const;
