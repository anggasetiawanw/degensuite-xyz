import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { createRevokeInstruction } from "@solana/spl-token";
import {
  BASE_COMPUTE_UNIT_LIMIT,
  COMPUTE_UNITS_PER_CLOSE,
  DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  MAX_ACCOUNTS_PER_TX,
  TOKEN_PROGRAM_ID,
  parsePublicKey,
} from "../constants";
import { chunkAccounts, type PreFlightSimulationResult } from "./vault-sweep";

export interface DelegatedTokenAccountInput {
  pubkey: PublicKey | string;
  delegate: PublicKey | string | null;
  state?: "initialized" | "frozen" | string;
  programId?: PublicKey | string;
}

export interface BuildWalletGuardRevokeParams {
  userPublicKey: PublicKey | string;
  accounts: DelegatedTokenAccountInput[];
  recentBlockhash?: string;
  computeUnitPriceMicroLamports?: bigint;
}

export interface WalletGuardBuildResult {
  transactions: Transaction[];
  totalRevokedAccounts: number;
  skippedAccounts: PublicKey[];
}

function toPubkey(val: PublicKey | string, field: string): PublicKey {
  return val instanceof PublicKey ? val : parsePublicKey(val, field);
}

/**
 * Builds batched `createRevokeInstruction` transactions for `WalletGuard` (0% platform fee).
 * Automatically filters out accounts without an active delegate or in a frozen state.
 */
export function buildWalletGuardRevokeTransactions(
  params: BuildWalletGuardRevokeParams
): WalletGuardBuildResult {
  const userPubkey = toPubkey(params.userPublicKey, "userPublicKey");
  const computeUnitPriceMicroLamports =
    params.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS;

  const eligible: Array<{ pubkey: PublicKey; programId: PublicKey }> = [];
  const skippedAccounts: PublicKey[] = [];

  for (const item of params.accounts) {
    const pubkey = toPubkey(item.pubkey, "tokenAccount.pubkey");
    if (!item.delegate || item.state === "frozen") {
      skippedAccounts.push(pubkey);
      continue;
    }

    const programId = item.programId
      ? toPubkey(item.programId, "tokenAccount.programId")
      : TOKEN_PROGRAM_ID;

    eligible.push({ pubkey, programId });
  }

  const batches = chunkAccounts(eligible, MAX_ACCOUNTS_PER_TX);
  const transactions: Transaction[] = [];

  for (const batch of batches) {
    const tx = new Transaction();
    const computeUnits = BASE_COMPUTE_UNIT_LIMIT + batch.length * COMPUTE_UNITS_PER_CLOSE;

    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: computeUnitPriceMicroLamports,
      })
    );

    for (const acc of batch) {
      tx.add(createRevokeInstruction(acc.pubkey, userPubkey, [], acc.programId));
    }

    tx.feePayer = userPubkey;
    if (params.recentBlockhash) {
      tx.recentBlockhash = params.recentBlockhash;
    }

    transactions.push(tx);
  }

  return {
    transactions,
    totalRevokedAccounts: eligible.length,
    skippedAccounts,
  };
}

/**
 * Rule 2.5: Mandatory Pre-Flight Simulation for WalletGuard revoke transactions.
 */
export async function simulateWalletGuardTransactions(
  connection: Connection,
  transactions: readonly Transaction[]
): Promise<PreFlightSimulationResult> {
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i]!;
    const simulation = await connection.simulateTransaction(tx);

    if (simulation.value.err !== null) {
      return {
        success: false,
        failedBatchIndex: i,
        error: `WalletGuard simulation failed on batch #${i + 1}: ${JSON.stringify(
          simulation.value.err
        )}`,
        logs: simulation.value.logs ?? null,
      };
    }
  }

  return { success: true };
}
