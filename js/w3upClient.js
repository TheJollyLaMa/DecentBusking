// js/w3upClient.js — DecentBusking
// Ported from BigNuten_Vanilla (js/w3upClient.js).
//
// Provides two public functions:
//   connectW3upClient()       — prompts for email, logs in, returns { client, spaceDid }
//   tryAutoRestoreW3upClient() — silently restores an existing session, returns same shape or null
//
// Both functions set window._w3upClient and window._w3upSpaceDid on success so
// that mint.js can upload audio files and metadata to IPFS without needing to
// import this module directly.

// Lazily access window.w3up so the module does not throw when the IPFS
// browser bundle hasn't loaded yet (e.g. during local dev or when blocked).
function _getCreate() {
  return window.w3up && window.w3up.create;
}

/**
 * Attempt to restore an existing W3UP session without prompting the user.
 * Returns { client, spaceDid } if a previously-authorised space is found,
 * otherwise returns null.
 */
export async function tryAutoRestoreW3upClient() {
  const create = _getCreate();
  if (!create) {
    console.warn('[w3up] auto-restore: window.w3up not available.');
    return null;
  }
  try {
    const client = await create();
    const spaces = client.spaces();
    if (!spaces.length) {
      console.log('[w3up] auto-restore: no existing spaces found.');
      return null;
    }
    const space = spaces[0];
    await client.setCurrentSpace(space.did());
    console.log('[w3up] auto-restored space:', space.did());
    return { client, spaceDid: space.did() };
  } catch (err) {
    console.warn('[w3up] auto-restore failed:', err);
    return null;
  }
}

/**
 * Interactively connect a w3up (web3.storage / Storacha) account.
 * 1. Tries to restore an existing session silently first.
 * 2. Falls back to email-based login if no session is found.
 * Returns { client, spaceDid } on success, or null on failure/cancellation.
 */
export async function connectW3upClient() {
  const create = _getCreate();
  if (!create) {
    console.error('[w3up] connectW3upClient: window.w3up is not available. Ensure the IPFS browser bundle loaded.');
    return null;
  }

  // Try to restore an existing session before prompting the user.
  const restored = await tryAutoRestoreW3upClient();
  if (restored) return restored;

  try {
    console.log('[w3up] Initialising client…');
    const client = await create();
    console.log('[w3up] Client ready:', client);

    const email = prompt('Enter your web3.storage / Storacha email to connect IPFS:');
    if (!email) {
      alert('No email entered — IPFS connection cancelled.');
      return null;
    }

    const account = await client.login(email);
    console.log('[w3up] Login successful:', account);
    if (account.plan) {
      await account.plan.wait();
      console.log('[w3up] Payment plan confirmed.');
    }

    const spaces = client.spaces();
    if (!spaces.length) {
      console.warn('[w3up] No spaces found for this account.');
      alert('No web3.storage spaces found for this account. Please create one at https://console.web3.storage');
      return null;
    }

    const space = spaces[0];
    await client.setCurrentSpace(space.did());
    console.log('[w3up] Connected to space:', space.did());

    return { client, spaceDid: space.did() };
  } catch (err) {
    console.error('[w3up] Error connecting client:', err);
    return null;
  }
}
