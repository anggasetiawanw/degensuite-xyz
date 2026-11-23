import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  PRO_PASS_PRICE_LAMPORTS,
  getTreasuryPublicKey,
  parsePublicKey,
} from "../constants";

export interface BuildProPassPaymentParams {
  payerPublicKey: PublicKey | string;
  referencePublicKey: PublicKey | string;
  treasuryPublicKey?: PublicKey | string;
  expectedLamports?: bigint;
  recentBlockhash?: string;
}

/**
 * Builds a Solana Pay-compatible Pro Pass checkout transaction using BigInt lamports.
 * Attaches `referencePublicKey` as a non-signer read-only account key on the transfer instruction
 * so the backend verification worker can locate it via `getSignaturesForAddress(referencePubkey)`.
 */
export function buildProPassPaymentTransaction(
  params: BuildProPassPaymentParams
): Transaction {
  const payerPubkey =
    params.payerPublicKey instanceof PublicKey
      ? params.payerPublicKey
      : parsePublicKey(params.payerPublicKey, "payerPublicKey");
  const referencePubkey =
    params.referencePublicKey instanceof PublicKey
      ? params.referencePublicKey
      : parsePublicKey(params.referencePublicKey, "referencePublicKey");
  const treasuryPubkey = params.treasuryPublicKey
    ? params.treasuryPublicKey instanceof PublicKey
      ? params.treasuryPublicKey
      : parsePublicKey(params.treasuryPublicKey, "treasuryPublicKey")
    : getTreasuryPublicKey();

  // Paying the treasury from the treasury wallet moves no money (it only burns
  // the network fee), so it can never verify. Stop before the user signs.
  if (payerPubkey.equals(treasuryPubkey)) {
    throw new Error(
      "This wallet receives DegenSuite fees, so it can't buy Pro from itself. Switch to a different wallet."
    );
  }

  const lamports = params.expectedLamports ?? PRO_PASS_PRICE_LAMPORTS;
  if (lamports <= 0n) {
    throw new Error("Expected payment lamports must be strictly positive.");
  }

  const transferIx = SystemProgram.transfer({
    fromPubkey: payerPubkey,
    toPubkey: treasuryPubkey,
    lamports,
  });

  // Attach unique Solana Pay reference key as non-signer read-only
  transferIx.keys.push({
    pubkey: referencePubkey,
    isSigner: false,
    isWritable: false,
  });

  const tx = new Transaction();
  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 25_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
    }),
    transferIx
  );

  tx.feePayer = payerPubkey;
  if (params.recentBlockhash) {
    tx.recentBlockhash = params.recentBlockhash;
  }

  return tx;
}
