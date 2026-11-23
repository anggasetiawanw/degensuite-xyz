import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";

export type SolanaNetwork = "devnet" | "mainnet-beta";

/**
 * Standard lamports per 1 SOL in BigInt.
 * Rule 2.1: Never perform floating-point math on lamports.
 */
export const LAMPORTS_PER_SOL_BIGINT = BigInt(LAMPORTS_PER_SOL);

/**
 * Standard rent-exempt balance for a 165-byte SPL Token Account (0.00203928 SOL = 2,039,280 lamports).
 */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

/**
 * Platform fee in basis points: 10.00% (1000 BPS out of 10000).
 */
export const PLATFORM_FEE_BPS = 1000n;
export const BPS_DENOMINATOR = 10000n;

/**
 * Rule 2.2: Maximum number of token accounts packed into a single transaction
 * to keep serialized packet size safely below the 1232-byte Solana MTU limit.
 */
export const MAX_ACCOUNTS_PER_TX = 15;

/**
 * Rule 2.4: Maximum verified USD value eligible for dust burning ($0.05).
 */
export const MAX_DUST_USD_VALUE = 0.05;

/**
 * Default Compute Budget parameters for VaultSweep & WalletGuard transactions.
 */
export const BASE_COMPUTE_UNIT_LIMIT = 45_000;
export const COMPUTE_UNITS_PER_CLOSE = 12_000;
export const COMPUTE_UNITS_PER_BURN = 15_000;
export const DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000n;

/**
 * Pro Pass Subscription Price (0.20 SOL = 200,000,000 lamports).
 */
export const PRO_PASS_PRICE_LAMPORTS = 200_000_000n;

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

/**
 * Validates and parses a Base58 string into a Solana PublicKey.
 * Rule 3.2: Validate all incoming Base58 strings using `new PublicKey(input)` inside a try/catch block.
 */
export function parsePublicKey(input: string, fieldName = "PublicKey"): PublicKey {
  const trimmed = input?.trim();
  if (!trimmed) {
    throw new Error(`Please enter an address (${fieldName}).`);
  }
  try {
    return new PublicKey(trimmed);
  } catch {
    throw new Error(`"${trimmed}" isn't a valid Solana address.`);
  }
}

/**
 * Rule 3.4: Read SOLANA_NETWORK ("devnet" | "mainnet-beta") strictly from environment variables
 * with validation.
 */
export function getSolanaNetwork(): SolanaNetwork {
  const rawNetwork = process.env.SOLANA_NETWORK?.trim();
  if (!rawNetwork) {
    throw new Error(
      "Missing environment variable SOLANA_NETWORK. Expected 'devnet' or 'mainnet-beta'."
    );
  }
  if (rawNetwork !== "devnet" && rawNetwork !== "mainnet-beta") {
    throw new Error(
      `Invalid SOLANA_NETWORK "${rawNetwork}". Must be strictly "devnet" or "mainnet-beta".`
    );
  }
  return rawNetwork;
}

/**
 * Rule 3.4: Read TREASURY_WALLET_PUBKEY strictly from environment variables with validation.
 */
export function getTreasuryPublicKey(): PublicKey {
  const rawPubkey = process.env.TREASURY_WALLET_PUBKEY?.trim();
  if (!rawPubkey) {
    throw new Error(
      "Missing environment variable TREASURY_WALLET_PUBKEY. Configure a valid Base58 Solana address."
    );
  }
  return parsePublicKey(rawPubkey, "TREASURY_WALLET_PUBKEY");
}
