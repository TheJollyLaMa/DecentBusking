export const DJUKE_SIGNING_DOMAIN_VERSION = '0.2';

export function supportsDjukeAlbumsAndGas(version) {
  return ['0.2', '0.3', '0.4', '0.5', '0.6'].includes(version);
}
