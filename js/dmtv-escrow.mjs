export const DMTV_ESCROW_ABI = [
  'function paused() view returns (bool)',
  'function quote(uint8) pure returns (uint256)',
  'function head(uint8) view returns (uint256)',
  'function tail(uint8) view returns (uint256)',
  'function paymentToken() view returns (address)',
  'function fundRouter() view returns (address)',
  'function FULFILLER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function videos(bytes32) view returns (address creator, bytes32 mediaHash, uint8 lanes)',
  'function requests(uint8,uint256) view returns (bytes32 videoId,bytes32 mediaHash,address payer,address creator,uint64 refundAt,uint8 status)',
  'function requestVideo(uint8,bytes32,bytes32,address) returns (uint256)',
  'function fulfill(uint8,uint256,bytes32)',
  'function cancelAndRefund(uint8,uint256)',
  'function supportsAutomaticRefunds() pure returns (bool)',
  'function claimRefund(uint8,uint256)',
  'event VideoRequested(uint8 indexed lane,uint256 indexed requestId,address indexed payer,bytes32 videoId,bytes32 mediaHash,address creator,uint256 amount,uint64 refundAt)',
  'event VideoSettled(uint8 indexed lane,uint256 indexed requestId,bytes32 indexed playbackProof)',
];

export async function reserveDmtvVideo({ escrow, usdc, lane, videoId, mediaHash, creator, payer, onStep }) {
  const amount = lane === 0 ? 2_000_000n : 3_000_000n;
  const [video, price, paused] = await Promise.all([escrow.videos(videoId), escrow.quote(lane), escrow.paused()]);
  if (paused || price !== amount || video.mediaHash !== mediaHash ||
      video.creator.toLowerCase() !== creator.toLowerCase() || !(Number(video.lanes) & (1 << lane))) {
    throw new Error('This video is no longer available for that queue.');
  }
  if (await usdc.allowance(payer, escrow.target) < amount) {
    onStep('Approve Base USDC for this reservation.');
    if ((await (await usdc.approve(escrow.target, amount)).wait(2))?.status !== 1) throw new Error('USDC approval failed.');
  }
  onStep('Confirm the refundable reservation in your wallet.');
  const tx = await escrow.requestVideo(lane, videoId, mediaHash, creator);
  onStep(`Reservation submitted: ${tx.hash}. Check wallet history before retrying.`);
  const receipt = await tx.wait(2);
  const event = receipt?.status === 1 && receipt.logs
    .filter(log => log.address.toLowerCase() === escrow.target.toLowerCase())
    .map(log => escrow.interface.parseLog(log))
    .find(log => log?.name === 'VideoRequested' && Number(log.args.lane) === lane &&
      log.args.videoId === videoId && log.args.mediaHash === mediaHash && log.args.amount === amount &&
      log.args.creator.toLowerCase() === creator.toLowerCase() && log.args.payer.toLowerCase() === payer.toLowerCase());
  if (!event) throw new Error(`Reservation receipt was not verified. Check ${tx.hash} before retrying.`);
  return { requestId: String(event.args.requestId), refundAt: Number(event.args.refundAt), txHash: tx.hash };
}
