export function activeDevertCampaign(campaigns, address, audioURI, now = Date.now()) {
  return campaigns.find(campaign => campaign.advertiser?.toLowerCase() === address.toLowerCase() &&
    campaign.audioURI === audioURI && Date.parse(campaign.startedAt) <= now && now < Date.parse(campaign.expiresAt)) || null;
}

export function buildDevertRemovalMessage({ address, origin, issuedAt, campaignId }) {
  return [
    'DecentBusking remove advert campaign from playback',
    `Wallet: ${address.toLowerCase()}`,
    `Origin: ${origin}`,
    `Campaign: ${campaignId}`,
    'No refund. The original paid campaign term remains unchanged.',
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

export async function removeDevertCampaign({ service, signer, campaignId }) {
  const address = await signer.getAddress();
  const authorization = { address, origin: window.location.origin, campaignId: String(campaignId),
    issuedAt: new Date().toISOString() };
  const signature = await signer.signMessage(buildDevertRemovalMessage(authorization));
  const response = await fetch(`${service.replace(/\/$/, '')}/api/devert/remove`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...authorization, signature }), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Campaign removal failed (${response.status})`);
  return result;
}
