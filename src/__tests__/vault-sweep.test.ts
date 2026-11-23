import { describe, expect, it, vi } from "vitest";
import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  decodeInstruction,
  isBurnInstruction,
  isCloseAccountInstruction,
} from "@solana/spl-token";
import {
  TOKEN_ACCOUNT_RENT_LAMPORTS,
  TOKEN_PROGRAM_ID,
} from "../lib/solana/constants";
import {
  LIGHTHOUSE_MAX_SAFE_TX_BYTES,
  NonZeroBalanceError,
  UnsafeBurnError,
  buildVaultSweepTransactions,
  calculateFeeSplit,
  signAndSendUnsignedTransaction,
  simulateVaultSweepTransactions,
  type FlatSweepAccountInput,
  type PhantomProviderLike,
} from "../lib/solana/tx-builder/vault-sweep";
import { buildWalletGuardRevokeTransactions } from "../lib/solana/tx-builder/wallet-guard";

const TEST_USER_PUBKEY = Keypair.generate().publicKey;
const TEST_TREASURY_PUBKEY = Keypair.generate().publicKey;

function createDummyZeroAccount(
  overrides: Partial<FlatSweepAccountInput> = {}
): FlatSweepAccountInput {
  return {
    pubkey: Keypair.generate().publicKey,
    mint: Keypair.generate().publicKey,
    amount: "0",
    decimals: 6,
    state: "initialized",
    rentLamports: TOKEN_ACCOUNT_RENT_LAMPORTS,
    verifiedUsdValue: 0,
    programId: TOKEN_PROGRAM_ID,
    ...overrides,
  };
}

describe("VaultSweep Transaction Builder & Safety Guards", () => {
  it("1. Batching Test: Passing 35 empty token accounts produces exactly 3 transactions (15 + 15 + 5 accounts)", () => {
    const accounts = Array.from({ length: 35 }, () => createDummyZeroAccount());

    const result = buildVaultSweepTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      treasuryPublicKey: TEST_TREASURY_PUBKEY,
      accounts,
    });

    expect(result.transactions).toHaveLength(3);
    expect(result.batches).toHaveLength(3);
    expect(result.totalAccountsClosed).toBe(35);

    expect(result.batches[0]?.accountsClosed).toHaveLength(15);
    expect(result.batches[1]?.accountsClosed).toHaveLength(15);
    expect(result.batches[2]?.accountsClosed).toHaveLength(5);
  });

  it("2. Fee Math Test: Reclaiming 10 accounts (20,392,800 lamports) transfers exact 2,039,280 lamports to Treasury and retains 18,353,520 net lamports for User", () => {
    const tenAccountsLamports = 10n * TOKEN_ACCOUNT_RENT_LAMPORTS; // 20,392,800n
    expect(tenAccountsLamports).toBe(20_392_800n);

    const split = calculateFeeSplit(tenAccountsLamports);
    expect(split.treasuryFeeLamports).toBe(2_039_280n);
    expect(split.userNetLamports).toBe(18_353_520n);
    expect(split.treasuryFeeLamports + split.userNetLamports).toBe(20_392_800n);

    const accounts = Array.from({ length: 10 }, () => createDummyZeroAccount());
    const buildResult = buildVaultSweepTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      treasuryPublicKey: TEST_TREASURY_PUBKEY,
      accounts,
    });

    expect(buildResult.totalReclaimedLamports).toBe(20_392_800n);
    expect(buildResult.treasuryFeeLamports).toBe(2_039_280n);
    expect(buildResult.userNetLamports).toBe(18_353_520n);

    const tx = buildResult.transactions[0]!;
    const lastInstruction = tx.instructions[tx.instructions.length - 1]!;
    const decodedTransfer = SystemInstruction.decodeTransfer(lastInstruction);

    expect(decodedTransfer.fromPubkey.equals(TEST_USER_PUBKEY)).toBe(true);
    expect(decodedTransfer.toPubkey.equals(TEST_TREASURY_PUBKEY)).toBe(true);
    expect(decodedTransfer.lamports).toBe(2_039_280n);
  });

  it("3. Asset Safety Guard Test: Passing an account with amount !== '0' into zero-balance sweep builder throws NonZeroBalanceError", () => {
    const accounts: FlatSweepAccountInput[] = [
      createDummyZeroAccount(),
      createDummyZeroAccount({ amount: "150000" }),
      createDummyZeroAccount(),
    ];

    expect(() =>
      buildVaultSweepTransactions({
        userPublicKey: TEST_USER_PUBKEY,
        treasuryPublicKey: TEST_TREASURY_PUBKEY,
        accounts,
      })
    ).toThrowError(NonZeroBalanceError);
  });

  it("4. Frozen Account Guard Test: Passing an account with state === 'frozen' is automatically filtered out and does not break the batch", () => {
    const frozenPubkey1 = Keypair.generate().publicKey;
    const frozenPubkey2 = Keypair.generate().publicKey;

    const accounts: FlatSweepAccountInput[] = [
      createDummyZeroAccount(),
      createDummyZeroAccount({ pubkey: frozenPubkey1, state: "frozen" }),
      createDummyZeroAccount(),
      createDummyZeroAccount({
        pubkey: frozenPubkey2,
        state: "frozen",
        amount: "999999", // Even non-zero frozen accounts must be safely skipped first
      }),
      createDummyZeroAccount(),
    ];

    const result = buildVaultSweepTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      treasuryPublicKey: TEST_TREASURY_PUBKEY,
      accounts,
    });

    expect(result.transactions).toHaveLength(1);
    expect(result.totalAccountsClosed).toBe(3);
    expect(result.skippedFrozenAccounts).toHaveLength(2);
    expect(result.skippedFrozenAccounts[0]?.equals(frozenPubkey1)).toBe(true);
    expect(result.skippedFrozenAccounts[1]?.equals(frozenPubkey2)).toBe(true);
  });

  it("5. Instruction Ordering Test: Every VaultSweep transaction strictly orders ComputeBudget -> Burn (if dust) -> CloseAccount -> SystemProgram.transfer (last)", () => {
    const accounts: FlatSweepAccountInput[] = [
      ...Array.from({ length: 16 }, () => createDummyZeroAccount()),
      createDummyZeroAccount({
        amount: "42000",
        decimals: 6,
        verifiedUsdValue: 0.01, // verified dust < $0.05
      }),
    ];

    const result = buildVaultSweepTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      treasuryPublicKey: TEST_TREASURY_PUBKEY,
      accounts,
      userConfirmedDustBurn: true,
    });

    expect(result.transactions).toHaveLength(2);

    for (const tx of result.transactions) {
      const instructions = tx.instructions;
      expect(instructions.length).toBeGreaterThanOrEqual(4);

      // First two instructions must be ComputeBudgetProgram
      expect(instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(instructions[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);

      // Last instruction must be SystemProgram.transfer to TREASURY_WALLET_PUBKEY
      const lastIx = instructions[instructions.length - 1]!;
      expect(lastIx.programId.equals(SystemProgram.programId)).toBe(true);
      const transferParams = SystemInstruction.decodeTransfer(lastIx);
      expect(transferParams.fromPubkey.equals(TEST_USER_PUBKEY)).toBe(true);
      expect(transferParams.toPubkey.equals(TEST_TREASURY_PUBKEY)).toBe(true);

      // Middle instructions: all Burns must appear strictly before any CloseAccount
      const middleInstructions = instructions.slice(2, instructions.length - 1);
      expect(middleInstructions.length).toBeGreaterThan(0);

      let seenCloseAccount = false;
      for (const ix of middleInstructions) {
        expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
        const decoded = decodeInstruction(ix);

        if (isBurnInstruction(decoded)) {
          expect(seenCloseAccount).toBe(false);
        } else if (isCloseAccountInstruction(decoded)) {
          seenCloseAccount = true;
          // Destination of CloseAccount must be 100% userPublicKey first
          expect(decoded.keys.destination.pubkey.equals(TEST_USER_PUBKEY)).toBe(true);
        } else {
          throw new Error(`Unexpected SPL token instruction: ${decoded.data.instruction}`);
        }
      }

      expect(seenCloseAccount).toBe(true);
    }
  });

  it("6. NFT & Valuable Asset Protection Test: Refuses to burn NFTs (decimals === 0) or tokens with USD value >= $0.05 or null", () => {
    // Case A: NFT (decimals === 0)
    expect(() =>
      buildVaultSweepTransactions({
        userPublicKey: TEST_USER_PUBKEY,
        treasuryPublicKey: TEST_TREASURY_PUBKEY,
        userConfirmedDustBurn: true,
        accounts: [
          createDummyZeroAccount({
            amount: "1",
            decimals: 0,
            verifiedUsdValue: 0.001,
          }),
        ],
      })
    ).toThrowError(UnsafeBurnError);

    // Case B: Valuable token >= $0.05
    expect(() =>
      buildVaultSweepTransactions({
        userPublicKey: TEST_USER_PUBKEY,
        treasuryPublicKey: TEST_TREASURY_PUBKEY,
        userConfirmedDustBurn: true,
        accounts: [
          createDummyZeroAccount({
            amount: "1000000",
            decimals: 6,
            verifiedUsdValue: 0.05,
          }),
        ],
      })
    ).toThrowError(UnsafeBurnError);

    // Case C: Unknown USD value (null)
    expect(() =>
      buildVaultSweepTransactions({
        userPublicKey: TEST_USER_PUBKEY,
        treasuryPublicKey: TEST_TREASURY_PUBKEY,
        userConfirmedDustBurn: true,
        accounts: [
          createDummyZeroAccount({
            amount: "1000000",
            decimals: 6,
            verifiedUsdValue: null,
          }),
        ],
      })
    ).toThrowError(UnsafeBurnError);
  });

  it("7. Pre-Flight Simulation Guard Test: Aborts immediately if simulateTransaction returns a non-null err", async () => {
    const { transactions } = buildVaultSweepTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      treasuryPublicKey: TEST_TREASURY_PUBKEY,
      accounts: [createDummyZeroAccount()],
    });

    const mockConnectionFailure = {
      simulateTransaction: vi.fn().mockResolvedValue({
        value: {
          err: { InstructionError: [2, "CustomError"] },
          logs: ["Program log: Simulation failed"],
        },
      }),
    } as unknown as Connection;

    const failedSim = await simulateVaultSweepTransactions(
      mockConnectionFailure,
      transactions
    );
    expect(failedSim.success).toBe(false);
    expect(failedSim.failedBatchIndex).toBe(0);
    expect(failedSim.error).toContain("InstructionError");

    const mockConnectionSuccess = {
      simulateTransaction: vi.fn().mockResolvedValue({
        value: {
          err: null,
          logs: ["Program log: Success"],
        },
      }),
    } as unknown as Connection;

    const passedSim = await simulateVaultSweepTransactions(
      mockConnectionSuccess,
      transactions
    );
    expect(passedSim.success).toBe(true);
  });

  it("8. WalletGuard Revoke Builder Test: Batches up to 15 accounts and skips frozen or non-delegated accounts", () => {
    const delegateKey = Keypair.generate().publicKey;
    const delegatedAccounts = Array.from({ length: 18 }, () => ({
      pubkey: Keypair.generate().publicKey,
      delegate: delegateKey,
      state: "initialized" as const,
    }));

    const frozenAccount = {
      pubkey: Keypair.generate().publicKey,
      delegate: delegateKey,
      state: "frozen" as const,
    };

    const result = buildWalletGuardRevokeTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      accounts: [...delegatedAccounts, frozenAccount],
    });

    expect(result.transactions).toHaveLength(2);
    expect(result.totalRevokedAccounts).toBe(18);
    expect(result.skippedAccounts).toHaveLength(1);
    expect(result.skippedAccounts[0]?.equals(PublicKey.default)).toBe(false);
  });

  it("9. Lighthouse Guard Headroom & Unsigned signAndSendTransaction Test: Full 15-account batch stays <= 1050 bytes and strips pre-existing signatures", async () => {
    const recentBlockhash = Keypair.generate().publicKey.toBase58();
    const fullBatchAccounts = Array.from({ length: 15 }, () =>
      createDummyZeroAccount()
    );

    const { transactions } = buildVaultSweepTransactions({
      userPublicKey: TEST_USER_PUBKEY,
      treasuryPublicKey: TEST_TREASURY_PUBKEY,
      accounts: fullBatchAccounts,
      recentBlockhash,
    });

    expect(transactions).toHaveLength(1);
    const tx = transactions[0]!;
    const serializedLen = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    }).length;
    expect(serializedLen).toBeLessThanOrEqual(LIGHTHOUSE_MAX_SAFE_TX_BYTES);

    const mockConn = {} as unknown as Connection;
    tx.signatures = [
      { publicKey: TEST_USER_PUBKEY, signature: Buffer.alloc(64, 1) },
    ];

    const phantomProvider: PhantomProviderLike = {
      isPhantom: true,
      publicKey: TEST_USER_PUBKEY,
      signAndSendTransaction: vi.fn(async (submittedTx) => {
        expect(submittedTx.signatures).toHaveLength(0);
        return { signature: "phantom_sig_123" };
      }),
    };
    const sendTransactionMock = vi.fn().mockResolvedValue("adapter_sig_456");

    const phantomSig = await signAndSendUnsignedTransaction({
      transaction: tx,
      connection: mockConn,
      userPublicKey: TEST_USER_PUBKEY,
      recentBlockhash,
      phantomProvider,
      sendTransaction: sendTransactionMock,
    });
    expect(phantomSig).toBe("phantom_sig_123");
    expect(phantomProvider.signAndSendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransactionMock).not.toHaveBeenCalled();

    tx.signatures = [
      { publicKey: TEST_USER_PUBKEY, signature: Buffer.alloc(64, 2) },
    ];
    const adapterSig = await signAndSendUnsignedTransaction({
      transaction: tx,
      connection: mockConn,
      userPublicKey: TEST_USER_PUBKEY,
      recentBlockhash,
      phantomProvider: null,
      sendTransaction: sendTransactionMock,
    });
    expect(adapterSig).toBe("adapter_sig_456");
    expect(sendTransactionMock).toHaveBeenCalledTimes(1);
    expect(tx.signatures).toHaveLength(0);
  });
});
