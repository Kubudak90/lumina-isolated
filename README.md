# Lumina Isolated

Isolated two-asset lending pairs for Lumina. Contracts are a fork of [FraxLend V3](https://docs.frax.finance/fraxlend/fraxlend-overview) (previously branded HyperLend Isolated); see [diffs](https://gist.github.com/fbslo/0ca194e7b0b5b1942a84b53450341f43).

Lenders deposit an ERC-20 into the pair and receive EIP-4626 yield-bearing shares.

See `NOTICE.md` for attribution.

### Overview

![pairOverview](./documentation/images/pairOverview.jpg)

### Building and Testing

- Rename `.env.example` to `.env` and fill in the mnemonic
- Run `npm install`

Compilation:

- `npx hardhat compile`

Tests:

- `npx hardhat test`

### License

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
