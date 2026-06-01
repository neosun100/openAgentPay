# Wallet Sign-Up Plan — v0.11

> **Goal**: every one of OpenAgentPay's 18 protocols gets ≥ 1 real testnet wallet behind it. Today's target list is everything 🟢 ("5-minute self-serve") and 🟡 ("15-minute developer portal email").
>
> **Skipping for now**: 🟠 review-required (HashKey Pro, OKX merchant, Bitget) and 🔴 sales-contacted (Fireblocks, Anchorage).

---

## 🎯 The 18-protocol coverage matrix (today)

| # | Protocol | Existing wallet(s) | Gap? | Recommended sign-up |
|---|---|---|---|---|
| 1 | `x402-v1/v2` | ✅ hashkey, coinbase-cdp, metamask, walletconnect | none | (already 4) |
| 2 | `ap2-v0.1` | ⚠️ orthogonal — composes with any wallet | ok | (no dedicated wallet needed) |
| 3 | `cex-pay-v0.1` (OAP-CEX) | ✅ binance · ✅ **okx** (Demo Trading sandbox — OK-ACCESS-SIGN verified live `pnpm smoke:okx`) | 2 impls — protocol proven non-Binance-specific | 🟡 HashKey Pro sandbox (KYC-gated, later) |
| 4 | `solana-pay-v1` | ⚠️ solana (DemoSigner only) | **needs real signer** | 🟢 **Helius (devnet RPC + faucet)** |
| 5 | `mpp-v0.1` | ❌ none (sub-protocol of x402, reuses) | covered via x402 | (no action) |
| 6 | `l402-v1` (Lightning) | ❌ NONE | **critical gap** | 🟡 **Voltage testnet LND node** |
| 7 | `stellar-sep31-v1` | ❌ NONE | **critical gap** | 🟢 **Stellar Lab + testanchor.stellar.org** |
| 8 | `w3c-payment-v1` | ✅ metamask (via EIP-1193) | ok | (browser-mediated, reuses) |
| 9 | `sui-pay-v1` | ❌ NONE | gap | 🟢 **Sui devnet keypair + Suiet/Slush wallet** |
| 10 | `aptos-pay-v1` | ❌ NONE | gap | 🟢 **Aptos devnet keypair + Petra wallet** |
| 11 | `erc8004-v1` | ✅ any x402 wallet | ok | (registry layer, reuses) |
| 12 | `skyfire-v1` | ❌ no skyfire-specific | gap | 🟡 **Skyfire developer account** |
| 13 | `virtuals-acp-v1` | ❌ no virtuals-specific | gap | 🟡 **Virtuals testnet (Base Sepolia)** |
| 14 | `nevermined-v1` | ❌ no nevermined-specific | gap | 🟡 **Nevermined developer account** |
| 15 | `erc7777-v1` | ✅ any x402 wallet | ok | (governance registry, reuses) |
| 16 | `tron-usdt-v1` | ❌ NONE | **critical gap** | 🟢 **TronLink + Shasta faucet** |
| 17 | `open-payments-v1` | ❌ NONE | **critical gap** | 🟡 **Interledger Test Wallet (rafiki.money)** |
| 18 | `hedera-hcs-v1` | ❌ NONE | **critical gap** | 🟢 **Hedera Portal testnet** |
| 19 | `cosmos-ibc-v1` | ❌ NONE | gap | 🟢 **Cosmos Theta testnet (Keplr)** |

**Critical gaps (protocol exists, no wallet at all)**: 7
- L402 · Stellar · Sui · Aptos · TRON · Open Payments · Hedera · Cosmos · Solana(real)

After today's batch, **every protocol has at least one real wallet integration**. ✅

---

## 📦 Today's target list — 10 wallets to register

Sorted by ROI × difficulty (do them in this order):

### 🟢 Tier A — pure self-serve (just generate a keypair, 5-10 min each)

These are entirely client-side: install wallet / generate keypair / use a public faucet. **No accounts to create, no emails, no review.**

#### A1. Hedera Portal (testnet) → `wallet-hedera`
- **Sign up**: https://portal.hedera.com/ → "Create Testnet Account" → email + click confirm
- **You get**: Account ID `0.0.xxxxxx` + Ed25519 private key + 1000 testnet HBAR free
- **Time**: 5 min
- **Protocol it unlocks**: `hedera-hcs-v1`
- **Asset**: HBAR (native), USDC (HTS test token id `0.0.456858`)
- **What I need from you**:
  ```
  HEDERA_ACCOUNT_ID=0.0.xxxxxx
  HEDERA_PRIVATE_KEY_DER=302e02010030...
  HEDERA_NETWORK=testnet
  ```

#### A2. Stellar Lab (testnet) → `wallet-stellar`
- **Sign up**: https://laboratory.stellar.org/ → "Create Account" tab → click "Generate keypair" → click "Get test XLM" (Friendbot funds it)
- **You get**: Stellar account `GA...` + secret `SA...` + 10,000 testnet XLM
- **Time**: 2 min (no email even)
- **Protocol it unlocks**: `stellar-sep31-v1`
- **Asset**: XLM, USDC (test asset on testanchor.stellar.org)
- **What I need from you**:
  ```
  STELLAR_PUBLIC_KEY=G...
  STELLAR_SECRET=S...
  STELLAR_NETWORK=testnet
  STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
  ```

#### A3. Sui devnet → `wallet-sui`
- **Sign up**: install **Slush Wallet** (https://slush.app) browser extension → toggle to devnet → request faucet from menu
- **OR via CLI**: `sui client new-address ed25519` then `sui client faucet`
- **You get**: Sui address `0x...` + Ed25519 keypair + 1 SUI from faucet
- **Time**: 5 min
- **Protocol it unlocks**: `sui-pay-v1`
- **Asset**: SUI, devnet USDC (`0x...::usdc::USDC`)
- **What I need from you**:
  ```
  SUI_ADDRESS=0x...
  SUI_PRIVATE_KEY_BECH32=suiprivkey1...
  SUI_NETWORK=devnet
  ```

#### A4. Aptos devnet → `wallet-aptos`
- **Sign up**: install **Petra Wallet** (https://petra.app) → switch to devnet → click "Faucet"
- **OR via CLI**: `aptos init --network devnet` (auto-funds)
- **You get**: Aptos address `0x...` + Ed25519 keypair + 1 APT
- **Time**: 5 min
- **Protocol it unlocks**: `aptos-pay-v1`
- **Asset**: APT, devnet USDC
- **What I need from you**:
  ```
  APTOS_ADDRESS=0x...
  APTOS_PRIVATE_KEY=0x...
  APTOS_NETWORK=devnet
  ```

#### A5. TronLink Shasta → `wallet-tron`
- **Sign up**: install **TronLink** browser extension → settings → toggle to "Shasta Testnet" → click "Get Test TRX" link to faucet (https://www.trongrid.io/shasta/#/faucet)
- **You get**: TRON address `T...` + private key + 5000 test TRX
- **Time**: 5 min
- **Protocol it unlocks**: `tron-usdt-v1`
- **Asset**: TRX, USDT-TRC20 (Shasta has a test USDT contract)
- **What I need from you**:
  ```
  TRON_ADDRESS=T...
  TRON_PRIVATE_KEY=0x...
  TRON_NETWORK=shasta
  TRON_TRONGRID_API_KEY=optional_but_fast    # https://www.trongrid.io/dashboard
  ```

#### A6. Cosmos Theta testnet → `wallet-cosmos`
- **Sign up**: install **Keplr Wallet** browser extension → settings → "Manage Chain Visibility" → enable "Cosmos Hub Theta Testnet" → click address to copy → faucet at https://faucet.testnet.theta.cosmos.network
- **OR via CLI**: `gaiad keys add agent --keyring-backend test`
- **You get**: bech32 `cosmos1...` + 24-word mnemonic + 10 test ATOM
- **Time**: 8 min
- **Protocol it unlocks**: `cosmos-ibc-v1`
- **Asset**: ATOM (uatom), test USDC via IBC
- **What I need from you**:
  ```
  COSMOS_ADDRESS=cosmos1...
  COSMOS_MNEMONIC="word1 word2 ... word24"
  COSMOS_RPC=https://rpc.theta-testnet.polypore.xyz
  ```

#### A7. Helius Solana → `wallet-solana` (real signer upgrade)
- **Sign up**: https://www.helius.dev/ → "Get Started Free" → email signup → dashboard gives you `HELIUS_API_KEY`
- **You also need**: a Solana keypair (any will do): `solana-keygen new --outfile ~/.config/solana/id.json` then `solana airdrop 2 --url devnet`
- **Time**: 8 min
- **Protocol it unlocks**: upgrades existing `wallet-solana` from `DemoSigner` → real `@solana/web3.js`
- **Asset**: SOL, devnet USDC (`Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`)
- **What I need from you**:
  ```
  SOLANA_KEYPAIR_BASE58=4xQ...      # base58 of the secret key bytes
  SOLANA_PUBLIC_KEY=...
  SOLANA_HELIUS_API_KEY=...
  SOLANA_CLUSTER=devnet
  ```

---

### 🟡 Tier B — developer portal sign-up (15 min, may need email confirm)

#### B1. Voltage Cloud (Lightning testnet) → `wallet-lightning`
- **Sign up**: https://voltage.cloud/ → "Sign Up" → email confirm → "Create Node" → choose "Testnet LND" (free tier) → wait ~3 min for sync
- **You get**: LND node URL `https://xxx.voltageapp.io:8080` + REST macaroon (admin) + TLS cert
- **Time**: 10-15 min
- **Protocol it unlocks**: `l402-v1` (and unlocks Lightning entirely)
- **Asset**: testnet sats (free from any LN testnet faucet, e.g., https://htlc.me)
- **What I need from you**:
  ```
  LND_NODE_URL=https://xxx.voltageapp.io:8080
  LND_ADMIN_MACAROON_HEX=02011...
  LND_TLS_CERT_BASE64=LS0tLS...
  ```

#### B2. Interledger Test Wallet (Open Payments) → `wallet-open-payments`
- **Sign up**: https://rafiki.money/ → click "Sign Up" → email + password → wait for verification email → click confirm
- **You get**: a Test Wallet account at `https://rafiki.money/$YOUR_USERNAME` + auto-issued Open Payments client keys
- **Time**: 8 min
- **Protocol it unlocks**: `open-payments-v1`
- **Asset**: test USD (Rafiki sandbox-only)
- **What I need from you**:
  ```
  OP_WALLET_ADDRESS=https://ilp.rafiki.money/your-username
  OP_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n..."
  OP_KEY_ID=...
  ```

#### B3. Stripe Privy (closes AgentCore Path-D) → `wallet-stripe-privy`
- **Sign up**: https://dashboard.privy.io/ → "Get Started" → email signup → no card needed for dev tier
- **You get**: `PRIVY_APP_ID` + `PRIVY_APP_SECRET` + ability to mint embedded wallets
- **Time**: 10 min
- **Protocol it unlocks**: `x402-v1` (the OTHER managed wallet AWS AgentCore natively supports)
- **Asset**: Circle USDC on Base Sepolia (same as our coinbase-cdp)
- **What I need from you**:
  ```
  PRIVY_APP_ID=cl...
  PRIVY_APP_SECRET=...
  PRIVY_AGENT_WALLET_ID=...     # we mint this once via the SDK
  ```

#### B4. Circle Programmable Wallets → `wallet-circle-pw`
- **Sign up**: https://console.circle.com/ → "Get Started" → email → "Sandbox" environment auto-issued
- **You get**: `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` (you generate locally with their tool, register the public part)
- **Time**: 12 min (the entity-secret cycle adds a step)
- **Protocol it unlocks**: `x402-v1` with native USDC + gas-station
- **Asset**: USDC (Circle's own) on testnet (Polygon Amoy / Base Sepolia / ETH Sepolia)
- **What I need from you**:
  ```
  CIRCLE_API_KEY=TEST_API_KEY:...
  CIRCLE_ENTITY_SECRET=...           # 32-byte hex
  CIRCLE_WALLET_ID=...              # from /v1/w3s/wallets POST
  CIRCLE_NETWORK=POLYGON-AMOY        # or ETH-SEPOLIA / BASE-SEPOLIA
  ```

#### B5. Magic.link → `wallet-magic`
- **Sign up**: https://magic.link/ → "Sign Up" → email confirm → free dev tier
- **You get**: `MAGIC_PUBLISHABLE_KEY` (`pk_live_xxx`) + `MAGIC_SECRET_KEY` (`sk_live_xxx`)
- **Time**: 8 min
- **Protocol it unlocks**: `x402-v1` with mainstream user (email-based) wallets
- **Asset**: Circle USDC on Base Sepolia
- **What I need from you**:
  ```
  MAGIC_PUBLISHABLE_KEY=pk_live_...
  MAGIC_SECRET_KEY=sk_live_...
  MAGIC_AGENT_EMAIL=agent+oap@yourdomain.com    # used as the wallet identity
  ```

#### B6. ZeroDev (Smart Account / ERC-4337) → `wallet-zerodev`
- **Sign up**: https://dashboard.zerodev.app/ → "Sign Up" → email → free tier (5K UserOps/mo)
- **You get**: `ZERODEV_PROJECT_ID` + `ZERODEV_BUNDLER_RPC` + `ZERODEV_PAYMASTER_RPC`
- **Time**: 8 min
- **Protocol it unlocks**: `x402-v1` with smart-account-encoded spending limits
- **Asset**: Circle USDC on Base Sepolia
- **What I need from you**:
  ```
  ZERODEV_PROJECT_ID=...
  ZERODEV_BUNDLER_RPC=https://rpc.zerodev.app/api/v2/bundler/...
  ZERODEV_PAYMASTER_RPC=https://rpc.zerodev.app/api/v2/paymaster/...
  ZERODEV_OWNER_PRIVATE_KEY=0x...     # we provide; signs UserOps
  ```

---

### 🟡 Tier C — protocol-specific developer access (still 🟡 but more niche)

These three are needed only if you want a wallet **specifically branded** for that protocol. The protocol itself works on top of a regular x402 wallet today (we have adapters), so this is "closing the matrix" rather than functional gap.

#### C1. Skyfire developer account → `wallet-skyfire`
- **Sign up**: https://skyfire.xyz/ → "For Developers" → wait-list form OR direct sandbox if open
- **Time**: depends — sometimes instant, sometimes 1-day review (consider skipping if review)
- **What you get** (when approved): `SKYFIRE_API_KEY` + KYA agent issuance API
- **Protocol it unlocks**: `skyfire-v1` with native KYA token issuance (vs. just adapting an x402 wallet)

#### C2. Virtuals testnet → `wallet-virtuals-acp`
- **Sign up**: https://app.virtuals.io/ → "Sign In With Wallet" → connect MetaMask Base Sepolia → no extra account needed beyond MetaMask
- **Time**: 5 min — actually 🟢 since you already have MetaMask
- **What you get**: ability to mint Virtuals agents on Base Sepolia + interact with their ACP 4-phase flow
- **Protocol it unlocks**: native `virtuals-acp-v1`

#### C3. Nevermined → `wallet-nevermined`
- **Sign up**: https://nevermined.io/ → docs page links to their developer Discord; account creation goes through their team
- **Time**: 1-2 days (review-required, consider skipping for now)

---

## 🚦 Recommended ordering (today)

If you want to go in priority order **for max protocol coverage** with minimum effort:

```
Round 1 — Tier A self-serve (target: 7 protocols in 1 hour)
─────────────────────────────────────────────────────────
  A2  Stellar Lab          (2 min)
  A1  Hedera Portal        (5 min)
  A3  Sui devnet            (5 min)
  A4  Aptos devnet          (5 min)
  A5  TronLink Shasta       (5 min)
  A6  Cosmos Theta          (8 min)
  A7  Helius Solana         (8 min)

Round 2 — Tier B email signups (target: 6 wallets in ~1.5 hours)
────────────────────────────────────────────────────────────
  C2  Virtuals (use MetaMask)  (5 min)
  B5  Magic.link            (8 min)
  B6  ZeroDev               (8 min)
  B1  Voltage Lightning     (15 min)
  B2  Rafiki Open Payments  (8 min)
  B3  Stripe Privy          (10 min)
  B4  Circle PW             (12 min)
```

After Round 1: every protocol has a real testnet wallet (except Skyfire/Nevermined/MPP which compose with x402).

After Round 2: every Tier-1 enterprise wallet category covered (managed/MPC/embedded/smart-account).

---

## 📨 How to hand the credentials back

Easiest workflow:

1. Make a **`.env.local.candidates`** file (gitignored — already covered by `.env*`)
2. Append each wallet's credentials block as you go (the `What I need from you` snippet above)
3. Tell me which ones you've added — I'll implement the corresponding `wallet-*` packages, run conformance against them, and put a real testnet tx hash in `CHANGELOG.md` for each.

You don't need to do them all at once — even 2-3 from Round 1 lets me build the next batch of connectors.

---

## ❌ What we're explicitly NOT doing today

| Wallet | Why not | When? |
|---|---|---|
| **HashKey Pro sandbox** | Requires KYC + sales contact | Q3 if customer asks |
| **OKX Pay merchant** | Same | Q3 |
| **Bitget / Bybit Pay** | Sandbox tied to merchant onboarding | When OAP-CEX gets a 2nd impl ready |
| **Fireblocks** | Enterprise sales-led, no public dev portal | Customer-driven |
| **Anchorage** | Same | Customer-driven |
| **Crossmint** | API key easy but use case (NFT) is niche | Round 3 |
| **Web3Auth** | Duplicates Magic.link role | Round 3 |
| **HKDR / FDUSD wallets** | Issuers don't have agent SDKs yet | When ecosystem catches up |

---

## 🎯 The end-state we're racing toward

After today's batches:

```
✅ 18 protocols × 13+ real wallet integrations
✅ Every protocol has ≥ 1 real testnet tx demonstrable
✅ Conformance suite green on every new wallet
✅ Demo URL switches across all of them with one config-line change
```

That's the "终结春秋战国 Crypto Payments" moment — a real demonstration that **one config switches you between Lightning Network, TRON USDT, Solana, Hedera, Stellar, Cosmos, Sui, Aptos, MetaMask, Coinbase, Stripe Privy, Circle, Magic, and ZeroDev** without business code changes.

---

*Maintained by: OpenAgentPay maintainer team*
*Last updated: v0.11 sign-up phase*
