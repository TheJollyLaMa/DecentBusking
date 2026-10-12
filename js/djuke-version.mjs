export const DJUKE_SIGNING_DOMAIN_VERSION = '0.2';

export function supportsDjukeAlbumsAndGas(version) {
  return version === '0.2' || version === '0.3';
}
