# DegenSuite Wallet Allowlist & Domain Verification Guide

This guide documents the complete domain verification and security allowlist submission process for **DegenSuite** (`https://degensuite.xyz`) across **Blowfish**, **Phantom**, and **Solflare**.

---

## 1. Pre-Submission Verification Checklist

Security reviewers (Blowfish, Phantom, Solflare) automatically reject or delay requests if the production domain appears incomplete or cannot be cross-verified against official social channels. Complete every item below before sending review emails:

- [ ] **Live Production Frontend (`https://degensuite.xyz`)**: Ensure HTTPS is valid (valid SSL certificate, no mixed-content errors, no placeholder/under-construction page).
- [ ] **Bidirectional Domain ↔ X Verification**:
  - `https://degensuite.xyz` footer/header visibly links to `https://x.com/degensuite_xyz` and `https://github.com/anggasetiawanw/degensuite-xyz`.
  - X profile `https://x.com/degensuite_xyz` bio/website field explicitly lists `https://degensuite.xyz`.
- [ ] **Public Verification Repository**: Ensure `https://github.com/anggasetiawanw/degensuite-xyz` is set to **Public** on GitHub and contains the transaction builder source code, security guarantees, and passing unit tests.
- [ ] **Official Domain Email (`@degensuite.xyz`)**: Send requests from an official `@degensuite.xyz` address (e.g., `security@degensuite.xyz` or `team@degensuite.xyz`) rather than a free webmail address (see [Section 5](#5-free-custom-domain-email-via-cloudflare-email-routing--gmail) below).
- [ ] **Optional Security Contact (`/.well-known/security.txt`)**: Optionally host a plain-text `security.txt` file at `https://degensuite.xyz/.well-known/security.txt` containing:
  ```text
  Contact: mailto:security@degensuite.xyz
  Canonical: https://degensuite.xyz/.well-known/security.txt
  Policy: https://github.com/anggasetiawanw/degensuite-xyz/blob/main/SECURITY.md
  Preferred-Languages: en
  ```

---

## 2. Blowfish Security Allowlist Request (`review@blowfish.xyz`)

**Blowfish** is the primary transaction simulation and domain screening engine used by **Phantom**, **Solflare**, and **Backpack**. Getting approved by Blowfish resolves most false-positive "Untrusted Domain" and "Malicious dApp" warnings simultaneously.

* **To:** `review@blowfish.xyz`
* **From:** `security@degensuite.xyz` (or `team@degensuite.xyz`)
* **Subject:** `Domain Allowlist & Security Review Request — DegenSuite (https://degensuite.xyz)`

```text
Hi Blowfish Security Review Team,

We are reaching out to request a domain security review and allowlisting for DegenSuite, a non-custodial Solana wallet hygiene and token security analytics application.

1. Project & Verification Links:
- Project Name: DegenSuite
- Production Domain: https://degensuite.xyz
- Official X (Twitter): https://x.com/degensuite_xyz
- Official Telegram Alerts: https://t.me/degensuitealert
- Public Security & Tx-Builder Repository: https://github.com/anggasetiawanw/degensuite-xyz
- Contact Email: security@degensuite.xyz

2. Application Overview:
DegenSuite provides two categories of functionality:
- Read-Only Analytics (zero wallet connection required): RugShield (token risk & liquidity parser), ClusterGraph (top-holder cluster inspection), KOLWatch, DegenLedger, and ChainRelay.
- Non-Custodial Wallet Utilities:
  - VaultSweep: Closes user-owned zero-balance Associated Token Accounts (ATAs) to reclaim locked SOL rent (and optionally burns explicitly confirmed dust tokens worth < $0.05 USD).
  - WalletGuard: Revokes active SPL Token delegates from user token accounts (0% platform fee).

3. Transaction Safety & Anti-Drainer Architecture:
- Zero Custom Smart Contracts: All client transactions exclusively invoke official Solana native and SPL programs:
  - SPL Token Program: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
  - SPL Token-2022 Program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
  - System Program: 11111111111111111111111111111111
  - Compute Budget Program: ComputeBudget111111111111111111111111111111
- Strict Instruction Ordering (VaultSweep):
  1. ComputeBudgetProgram (setComputeUnitLimit & setComputeUnitPrice)
  2. createBurnInstruction (strictly gated: only when userConfirmedDustBurn === true, decimals !== 0, and verifiedUsdValue < $0.05)
  3. createCloseAccountInstruction (100% of reclaimed rent goes directly to the user's wallet first)
  4. Single SystemProgram.transfer (10% platform fee to Treasury placed strictly LAST so the user's net SOL balance change is always positive)
- Exact BigInt Lamport Math & Batching: All lamport splits use integer BigInt arithmetic (1000 BPS / 10000), batched at a maximum of 15 token accounts per transaction.
- Asset Guards: NFTs (decimals === 0), valuable tokens (>= $0.05 or unverified USD value), and frozen accounts are protected/skipped.
- Pre-Flight Simulation: Every transaction executes connection.simulateTransaction(tx) and aborts immediately if simulation.value.err !== null before prompting wallet signing.

The isolated transaction builders and Vitest verification suite are publicly auditable here:
https://github.com/anggasetiawanw/degensuite-xyz

We are ready to add a DNS TXT record or host a verification token under https://degensuite.xyz/.well-known/ if needed to confirm domain ownership.

Thank you for your review!

Best regards,
DegenSuite Security Team
https://degensuite.xyz
https://x.com/degensuite_xyz
```

---

## 3. Phantom Developer Portal Access & Domain Verification (`partnerships@phantom.app`)

Because **Phantom Developer Portal** (`https://phantom.com/portal`) currently displays *"New sign ups are paused"*:

- **Important note for standard Wallet Adapter integrations:** If your dApp connects through the standard injected Phantom browser/mobile provider (`@solana/wallet-adapter-react`), you do **not** need a Phantom Portal App ID for wallet connection to work.
- **Why still email Phantom:** You should still email `partnerships@phantom.app` from your `@degensuite.xyz` address to request portal onboarding / DNS TXT domain verification for DegenSuite's production domain.

* **To:** `partnerships@phantom.app`
* **From:** `team@degensuite.xyz` (or `security@degensuite.xyz`)
* **Subject:** `Developer Portal Access & Domain Verification — DegenSuite (https://degensuite.xyz)`

```text
Hi Phantom Team,

We noticed that new self-serve sign-ups on https://phantom.com/portal are currently paused. We would like to request Developer Portal access and DNS TXT domain verification for our non-custodial Solana web application, DegenSuite.

- Application Name: DegenSuite
- Production URL: https://degensuite.xyz
- Official X (Twitter): https://x.com/degensuite_xyz
- Public Tx-Builder & Security Repo: https://github.com/anggasetiawanw/degensuite-xyz

DegenSuite uses standard Solana Wallet Adapter integration and interacts solely with official SPL Token, Token-2022, ComputeBudget, and System Program instructions (zero custom on-chain programs). Our read-only token analytics modules require no wallet connection, and our non-custodial VaultSweep / WalletGuard builders enforce strict pre-flight simulation, BigInt fee math, and user-first instruction ordering.

Please let us know what steps are required to verify https://degensuite.xyz (we are ready to publish a DNS TXT record immediately).

Best regards,
DegenSuite Team
https://degensuite.xyz
https://x.com/degensuite_xyz
```

---

## 4. Solflare Support Verification (`https://support.solflare.com`)

**Solflare** aggregates ecosystem security feeds (including Blowfish) along with on-chain simulation checks. Once Blowfish approves `https://degensuite.xyz`, Solflare usually clears within 24–48 hours.

If Solflare continues displaying an *"Unverified Domain"* or false-positive security warning after Blowfish approval:

1. Visit **[https://support.solflare.com](https://support.solflare.com)** and open the support chat/ticket widget.
2. Select **dApp Verification / False Positive Report**.
3. Submit the message below:

```text
Subject: Domain Verification / False Positive Allowlist Request — https://degensuite.xyz

Hi Solflare Security & Support Team,

We are requesting verification/allowlisting for DegenSuite (https://degensuite.xyz), a non-custodial Solana wallet hygiene and token security analytics platform.

- Production URL: https://degensuite.xyz
- Official X (Twitter): https://x.com/degensuite_xyz
- Public Security & Tx-Builder Repo: https://github.com/anggasetiawanw/degensuite-xyz
- Blowfish Review Status: Submitted to review@blowfish.xyz

All transactions built by DegenSuite strictly use official Solana SPL Token / Token-2022 / System / ComputeBudget instructions with zero custom contracts, strict user-first rent reclamation ordering (VaultSweep), zero-fee delegate revocation (WalletGuard), and mandatory pre-flight simulation prior to wallet signing.

Please let us know if you require DNS TXT verification or additional technical details.

Thank you,
DegenSuite Team
```

---

## 5. Free Custom Domain Email via Cloudflare Email Routing + Gmail

Sending review emails from `@degensuite.xyz` (instead of a personal webmail account) strongly improves trust with both `review@blowfish.xyz` and `partnerships@phantom.app` (Phantom explicitly asks you to *"email partnerships@phantom.app from your company email address"*).

### Step A — Receive emails at `@degensuite.xyz` (Cloudflare Email Routing)
1. Open your domain in the **Cloudflare Dashboard** → **Email** → **Email Routing**.
2. Enable **Email Routing** and let Cloudflare automatically add the required `MX` and `TXT (SPF)` DNS records.
3. Add a destination address (your inbox) and verify it via the confirmation link.
4. Create custom addresses:
   - `security@degensuite.xyz` → forwards to your destination inbox
   - `team@degensuite.xyz` → forwards to your destination inbox

### Step B — Send emails *from* `@degensuite.xyz` via Gmail SMTP
1. Ensure **2-Step Verification** is enabled on your Google Account.
2. Create a Google **App Password** at `https://myaccount.google.com/apppasswords` (name it e.g. `DegenSuite Mail`).
3. Open Gmail → **Settings (Gear icon)** → **See all settings** → **Accounts and Import** → **Send mail as** → **Add another email address**.
4. Enter:
   - **Name:** `DegenSuite Team` (or `DegenSuite Security`)
   - **Email address:** `security@degensuite.xyz`
   - Leave **"Treat as an alias"** checked → **Next Step**.
5. Configure SMTP Server:
   - **SMTP Server:** `smtp.gmail.com`
   - **Port:** `587` (`TLS`)
   - **Username:** your full Gmail address
   - **Password:** the 16-character Google App Password (no spaces)
6. Click **Add Account**, then enter the verification code that Cloudflare Email Routing forwards into your inbox.
7. When composing emails to `review@blowfish.xyz` or `partnerships@phantom.app`, select `security@degensuite.xyz` in the **From** dropdown.
