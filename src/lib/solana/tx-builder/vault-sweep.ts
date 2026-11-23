import {
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createBurnInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  BASE_COMPUTE_UNIT_LIMIT,
  BPS_DENOMINATOR,
  COMPUTE_UNITS_PER_BURN,
  COMPUTE_UNITS_PER_CLOSE,
  DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
  MAX_ACCOUNTS_PER_TX,
  MAX_DUST_USD_VALUE,
  PLATFORM_FEE_BPS,
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
  getTreasuryPublicKey,
  parsePublicKey,
} from "../constants";

// ============================================================================
// CUSTOM SAFETY ERRORS
// ============================================================================

export class NonZeroBalanceError extends Error {
  public readonly accountPubkey: string;
  public readonly amount: string;

  constructor(accountPubkey: string, amount: string) {
    super(
      `Asset Safety Guard: Cannot close non-zero token account ${accountPubkey} (amount=${amount}) in zero-balance sweep mode.`
    );
    this.name = "NonZeroBalanceError";
    this.accountPubkey = accountPubkey;
    this.amount = amount;
  }
}

export class UnsafeBurnError extends Error {
  public readonly accountPubkey: string;
  public readonly reason: string;

  constructor(accountPubkey: string, reason: string) {
    super(`Asset Safety Guard: Refusing to burn token account ${accountPubkey} — ${reason}`);
    this.name = "UnsafeBurnError";
    this.accountPubkey = accountPubkey;
    this.reason = reason;
  }
}

export class SimulationFailedError extends Error {
  public readonly batchIndex: number;
  public readonly simulationError: unknown;
  public readonly logs: string[] | null;

  constructor(batchIndex: number, simulationError: unknown, logs: string[] | null = null) {
    super(
      `Pre-flight simulation failed for transaction batch #${batchIndex + 1}: ${JSON.stringify(
        simulationError
      )}`
    );
    this.name = "SimulationFailedError";
    this.batchIndex = batchIndex;
    this.simulationError = simulationError;
    this.logs = logs;
  }
}

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

export type TokenAccountState = "initialized" | "frozen" | "uninitialized" | string;

/**
 * Flat input shape for a token account candidate.
 */
export interface FlatSweepAccountInput {
  pubkey: PublicKey | string;
  mint?: PublicKey | string;
  amount: string;
  decimals?: number;
  state: TokenAccountState;
  rentLamports?: bigint;
  verifiedUsdValue?: number | null;
  programId?: PublicKey | string;
}

/**
 * RPC `getParsedTokenAccountsByOwner` item shape for seamless compatibility.
 */
export interface RpcParsedSweepAccountInput {
  pubkey: PublicKey | string;
  verifiedUsdValue?: number | null;
  account: {
    lamports?: number | bigint;
    owner?: PublicKey | string;
    data: {
      parsed: {
        info: {
          mint?: string;
          state: TokenAccountState;
          tokenAmount: {
            amount: string;
            decimals?: number;
            uiAmount?: number | null;
          };
        };
      };
    };
  };
}

export type SweepAccountInput = FlatSweepAccountInput | RpcParsedSweepAccountInput;

export interface NormalizedSweepAccount {
  pubkey: PublicKey;
  mint: PublicKey | null;
  rawAmount: bigint;
  amountString: string;
  decimals: number | null;
  state: TokenAccountState;
  rentLamports: bigint;
  verifiedUsdValue: number | null;
  programId: PublicKey;
}

export interface BuildVaultSweepParams {
  userPublicKey: PublicKey | string;
  accounts: SweepAccountInput[];
  /**
   * Optional override for treasury public key; defaults to process.env.TREASURY_WALLET_PUBKEY.
   */
  treasuryPublicKey?: PublicKey | string;
  /**
   * Must be explicitly true to allow burning non-zero dust accounts with verifiedUsdValue < $0.05.
   * Defaults to false (strict zero-balance sweep).
   */
  userConfirmedDustBurn?: boolean;
  /**
   * Optional recent blockhash to attach to constructed transactions.
   */
  recentBlockhash?: string;
  /**
   * Optional priority fee in micro-lamports per compute unit.
   */
  computeUnitPriceMicroLamports?: bigint;
}

export interface VaultSweepBatchMetadata {
  batchIndex: number;
  transaction: Transaction;
  accountsClosed: PublicKey[];
  accountsBurned: PublicKey[];
  batchReclaimedLamports: bigint;
  batchTreasuryFeeLamports: bigint;
  batchUserNetLamports: bigint;
}

export interface VaultSweepBuildResult {
  transactions: Transaction[];
  batches: VaultSweepBatchMetadata[];
  totalAccountsClosed: number;
  totalAccountsBurned: number;
  skippedFrozenAccounts: PublicKey[];
  totalReclaimedLamports: bigint;
  treasuryFeeLamports: bigint;
  userNetLamports: bigint;
}

export interface PreFlightSimulationResult {
  success: boolean;
  error?: string;
  failedBatchIndex?: number;
  logs?: string[] | null;
}

// ============================================================================
// CORE BIGINT FEE SPLIT LOGIC (RULE 2.1)
// ============================================================================

/**
 * Rule 2.1: Standard Fee Split Implementation (90% User / 10% Treasury) in BigInt Lamports.
 * NEVER uses floating-point math.
 */
export function calculateFeeSplit(totalReclaimedLamports: bigint): {
  userNetLamports: bigint;
  treasuryFeeLamports: bigint;
} {
  if (totalReclaimedLamports <= 0n) {
    return { userNetLamports: 0n, treasuryFeeLamports: 0n };
  }
  const treasuryFeeLamports =
    (totalReclaimedLamports * PLATFORM_FEE_BPS) / BPS_DENOMINATOR;
  const userNetLamports = totalReclaimedLamports - treasuryFeeLamports;
  return { userNetLamports, treasuryFeeLamports };
}

// ============================================================================
// NORMALIZATION & BATCHING HELPERS
// ============================================================================

function isRpcParsedInput(input: SweepAccountInput): input is RpcParsedSweepAccountInput {
  return "account" in input && typeof input.account === "object" && input.account !== null;
}

function toPublicKey(value: PublicKey | string, label: string): PublicKey {
  if (value instanceof PublicKey) {
    return value;
  }
  return parsePublicKey(value, label);
}

/**
 * Normalizes either a flat account object or an RPC-parsed account object.
 */
export function normalizeSweepAccount(input: SweepAccountInput): NormalizedSweepAccount {
  const pubkey = toPublicKey(input.pubkey, "tokenAccount.pubkey");

  if (isRpcParsedInput(input)) {
    const parsedInfo = input.account.data.parsed.info;
    const amountString = parsedInfo.tokenAmount.amount;
    const rawAmount = BigInt(amountString);
    const decimals =
      typeof parsedInfo.tokenAmount.decimals === "number"
        ? parsedInfo.tokenAmount.decimals
        : null;
    const mint = parsedInfo.mint ? toPublicKey(parsedInfo.mint, "tokenAccount.mint") : null;
    const programId = input.account.owner
      ? toPublicKey(input.account.owner, "tokenAccount.programId")
      : TOKEN_PROGRAM_ID;
    const rentLamports =
      input.account.lamports !== undefined
        ? BigInt(input.account.lamports)
        : TOKEN_ACCOUNT_RENT_LAMPORTS;

    return {
      pubkey,
      mint,
      rawAmount,
      amountString,
      decimals,
      state: parsedInfo.state,
      rentLamports,
      verifiedUsdValue: input.verifiedUsdValue ?? null,
      programId,
    };
  }

  const rawAmount = BigInt(input.amount);
  const mint = input.mint ? toPublicKey(input.mint, "tokenAccount.mint") : null;
  const programId = input.programId
    ? toPublicKey(input.programId, "tokenAccount.programId")
    : TOKEN_PROGRAM_ID;
  const rentLamports =
    input.rentLamports !== undefined ? input.rentLamports : TOKEN_ACCOUNT_RENT_LAMPORTS;

  return {
    pubkey,
    mint,
    rawAmount,
    amountString: input.amount,
    decimals: typeof input.decimals === "number" ? input.decimals : null,
    state: input.state,
    rentLamports,
    verifiedUsdValue: input.verifiedUsdValue ?? null,
    programId,
  };
}

/**
 * Rule 2.2: Chunks an array of items into batches of at most `maxPerBatch` (15).
 */
export function chunkAccounts<T>(items: readonly T[], maxPerBatch = MAX_ACCOUNTS_PER_TX): T[][] {
  if (maxPerBatch <= 0 || maxPerBatch > MAX_ACCOUNTS_PER_TX) {
    throw new Error(
      `Invalid batch size ${maxPerBatch}. Must be between 1 and ${MAX_ACCOUNTS_PER_TX}.`
    );
  }
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += maxPerBatch) {
    batches.push(items.slice(i, i + maxPerBatch));
  }
  return batches;
}

// ============================================================================
// VAULTSWEEP TRANSACTION BUILDER
// ============================================================================

/**
 * Builds isolated, Blowfish-compliant `VaultSweep` transactions.
 *
 * Rules enforced:
 * - Rule 2.1: 100% BigInt lamport fee math (90% user / 10% treasury).
 * - Rule 2.2: Maximum 15 token accounts per transaction (`MAX_ACCOUNTS_PER_TX = 15`).
 * - Rule 2.3: Strict Anti-Drainer instruction ordering:
 *     1. ComputeBudgetProgram (setComputeUnitLimit & setComputeUnitPrice)
 *     2. All createBurnInstruction (only for verified dust when userConfirmedDustBurn === true)
 *     3. All createCloseAccountInstruction (100% of rent goes to userPublicKey first)
 *     4. Single SystemProgram.transfer (10% treasuryFeeLamports from userPublicKey to treasury)
 * - Rule 2.4: Frozen accounts are automatically filtered out; non-zero accounts throw
 *     `NonZeroBalanceError` in zero-balance mode; NFTs (`decimals === 0`) or tokens with
 *     `verifiedUsdValue >= 0.05` or `null` throw `UnsafeBurnError`.
 */
export function buildVaultSweepTransactions(
  params: BuildVaultSweepParams
): VaultSweepBuildResult {
  const userPubkey = toPublicKey(params.userPublicKey, "userPublicKey");
  const treasuryPubkey = params.treasuryPublicKey
    ? toPublicKey(params.treasuryPublicKey, "treasuryPublicKey")
    : getTreasuryPublicKey();
  const userConfirmedDustBurn = params.userConfirmedDustBurn === true;
  const computeUnitPriceMicroLamports =
    params.computeUnitPriceMicroLamports ?? DEFAULT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS;

  const eligibleAccounts: NormalizedSweepAccount[] = [];
  const skippedFrozenAccounts: PublicKey[] = [];

  for (const rawInput of params.accounts) {
    const account = normalizeSweepAccount(rawInput);

    // Rule 2.4 & Rule 4.2.4: Automatically filter out frozen accounts so they never break a batch
    if (account.state === "frozen") {
      skippedFrozenAccounts.push(account.pubkey);
      continue;
    }

    if (account.rawAmount < 0n) {
      throw new NonZeroBalanceError(account.pubkey.toBase58(), account.amountString);
    }

    // Rule 2.4 & Rule 4.2.3: Non-zero balance safety guards
    if (account.rawAmount > 0n) {
      if (!userConfirmedDustBurn) {
        throw new NonZeroBalanceError(account.pubkey.toBase58(), account.amountString);
      }

      if (account.decimals === 0) {
        throw new UnsafeBurnError(
          account.pubkey.toBase58(),
          "Token has decimals === 0 (NFT / Collectible protection)."
        );
      }

      if (
        account.verifiedUsdValue === null ||
        account.verifiedUsdValue === undefined ||
        Number.isNaN(account.verifiedUsdValue) ||
        account.verifiedUsdValue < 0
      ) {
        throw new UnsafeBurnError(
          account.pubkey.toBase58(),
          "Token has unknown or unverified USD value."
        );
      }

      if (account.verifiedUsdValue >= MAX_DUST_USD_VALUE) {
        throw new UnsafeBurnError(
          account.pubkey.toBase58(),
          `Token USD value ($${account.verifiedUsdValue.toFixed(4)}) is >= $${MAX_DUST_USD_VALUE}.`
        );
      }

      if (!account.mint) {
        throw new UnsafeBurnError(
          account.pubkey.toBase58(),
          "Missing token mint public key required for burn instruction."
        );
      }
    }

    eligibleAccounts.push(account);
  }

  const accountBatches = chunkAccounts(eligibleAccounts, MAX_ACCOUNTS_PER_TX);
  const batches: VaultSweepBatchMetadata[] = [];
  const transactions: Transaction[] = [];

  let totalAccountsClosed = 0;
  let totalAccountsBurned = 0;
  let totalReclaimedLamports = 0n;
  let totalTreasuryFeeLamports = 0n;
  let totalUserNetLamports = 0n;

  for (let batchIndex = 0; batchIndex < accountBatches.length; batchIndex++) {
    const batch = accountBatches[batchIndex]!;
    const tx = new Transaction();

    const dustAccountsToBurn = batch.filter((acc) => acc.rawAmount > 0n);
    const computeUnitLimit =
      BASE_COMPUTE_UNIT_LIMIT +
      batch.length * COMPUTE_UNITS_PER_CLOSE +
      dustAccountsToBurn.length * COMPUTE_UNITS_PER_BURN;

    // ------------------------------------------------------------------------
    // STEP 1 (Rule 2.3): ComputeBudgetProgram instructions
    // ------------------------------------------------------------------------
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: computeUnitLimit,
      }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: computeUnitPriceMicroLamports,
      })
    );

    // ------------------------------------------------------------------------
    // STEP 2 (Rule 2.3): All createBurnInstruction (only verified dust)
    // ------------------------------------------------------------------------
    const accountsBurned: PublicKey[] = [];
    for (const dustAccount of dustAccountsToBurn) {
      tx.add(
        createBurnInstruction(
          dustAccount.pubkey,
          dustAccount.mint!,
          userPubkey,
          dustAccount.rawAmount,
          [],
          dustAccount.programId
        )
      );
      accountsBurned.push(dustAccount.pubkey);
    }

    // ------------------------------------------------------------------------
    // STEP 3 (Rule 2.3): All createCloseAccountInstruction
    // 100% of reclaimed rent is sent directly to userPubkey first!
    // ------------------------------------------------------------------------
    const accountsClosed: PublicKey[] = [];
    let batchReclaimedLamports = 0n;

    for (const account of batch) {
      tx.add(
        createCloseAccountInstruction(
          account.pubkey,
          userPubkey,
          userPubkey,
          [],
          account.programId
        )
      );
      accountsClosed.push(account.pubkey);
      batchReclaimedLamports += account.rentLamports;
    }

    // ------------------------------------------------------------------------
    // STEP 4 (Rule 2.3): Single SystemProgram.transfer for 10% platform fee
    // Placed strictly LAST so Blowfish/Phantom see user receiving funds first.
    // ------------------------------------------------------------------------
    const {
      userNetLamports: batchUserNetLamports,
      treasuryFeeLamports: batchTreasuryFeeLamports,
    } = calculateFeeSplit(batchReclaimedLamports);

    if (batchTreasuryFeeLamports > 0n) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: userPubkey,
          toPubkey: treasuryPubkey,
          lamports: batchTreasuryFeeLamports,
        })
      );
    }

    tx.feePayer = userPubkey;
    if (params.recentBlockhash) {
      tx.recentBlockhash = params.recentBlockhash;
    }

    transactions.push(tx);
    batches.push({
      batchIndex,
      transaction: tx,
      accountsClosed,
      accountsBurned,
      batchReclaimedLamports,
      batchTreasuryFeeLamports,
      batchUserNetLamports,
    });

    totalAccountsClosed += accountsClosed.length;
    totalAccountsBurned += accountsBurned.length;
    totalReclaimedLamports += batchReclaimedLamports;
    totalTreasuryFeeLamports += batchTreasuryFeeLamports;
    totalUserNetLamports += batchUserNetLamports;
  }

  return {
    transactions,
    batches,
    totalAccountsClosed,
    totalAccountsBurned,
    skippedFrozenAccounts,
    totalReclaimedLamports,
    treasuryFeeLamports: totalTreasuryFeeLamports,
    userNetLamports: totalUserNetLamports,
  };
}

// ============================================================================
// PRE-FLIGHT SIMULATION (RULE 2.5)
// ============================================================================

/**
 * Rule 2.5: Mandatory Pre-Flight Simulation.
 * Executes `await connection.simulateTransaction(tx)` on every constructed transaction
 * before invoking `wallet.signTransaction` or `wallet.signAllTransactions`.
 * If `simulation.value.err !== null`, aborts immediately and returns a structured error.
 */
export async function simulateVaultSweepTransactions(
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
        error: `Simulation failed on transaction batch #${i + 1}: ${JSON.stringify(
          simulation.value.err
        )}`,
        logs: simulation.value.logs ?? null,
      };
    }
  }

  return {
    success: true,
  };
}
