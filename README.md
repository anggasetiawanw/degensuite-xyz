# DegenSuite (`degensuite.xyz`) — Security Architecture & Transaction Verification Suite

> **Official Verification & Social Attestation**
> - **Production Web App:** [https://degensuite.xyz](https://degensuite.xyz)
> - **Official X (Twitter):** [https://x.com/degensuite_xyz](https://x.com/degensuite_xyz) (`@degensuite_xyz`)
> - **Official Telegram Alerts:** [https://t.me/degensuitealert](https://t.me/degensuitealert) (`@degensuitealert`)
> - **Public Verification Repository:** [https://github.com/anggasetiawanw/degensuite-xyz](https://github.com/anggasetiawanw/degensuite-xyz)

This public repository exposes **DegenSuite**'s isolated client-side Solana transaction builders, safety invariants, and automated Vitest verification suite so wallet security providers (**Blowfish**, **Phantom**, **Solflare**, **Backpack**) and users can independently audit every instruction constructed by the application.

---

## 1. Platform Overview

DegenSuite separates **read-only on-chain intelligence** from **non-custodial wallet hygiene**:

### Read-Only Analytics (Zero Wallet Connection Required)
All analytics modules accept a public Base58 Solana address (`mint` or `wallet`) without requesting wallet connection or signing privileges:
- **RugShield** (`/rug-shield`): Token mint authority, freeze authority, liquidity, and risk-signal parser.
- **ClusterGraph** (`/cluster-graph`): Top-holder funding cluster & relationship inspector.
- **KOLWatch** (`/kol-watch`): On-chain wallet activity tracker and alert feed.
- **DegenLedger** (`/degen-ledger`): Historical wallet PnL and transaction ledger analyzer.
- **ChainRelay** (`/developer`): Server-side RPC relay & webhook alert infrastructure.

### Non-Custodial Wallet Hygiene (Standard Solana Programs Only)
- **VaultSweep** (`/vault-sweep`): Reclaims locked SOL rent from empty Associated Token Accounts (`amount === "0"`) and optionally closes explicitly user-confirmed dust accounts (`verifiedUsdValue < $0.05` USD).
- **WalletGuard**: Revokes active SPL Token delegates (`createRevokeInstruction`) with **0% platform fee**.
- **Pro Pass Checkout**: Standard `SystemProgram.transfer` with a read-only Solana Pay reference key.

---

## 2. On-Chain Program Interaction Matrix

DegenSuite deploys **zero custom smart contracts**. Every transaction constructed by [`src/lib/solana/tx-builder/`](src/lib/solana/tx-builder/) interacts exclusively with official Solana native and SPL Token programs:

| Program Name | Program ID | Used By | Purpose |
| :--- | :--- | :--- | :--- |
| **Compute Budget Program** | `ComputeBudget111111111111111111111111111111` | `VaultSweep`, `WalletGuard`, `ProPass` | Sets explicit compute unit limit & priority fee (`microLamports`) |
| **SPL Token Program** | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `VaultSweep`, `WalletGuard` | `CloseAccount`, `Revoke`, and strictly gated dust `Burn` |
| **SPL Token-2022 Program** | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | `VaultSweep`, `WalletGuard` | Supports Token-2022 `CloseAccount` / `Revoke` / dust `Burn` |
| **System Program** | `11111111111111111111111111111111` | `VaultSweep`, `ProPass` | Single 10% platform fee transfer placed **last**; Pro Pass checkout |

---

## 3. Anti-Drainer & Asset Safety Guarantees

Every transaction builder enforces five non-negotiable security invariants verified by unit tests in [`src/__tests__/vault-sweep.test.ts`](src/__tests__/vault-sweep.test.ts):

### 3.1 Exact `BigInt` Lamport Fee Split (Zero Floating-Point Math)
All fee calculations use integer `BigInt` lamports (`PLATFORM_FEE_BPS = 1000n` / `BPS_DENOMINATOR = 10000n`), never IEEE 754 floats:
- **User retains:** 90.00% (`totalReclaimedLamports - treasuryFeeLamports`)
- **Platform fee:** 10.00% (`(totalReclaimedLamports * 1000n) / 10000n`)
- **Example:** Closing 10 standard 165-byte SPL token accounts (`10 * 2,039,280 = 20,392,800` lamports) transfers exactly `2,039,280` lamports to treasury and leaves `18,353,520` net lamports in the user's wallet.

### 3.2 Strict Anti-Drainer Instruction Ordering (`VaultSweep`)
To ensure wallet transaction simulators (Blowfish / Phantom / Solflare) observe a net-positive SOL inflow to the user before any fee transfer:
1. `ComputeBudgetProgram.setComputeUnitLimit` & `setComputeUnitPrice`
2. `createBurnInstruction` *(only included when `userConfirmedDustBurn === true` and `verifiedUsdValue < 0.05`)*
3. `createCloseAccountInstruction` *(100% of reclaimed rent goes directly to `userPublicKey` first)*
4. Single `SystemProgram.transfer` *(10% `treasuryFeeLamports` from `userPublicKey` to `TREASURY_WALLET_PUBKEY` — strictly LAST)*

### 3.3 Batching Limit Below Solana MTU (`MAX_ACCOUNTS_PER_TX = 15`)
Transactions pack at most **15 token accounts per transaction** so serialized packets remain safely below Solana's **1232-byte** MTU limit. Closing 35 accounts produces 3 isolated batches (`15 + 15 + 5`).

### 3.4 NFT, Valuable Token & Frozen Account Protection
- **Zero-Balance Enforcement:** Attempting to pass an account with `amount !== "0"` into zero-balance sweep mode throws `NonZeroBalanceError`.
- **Frozen Account Filtering:** Accounts with `state === "frozen"` are automatically filtered out into `skippedFrozenAccounts` so they never break a batch.
- **NFT & Asset Guard (`UnsafeBurnError`):** Burn instructions are unconditionally blocked for:
  - Any NFT or zero-decimal asset (`decimals === 0`)
  - Any token with `verifiedUsdValue >= 0.05`
  - Any token with unknown or unverified USD pricing (`verifiedUsdValue === null` or `undefined`)
  - Any batch where `userConfirmedDustBurn !== true`

### 3.5 Mandatory Pre-Flight Simulation
Both [`simulateVaultSweepTransactions`](src/lib/solana/tx-builder/vault-sweep.ts) and [`simulateWalletGuardTransactions`](src/lib/solana/tx-builder/wallet-guard.ts) execute `await connection.simulateTransaction(tx)` prior to invoking wallet signing (`signTransaction` / `signAllTransactions`). Any non-null `simulation.value.err` aborts the signing flow immediately.

---

## 4. Repository Structure

```text
.
├── docs/
│   └── WALLET_ALLOWLIST_GUIDE.md          # Domain verification & wallet allowlist templates
├── src/
│   ├── lib/
│   │   └── solana/
│   │       ├── constants.ts               # Program IDs, BigInt rent/fee constants, env parsers
│   │       └── tx-builder/
│   │           ├── vault-sweep.ts         # Batched CloseAccount, Dust Guard & 90/10 fee split
│   │           ├── wallet-guard.ts        # Batched SPL Token delegate revoke builder (0% fee)
│   │           └── pass-payment.ts        # Solana Pay reference checkout builder
│   └── __tests__/
│       └── vault-sweep.test.ts            # 8 Vitest security & invariant tests
├── .env.example                           # Sanitized configuration schema (no secrets)
├── package.json
├── SECURITY.md                            # Formal wallet security review specification
└── tsconfig.json
```

---

## 5. Quickstart & Verification

Run the TypeScript check and Vitest security test suite locally:

```bash
pnpm install
pnpm typecheck
pnpm test
```

For wallet domain verification and allowlist submission templates (Blowfish, Phantom, Solflare), see [SECURITY.md](SECURITY.md) and [docs/WALLET_ALLOWLIST_GUIDE.md](docs/WALLET_ALLOWLIST_GUIDE.md).
