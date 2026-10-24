export function renderWallet(element, address) {
  if (!element) return;
  element.replaceChildren();
  element.title = address || '';
  element.removeAttribute('aria-label');
  if (!address) return;
  const part = text => Object.assign(document.createElement('code'), { textContent: text });
  const icons = document.createElement('span');
  icons.className = 'creator-profile-wallet-icons';
  icons.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) {
    const icon = Object.assign(document.createElement('img'), { src: 'img/Ens_Eth_Breathe.png', alt: '', loading: 'lazy' });
    icon.style.animationDelay = `${i * 0.25}s`;
    icons.append(icon);
  }
  element.setAttribute('aria-label', `Wallet ${address}`);
  element.append(part(address.slice(0, 6)), icons, part(address.slice(-4)));
}
