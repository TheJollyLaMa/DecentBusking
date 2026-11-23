import { Contract } from 'ethers';
import { songSplitOwners, SONG_SPLIT_WALLET_ABI } from '../js/song-split-wallet.mjs';

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

// Single-address payers (the DMTv escrow) pay a per-split wallet; the split itself is always read from DJuke on-chain.
export function createSongSplitPayouts({ factory, djuke, token, signer, log = console }) {
  const pending = new Set();
  const onChainSplit = async nft => {
    const song = await djuke.getSong(nft.djukeSongId);
    if (song.recipients.length < 2) throw new Error('Song split is not configured on-chain');
    return [[...song.recipients], [...song.sharesBps].map(Number)];
  };
  return {
    async payeeFor(nft, creatorOf) {
      if (!songSplitOwners(nft) || !nft.djukeSongId) return creatorOf(nft);
      return factory.walletFor(...await onChainSplit(nft));
    },
    async prepare(nft, payee) {
      if (!songSplitOwners(nft) || await factory.isWallet(payee)) return;
      const split = await onChainSplit(nft);
      if ((await factory.walletFor(...split)).toLowerCase() !== payee.toLowerCase()) throw new Error('Split wallet changed');
      const tx = await factory.connect(signer).createWallet(...split);
      if ((await tx.wait(2))?.status !== 1) throw new Error('Split wallet creation not confirmed');
      log.log(`[song-splits] Created split wallet ${payee}: ${tx.hash}`);
    },
    async settled(payee) {
      if (payee && await factory.isWallet(payee)) pending.add(payee);
      return this.flush();
    },
    async flush() {
      for (const wallet of [...pending]) {
        try {
          if (await new Contract(token, ERC20_BALANCE_ABI, signer).balanceOf(wallet) > 0n) {
            const tx = await new Contract(wallet, SONG_SPLIT_WALLET_ABI, signer).distribute(token);
            if ((await tx.wait(2))?.status !== 1) throw new Error('distribution not confirmed');
            log.log(`[song-splits] Distributed ${wallet}: ${tx.hash}`);
          }
          pending.delete(wallet);
        } catch (error) {
          log.warn(`[song-splits] Distribution for ${wallet} deferred:`, error.shortMessage || error.message);
        }
      }
    },
    pending: () => [...pending],
  };
}
