/* Get Your SOL Back (DegenCalc) - browser-side wallet tools.
 *
 * What this file does: it builds Solana transactions in your browser and asks
 * YOUR wallet (Phantom, Solflare, Backpack) to approve and sign them. Tools:
 *   - close empty token accounts (rent goes back to you)
 *   - burn tokens you pick, then close the account
 *   - revoke token approvals
 *   - unwrap wrapped SOL
 *   - withdraw idle stake accounts and close leftover program buffers
 *
 * Private keys and seed phrases never leave the wallet. This file never asks
 * for them.
 *
 * Where the money goes: the reclaimed SOL (the account rent) always goes to
 * the connected wallet, MINUS an optional service fee. When the fee is on, it
 * is a percentage of the reclaimed rent only (never your own SOL), sent by a
 * separate transfer instruction to the DegenCalc fee wallet, and it is shown
 * on screen and in your wallet's approval before you sign. The fee wallet
 * address and fee percent come from the server config (/api/solreclaim/config),
 * not from this file. Before sending, this file refuses any transaction that
 * pays SOL to anyone other than your wallet, the fee wallet, or a Jito tip
 * account. You can read the exact checks below, and your wallet shows what
 * you are signing.
 */
(function () {
  'use strict';

  const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111';
  const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
  const CLOSE_ACCOUNT_TAG = 9;
  const BURN_TAG = 8;
  const BURN_CHECKED_TAG = 15;
  const BURN_BATCH_SIZE = 6; // burn + close pairs per transaction
  const REVOKE_TAG = 5;
  const REVOKE_BATCH_SIZE = 8; // revokes per transaction
  const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111';
  const LOADER_UPGRADEABLE_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';
  const CLOCK_SYSVAR_ID = 'SysvarC1ock11111111111111111111111111111111';
  const STAKE_HISTORY_ID = 'SysvarStakeHistory1111111111111111111111111';
  const STAKE_WITHDRAW_TAG = 4; // StakeInstruction::Withdraw(u64)
  const LOADER_CLOSE_TAG = 5; // UpgradeableLoaderInstruction::Close
  const SYSTEM_TRANSFER_TAG = 2;
  const CB_REQUEST_UNITS_DEPRECATED = 1;
  const CB_REQUEST_HEAP_FRAME = 2;
  const CB_SET_COMPUTE_UNIT_LIMIT = 3;
  const CB_SET_COMPUTE_UNIT_PRICE = 4;
  const CB_SET_LOADED_DATA_SIZE = 5;
  const DEFAULT_LIGHTHOUSE = [
    'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
    'L1TEVtgA75k273wWz1s6XMmDhQY5i3MwcvKb4VbZzfK',
  ];
  const BATCH_SIZE = 20;
  const LAMPORTS = 1000000000;

  let provider = null;
  let walletName = '';
  let publicKey = null;
  let scan = null;
  let busy = false;
  let stateRef = null;
  let feeCfg = { feeEnabled: false, feePercent: 0, feeWallet: '', batchSize: BATCH_SIZE, protectedSend: true, tipLamports: 0, tipMaxLamports: 10000, jitoTipAccounts: [], sendPathDefault: 'jito-no-tip', lighthousePrograms: DEFAULT_LIGHTHOUSE.slice(), cuPriceMaxMicroLamports: 5000000, cuLimitMax: 400000 };
  let sessionReclaimed = 0;
  let successTimer = null;
  let completing = false;
  const burnSel = new Set(); // pubkeys the visitor ticked (never pre-selected)
  const revokeSel = new Set(); // approvals the visitor ticked (never pre-selected)
  const unwrapSel = new Set(); // wrapped-SOL accounts the visitor ticked (never pre-selected)
  const stuckSel = new Set(); // idle stake accounts / leftover buffers the visitor ticked (never pre-selected)
  let revokeRun = false; // true while a revoke transaction is being built / sent
  let toolKind = 'reclaim'; // which tool is sending (admin accounting label only)

  function base() {
    try { return JSON.parse(document.getElementById('bootData').textContent).base || ''; }
    catch (e) { return ''; }
  }
  const $ = id => document.getElementById(id);

  function shortAddr(a) {
    a = String(a || '');
    return a.length > 8 ? a.slice(0, 4) + '\u2026' + a.slice(-4) : a;
  }
  function solStr(lamports, digits) {
    return (Number(lamports) / LAMPORTS).toFixed(digits == null ? 6 : digits) + ' SOL';
  }
  function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }
  function phantomBrowseUrl() {
    return 'https://phantom.app/ul/browse/' + encodeURIComponent(window.location.href)
      + '?ref=' + encodeURIComponent(window.location.origin);
  }
  function uint8ToB64(u8) {
    const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function readU32LE(data) {
    return data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  }
  function readU64LE(data, off) {
    let n = 0, f = 1;
    for (let i = 0; i < 8; i++) { n += data[off + i] * f; f *= 256; }
    return n;
  }
  // ---- service fee (Nov 22 2026: admin toggle; OFF unless /api/solreclaim/config says on)
  function feeOn() {
    return !!(feeCfg && feeCfg.feeEnabled && feeCfg.feeWallet && Number(feeCfg.feeBps) > 0);
  }
  function feeMaxFor(lamports) {
    // floor(pct x lamports) with integer basis points, same as the server.
    if (!feeOn()) return 0;
    const l = Math.max(0, Math.floor(Number(lamports) || 0));
    return Math.floor(l * Number(feeCfg.feeBps) / 10000);
  }
  function feeForTx(lamports) {
    const f = feeMaxFor(lamports);
    return f >= (Number(feeCfg.feeMinLamports) || 5000) ? f : 0;
  }
  // Everything that comes back to the wallet: rent plus any wrapped SOL inside (extraLamports).
  function grossOf(list) {
    return list.reduce(function (s, a) { return s + Number(a.lamports || 0) + Number(a.extraLamports || 0); }, 0);
  }
  function chunkLamports(chunk) {
    return chunk.reduce(function (s, a) { return s + Number(a.lamports || 0); }, 0);
  }
  function totalFee(closable, size) {
    if (!feeOn()) return 0;
    size = size || feeCfg.batchSize || BATCH_SIZE;
    let t = 0;
    for (let i = 0; i < closable.length; i += size) t += feeForTx(chunkLamports(closable.slice(i, i + size)));
    return t;
  }
  function pctText() {
    const p = Number(feeCfg.feePercent) || 0;
    return (Math.round(p * 100) / 100) + '%';
  }
  function serviceFeeText(feeLamports) {
    if (!feeOn()) return '0 SOL (off)';
    return pctText() + ' (' + solStr(feeLamports, 6) + ')';
  }
  function closableLamportsMap() {
    const m = {};
    ((scan && scan.closable) || []).forEach(function (a) { m[a.pubkey] = Number(a.lamports || 0); });
    ((scan && scan.burnable) || []).forEach(function (a) { m[a.pubkey] = Number(a.lamports || 0); });
    ((scan && scan.unwrappable) || []).forEach(function (a) { m[a.pubkey] = Number(a.lamports || 0); });
    ((scan && scan.stuck) || []).forEach(function (a) { m[a.pubkey] = Number(a.lamports || 0); });
    return m;
  }

  function tipLabel(lamports) {
    const n = Number(lamports) || 0;
    if (n <= 0) return '0 SOL (not used)';
    return solStr(n, 9) + ' (Jito tip)';
  }

  function detectedWallets() {
    const list = [];
    const seen = new Set();
    function add(name, p) {
      if (!p || seen.has(p)) return;
      seen.add(p);
      list.push({ name: name, provider: p });
    }
    add('Phantom', window.phantom && window.phantom.solana);
    add('Solflare', window.solflare);
    add('Backpack', window.backpack);
    const injected = window.solana;
    if (injected) {
      if (injected.isPhantom) add('Phantom', injected);
      else if (injected.isSolflare) add('Solflare', injected);
      else if (injected.isBackpack) add('Backpack', injected);
      else add('Phantom', injected); // Phantom in-app browser often exposes window.solana
    }
    return list;
  }

  function closeAccountIx(programId, account, destination, owner, item) {
    const web3 = window.solanaWeb3;
    const dest = new web3.PublicKey(destination);
    const own = new web3.PublicKey(owner);
    if (dest.toBase58() !== own.toBase58()) {
      throw new Error('closeAccount destination must be the owner wallet');
    }
    if (programId === STAKE_PROGRAM_ID) {
      // Withdraw the whole balance (reserve + the rest) of an idle stake account to the owner.
      const total = Number((item && item.lamports) || 0) + Number((item && item.extraLamports) || 0);
      if (!(total > 0)) throw new Error('Stake account has nothing to withdraw');
      const wd = new Uint8Array(12);
      wd[0] = STAKE_WITHDRAW_TAG;
      writeU64LE(wd, 4, BigInt(total));
      return new web3.TransactionInstruction({
        programId: new web3.PublicKey(STAKE_PROGRAM_ID),
        keys: [
          { pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
          { pubkey: new web3.PublicKey(CLOCK_SYSVAR_ID), isSigner: false, isWritable: false },
          { pubkey: new web3.PublicKey(STAKE_HISTORY_ID), isSigner: false, isWritable: false },
          { pubkey: own, isSigner: true, isWritable: false },
        ],
        data: wd,
      });
    }
    if (programId === LOADER_UPGRADEABLE_ID) {
      return new web3.TransactionInstruction({
        programId: new web3.PublicKey(LOADER_UPGRADEABLE_ID),
        keys: [
          { pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
          { pubkey: own, isSigner: true, isWritable: false },
        ],
        data: new Uint8Array([LOADER_CLOSE_TAG, 0, 0, 0]),
      });
    }
    return new web3.TransactionInstruction({
      programId: new web3.PublicKey(programId),
      keys: [
        { pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: own, isSigner: true, isWritable: false },
      ],
      data: Uint8Array.of(CLOSE_ACCOUNT_TAG),
    });
  }

  function computeBudgetIxs(n, cuPrice) {
    const C = window.solanaWeb3.ComputeBudgetProgram;
    return [
      C.setComputeUnitLimit({ units: 20000 + 8000 * n }),
      C.setComputeUnitPrice({ microLamports: cuPrice || 10000 }),
    ];
  }

  function buildBatches(owner, closable, blockhash, batchSize, cuPrice) {
    const web3 = window.solanaWeb3;
    const ownerPk = new web3.PublicKey(owner);
    const size = batchSize || BATCH_SIZE;
    const txs = [];
    for (let i = 0; i < closable.length; i += size) {
      const chunk = closable.slice(i, i + size);
      const tx = new web3.Transaction();
      computeBudgetIxs(chunk.length, cuPrice).forEach(ix => tx.add(ix));
      chunk.forEach(acc => tx.add(closeAccountIx(acc.programId, acc.pubkey, ownerPk, ownerPk, acc)));
      // Service fee (only when ON): one transfer to the fee wallet, after the closes,
      // for floor(pct x rent closed in THIS tx). Close destinations stay the owner.
      const fee = feeForTx(chunkLamports(chunk));
      if (fee > 0) {
        tx.add(web3.SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: new web3.PublicKey(feeCfg.feeWallet), lamports: fee }));
      }
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;
      txs.push(tx);
    }
    return txs;
  }

  function writeU64LE(out, off, big) {
    for (let i = 0; i < 8; i++) out[off + i] = Number((big >> BigInt(8 * i)) & BigInt(255));
  }

  // BurnChecked: the owner burns `amount` (raw units, a string) of `mint` from `account`.
  function burnCheckedIx(programId, account, mint, owner, amount, decimals) {
    const web3 = window.solanaWeb3;
    const own = new web3.PublicKey(owner);
    const amt = BigInt(String(amount));
    if (amt <= BigInt(0) || amt >= BigInt('18446744073709551616')) throw new Error('Burn amount is out of range');
    const data = new Uint8Array(10);
    data[0] = BURN_CHECKED_TAG;
    writeU64LE(data, 1, amt);
    data[9] = Number(decimals) & 255;
    return new web3.TransactionInstruction({
      programId: new web3.PublicKey(programId),
      keys: [
        { pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(mint), isSigner: false, isWritable: true },
        { pubkey: own, isSigner: true, isWritable: false },
      ],
      data: data,
    });
  }

  // Revoke: the owner removes the spending approval (delegate) on a token account.
  function revokeIx(programId, account, owner) {
    const web3 = window.solanaWeb3;
    return new web3.TransactionInstruction({
      programId: new web3.PublicKey(programId),
      keys: [
        { pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true },
        { pubkey: new web3.PublicKey(owner), isSigner: true, isWritable: false },
      ],
      data: new Uint8Array([REVOKE_TAG]),
    });
  }

  // Revoking recovers no rent, so there is never a service fee in these transactions.
  function buildRevokeBatches(owner, items, blockhash, batchSize, cuPrice) {
    const web3 = window.solanaWeb3;
    const ownerPk = new web3.PublicKey(owner);
    const size = Math.max(1, Math.min(batchSize || REVOKE_BATCH_SIZE, REVOKE_BATCH_SIZE));
    const C = web3.ComputeBudgetProgram;
    const txs = [];
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      const tx = new web3.Transaction();
      tx.add(C.setComputeUnitLimit({ units: 20000 + 8000 * chunk.length }));
      tx.add(C.setComputeUnitPrice({ microLamports: cuPrice || 10000 }));
      chunk.forEach(function (a) { tx.add(revokeIx(a.programId, a.pubkey, ownerPk)); });
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;
      txs.push(tx);
    }
    return txs;
  }

  // Burn each chosen token account's whole balance, then close it (rent -> the owner).
  function buildBurnBatches(owner, items, blockhash, batchSize, cuPrice) {
    const web3 = window.solanaWeb3;
    const ownerPk = new web3.PublicKey(owner);
    const size = Math.max(1, Math.min(batchSize || BURN_BATCH_SIZE, BURN_BATCH_SIZE));
    const C = web3.ComputeBudgetProgram;
    const txs = [];
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      const tx = new web3.Transaction();
      tx.add(C.setComputeUnitLimit({ units: 20000 + 25000 * chunk.length }));
      tx.add(C.setComputeUnitPrice({ microLamports: cuPrice || 10000 }));
      chunk.forEach(function (a) {
        tx.add(burnCheckedIx(a.programId, a.pubkey, a.mint, ownerPk, a.amount, a.decimals));
        tx.add(closeAccountIx(a.programId, a.pubkey, ownerPk, ownerPk));
      });
      const fee = feeForTx(chunkLamports(chunk));
      if (fee > 0) {
        tx.add(web3.SystemProgram.transfer({ fromPubkey: ownerPk, toPubkey: new web3.PublicKey(feeCfg.feeWallet), lamports: fee }));
      }
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;
      txs.push(tx);
    }
    return txs;
  }

  function pkStr(k) {
    if (!k) return '';
    if (typeof k === 'string') return k;
    if (typeof k.toBase58 === 'function') return k.toBase58();
    return String(k);
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { reject(new Error(message)); }, ms);
      Promise.resolve(promise).then(
        function (v) { clearTimeout(t); resolve(v); },
        function (e) { clearTimeout(t); reject(e); }
      );
    });
  }

  function normalizeTx(signed) {
    const web3 = window.solanaWeb3;
    if (!signed) throw new Error('Wallet did not return a signed transaction');
    if (web3) {
      if (signed instanceof web3.Transaction || signed instanceof web3.VersionedTransaction) return signed;
    }
    if (signed.transaction) return normalizeTx(signed.transaction);
    let bytes = null;
    if (signed instanceof Uint8Array) bytes = signed;
    else if (signed instanceof ArrayBuffer) bytes = new Uint8Array(signed);
    else if (Array.isArray(signed)) bytes = Uint8Array.from(signed);
    else if (typeof signed === 'string') {
      try { bytes = Uint8Array.from(atob(signed), function (c) { return c.charCodeAt(0); }); }
      catch (e) { bytes = null; }
    }
    if (bytes && web3) {
      try { return web3.VersionedTransaction.deserialize(bytes); } catch (e) { /* try legacy */ }
      try { return web3.Transaction.from(bytes); } catch (e) { /* fall through */ }
    }
    return signed;
  }

  function toVersioned(tx) {
    const web3 = window.solanaWeb3;
    if (!web3) return tx;
    if (tx instanceof web3.VersionedTransaction) return tx;
    if (typeof tx.compileMessage === 'function') {
      return new web3.VersionedTransaction(tx.compileMessage());
    }
    return tx;
  }

  function serializeSigned(tx) {
    if (!tx || typeof tx.serialize !== 'function') {
      throw new Error('Wallet returned a transaction that could not be serialized');
    }
    try {
      return tx.serialize();
    } catch (e) {
      try {
        return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      } catch (e2) {
        throw new Error('Could not serialize the signed transaction');
      }
    }
  }

  function lighthouseIds() {
    const list = feeCfg.lighthousePrograms;
    return (list && list.length) ? list : DEFAULT_LIGHTHOUSE;
  }

  function assertSafeIxs(ixs, ownerStr) {
    const tipAccounts = feeCfg.jitoTipAccounts || [];
    const tipMax = Number(feeCfg.tipMaxLamports) || 10000;
    const lighthouse = lighthouseIds();
    const priceMax = Number(feeCfg.cuPriceMaxMicroLamports) || 5000000;
    const limitMax = Number(feeCfg.cuLimitMax) || 400000;
    let closes = 0;
    let tips = 0;
    let fees = 0;
    let feeAmount = 0;
    const closed = [];
    const burned = [];
    const revoked = [];
    const feeWallet = feeOn() ? String(feeCfg.feeWallet) : '';
    (ixs || []).forEach(function (ix) {
      const pid = pkStr(ix.programId);
      const raw = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data || []);
      if (lighthouse.indexOf(pid) !== -1) return;
      if (pid === COMPUTE_BUDGET_ID) {
        if (!raw.length) throw new Error('Empty compute budget instruction');
        const tag = raw[0];
        const n = raw.length;
        if (n >= 9 && (tag === 3 || tag === 4)) {
          const price = readU64LE(raw, 1);
          if (price > priceMax) throw new Error('Compute unit price is too high');
          return;
        }
        if (n >= 9 && tag === 1) {
          const units = raw[1] | (raw[2] << 8) | (raw[3] << 16) | (raw[4] << 24);
          const additional = raw[5] | (raw[6] << 8) | (raw[7] << 16) | (raw[8] << 24);
          if (additional > 0) throw new Error('Compute budget additional fee is not allowed');
          if (units > limitMax) throw new Error('Compute unit limit is too high');
          return;
        }
        if (n >= 5 && (tag === 2 || tag === 3)) {
          const units = raw[1] | (raw[2] << 8) | (raw[3] << 16) | (raw[4] << 24);
          if (units > limitMax) throw new Error('Compute unit limit is too high');
          return;
        }
        if (n >= 5 && (tag === 1 || tag === 4 || tag === 5)) return;
        throw new Error('Unsupported compute budget instruction');
      }
            if (pid === SYSTEM_PROGRAM_ID) {
        if (!raw || raw.length < 12 || readU32LE(raw) !== SYSTEM_TRANSFER_TAG) {
          throw new Error('System instruction is not a transfer');
        }
        if (!ix.keys || ix.keys.length < 2) {
          throw new Error('System transfer is missing accounts');
        }
        const from = pkStr(ix.keys[0].pubkey || ix.keys[0]);
        const to = pkStr(ix.keys[1].pubkey || ix.keys[1]);
        const lamports = readU64LE(raw, 4);
        if (feeWallet && to === feeWallet && tipAccounts.indexOf(to) === -1) {
          if (from !== ownerStr) throw new Error('Service fee must come from the connected wallet');
          fees += 1;
          if (fees > 1) throw new Error('Only one service-fee transfer is allowed');
          if (lamports <= 0) throw new Error('Service fee amount is invalid');
          feeAmount = lamports;
          return;
        }
        if (from !== ownerStr || tipAccounts.indexOf(to) === -1 || lamports <= 0 || lamports > tipMax) {
          throw new Error(feeWallet ? 'System transfer is not allowed: not the site fee wallet or a Jito tip' : 'System transfer is not an allowed Jito tip (the service fee is off)');
        }
        tips += 1;
        if (tips > 1) throw new Error('Only one Jito tip transfer is allowed');
        return;
      }
      if (pid === STAKE_PROGRAM_ID) {
        if (fees) throw new Error('The service fee transfer must come after all account closes');
        if (raw.length !== 12 || readU32LE(raw) !== STAKE_WITHDRAW_TAG) throw new Error('Stake instruction is not a withdraw');
        if (readU64LE(raw, 4) <= 0) throw new Error('Stake withdraw amount must be above zero');
        if (!ix.keys || ix.keys.length !== 5) throw new Error('Unexpected stake withdraw account list');
        if (pkStr(ix.keys[1].pubkey || ix.keys[1]) !== ownerStr) throw new Error('Stake can only be withdrawn to the connected wallet');
        if (pkStr(ix.keys[2].pubkey || ix.keys[2]) !== CLOCK_SYSVAR_ID || pkStr(ix.keys[3].pubkey || ix.keys[3]) !== STAKE_HISTORY_ID) throw new Error('Stake withdraw is missing the clock or stake history account');
        if (pkStr(ix.keys[4].pubkey || ix.keys[4]) !== ownerStr) throw new Error('Stake can only be withdrawn by the connected wallet');
        closed.push(pkStr(ix.keys[0].pubkey || ix.keys[0]));
        closes += 1;
        return;
      }
      if (pid === LOADER_UPGRADEABLE_ID) {
        if (fees) throw new Error('The service fee transfer must come after all account closes');
        if (raw.length !== 4 || readU32LE(raw) !== LOADER_CLOSE_TAG) throw new Error('Loader instruction is not a buffer close');
        if (!ix.keys || ix.keys.length !== 3) throw new Error('Unexpected buffer close account list');
        if (pkStr(ix.keys[1].pubkey || ix.keys[1]) !== ownerStr || pkStr(ix.keys[2].pubkey || ix.keys[2]) !== ownerStr) {
          throw new Error('A buffer can only be closed to, and by, the connected wallet');
        }
        closed.push(pkStr(ix.keys[0].pubkey || ix.keys[0]));
        closes += 1;
        return;
      }
      if (pid !== TOKEN_PROGRAM_ID && pid !== TOKEN_2022_ID) {
        throw new Error('Transaction contains an instruction from ' + pid + ' that is not allowed');
      }
      if (fees) throw new Error('The service fee transfer must come after all account closes');
      if (raw.length && (raw[0] === BURN_CHECKED_TAG || raw[0] === BURN_TAG)) {
        if (raw.length !== (raw[0] === BURN_TAG ? 9 : 10)) throw new Error('Burn instruction has the wrong size');
        if (readU64LE(raw, 1) <= 0) throw new Error('Burn amount must be above zero');
        if (!ix.keys || ix.keys.length !== 3) throw new Error('Unexpected burn account list');
        if (pkStr(ix.keys[2].pubkey || ix.keys[2]) !== ownerStr) throw new Error('Tokens can only be burned by the connected wallet');
        const bacct = pkStr(ix.keys[0].pubkey || ix.keys[0]);
        if (closed.indexOf(bacct) !== -1 || burned.indexOf(bacct) !== -1) throw new Error('A burn must come before its account is closed, once per account');
        burned.push(bacct);
        return;
      }
      if (raw.length && raw[0] === REVOKE_TAG) {
        if (raw.length !== 1) throw new Error('Revoke instruction has the wrong size');
        if (!ix.keys || ix.keys.length !== 2) throw new Error('Multisig revoke is not allowed');
        if (pkStr(ix.keys[1].pubkey || ix.keys[1]) !== ownerStr) throw new Error('Approvals can only be revoked by the connected wallet');
        const racct = pkStr(ix.keys[0].pubkey || ix.keys[0]);
        if (revoked.indexOf(racct) !== -1 || closed.indexOf(racct) !== -1) throw new Error('A revoke must come first, once per account');
        revoked.push(racct);
        return;
      }
      if (!raw.length || raw[0] !== CLOSE_ACCOUNT_TAG) {
        throw new Error('Token instruction is not closeAccount, burn or revoke');
      }
      if (!ix.keys || ix.keys.length !== 3) {
        throw new Error('Unexpected closeAccount account list');
      }
      const dest = pkStr(ix.keys[1].pubkey || ix.keys[1]);
      const own = pkStr(ix.keys[2].pubkey || ix.keys[2]);
      if (dest !== ownerStr || own !== ownerStr) {
        throw new Error('closeAccount destination must be the connected wallet');
      }
      closed.push(pkStr(ix.keys[0].pubkey || ix.keys[0]));
      closes += 1;
    });
    if (!closes && !revoked.length) throw new Error('Transaction has no closeAccount instruction');
    if (!closes && fees) throw new Error('A service fee is only allowed when accounts are closed');
    burned.forEach(function (a) {
      if (closed.indexOf(a) === -1) throw new Error('Tokens may only be burned on an account that is closed in the same transaction');
    });
    if (fees) {
      const m = closableLamportsMap();
      const reclaimed = closed.reduce(function (s, k) { return s + (m[k] || 0); }, 0);
      if (feeAmount > feeMaxFor(reclaimed)) {
        throw new Error('Service fee is more than ' + pctText() + ' of the rent being reclaimed');
      }
    }
    return closes;
  }

  function assertSafeMessage(msg, ownerStr) {
    const keys = (msg && (msg.staticAccountKeys || msg.accountKeys)) || [];
    if (!keys.length) throw new Error('Transaction has no account keys');
    if (pkStr(keys[0]) !== ownerStr) throw new Error('Fee payer must be the connected wallet');
    const compiled = msg.compiledInstructions || msg.instructions || [];
    const ixs = compiled.map(function (ix) {
      const accIdx = ix.accountKeyIndexes || ix.accounts || [];
      return {
        programId: keys[ix.programIdIndex],
        keys: accIdx.map(function (i) { return { pubkey: keys[i] }; }),
        data: ix.data,
      };
    });
    return assertSafeIxs(ixs, ownerStr);
  }

  function assertSafeTransaction(tx, owner) {
    tx = normalizeTx(tx);
    const ownerStr = String(owner);
    if (tx && tx.instructions && tx.feePayer) {
      if (pkStr(tx.feePayer) !== ownerStr) throw new Error('Fee payer must be the connected wallet');
      return assertSafeIxs(tx.instructions, ownerStr);
    }
    if (tx && tx.message) {
      return assertSafeMessage(tx.message, ownerStr);
    }
    throw new Error('Wallet returned a transaction that could not be checked');
  }

  async function rpc(method, params) {
    const res = await fetch(base() + '/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: method, params: params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'RPC error');
    return body.result;
  }

  async function loadConfig() {
    try {
      const res = await fetch(base() + '/api/solreclaim/config');
      if (res.ok) feeCfg = await res.json();
    } catch (e) { /* keep fee-off defaults */ }
  }

  async function scanWallet(address) {
    const res = await fetch(base() + '/api/solreclaim/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: address }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Scan failed');
    return body;
  }

  function setStatus(text, show) {
    const el = $('solReclaimStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !show || !text);
  }

  function renderPreview() {
    const box = $('solReclaimPreview');
    if (!box) return;
    if (!scan || !publicKey) {
      box.classList.add('hidden');
      renderBurn();
      renderRevoke();
      renderUnwrap();
      renderStuck();
      return;
    }
    const closable = scan.closable || [];
    $('solReclaimCount').textContent = String(closable.length);
    $('solReclaimTotal').textContent = solStr(scan.closable_lamports || 0);
    const svcFee = totalFee(closable);
    $('solReclaimServiceFee').textContent = serviceFeeText(svcFee);
    if ($('solReclaimNet')) $('solReclaimNet').textContent = solStr(Math.max(0, (scan.closable_lamports || 0) - svcFee)) + ' (before network fees)';
    if ($('solReclaimFeeNote')) {
      $('solReclaimFeeNote').textContent = feeOn()
        ? 'Service fee: ' + pctText() + ' (' + solStr(svcFee, 6) + ') of the rent being reclaimed, sent to the DegenCalc fee wallet ' + shortAddr(feeCfg.feeWallet) + '. You receive: ' + solStr(Math.max(0, (scan.closable_lamports || 0) - svcFee)) + '. It is a separate line in your wallet approval.'
        : '';
      $('solReclaimFeeNote').classList.toggle('hidden', !feeOn());
    }
    if ($('solReclaimTip')) $('solReclaimTip').textContent = tipLabel(feeCfg.tipLamports);
    const skipped = scan.skipped || {};
    const labels = {
      nonzero_balance: 'still holding tokens',
      frozen: 'frozen',
      withheld_transfer_fees: 'not closable yet',
      confidential_transfer: 'not closable yet',
      close_authority: 'not closable by this wallet',
      not_owner: 'not owned by this wallet',
      paused: 'paused',
      unparsed: 'unreadable',
      unknown_program: 'unsupported',
    };
    const parts = Object.keys(skipped).filter(k => skipped[k]).map(k => skipped[k] + ' ' + (labels[k] || k));
    const skipEl = $('solReclaimSkipped');
    if (parts.length) {
      skipEl.textContent = 'Skipped ' + parts.join(', ') + ((scan.burnable && scan.burnable.length) ? '. Tokens you still hold can be burned in the section below, only if you choose.' : '.');
      skipEl.classList.remove('hidden');
    } else {
      skipEl.classList.add('hidden');
    }
    const list = $('solReclaimList');
    list.textContent = '';
    closable.slice(0, 50).forEach(a => {
      const li = document.createElement('li');
      li.textContent = shortAddr(a.pubkey) + ' \u00b7 ' + solStr(a.lamports, 6);
      list.appendChild(li);
    });
    if (closable.length > 50) {
      const li = document.createElement('li');
      li.textContent = '\u2026and ' + (closable.length - 50) + ' more';
      list.appendChild(li);
    }
    $('solReclaimRunBtn').disabled = closable.length === 0 || busy;
    box.classList.remove('hidden');
    renderBurn();
      renderRevoke();
      renderUnwrap();
      renderStuck();
    estimateNetworkFee();
  }

  // ---------------- coin burner (opt-in) ----------------
  function burnItems() { return (scan && scan.burnable) || []; }
  function selectedBurn() { return burnItems().filter(function (a) { return burnSel.has(a.pubkey); }); }
  function burnName(a) {
    const base = a.symbol || a.name || shortAddr(a.mint);
    return a.nft_like ? base + ' (NFT / whole-unit token)' : base;
  }
  function burnValueText(a) {
    if (a.value === 'has_value') return a.usd != null ? 'worth about $' + Number(a.usd).toFixed(2) : 'has a market price';
    if (a.value === 'low') return 'about $' + Number(a.usd || 0).toFixed(2);
    if (a.value === 'none') return 'no market found';
    return 'value unknown, check first';
  }
  function needsCare(a) { return a.value === 'has_value' || a.value === 'unknown' || !!a.nft_like; }

  function updateBurnSummary() {
    const sel = selectedBurn();
    const lam = chunkLamports(sel);
    const fee = totalFee(sel, BURN_BATCH_SIZE);
    const set = function (id, v) { const el = $(id); if (el) el.textContent = v; };
    set('solBurnSelCount', String(sel.length));
    set('solBurnRent', solStr(lam));
    set('solBurnFee', serviceFeeText(fee));
    set('solBurnNet', solStr(Math.max(0, lam - fee)) + ' (before network fees)');
    const care = sel.filter(needsCare);
    const warn = $('solBurnValueWarn');
    if (warn) {
      if (care.length) {
        warn.textContent = care.length + ' of the selected tokens have a market value, could not be checked, or may be NFTs. Burning destroys them for good. Untick any you want to keep.';
        warn.classList.remove('hidden');
      } else {
        warn.classList.add('hidden');
      }
    }
    const btn = $('solBurnRunBtn');
    if (btn) btn.disabled = busy || !sel.length || !publicKey;
    const rows = document.querySelectorAll('#solBurnList input[type=checkbox]');
    rows.forEach(function (cb) { cb.checked = burnSel.has(cb.getAttribute('data-k')); });
  }

  // ---------------- unwrap wrapped SOL (opt-in) ----------------
  function unwrapItems() { return (scan && scan.unwrappable) || []; }
  function selectedUnwrap() { return unwrapItems().filter(function (a) { return unwrapSel.has(a.pubkey); }); }
  function updateUnwrapSummary() {
    const sel = selectedUnwrap();
    const gross = grossOf(sel);
    const fee = totalFee(sel, feeCfg.batchSize || BATCH_SIZE);
    const set = function (id, v) { const el = $(id); if (el) el.textContent = v; };
    set('solUnwrapSelCount', String(sel.length));
    set('solUnwrapGross', solStr(gross));
    set('solUnwrapFee', serviceFeeText(fee));
    set('solUnwrapNet', solStr(Math.max(0, gross - fee)) + ' (before network fees)');
    const btn = $('solUnwrapRunBtn');
    if (btn) btn.disabled = busy || !sel.length || !publicKey;
    document.querySelectorAll('#solUnwrapList input[type=checkbox]').forEach(function (cb) {
      cb.checked = unwrapSel.has(cb.getAttribute('data-k'));
    });
  }
  function renderUnwrap() {
    const panel = $('solUnwrapPanel');
    if (!panel) return;
    const items = unwrapItems();
    if (!scan || !publicKey || !items.length) {
      panel.classList.add('hidden');
      unwrapSel.clear();
      return;
    }
    Array.from(unwrapSel).forEach(function (k) { if (!items.some(function (a) { return a.pubkey === k; })) unwrapSel.delete(k); });
    const total = Number(scan.unwrappable_total || items.length);
    $('solUnwrapTotal').textContent = total + ' account' + (total === 1 ? '' : 's') + (total > items.length ? ' (showing ' + items.length + ')' : '');
    const list = $('solUnwrapList');
    list.textContent = '';
    items.forEach(function (a) {
      const li = document.createElement('li');
      li.className = 'solburn-row';
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-k', a.pubkey);
      cb.addEventListener('change', function () {
        if (cb.checked) unwrapSel.add(a.pubkey); else unwrapSel.delete(a.pubkey);
        updateUnwrapSummary();
      });
      const name = document.createElement('span');
      name.className = 'solburn-name';
      name.textContent = 'Wrapped SOL';
      const amt = document.createElement('span');
      amt.className = 'solburn-amt';
      amt.textContent = solStr(Number(a.extraLamports || 0)) + ' + ' + solStr(Number(a.lamports || 0)) + ' rent';
      label.appendChild(cb); label.appendChild(name); label.appendChild(amt);
      li.appendChild(label);
      list.appendChild(li);
    });
    panel.classList.remove('hidden');
    updateUnwrapSummary();
  }

  // ---------------- stuck SOL: idle stake accounts and leftover buffers (opt-in) ----------------
  function stuckItems() { return (scan && scan.stuck) || []; }
  function selectedStuck() { return stuckItems().filter(function (a) { return stuckSel.has(a.pubkey); }); }
  function updateStuckSummary() {
    const sel = selectedStuck();
    const gross = grossOf(sel);
    const fee = totalFee(sel, feeCfg.batchSize || BATCH_SIZE);
    const set = function (id, v) { const el = $(id); if (el) el.textContent = v; };
    set('solStuckSelCount', String(sel.length));
    set('solStuckGross', solStr(gross));
    set('solStuckFee', serviceFeeText(fee));
    set('solStuckNet', solStr(Math.max(0, gross - fee)) + ' (before network fees)');
    const btn = $('solStuckRunBtn');
    if (btn) btn.disabled = busy || !sel.length || !publicKey;
    document.querySelectorAll('#solStuckList input[type=checkbox]').forEach(function (cb) {
      cb.checked = stuckSel.has(cb.getAttribute('data-k'));
    });
  }
  function renderStuck() {
    const panel = $('solStuckPanel');
    if (!panel) return;
    const items = stuckItems();
    if (!scan || !publicKey || !items.length) {
      panel.classList.add('hidden');
      stuckSel.clear();
      return;
    }
    Array.from(stuckSel).forEach(function (k) { if (!items.some(function (a) { return a.pubkey === k; })) stuckSel.delete(k); });
    const total = Number(scan.stuck_total || items.length);
    $('solStuckTotal').textContent = total + ' account' + (total === 1 ? '' : 's') + (total > items.length ? ' (showing ' + items.length + ')' : '');
    const list = $('solStuckList');
    list.textContent = '';
    items.forEach(function (a) {
      const li = document.createElement('li');
      li.className = 'solburn-row';
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-k', a.pubkey);
      cb.addEventListener('change', function () {
        if (cb.checked) stuckSel.add(a.pubkey); else stuckSel.delete(a.pubkey);
        updateStuckSummary();
      });
      const name = document.createElement('span');
      name.className = 'solburn-name';
      name.textContent = (a.kind === 'buffer' ? 'Leftover program buffer ' : 'Idle stake account ') + shortAddr(a.pubkey);
      const amt = document.createElement('span');
      amt.className = 'solburn-amt';
      amt.textContent = a.kind === 'buffer'
        ? solStr(Number(a.lamports || 0)) + ' rent'
        : solStr(Number(a.extraLamports || 0)) + ' + ' + solStr(Number(a.lamports || 0)) + ' rent';
      label.appendChild(cb); label.appendChild(name); label.appendChild(amt);
      li.appendChild(label);
      list.appendChild(li);
    });
    panel.classList.remove('hidden');
    updateStuckSummary();
  }

  // ---------------- approval revoker (opt-in, free) ----------------
  function revokeItems() { return (scan && scan.revocable) || []; }
  function selectedRevoke() { return revokeItems().filter(function (a) { return revokeSel.has(a.pubkey); }); }
  function revokeName(a) { return a.symbol || a.name || shortAddr(a.mint); }
  function updateRevokeSummary() {
    const sel = selectedRevoke();
    const el = $('solRevokeSelCount');
    if (el) el.textContent = String(sel.length);
    const btn = $('solRevokeRunBtn');
    if (btn) btn.disabled = busy || !sel.length || !publicKey;
    document.querySelectorAll('#solRevokeList input[type=checkbox]').forEach(function (cb) {
      cb.checked = revokeSel.has(cb.getAttribute('data-k'));
    });
  }
  function renderRevoke() {
    const panel = $('solRevokePanel');
    if (!panel) return;
    const items = revokeItems();
    if (!scan || !publicKey || !items.length) {
      panel.classList.add('hidden');
      revokeSel.clear();
      return;
    }
    Array.from(revokeSel).forEach(function (k) { if (!items.some(function (a) { return a.pubkey === k; })) revokeSel.delete(k); });
    const total = Number(scan.revocable_total || items.length);
    $('solRevokeTotal').textContent = total + ' approval' + (total === 1 ? '' : 's') + (total > items.length ? ' (showing ' + items.length + ')' : '');
    const list = $('solRevokeList');
    list.textContent = '';
    items.forEach(function (a) {
      const li = document.createElement('li');
      li.className = 'solburn-row';
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-k', a.pubkey);
      cb.addEventListener('change', function () {
        if (cb.checked) revokeSel.add(a.pubkey); else revokeSel.delete(a.pubkey);
        updateRevokeSummary();
      });
      const name = document.createElement('span');
      name.className = 'solburn-name';
      name.textContent = revokeName(a);
      const amt = document.createElement('span');
      amt.className = 'solburn-amt';
      amt.textContent = 'can spend up to ' + String(a.uiAmount || a.amount);
      const who = document.createElement('span');
      who.className = 'solburn-val';
      who.textContent = 'approved: ' + shortAddr(a.delegate);
      label.appendChild(cb); label.appendChild(name); label.appendChild(amt); label.appendChild(who);
      li.appendChild(label);
      const link = document.createElement('a');
      link.href = 'https://solscan.io/account/' + encodeURIComponent(a.delegate);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'who is this';
      link.className = 'solburn-link';
      li.appendChild(link);
      list.appendChild(li);
    });
    panel.classList.remove('hidden');
    updateRevokeSummary();
  }

  function renderBurn() {
    const panel = $('solBurnPanel');
    if (!panel) return;
    const items = burnItems();
    if (!scan || !publicKey || !items.length) {
      panel.classList.add('hidden');
      burnSel.clear();
      return;
    }
    Array.from(burnSel).forEach(function (k) { if (!items.some(function (a) { return a.pubkey === k; })) burnSel.delete(k); });
    const total = Number(scan.burnable_total || items.length);
    $('solBurnTotal').textContent = total + ' token account' + (total === 1 ? '' : 's') + (total > items.length ? ' (showing ' + items.length + ')' : '');
    const list = $('solBurnList');
    list.textContent = '';
    items.forEach(function (a) {
      const li = document.createElement('li');
      li.className = 'solburn-row solburn-' + (a.value || 'unknown') + (a.nft_like ? ' solburn-nft' : '');
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.setAttribute('data-k', a.pubkey);
      cb.addEventListener('change', function () {
        if (cb.checked) burnSel.add(a.pubkey); else burnSel.delete(a.pubkey);
        updateBurnSummary();
      });
      const name = document.createElement('span');
      name.className = 'solburn-name';
      name.textContent = burnName(a);
      const amt = document.createElement('span');
      amt.className = 'solburn-amt';
      amt.textContent = String(a.uiAmount || a.amount);
      const val = document.createElement('span');
      val.className = 'solburn-val';
      val.textContent = burnValueText(a);
      label.appendChild(cb); label.appendChild(name); label.appendChild(amt); label.appendChild(val);
      li.appendChild(label);
      const link = document.createElement('a');
      link.href = 'https://solscan.io/token/' + encodeURIComponent(a.mint);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'view';
      link.className = 'solburn-link';
      li.appendChild(link);
      list.appendChild(li);
    });
    panel.classList.remove('hidden');
    updateBurnSummary();
  }


  async function estimateNetworkFee() {
    const el = $('solReclaimNetworkFee');
    if (!el || !scan || !publicKey || !window.solanaWeb3) return;
    const closable = scan.closable || [];
    const n = Math.ceil((closable.length || 0) / (feeCfg.batchSize || BATCH_SIZE));
    if (!closable.length) { el.textContent = '0 SOL'; return; }
    try {
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const blockhash = latest.value ? latest.value.blockhash : latest.blockhash;
      txs = buildBatches(publicKey, closable, blockhash, feeCfg.batchSize || BATCH_SIZE, 10000);
      let total = 0;
      for (let i = 0; i < txs.length; i++) {
        assertSafeTransaction(txs[i], publicKey);
        const msg = txs[i].compileMessage();
        const fee = await rpc('getFeeForMessage', [uint8ToB64(msg.serialize()), { commitment: 'confirmed' }]);
        const v = fee && (fee.value != null ? fee.value : fee);
        total += typeof v === 'number' ? v : 5000;
      }
      el.textContent = solStr(total, 6) + ' (' + txs.length + ' transaction' + (txs.length === 1 ? '' : 's') + ')';
    } catch (e) {
      el.textContent = 'about ' + solStr(n * 5000, 6);
    }
  }

  async function connectNamed(item) {
    const p = item.provider;
    const resp = await p.connect();
    const pk = (resp && resp.publicKey) || p.publicKey;
    if (!pk) throw new Error('Wallet did not return an address');
    provider = p;
    walletName = item.name;
    publicKey = typeof pk === 'string' ? pk : pk.toString();
    $('solReclaimWalletLabel').textContent = item.name + ' \u00b7 ' + shortAddr(publicKey);
    $('solReclaimWalletLabel').classList.remove('hidden');
    $('solReclaimDisconnectBtn').classList.remove('hidden');
    $('solReclaimPicker').classList.add('hidden');
    $('solReclaimConnectBtn').textContent = 'Connected';
    const input = $('field-address');
    if (input) input.value = publicKey;
    if (stateRef && stateRef.values) stateRef.values.address = publicKey;
    setStatus('Scanning empty token accounts for the connected wallet\u2026', true);
    scan = await scanWallet(publicKey);
    setStatus('', false);
    renderPreview();
    const btn = $('runActionBtn');
    if (btn) btn.click();
  }

  function showPicker() {
    const wallets = detectedWallets();
    const open = $('solReclaimOpenPhantom');
    if (open) {
      open.href = phantomBrowseUrl();
      open.classList.toggle('hidden', !(isMobile() && wallets.length === 0));
    }
    if (wallets.length === 1) {
      connectNamed(wallets[0]).catch(err => setStatus(friendlyError(err), true));
      return;
    }
    if (!wallets.length) {
      setStatus('No Solana wallet was found in this browser. On a phone, use Open in Phantom. On a computer, install Phantom, Solflare, or Backpack, then come back.', true);
      return;
    }
    const picker = $('solReclaimPicker');
    picker.textContent = '';
    wallets.forEach(w => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'px-3 py-2 rounded-lg border border-slate-700 bg-elevated text-xs text-slate-200 hover:text-white text-left';
      btn.textContent = w.name;
      btn.addEventListener('click', () => connectNamed(w).catch(err => setStatus(friendlyError(err), true)));
      picker.appendChild(btn);
    });
    picker.classList.remove('hidden');
  }

  function friendlyError(err) {
    const msg = (err && err.message) ? String(err.message) : String(err || 'Something went wrong');
    if (/user rejected|denied|cancelled|canceled/i.test(msg)) return 'Request was rejected in the wallet. Nothing was sent.';
    if (/InsufficientFundsForRent/i.test(msg)) {
      if (/account_index\W+0\b/i.test(msg)) {
        return 'Your wallet needs a little more SOL to pay the network fee and still keep its minimum balance. Add about 0.002 SOL to the connected wallet and try again. Nothing was sent.';
      }
      return 'Solana refused the transaction because an account it pays into would be left below the minimum balance. Nothing was sent. Please try again later or contact us.';
    }
    if (/BlockhashNotFound|blockhash not found/i.test(msg)) {
      return 'The request took too long and the network let it expire. Nothing was sent. Please close this window and press the button again.';
    }
    if (/InsufficientFundsForFee|insufficient (funds|lamports)|attempt to debit/i.test(msg)) {
      return 'Your wallet does not have enough SOL to pay the network fee. Add about 0.002 SOL and try again. Nothing was sent.';
    }
    return msg;
  }

  function showSigs(sigs) {
    const ul = $('solReclaimSigs');
    if (!ul) return;
    ul.textContent = '';
    sigs.forEach(s => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'text-accent hover:underline break-all';
      a.href = 'https://solscan.io/tx/' + encodeURIComponent(s);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Solscan: ' + shortAddr(s);
      li.appendChild(a);
      ul.appendChild(li);
    });
    ul.classList.remove('hidden');
  }

  async function confirmSigs(sigs, raws) {
    const results = (sigs || []).map(function () { return { status: 'pending', err: null }; });
    if (!results.length) return results;
    for (let n = 0; n < 30; n++) {
      const st = await rpc('getSignatureStatuses', [sigs, { searchTransactionHistory: true }]);
      const value = st.value || [];
      value.forEach(function (v, i) {
        if (!v) return;
        if (v.err) {
          results[i].status = 'failed';
          results[i].err = v.err;
        } else if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') {
          results[i].status = 'ok';
        }
      });
      if (results.every(function (r) { return r.status !== 'pending'; })) return results;
      // The private route can accept a transaction and still never land it. After ~10s and ~30s,
      // send the same signed bytes again through the normal network (same signature, so it
      // can only land once). Errors such as already-processed are harmless.
      if (raws && (n === 5 || n === 15)) {
        for (let k = 0; k < sigs.length; k++) {
          if (results[k].status === 'pending' && raws[k]) {
            try { await fetch(base() + '/api/solreclaim/rebroadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transaction: raws[k] }) }); } catch (e) { /* ignore */ }
          }
        }
      }
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
    results.forEach(function (r) { if (r.status === 'pending') r.status = 'unknown'; });
    return results;
  }


  function setHidden(el, hidden) {
    if (!el) return;
    el.hidden = !!hidden;
    el.classList.toggle('hidden', !!hidden);
  }

  function clearSuccessTimer() {
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  }

  function resetModalChrome() {
    clearSuccessTimer();
    setHidden($('solReclaimModalConfirmBody'), false);
    setHidden($('solReclaimModalSuccess'), true);
    const icon = $('solReclaimModalSuccessIcon');
    if (icon) { icon.classList.remove('is-partial'); icon.textContent = '\u2713'; }
    const retry = $('solReclaimModalRetry');
    if (retry) { setHidden(retry, true); retry.onclick = null; }
    const done = $('solReclaimModalDone');
    if (done) { done.onclick = null; done.textContent = 'Done'; }
    const cancelBtn = $('solReclaimModalCancel');
    if (cancelBtn) { cancelBtn.textContent = 'Cancel'; cancelBtn.disabled = false; cancelBtn.onclick = null; }
    const confirmBtn = $('solReclaimModalConfirm');
    if (confirmBtn) confirmBtn.disabled = true;
    const box = $('solReclaimModalUnderstand');
    if (box) { box.checked = false; box.disabled = false; }
    const sigsBox = $('solReclaimModalSuccessSigs');
    if (sigsBox) sigsBox.textContent = '';
    const hint = $('solReclaimModalSuccessHint');
    if (hint) hint.textContent = '';
  }

  function closeConfirmModal() {
    clearSuccessTimer();
    const modal = $('solReclaimModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.hidden = true;
    const box = $('solReclaimModalProgress');
    if (box) { box.textContent = ''; box.classList.add('hidden'); box.hidden = true; }
    resetModalChrome();
  }

  function setModalProgress(lines) {
    const box = $('solReclaimModalProgress');
    if (!box) return;
    box.textContent = '';
    (lines || []).forEach(item => {
      const li = document.createElement('li');
      const text = typeof item === 'string' ? item : (item && item.text) || '';
      li.textContent = text;
      if (item && item.err) li.className = 'err';
      box.appendChild(li);
    });
    const show = (lines || []).length > 0;
    box.classList.toggle('hidden', !show);
    box.hidden = !show;
  }

  function fillConfirmModal(summary) {
    const setTxt = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setTxt('solReclaimModalWallet', summary.wallet);
    setTxt('solReclaimModalCount', String(summary.count));
    setTxt('solReclaimModalReturn', summary.returnText);
    setTxt('solReclaimModalNetworkFee', summary.networkFeeText);
    setTxt('solReclaimModalTip', tipLabel(summary.tipLamports));
    const svc = Number(summary.serviceFeeLamports) || 0;
    setTxt('solReclaimModalServiceFee', summary.feeOn ? serviceFeeText(svc) : '0 SOL');
    setTxt('solReclaimModalNet', summary.netText || summary.returnText);
    const note = $('solReclaimModalNote');
    const mtitle = $('solReclaimModalTitle');
    if (mtitle) mtitle.textContent = summary.stuck ? 'Confirm reclaiming stuck SOL' : summary.unwrap ? 'Confirm unwrapping SOL' : summary.revoke ? 'Confirm removing approvals' : summary.burn ? 'Confirm burning tokens' : 'Confirm closing empty accounts';
    if (note && summary.stuck) {
      note.textContent = 'This closes ' + summary.stuck.count + ' idle stake account' + (summary.stuck.count === 1 ? '' : 's') + ' or leftover program buffer' + (summary.stuck.count === 1 ? '' : 's')
        + ' that you control: all of their SOL goes back to this wallet.'
        + (summary.feeOn && svc > 0 ? ' Service fee: ' + pctText() + ' (' + solStr(svc, 6) + ') of the account rent only, never of your own staked or idle SOL, to the DegenCalc fee wallet ' + shortAddr(feeCfg.feeWallet) + '.' : ' No service fee.')
        + ' Nothing else leaves your wallet except network fees.';
    } else if (note && summary.unwrap) {
      note.textContent = 'This unwraps ' + summary.unwrap.count + ' wrapped-SOL account' + (summary.unwrap.count === 1 ? '' : 's') + ': the SOL inside plus the account rent goes back to this wallet as normal SOL.'
        + (summary.feeOn && svc > 0 ? ' Service fee: ' + pctText() + ' (' + solStr(svc, 6) + ') of the rent only, never of your own SOL, to the DegenCalc fee wallet ' + shortAddr(feeCfg.feeWallet) + '.' : ' No service fee.')
        + ' Nothing else leaves your wallet except network fees.';
    } else if (note && summary.revoke) {
      note.textContent = 'This removes the spending approval on ' + summary.revoke.count + ' token account' + (summary.revoke.count === 1 ? '' : 's') + '. Your tokens stay in your wallet and nothing is sent anywhere. There is no DegenCalc fee. Only network fees leave your wallet.';
    } else if (note && summary.burn) {
      note.textContent = 'PERMANENT: this burns the ' + summary.burn.count + ' token' + (summary.burn.count === 1 ? '' : 's') + ' you selected (it cannot be undone), then closes their accounts and sends the rent to this wallet.'
        + (summary.burn.care ? ' ' + summary.burn.care + ' of them may have value or could not be checked.' : '')
        + (summary.feeOn && svc > 0 ? ' Service fee: ' + pctText() + ' (' + solStr(svc, 6) + ') of the rent, to the DegenCalc fee wallet ' + shortAddr(feeCfg.feeWallet) + '.' : '')
        + ' Nothing else leaves your wallet except network fees.';
    } else if (note) {
      if (summary.feeOn && svc > 0) {
        note.textContent = 'Service fee: ' + pctText() + ' (' + solStr(svc, 6) + '). You receive: ' + (summary.netText || '') + '. Only closes empty token accounts. Nothing else leaves your wallet except network fees'
          + ((Number(summary.tipLamports) || 0) > 0 ? ' and the protection tip shown above.' : '.')
          + ' The fee goes to the DegenCalc fee wallet ' + shortAddr(feeCfg.feeWallet) + '.';
      } else {
        note.textContent = (Number(summary.tipLamports) || 0) > 0
          ? 'Only closes empty token accounts. Nothing leaves your wallet except network fees and the protection tip shown above.'
          : 'Only closes empty token accounts. Nothing leaves your wallet except network fees.';
      }
    }
  }

  function openConfirmModal(summary) {
    return new Promise(resolve => {
      const modal = $('solReclaimModal');
      const confirmBtn = $('solReclaimModalConfirm');
      const cancelBtn = $('solReclaimModalCancel');
      const box = $('solReclaimModalUnderstand');
      const backdrop = $('solReclaimModalBackdrop');
      if (!modal || !confirmBtn || !cancelBtn || !box) {
        resolve(false);
        return;
      }
      resetModalChrome();
      fillConfirmModal(summary);
      box.checked = false;
      box.disabled = false;
      confirmBtn.disabled = true;
      cancelBtn.disabled = false;
      setModalProgress([]);
      let settled = false;
      function finish(ok) {
        if (settled) return;
        settled = true;
        box.onchange = null;
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        if (backdrop) backdrop.onclick = null;
        document.removeEventListener('keydown', onKey);
        if (!ok) closeConfirmModal();
        else {
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          box.disabled = true;
        }
        resolve(ok);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') finish(false);
      }
      box.onchange = function () { confirmBtn.disabled = !box.checked; };
      confirmBtn.onclick = function () { if (box.checked) finish(true); };
      cancelBtn.onclick = function () { finish(false); };
      if (backdrop) backdrop.onclick = function () { finish(false); };
      document.addEventListener('keydown', onKey);
      modal.hidden = false;
      modal.classList.remove('hidden');
    });
  }

  async function sendSigned(txB64) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
    let res;
    try {
      res = await fetch(base() + '/api/solreclaim/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction: txB64, tool: toolKind }),
        signal: ctrl ? ctrl.signal : undefined,
      });
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && (e.name === 'AbortError' || /aborted/i.test(String(e)))) {
        throw new Error('Sending timed out. The transaction may or may not have landed — check the Solscan link or your wallet activity before retrying.');
      }
      throw e;
    }
    if (timer) clearTimeout(timer);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Send failed');
    if (!body.signature) throw new Error('Send did not return a signature');
    return body;
  }

  async function signOne(tx) {
    if (typeof provider.signTransaction !== 'function') {
      throw new Error('This wallet cannot sign a transaction from the site');
    }
    let toSign = tx;
    try { toSign = toVersioned(tx); } catch (e) { toSign = tx; }
    const hangMsg = 'The wallet did not return the signed transaction. If you already approved it, this site did not send it. Check Phantom Recent Activity, then try again.';
    try {
      const signed = await withTimeout(provider.signTransaction(toSign), 180000, hangMsg);
      return normalizeTx(signed);
    } catch (e) {
      // Some wallets reject a VersionedTransaction and only accept a legacy one.
      const msg = (e && e.message) ? String(e.message) : String(e || '');
      if (toSign !== tx && !/did not return the signed transaction/i.test(msg)) {
        const signed = await withTimeout(provider.signTransaction(tx), 180000, hangMsg);
        return normalizeTx(signed);
      }
      throw e;
    }
  }

  function failModal(message) {
    setModalProgress([{ text: message, err: true }]);
    setStatus(message, true);
    const cancelBtn = $('solReclaimModalCancel');
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Close';
      cancelBtn.onclick = function () { closeConfirmModal(); };
    }
    const confirmBtn = $('solReclaimModalConfirm');
    if (confirmBtn) confirmBtn.disabled = true;
  }

  function addModalSigLinks(sigs) {
    const box = $('solReclaimModalProgress');
    if (!box) return;
    (sigs || []).forEach(function (s) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'text-accent hover:underline break-all';
      a.href = 'https://solscan.io/tx/' + encodeURIComponent(s);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Solscan: ' + shortAddr(s);
      li.appendChild(a);
      box.appendChild(li);
    });
    box.classList.remove('hidden');
    box.hidden = false;
  }

  function fillSuccessSigs(sigs) {
    const box = $('solReclaimModalSuccessSigs');
    if (!box) return;
    box.textContent = '';
    (sigs || []).forEach(function (s) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'text-accent hover:underline break-all';
      a.href = 'https://solscan.io/tx/' + encodeURIComponent(s);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = 'Solscan: ' + shortAddr(s);
      li.appendChild(a);
      box.appendChild(li);
    });
  }

  function showSessionBanner() {
    const banner = $('solReclaimBanner');
    const text = $('solReclaimBannerText');
    if (!banner || !text) return;
    if (sessionReclaimed <= 0) {
      setHidden(banner, true);
      return;
    }
    text.textContent = 'This session: ' + solStr(sessionReclaimed) + ' reclaimed. Transaction completed.';
    setHidden(banner, false);
  }

  async function refreshAfterClose() {
    if (!publicKey) return;
    scan = await scanWallet(publicKey);
    renderPreview();
    const btn = $('runActionBtn');
    if (btn) btn.click();
  }

  async function completeAndReset() {
    if (completing) return;
    completing = true;
    clearSuccessTimer();
    closeConfirmModal();
    try {
      await refreshAfterClose();
    } catch (e) {
      setStatus(friendlyError(e), true);
    }
    showSessionBanner();
    completing = false;
  }

  function showCompletion(opts) {
    const partial = !!opts.partial;
    const failed = Number(opts.failed) || 0;
    const okCount = Number(opts.okCount) || 0;
    const totalBatches = Number(opts.totalBatches) || (okCount + failed);
    setHidden($('solReclaimModalConfirmBody'), true);
    const success = $('solReclaimModalSuccess');
    setHidden(success, false);
    const icon = $('solReclaimModalSuccessIcon');
    if (icon) {
      icon.classList.toggle('is-partial', partial);
      icon.textContent = partial ? '!' : '\u2713';
    }
    const title = $('solReclaimModalSuccessTitle');
    if (title) title.textContent = partial ? 'Transaction partly completed' : (revokeRun ? 'Approvals removed' : 'Transaction completed');
    const solEl = $('solReclaimModalSuccessSol');
    if (solEl) solEl.textContent = revokeRun ? 'None (free)' : (opts.solText || '0 SOL');
    const countEl = $('solReclaimModalSuccessCount');
    if (countEl) countEl.textContent = String(opts.accounts == null ? 0 : opts.accounts);
    const dt1 = solEl && solEl.previousElementSibling;
    if (dt1) dt1.textContent = revokeRun ? 'DegenCalc fee' : 'SOL back to your wallet';
    const dt2 = countEl && countEl.previousElementSibling;
    if (dt2) dt2.textContent = revokeRun ? 'Approvals removed' : 'Accounts closed';
    const pathEl = $('solReclaimModalSuccessPath');
    if (pathEl) pathEl.textContent = opts.pathLabel || '—';
    fillSuccessSigs(opts.sigs || []);
    const hint = $('solReclaimModalSuccessHint');
    if (hint) {
      if (partial) {
        hint.textContent = okCount + ' of ' + totalBatches + ' batches confirmed, ' + failed + ' failed. You can retry the rest.';
      } else {
        hint.textContent = 'This window will close in a few seconds, or click Done.';
      }
    }
    const retry = $('solReclaimModalRetry');
    if (retry) {
      setHidden(retry, !partial);
      retry.onclick = partial ? function () {
        clearSuccessTimer();
        closeConfirmModal();
        refreshAfterClose().then(function () {
          const left = (scan && scan.closable) || [];
          if (!left.length) {
            setStatus('No closable empty accounts left.', true);
            return;
          }
          return reclaim();
        }).catch(function (err) { failModal(friendlyError(err)); });
      } : null;
    }
    const done = $('solReclaimModalDone');
    if (done) {
      done.textContent = 'Done';
      done.onclick = function () { completeAndReset(); };
    }
    const modal = $('solReclaimModal');
    if (modal) { modal.hidden = false; modal.classList.remove('hidden'); }
    clearSuccessTimer();
    if (!partial && !opts.demo) {
      successTimer = setTimeout(function () { completeAndReset(); }, 8000);
    }
  }

  function showSuccessPreview(demo) {
    // Screenshots / local review only. Does not sign or send.
    const data = demo || {
      solText: '0.001514 SOL',
      accounts: 1,
      pathLabel: 'Jito (private, no public mempool)',
      sigs: ['DemoSig111111111111111111111111111111111111111'],
      partial: false,
      demo: true,
    };
    data.demo = true;
    const modal = $('solReclaimModal');
    if (modal) { modal.hidden = false; modal.classList.remove('hidden'); }
    showCompletion(data);
    const banner = $('solReclaimBanner');
    const text = $('solReclaimBannerText');
    if (banner && text) {
      text.textContent = 'This session: ' + (data.solText || '0 SOL') + ' reclaimed. Transaction completed.';
      setHidden(banner, false);
    }
  }

  function showConfirmPreview(demo) {
    // Used for screenshots and local review. Does not sign or send.
    const summary = demo || {
      wallet: '9WzD\u2026AWWM',
      count: 2,
      returnText: '0.071906 SOL',
      networkFeeText: '0.000010 SOL (1 transaction)',
      tipLamports: 0,
    };
    openConfirmModal(summary);
  }

  async function reclaim(burnList, revokeList, unwrapList, stuckList) {
    if (!provider || !publicKey) throw new Error('Connect your wallet first');
    const revoking = Array.isArray(revokeList) && revokeList.length > 0;
    revokeRun = revoking;
    const unwrapping = !revoking && Array.isArray(unwrapList) && unwrapList.length > 0;
    const stucking = !revoking && !unwrapping && Array.isArray(stuckList) && stuckList.length > 0;
    const burning = !revoking && !unwrapping && !stucking && Array.isArray(burnList) && burnList.length > 0;
    toolKind = revoking ? 'revoker' : (unwrapping ? 'unwrap' : (stucking ? 'stuck' : (!revoking && Array.isArray(burnList) && burnList.length > 0 ? 'burner' : 'reclaim')));
    const closable = revoking ? revokeList : (unwrapping ? unwrapList : (stucking ? stuckList : (burning ? burnList : ((scan && scan.closable) || []))));
    if (!closable.length) throw new Error(revoking ? 'Nothing selected to revoke' : (burning ? 'Nothing selected to burn' : 'No closable empty accounts'));
    const batchSz = revoking ? REVOKE_BATCH_SIZE : (burning ? BURN_BATCH_SIZE : (feeCfg.batchSize || BATCH_SIZE));
    const feeOf = function (list, sz) { return revoking ? 0 : totalFee(list, sz); };
    const rentTotal = grossOf(closable);
    if (!window.solanaWeb3) throw new Error('Solana library failed to load');
    const runBtn = $('solReclaimRunBtn');
    busy = true;
    if (runBtn) runBtn.disabled = true;
    updateBurnSummary();
    let sigs = [];
    let rawSigned = [];
    let paths = [];
    let txs = [];
    try {
      setStatus('Building and simulating transactions\u2026 nothing has been signed yet.', true);
      const latest = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
      const blockhash = latest.value ? latest.value.blockhash : latest.blockhash;
      const txs = revoking ? buildRevokeBatches(publicKey, closable, blockhash, batchSz, 10000) : (burning ? buildBurnBatches(publicKey, closable, blockhash, batchSz, 10000) : buildBatches(publicKey, closable, blockhash, batchSz, 10000));
      for (let i = 0; i < txs.length; i++) {
        assertSafeTransaction(txs[i], publicKey);
        const b64 = uint8ToB64(txs[i].serialize({ requireAllSignatures: false, verifySignatures: false }));
        const sim = await rpc('simulateTransaction', [b64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
        const val = sim.value || sim;
        if (val.err) {
          throw new Error('Simulation failed for batch ' + (i + 1) + ' \u2014 nothing was sent. ' + (typeof val.err === 'string' ? val.err : JSON.stringify(val.err)));
        }
      }
      const networkFeeText = ($('solReclaimNetworkFee') && $('solReclaimNetworkFee').textContent) || 'see preview';
      const svcFee = feeOf(closable, batchSz);
      const confirmed = await openConfirmModal({
        wallet: shortAddr(publicKey),
        count: closable.length,
        returnText: solStr(rentTotal),
        netText: solStr(Math.max(0, (rentTotal) - svcFee)),
        feeOn: revoking ? false : feeOn(),
        serviceFeeLamports: svcFee,
        networkFeeText: networkFeeText,
        tipLamports: feeCfg.tipLamports || 0,
        burn: burning ? { count: closable.length, care: closable.filter(needsCare).length } : null,
        revoke: revoking ? { count: closable.length } : null,
        unwrap: unwrapping ? { count: closable.length } : null,
        stuck: stucking ? { count: closable.length } : null,
      });
      if (!confirmed) {
        setStatus('Cancelled. Nothing was signed or sent.', true);
        return;
      }
      sigs = [];
      paths = [];
      const progress = [];
      for (let i = 0; i < txs.length; i++) {
        try {   // a blockhash only lives about a minute and the visitor may have spent a while reading the confirm window
          const fresh = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
          txs[i].recentBlockhash = fresh.value ? fresh.value.blockhash : fresh.blockhash;
        } catch (e) { /* keep the earlier one; the signed simulation below says if it is too old */ }
        assertSafeTransaction(txs[i], publicKey);
        const step = 'Batch ' + (i + 1) + ' of ' + txs.length + ': waiting for your approval in the wallet';
        progress.push(step);
        setModalProgress(progress);
        setStatus(step + '. You can reject it if anything looks wrong.', true);
        let sig;
        let sentRaw = null;
        let pathLabel = '';
        // Prefer sign + our send endpoint so the server can refuse anything
        // that is not a self-close, and so we can use the private Jito path.
        if (typeof provider.signTransaction === 'function') {
          const signed = await signOne(txs[i]);
          assertSafeTransaction(signed, publicKey);
          const signedB64 = uint8ToB64(serializeSigned(signed));
          progress[progress.length - 1] = 'Batch ' + (i + 1) + ' of ' + txs.length + ': approved in the wallet, simulating the signed transaction\u2026';
          setModalProgress(progress);
          setStatus(progress[progress.length - 1], true);
          const sim = await rpc('simulateTransaction', [signedB64, { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
          const val = sim.value || sim;
          if (val.err) {
            throw new Error('The signed transaction failed simulation \u2014 nothing was sent. ' + (typeof val.err === 'string' ? val.err : JSON.stringify(val.err)));
          }
          progress[progress.length - 1] = 'Batch ' + (i + 1) + ' of ' + txs.length + ': approved in the wallet, sending privately\u2026';
          setModalProgress(progress);
          setStatus(progress[progress.length - 1], true);
          const sent = await sendSigned(signedB64);
          sentRaw = signedB64;
          sig = sent.signature;
          pathLabel = sent.pathLabel || (sent.path === 'jito'
            ? 'Jito (private, no public mempool)'
            : 'Regular RPC (fallback after the private path did not accept it)');
        } else if (typeof provider.signAndSendTransaction === 'function') {
          const out = await withTimeout(
            provider.signAndSendTransaction(txs[i]),
            180000,
            'The wallet did not return a signature. If you already approved it, check Phantom Recent Activity before retrying.'
          );
          sig = typeof out === 'string' ? out : (out && (out.signature || out));
          pathLabel = 'sent by the wallet (this wallet has no sign-only path, so the private relay was not used)';
        } else {
          throw new Error('This wallet cannot sign a transaction from the site');
        }
        if (sig && typeof sig !== 'string') sig = sig.toString();
        if (!sig) throw new Error('Wallet did not return a signature');
        sigs.push(sig);
        rawSigned.push(sentRaw);
        paths.push(pathLabel);
        progress[progress.length - 1] = 'Batch ' + (i + 1) + ' of ' + txs.length + ': ' + pathLabel;
        setModalProgress(progress);
        setStatus('Batch ' + (i + 1) + ' of ' + txs.length + ': ' + pathLabel, true);
        showSigs(sigs);
        addModalSigLinks([sig]);
      }
      // Net to the user = rent reclaimed minus the service fee (0 when the fee is off).
      const intended = Math.max(0, grossOf(closable) - feeOf(closable, batchSz));
      const accounts = closable.length;
      const uniquePaths = paths.filter(function (x, i, arr) { return arr.indexOf(x) === i; });
      const pathLabel = uniquePaths.join('; ') || '—';

      function presentOutcome(kind, confirmed, failed) {
        const okN = confirmed.length;
        const failN = failed;
        if (okN) sessionReclaimed += intended * (okN / Math.max(1, txs.length));
        const solText = solStr(intended * (okN / Math.max(1, txs.length)));
        showSigs(confirmed);
        if (okN && !failN && kind === 'all') {
          setStatus('Transaction completed. About ' + solText + ' was reclaimed.', true);
          showCompletion({
            partial: false,
            solText: solText,
            accounts: accounts,
            pathLabel: pathLabel,
            sigs: confirmed,
            okCount: okN,
            failed: 0,
            totalBatches: txs.length,
          });
        } else {
          setStatus('Transaction partly completed. ' + failN + ' batch' + (failN === 1 ? '' : 'es') + ' failed.', true);
          showCompletion({
            partial: true,
            solText: solText,
            accounts: Math.round(accounts * (okN / Math.max(1, txs.length))),
            pathLabel: pathLabel,
            sigs: confirmed,
            okCount: okN,
            failed: failN,
            totalBatches: txs.length,
          });
        }
        showSessionBanner();
      }

      progress.push('Waiting for confirmations\u2026');
      setModalProgress(progress);
      addModalSigLinks(sigs);
      setStatus('Waiting for confirmations\u2026', true);
      const outcomes = await confirmSigs(sigs, rawSigned);
      const okSigs = [];
      let failedN = 0;
      outcomes.forEach(function (r, i) {
        if (r.status === 'ok') okSigs.push(sigs[i]);
        else failedN += 1;
      });
      if (failedN === 0) presentOutcome('all', okSigs, 0);
      else if (okSigs.length) presentOutcome('partial', okSigs, failedN);
      else throw new Error('No batches confirmed. Check the Solscan links if a signature appeared, or try again.');
    } catch (err) {
      if (sigs && sigs.length) {
        try {
          const catchOutcomes = await confirmSigs(sigs, rawSigned);
          const okSigs = [];
          let failedN = txs.length - sigs.length;
          catchOutcomes.forEach(function (r, i) {
            if (r.status === 'ok') okSigs.push(sigs[i]);
            else failedN += 1;
          });
          if (okSigs.length) {
            const intendedCatch = Math.max(0, grossOf(closable) - feeOf(closable, batchSz));
            const uniquePaths = (paths || []).filter(function (x, i, arr) { return arr.indexOf(x) === i; });
            sessionReclaimed += intendedCatch * (okSigs.length / Math.max(1, txs.length));
            showSigs(okSigs);
            setStatus('Transaction partly completed.', true);
            showCompletion({
              partial: true,
              solText: solStr(intendedCatch * (okSigs.length / Math.max(1, txs.length))),
              accounts: Math.round(closable.length * (okSigs.length / Math.max(1, txs.length))),
              pathLabel: uniquePaths.join('; ') || '—',
              sigs: okSigs,
              okCount: okSigs.length,
              failed: failedN,
              totalBatches: txs.length,
            });
            showSessionBanner();
            return;
          }
        } catch (e2) { /* fall through to failModal */ }
      }
      failModal(friendlyError(err));
      throw err;
    } finally {

      busy = false;
      if (runBtn) runBtn.disabled = !scan || !((scan.closable || []).length);
      updateBurnSummary();
      updateRevokeSummary();
      updateUnwrapSummary();
      updateStuckSummary();
    }
  }

  function disconnect() {
    try { if (provider && provider.disconnect) provider.disconnect(); } catch (e) { /* ignore */ }
    provider = null;
    walletName = '';
    publicKey = null;
    scan = null;
    if ($('solReclaimWalletLabel')) {
      $('solReclaimWalletLabel').classList.add('hidden');
      $('solReclaimWalletLabel').textContent = '';
    }
    if ($('solReclaimDisconnectBtn')) $('solReclaimDisconnectBtn').classList.add('hidden');
    if ($('solReclaimConnectBtn')) $('solReclaimConnectBtn').textContent = 'Connect wallet';
    if ($('solReclaimPreview')) $('solReclaimPreview').classList.add('hidden');
    if ($('solReclaimSigs')) { $('solReclaimSigs').classList.add('hidden'); $('solReclaimSigs').textContent = ''; }
    if ($('solReclaimPicker')) $('solReclaimPicker').classList.add('hidden');
    closeConfirmModal();
    sessionReclaimed = 0;
    showSessionBanner();
    setStatus('', false);
  }

  function attachModalToBody() {
    const modal = $('solReclaimModal');
    if (modal && modal.parentElement !== document.body) {
      document.body.appendChild(modal);
    }
  }

  function mount(state) {
    stateRef = state;
    attachModalToBody();
    if (!$('solReclaimPanel')) return;
    showSessionBanner();
    loadConfig();
    const connectBtn = $('solReclaimConnectBtn');
    const disc = $('solReclaimDisconnectBtn');
    const run = $('solReclaimRunBtn');
    const open = $('solReclaimOpenPhantom');
    if (connectBtn) connectBtn.onclick = function () { showPicker(); };
    if (disc) disc.onclick = disconnect;
    const burnRun = $('solBurnRunBtn');
    if (burnRun) burnRun.onclick = function () {
      const sel = selectedBurn();
      if (!sel.length) return;
      reclaim(sel).catch(function (err) { failModal(friendlyError(err)); });
    };
    const burnSafe = $('solBurnSelectSafe');
    if (burnSafe) burnSafe.onclick = function () {
      burnItems().forEach(function (a) { if (a.value === 'none' && !a.nft_like) burnSel.add(a.pubkey); });
      updateBurnSummary();
    };
    const stuckRunBtn = $('solStuckRunBtn');
    if (stuckRunBtn) stuckRunBtn.onclick = function () {
      const sel = selectedStuck();
      if (!sel.length) return;
      reclaim(null, null, null, sel).catch(function (err) { failModal(friendlyError(err)); });
    };
    const stuckAll = $('solStuckSelectAll');
    if (stuckAll) stuckAll.onclick = function () {
      stuckItems().forEach(function (a) { stuckSel.add(a.pubkey); });
      updateStuckSummary();
    };
    const stuckClear = $('solStuckClear');
    if (stuckClear) stuckClear.onclick = function () { stuckSel.clear(); updateStuckSummary(); };
    const unwrapRunBtn = $('solUnwrapRunBtn');
    if (unwrapRunBtn) unwrapRunBtn.onclick = function () {
      const sel = selectedUnwrap();
      if (!sel.length) return;
      reclaim(null, null, sel).catch(function (err) { failModal(friendlyError(err)); });
    };
    const unwrapAll = $('solUnwrapSelectAll');
    if (unwrapAll) unwrapAll.onclick = function () {
      unwrapItems().forEach(function (a) { unwrapSel.add(a.pubkey); });
      updateUnwrapSummary();
    };
    const unwrapClear = $('solUnwrapClear');
    if (unwrapClear) unwrapClear.onclick = function () { unwrapSel.clear(); updateUnwrapSummary(); };
    const revokeRunBtn = $('solRevokeRunBtn');
    if (revokeRunBtn) revokeRunBtn.onclick = function () {
      const sel = selectedRevoke();
      if (!sel.length) return;
      reclaim(null, sel).catch(function (err) { failModal(friendlyError(err)); });
    };
    const revokeAll = $('solRevokeSelectAll');
    if (revokeAll) revokeAll.onclick = function () {
      revokeItems().forEach(function (a) { revokeSel.add(a.pubkey); });
      updateRevokeSummary();
    };
    const revokeClear = $('solRevokeClear');
    if (revokeClear) revokeClear.onclick = function () { revokeSel.clear(); updateRevokeSummary(); };
    const burnClear = $('solBurnClear');
    if (burnClear) burnClear.onclick = function () { burnSel.clear(); updateBurnSummary(); };
    if (run) run.onclick = function () {
      reclaim().catch(function (err) { failModal(friendlyError(err)); });
    };
    if (open) {
      open.href = phantomBrowseUrl();
      if (isMobile() && !detectedWallets().length) open.classList.remove('hidden');
    }
    if (publicKey && $('solReclaimWalletLabel')) {
      $('solReclaimWalletLabel').textContent = (walletName || 'Wallet') + ' \u00b7 ' + shortAddr(publicKey);
      $('solReclaimWalletLabel').classList.remove('hidden');
      if ($('solReclaimDisconnectBtn')) $('solReclaimDisconnectBtn').classList.remove('hidden');
      if ($('solReclaimConnectBtn')) $('solReclaimConnectBtn').textContent = 'Connected';
      renderPreview();
    }
  }

  function onScan(state) {
    stateRef = state;
    if (!publicKey) return;
    const addr = state && state.values && state.values.address;
    if (addr && addr !== publicKey) {
      setStatus('The address you checked is not the connected wallet. Reclaim only runs for the wallet you connected.', true);
    }
  }

  // Used by unit-style checks in the browser console / tests.
  window.DCSolReclaim = {
    mount: mount,
    onScan: onScan,
    _buildBatches: buildBatches,
    _buildBurnBatches: buildBurnBatches,
    _buildRevokeBatches: buildRevokeBatches,
    _closeAccountIx: closeAccountIx,
    _assertSafeIxs: assertSafeIxs,
    _buildBatches: buildBatches,
    _assertSafeTransaction: assertSafeTransaction,
    _closeAccountIx: closeAccountIx,
    _showConfirmPreview: showConfirmPreview,
    _showSuccessPreview: showSuccessPreview,
  };
})();
