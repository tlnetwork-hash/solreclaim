# Get Your SOL Back: wallet code

This is the browser JavaScript behind the **Get Your SOL Back** tool at [degencalc.com/solreclaim](https://degencalc.com/solreclaim). It is published so anyone can read exactly what it does before connecting a wallet.

## What it does

It builds Solana transactions in your browser and asks **your wallet** (Phantom, Solflare or Backpack) to approve and sign them. Nothing is sent without your approval in the wallet.

| Tool | What the transaction does |
|---|---|
| Close empty token accounts | Closes zero-balance token accounts. The rent deposit goes back to your wallet. |
| Burn and close | Burns tokens **you tick**, then closes the account. Nothing is pre-selected. |
| Revoke approvals | Removes token delegate approvals you tick. |
| Unwrap SOL | Closes wrapped-SOL accounts you tick. |
| Stuck SOL | Withdraws idle stake accounts and closes leftover program buffers you tick. |

## Where the money goes

- Reclaimed SOL (the account rent) goes to the **connected wallet**.
- DegenCalc may charge an **optional service fee**: a percentage of the reclaimed rent only, never of your own SOL. When on, it is one separate transfer to the fee wallet, shown on screen and in your wallet's approval before you sign. The fee wallet and percentage come from the server config at `/api/solreclaim/config`, so you can check them there.
- Before sending, the code refuses any transaction that pays SOL to anyone other than your wallet, the fee wallet, or a small Jito tip. See the instruction checks in `solreclaim.js` (search for `Service fee` and `Jito tip`).

## What it never does

- It never asks for, sees or stores your private key or seed phrase. Signing happens inside your wallet.
- It never moves your tokens to another address. It only closes, burns, revokes or withdraws accounts you own, as listed above.

## Check that the live site runs this file

Open `https://degencalc.com/static/js/solreclaim.js` in your browser, save the file, then run `sha256sum solreclaim.js` (Mac: `shasum -a 256 solreclaim.js`; Windows: `certutil -hashfile solreclaim.js SHA256`). Compare the result with `SHA256SUM.txt` in this repo. A match means the site serves exactly this code. (Command-line `curl` may be blocked by the site's bot protection.)

## Limits

This repo contains only the front-end file. Transaction scanning, the RPC proxy and fee accounting run on the DegenCalc server and are not published here. Because your wallet shows what you are signing, always read the approval screen.

Found something wrong? Open an issue, or email the address on the contact page of degencalc.com.

## License

MIT. See `LICENSE`.
