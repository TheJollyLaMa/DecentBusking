import { createSplitTutorialSurfaces } from './split-tutorial-surfaces.mjs?v=20261025-split-surfaces';

const TUTORIAL_STORAGE_KEY = 'decentbusking:tutorial:seen:v1';
const TUTORIAL_COMPLETED_KEY = 'decentbusking:tutorial:completed:v1';
const TUTORIAL_PROGRESS_KEY = 'decentbusking:tutorial:progress:v1';
const TUTORIAL_PLAYLIST_PROGRESS_KEY = 'decentbusking:tutorial:playlist-progress:v1';
const TUTORIAL_SPLIT_PROGRESS_KEY = 'decentbusking:tutorial:split-progress:v1';
const TUTORIAL_STYLE_ID = 'decentbusking-tutorial-style';
const TUTORIAL_OVERLAY_ID = 'decentbusking-tutorial-overlay';
const TUTORIAL_HIGHLIGHT_CLASS = 'decentbusking-tutorial-highlight';
const TUTORIAL_BODY_CLASS = 'decentbusking-tutorial-open';

const TUTORIAL_STEPS = [
  {
    title: 'Follow the white rabbit.',
    prop: '🎺', propName: 'trumpet',
    body: 'Follow the white rabbit around DecentBusking. Explore the radio, music archive, creator submissions, and community features. This tour opens panels and menus without casting votes, uploading files, requesting wallet access, or making payments.',
    target: null,
  },
  {
    title: '24/7 Community Radio',
    prop: '📻', propName: 'radio',
    body: 'Community recordings play around the clock on JukeLoop radio. Use the footer controls to listen, adjust the volume, and see the current song and artist. The footer also shows when the next advert is due. The tour does not change your audio.',
    target: '#now-playing-label',
  },
  {
    title: 'Submit your music',
    prop: '🎤', propName: 'microphone',
    body: 'Open the briefcase to submit audio or MP4 video for owner review. Drop a file or enter its IPFS CID; the format is detected automatically. Add optional cover art and collaborator wallets with DJuke earning percentages. For advertisements, select DVert and book airtime separately.',
    target: '#mint-modal-inner',
    surface: 'briefcase',
  },
  {
    title: 'Vote on the current play',
    prop: '🎧', propName: 'headphones',
    body: 'Use thumbs up or thumbs down to rate the current radio play. Music votes contribute to the weekly Top 10, and the number beside the buttons shows the live net total. Advert votes apply to that advert’s current play and do not enter the music chart.',
    target: '#radio-voting',
  },
  {
    title: 'Weekly Top 10',
    prop: '🥁', propName: 'drum',
    body: 'The Top 10 ranks songs by weekly net votes. Friday Hype plays the opening chart from its lowest place up to #1 while live rankings continue to update. Open the information button for show and reward details. During Hype, use + to save a song to your personal playlist without purchasing a play.',
    target: '#top-ten-panel',
    surface: 'chart',
  },
  {
    title: 'DVert Advertising',
    prop: '📣', propName: 'megaphone',
    body: 'DVert manages approved adverts, weekly campaigns, and optional paid queue requests. View current prices, campaign details, and funding history here. The information button explains scheduling and payment terms. Opening this panel does not purchase airtime or switch your audio.',
    target: '#devert-panel',
    surface: 'adverts',
  },
  {
    title: 'DJuke Jukebox',
    prop: '🎹', propName: 'keys',
    body: 'Search for a song in DJuke to request a paid radio play. Requests wait for the current recording and protected shows to finish. Review the displayed price before paying. The earnings podium shows confirmed artist and collaborator payouts. Archive cards offer Preview for a free 30-second sample or Listen to play the whole song under its displayed terms.',
    target: '#djuke-panel',
    surface: 'jukebox',
  },
  {
    id: 'playlists',
    title: 'DJuke playlists: take over the radio',
    prop: '🪕', propName: 'banjo',
    body: 'Build a mix, support the musicians, and share it with Earth Village.',
    target: '#djuke-search',
    surface: 'playlists',
  },
  {
    title: 'Explore the music archive',
    prop: '💿', propName: 'record',
    body: 'Open Archive to browse community recordings and filter by artist. Song cards include Preview, Listen, NFT details, and playlist controls. You can browse the archive without purchasing an NFT.',
    target: '#dnft-list',
    surface: 'archive',
  },
  {
    title: 'Profile and public schedule',
    prop: '🎷', propName: 'saxophone',
    body: 'Open the right ankh menu to access Profile and Public Schedule. The schedule lists community shows and includes calendar reminders. Profile contains your personal collections and activity. Connect a wallet to use wallet-backed profile features.',
    target: 'decent-header >>> app-title >>> right-ankh >>> .dropdown-menu',
    surface: 'menu',
  },
  {
    title: 'Playback history and About',
    prop: '🎸', propName: 'guitar',
    body: 'Open the left ankh menu for Playback Tally and About. Playback Tally shows station-wide listening history. About explains the project and includes a link to replay this tour. Administrative tools appear for the owner wallet.',
    target: 'decent-header >>> app-title >>> .ankh-left .dropdown-menu',
    surface: 'left-menu',
  },
  {
    title: 'Community funds',
    prop: '🎼', propName: 'sheet music',
    body: 'Select a fund balance below the header to view funding sources and payout details. Estimated awards can change; only confirmed payouts represent completed payments. Information buttons in the panels provide further details. Use Follow the white rabbit whenever you want to revisit the tour.',
    target: '#artist-filter-bar',
  },
];

const PLAYLIST_HOPS = [
  { title: 'Find your village soundtrack', target: '#djuke-search',
    body: 'Search by song or creator, then choose a song in the Song selector below. Follow the bunny to build a mix of up to 24 songs. This guide never selects songs, connects a wallet, pays, or starts audio for you.' },
  { title: 'Add songs to your mix', target: '#djuke-add-selected-playlist',
    body: 'Choose a song above, then use Add selected song. Repeat for your mix. Music cards and Top 10 also offer + to add a favorite. Disabled controls mean a song, catalog, or payment service may not be ready; the guide does not bypass them.' },
  { title: 'Name it. Put it in order.', target: '.djuke-playlist-draft',
    body: 'Give your playlist a name. In the ordered list, use ↑ and ↓ to move songs, or × to remove one. The total below the list shows the Personal Play and Play Live estimates. Your existing draft stays yours; the guide never adds example songs.' },
  { title: 'Save without buying playback', target: '#djuke-playlist-save',
    body: 'Save to Profile keeps a named revision with your wallet signature. It does not buy or start a play. Saving is optional before either playback purchase. Only use this button when you want to sign and save your own mix.' },
  { title: 'Or keep the jam personal', target: '#djuke-named-playlist-private',
    body: 'Personal Play buys the ordered songs at creator prices in one batch, just for you. Song payments split 90% to musicians and collaborators, 8% to pinning, and 2% to development. No radio platform fee; Base gas is extra. Resume an interrupted purchase in Profile → Playlists without paying again.' },
  { title: 'Play Live for Earth Village', target: '#djuke-named-playlist-radio',
    body: 'Play Live queues your mix for everyone. Songs 1–8 are $0.25 each, 9–16 $0.50, and 17–24 $1. Add $3 per started group of 12 songs ($3 for 1–12; $6 for 13–24). Protected shows may set your mix aside; remaining songs resume afterward without another payment. No refund solely for that delay or interruption. Separate failed-delivery refunds still apply. Review the quote and Base gas; the tour never buys.' },
  { title: 'Your fee fuels the radio funds', target: '#artist-filter-bar', illustration: 'funds',
    body: 'Song payments keep their 90 / 8 / 2 split. The separate radio fee goes 25% each to Playback, Top 10, Pinners, and Development. It is reserved until every song is delivered. Undelivered songs and the unreleased fee are refundable; a purchase confirmation is not proof of delivery.' },
  { title: 'Your mix takes the radio stage', target: '#now-playing-label', illustration: 'radio',
    body: 'After the current song and protected shows, your mix joins public radio. A protected block can set it aside until the show ends; remaining songs return to the queue without another payment or a refund for that scheduling delay. Main paid requests can cut in between songs. This illustration changes no audio or queue. Follow delivery and any separate failure refund in Profile → Playlists.' },
];

let _initialized = false;
let _overlay = null;
let _panel = null;
let _titleEl = null;
let _bodyEl = null;
const SPLIT_HOPS = [
  { title: 'One song. More creators.', surface: 'menu',
    target: 'decent-header >>> app-title >>> right-ankh >>> .dropdown-menu',
    body: 'Follow the bunny through the real Profile and Admin panels to add collaborators and share a song’s artist payout. This read-only walkthrough works without a wallet. It never connects, signs, submits a proposal, buys playback, or changes payments. If no song or request is loaded, clearly labeled, disabled examples show the controls in place.',
  },
  { title: 'Choose the exact song',
    body: 'When you are ready to do this for real, connect your creator or current-payee wallet in the header. Open Profile → My NFTs, find your song, then choose Collaborators & payments beside it. Your song card offers Add collaborator / split payments too. Check the title, NFT token and song ID. No album is needed.',
  },
  { title: 'Add a wallet, role and share',
    body: 'The editor loads the current on-chain payees. Add a collaborator’s wallet or ENS name, give them a role, and set each percentage. Confirm the resolved wallet with your collaborator. All shares must total exactly 100%. These divide the artist payout, not the platform funds, NFT ownership or NFT royalties.',
  },
  { title: 'Review before asking for approval',
    body: 'Choose Review changes to resolve names and compare current and proposed payments for this song. Check every address, role and percentage. Editing a row invalidates the review. Create approval request asks for a gasless signature only after checking that the matching approval service is available.',
  },
  { title: 'Who approves?',
    body: 'Every current payee must approve. A current payee’s proposal signature counts as their approval; if you are the sole current payee, your signature makes it ready immediately. Newly added payees are not required to approve. Share the proposal link with any remaining current payees; they connect their wallet, review, and sign Review and approve. Requests expire after seven days.',
  },
  { title: 'The owner applies the change',
    body: 'A ready request goes to Admin → NFT Requests. The contract owner applies it in a separate Base transaction, which requires gas. The app rechecks approvals, expiry and the current on-chain split first. Payments remain unchanged until the transaction confirms and the worker reconciles it.',
  },
  { title: 'Check it, then play',
    body: 'Reopen the song and verify its current on-chain payees and percentages. Future playback purchases use the confirmed new split; already purchased requests keep their original snapshot. This standalone-song flow uses deployed DJuke v0.5. Album inheritance is not part of this guide. Leave the tour to try your own song, or replay this guide from About.',
  },
];

let _stepLabelEl = null;
let _progressEl = null;
let _backButton = null;
let _nextButton = null;
let _skipButton = null;
let _closeButton = null;
let _backdrop = null;
let _currentStep = 0;
let _currentTarget = null;
let _autoLaunchTimer = null;
let _dismissed = false;
let _furthest = { step: 0, hop: 0 };
let _completed = false;
let _furthestPlaylistHop = 0;
let _playlistCompleted = false;
let _rabbit = null;
let _spotlight = null;
let _returnFocus = null;
let _surfaceCleanup = null;
let _surfaceName = null;
let _savedDrawers = [];
let _savedMint = null;
let _savedScroll = null;
let _layoutFrame = null;
let _notice = null;
let _savedMenus = [];
let _propEl = null;
let _homeHole = null;
let _rabbitAtHome = true;
let _featurePosition = null;
let _journeyTimer = null;
let _journeyBusy = false;
let _playlistHop = 0;
let _playlistOnly = false;
let _splitOnly = false;
let _splitHop = 0;
let _furthestSplitHop = 0;
let _splitCompleted = false;
let _splitSurfaces = null;
let _mercury = null;
let _illustration = null;

const DRAWERS = ['top-ten-tab', 'devert-tab', 'djuke-tab', 'dnft-archive-toggle'];
const SURFACES = { chart: 'top-ten-tab', adverts: 'devert-tab', jukebox: 'djuke-tab', playlists: 'djuke-tab', archive: 'dnft-archive-toggle' };

function _storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function _isSeen() {
  return _storage()?.getItem(TUTORIAL_STORAGE_KEY) === '1';
}

function _readProgress() {
  try {
    _completed = _storage()?.getItem(TUTORIAL_COMPLETED_KEY) === '1';
    const saved = JSON.parse(_storage()?.getItem(TUTORIAL_PROGRESS_KEY) || 'null');
    if (saved && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < TUTORIAL_STEPS.length &&
        Number.isInteger(saved.hop) && saved.hop >= 0 && saved.hop < PLAYLIST_HOPS.length) {
      _furthest = { step: saved.step, hop: TUTORIAL_STEPS[saved.step].id === 'playlists' ? saved.hop : 0 };
    }
    const playlist = JSON.parse(_storage()?.getItem(TUTORIAL_PLAYLIST_PROGRESS_KEY) || 'null');
    if (playlist && Number.isInteger(playlist.hop) && playlist.hop >= 0 && playlist.hop < PLAYLIST_HOPS.length) {
      _furthestPlaylistHop = playlist.hop;
      _playlistCompleted = playlist.completed === true;
    }
    const splits = JSON.parse(_storage()?.getItem(TUTORIAL_SPLIT_PROGRESS_KEY) || 'null');
    if (splits && Number.isInteger(splits.hop) && splits.hop >= 0 && splits.hop < SPLIT_HOPS.length) {
      _furthestSplitHop = splits.hop;
      _splitCompleted = splits.completed === true;
    }
  } catch (error) {
    console.warn('[tutorial] Could not restore tutorial progress:', error);
  }
}

function _rememberProgress() {
  if (_splitOnly) {
    _furthestSplitHop = Math.max(_furthestSplitHop, _splitHop);
    _splitCompleted ||= _splitHop === SPLIT_HOPS.length - 1;
    try {
      _storage()?.setItem(TUTORIAL_SPLIT_PROGRESS_KEY,
        JSON.stringify({ hop: _furthestSplitHop, completed: _splitCompleted }));
    } catch (error) {
      console.warn('[tutorial] Could not remember split tutorial progress:', error);
    }
    return;
  }
  if (_playlistOnly) {
    _furthestPlaylistHop = Math.max(_furthestPlaylistHop, _playlistHop);
    _playlistCompleted ||= _playlistHop === PLAYLIST_HOPS.length - 1;
    try {
      _storage()?.setItem(TUTORIAL_PLAYLIST_PROGRESS_KEY,
        JSON.stringify({ hop: _furthestPlaylistHop, completed: _playlistCompleted }));
    } catch (error) {
      console.warn('[tutorial] Could not remember playlist tutorial progress:', error);
    }
    return;
  }
  if (_currentStep > _furthest.step || (_currentStep === _furthest.step && _playlistHop > _furthest.hop)) {
    _furthest = { step: _currentStep, hop: _playlistHop };
  }
  try {
    _storage()?.setItem(TUTORIAL_PROGRESS_KEY, JSON.stringify(_furthest));
    if (_currentStep === TUTORIAL_STEPS.length - 1) {
      _completed = true;
      _storage()?.setItem(TUTORIAL_COMPLETED_KEY, '1');
    }
  } catch (error) {
    console.warn('[tutorial] Could not remember tutorial progress:', error);
  }
}

function _setSeen(seen) {
  const storage = _storage();
  if (!storage) return;
  try {
    if (seen) storage.setItem(TUTORIAL_STORAGE_KEY, '1');
    else storage.removeItem(TUTORIAL_STORAGE_KEY);
  } catch {
    /* ignore storage failures */
  }
  syncTutorialLaunchButtons();
}

function _ensureStyles() {
  if (!document?.head || document.getElementById(TUTORIAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = TUTORIAL_STYLE_ID;
  style.textContent = `
    .${TUTORIAL_HIGHLIGHT_CLASS} {
      scroll-margin: 90px;
    }
    .decentbusking-tutorial-overlay {
      position: fixed;
      inset: 0;
      z-index: 100001;
      display: block;
      padding: 18px;
      box-sizing: border-box;
      pointer-events: none;
    }
    .decentbusking-tutorial-overlay[hidden] { display: none; }
    .tutorial-split-surfaces #admin-modal {
      inset: 0; width: 100vw; max-height: none; overflow: visible;
      transform: none; animation: none; pointer-events: none;
    }
    .tutorial-split-surfaces #creator-profile,
    .tutorial-split-surfaces #admin-modal-inner {
      position: fixed; inset: 14px auto auto 14px; margin: 0;
      width: min(55vw, 760px); max-width: calc(100vw - 28px);
      max-height: calc(100dvh - 28px); overflow: auto; box-sizing: border-box;
    }
    .tutorial-split-surfaces .split-tutorial-example-label {
      padding: 10px; border: 1px dashed #e9d7a0; border-radius: 8px;
      color: #f3e6bd; background: #182938;
    }
    #creator-profile .decentbusking-tutorial-actions button {
      color: #fff4eb; background: #29343f; border-radius: 999px;
    }
    #creator-profile .decentbusking-tutorial-actions button[data-tutorial-primary] {
      color: #15161f; background: linear-gradient(135deg, #91ddd3, #b9a3ff);
    }
    @media (max-width: 980px) {
      .tutorial-split-surfaces #creator-profile,
      .tutorial-split-surfaces #admin-modal-inner {
        inset: 10px 10px auto; width: calc(100vw - 20px);
        max-width: none; height: 36dvh; max-height: 36dvh;
      }
      .tutorial-split-surfaces .decentbusking-tutorial-card { max-height: 56dvh; }
      .tutorial-split-surfaces .tutorial-home-hole { height: 20px; margin: 0; }
      .tutorial-split-surfaces .decentbusking-tutorial-body { font-size: .82rem; line-height: 1.4; }
      .tutorial-split-surfaces .decentbusking-tutorial-progress { display: none; }
    }
    .decentbusking-tutorial-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(3, 5, 12, .12);
    }
    .decentbusking-tutorial-card {
      pointer-events: auto;
      position: absolute;
      z-index: 3;
      width: min(390px, calc(100% - 32px));
      box-sizing: border-box;
      max-height: calc(100dvh - 32px);
      overflow: auto;
      padding: 22px 20px 16px;
      color: #f4f1ff;
      background: linear-gradient(145deg, rgba(15, 35, 38, .99), rgba(23, 24, 40, .99));
      border: 1px solid rgba(172, 228, 214, .48);
      border-radius: 18px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .5);
      font-family: 'Segoe UI', system-ui, sans-serif;
      transition: left .65s ease, top .65s ease;
    }
    .decentbusking-tutorial-kicker {
      margin: 0 34px 12px 72px;
      min-height: 44px;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 5px 10px;
      color: #91ddd3;
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    .decentbusking-tutorial-card h2 {
      margin: 0;
      color: #fff2e4;
      font-size: clamp(1.2rem, 3vw, 1.65rem);
      line-height: 1.1;
    }
    .decentbusking-tutorial-step {
      white-space: nowrap;
      color: #d5d7e4;
      font-size: .72rem;
      letter-spacing: 0;
    }
    .decentbusking-tutorial-body {
      margin: 12px 0 0;
      color: #dde0ea;
      font-size: .92rem;
      line-height: 1.55;
    }
    .decentbusking-tutorial-actions {
      display: flex;
      gap: 10px;
      flex-wrap: nowrap;
      justify-content: flex-end;
      margin-top: 16px;
    }
    .decentbusking-tutorial-actions button {
      padding: 9px 12px;
      color: #fff4eb;
      background: rgba(255, 255, 255, .08);
      border: 1px solid rgba(255, 255, 255, .14);
      border-radius: 999px;
      cursor: pointer;
    }
    .decentbusking-tutorial-actions button[data-tutorial-primary] {
      color: #15161f;
      background: linear-gradient(135deg, #91ddd3, #b9a3ff, #ef9dca);
      border-color: transparent;
      font-weight: 700;
    }
    .decentbusking-tutorial-actions button:disabled {
      opacity: .45;
      cursor: not-allowed;
    }
    .decentbusking-tutorial-footer {
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      gap: 12px;
      margin-top: 14px;
      color: #aeb3c8;
      font-size: .85rem;
    }
    .decentbusking-tutorial-progress {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .decentbusking-tutorial-launch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border: 1px solid rgba(145, 221, 211, .35);
      border-radius: 999px;
      background: rgba(145, 221, 211, .1);
      color: #d7fff5;
      cursor: pointer;
    }
    .decentbusking-tutorial-launch:hover { background: rgba(145, 221, 211, .18); }
    .decentbusking-tutorial-launch:focus-visible,
    .decentbusking-tutorial-actions button:focus-visible { outline: 2px solid #fff5d9; outline-offset: 3px; }
    .rabbit-tour-launch {
      position: fixed; right: 18px; bottom: 122px; z-index: 2100;
      display: flex; align-items: center; gap: 8px; padding: 8px 13px 8px 5px;
      color: #e7fff5; background: linear-gradient(140deg, #1c3438, #171b29);
      border: 1px solid #8dbbb2; border-radius: 28px; box-shadow: 0 5px 24px #0007;
      cursor: pointer; font: 600 12px/1.25 system-ui, sans-serif;
    }
    #rabbit-tour-launch {
      pointer-events: auto;
      position: fixed;
      left: 50%;
      top: calc(var(--header-height, 112px) + 50px + (100dvh - var(--header-height, 112px) - 50px - var(--radio-footer-height, 96px)) / 2);
      right: auto;
      bottom: auto;
      transform: translate(-50%, -50%);
      max-width: calc(100vw - 32px);
    }
    .rabbit-tour-launch .rabbit-launch-label { max-width: 110px; text-align: left; }
    .rabbit-tour-launch[hidden] { display: none; }
    .rabbit-tour-launch.about-tutorial-btn { position: relative; inset: auto; }
    .rabbit-tour-launch small { display: block; color: #a3bdbd; font-size: 10px; font-weight: 400; margin-top: 3px; }
    .${TUTORIAL_BODY_CLASS} .rabbit-tour-launch { visibility: hidden; }
    .tutorial-notice {
      position: fixed; z-index: 100003; bottom: 190px; right: 18px; width: min(300px, calc(100vw - 60px));
      padding: 12px; border: 1px solid #91ddd3; border-radius: 12px; color: #fff2dc; background: #17262f;
      font: 14px/1.4 system-ui, sans-serif;
    }
    .tutorial-rabbit { position: fixed; z-index: 4; width: 72px; height: 82px; pointer-events: none; }
    .tutorial-home-hole { position: relative; display: flex; justify-content: center; height: 72px; margin: 8px auto; pointer-events: none; }
    .tutorial-home-hole > .rabbit-burrow .rabbit-window { display: none; }
    .tutorial-rabbit.at-home .rabbit-burrow::before { visibility: hidden; }
    .tutorial-rabbit.at-home { width: 64px; }
    .tutorial-rabbit .rabbit-ears { animation: rabbit-feature-idle 5s ease-in-out infinite; }
    .tutorial-rabbit[data-phase="diving"] .rabbit-ears { animation: rabbit-dive .35s ease-in both; }
    .tutorial-rabbit[data-phase="emerging"] .rabbit-ears { animation: rabbit-emerge .6s ease-out both; }
    .tutorial-rabbit:not(.at-home) {
      border-radius: 50%;
      background: radial-gradient(ellipse, #e4fff32e 0%, #b6f3db12 45%, transparent 72%);
      filter: drop-shadow(0 0 8px #a9e6d185);
    }
    .tutorial-magic { position: absolute; inset: 0; pointer-events: none; opacity: 0; }
    .tutorial-magic::before, .tutorial-magic::after {
      position: absolute; content: '✦'; color: #d0ffeb; font: 18px/1 Georgia, serif; text-shadow: 0 0 8px #b2ffe1;
    }
    .tutorial-magic::before { top: 8px; left: 3px; }
    .tutorial-magic::after { bottom: 12px; right: 2px; color: #e6c9ff; }
    .tutorial-rabbit[data-phase="emerging"] .tutorial-magic,
    .tutorial-spotlight.is-magical .tutorial-magic { animation: rabbit-magic 2.2s ease-out both; }
    .tutorial-spotlight .tutorial-magic::before { left: 12px; top: 10px; }
    .tutorial-spotlight .tutorial-magic::after { right: 12px; bottom: 10px; }
    .rabbit-burrow { position: relative; display: block; width: 64px; height: 72px; }
    .rabbit-burrow::before {
      content: ''; position: absolute; bottom: 0; left: 4px; width: 58px; height: 17px;
      border-radius: 50%; background: radial-gradient(ellipse, #020609 35%, #122b2d 70%, #78c5b1 77%, transparent 82%);
      box-shadow: 0 3px 9px #0009; transform: rotate(-7deg);
    }
    .rabbit-window { position: absolute; inset: 0 0 8px; overflow: hidden; }
    .rabbit-ears { position: absolute; bottom: 0; left: 7px; font-size: 47px; line-height: 1.2; filter: drop-shadow(0 0 5px #e1fff74d); animation: rabbit-peek 6.5s ease-in-out infinite; }
    .rabbit-tour-launch .rabbit-burrow { width: 46px; height: 46px; }
    .rabbit-tour-launch .rabbit-burrow::before { width: 42px; left: 0; height: 12px; }
    .rabbit-tour-launch .rabbit-ears { font-size: 34px; left: 2px; }
    .tutorial-mercury { position: absolute; top: 14px; left: 13px; width: 68px; height: 64px; pointer-events: none; }
    .tutorial-mercury .mercury-symbol { position: absolute; left: 12px; top: -6px; font: 58px/1 Georgia, serif; color: #fff0cc; text-shadow: 0 0 10px #e4bc7c70; }
    .tutorial-mercury .mercury-money { position: absolute; bottom: 0; left: 14px; font-size: 22px; transform: rotate(-12deg); }
    .tutorial-mercury .mercury-prop { position: absolute; top: 18px; left: 40px; font-size: 28px; line-height: 1; transform: rotate(12deg); filter: drop-shadow(0 2px 3px #0008); }
    .tutorial-mercury .mercury-prop[data-instrument="trumpet"] { transform: scaleX(-1) rotate(12deg); }
    .mercury-note { position: absolute; left: 28px; top: 24px; color: #c5f3dd; font: 700 15px/1 Georgia, serif; opacity: .65; transform: translate(var(--note-x), var(--note-y)); }
    .mercury-note:nth-of-type(1) { --note-x: -28px; --note-y: -21px; --note-delay: .1s; }
    .mercury-note:nth-of-type(2) { --note-x: 30px; --note-y: -23px; --note-delay: .5s; }
    .mercury-note:nth-of-type(3) { --note-x: 31px; --note-y: 26px; --note-delay: .9s; }
    .is-arriving .mercury-note { animation: mercury-notes 2.4s var(--note-delay) ease-out both; }
    .mercury-sound, .mercury-sound::before, .mercury-sound::after {
      position: absolute; width: 9px; height: 16px; border-left: 1.5px solid #a6dcca; border-radius: 50%; box-sizing: border-box;
    }
    .mercury-sound { left: 1px; top: 28px; opacity: .65; }
    .mercury-sound::before { content: ''; left: -5px; top: -4px; width: 13px; height: 24px; }
    .mercury-sound::after { content: ''; left: -10px; top: -8px; width: 17px; height: 32px; }
    .is-arriving .mercury-sound { animation: mercury-sound 1.3s ease-out 3; }
    .tutorial-mercury.is-arriving { animation: mercury-arrive .75s ease-out both; }
    .tutorial-mercury.is-following {
      position: fixed; z-index: 5;
      transition: left .65s ease .18s, top .65s ease .18s;
    }
    .tutorial-playlist-illustration {
      padding: 10px; margin: 10px 0; border: 1px solid #ffad65;
      border-radius: 12px; background: #102431; font: 13px/1.45 system-ui, sans-serif;
    }
    .tutorial-playlist-illustration[hidden] { display: none; }
    .tutorial-playlist-illustration strong { display: block; color: #ffbd80; margin-bottom: 5px; }
    .tutorial-playlist-flow { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .tutorial-playlist-flow span {
      flex: 1 1 70px; padding: 6px; border: 1px solid #52afff; border-radius: 8px;
      text-align: center; background: #233c4e; animation: playlist-flow 3s ease-in-out infinite;
    }
    .tutorial-playlist-flow span:nth-child(2) { animation-delay: .5s; }
    .tutorial-playlist-flow span:nth-child(3) { animation-delay: 1s; }
    .tutorial-playlist-flow span:nth-child(4) { animation-delay: 1.5s; }
    .tutorial-playlists-stacked #djuke-panel { top: 12px; bottom: calc(55dvh + 28px); }
    .tutorial-playlists-stacked .decentbusking-tutorial-card { max-height: 55dvh; }
    .tutorial-playlists-stacked .tutorial-home-hole { height: 24px; margin: 4px auto; }
    .tutorial-playlists-stacked .decentbusking-tutorial-progress { display: none; }
    .tutorial-playlists-stacked .decentbusking-tutorial-body { font-size: .84rem; line-height: 1.45; }
    .tutorial-playlists-stacked .decentbusking-tutorial-footer {
      position: sticky; bottom: -16px; padding: 8px 0; background: #171e28;
    }
    .tutorial-playlists-stacked .decentbusking-tutorial-highlight { scroll-margin: 8px; }
    @keyframes playlist-flow { 50% { border-color: #ffad65; background: #493b30; } }
    .tutorial-spotlight {
      position: fixed; z-index: 1; pointer-events: none; border: 2px solid #b9e9d9;
      border-radius: 16px; box-sizing: border-box; box-shadow: 0 0 0 200vmax #030810a6, 0 0 22px #91ddd340;
      transition: left .45s ease, top .45s ease, width .45s ease, height .45s ease;
    }
    .tutorial-spotlight[hidden], .tutorial-rabbit[hidden] { display: none; }
    .decentbusking-tutorial-progress { letter-spacing: .16em; color: #8fc9b9; font-size: .8rem; }
    @keyframes rabbit-peek {
      0%, 34%, 100% { transform: translateY(0) rotate(-5deg); }
      43%, 58% { transform: translateY(57px) rotate(8deg); }
      68%, 78% { transform: translateY(-5px) rotate(5deg); }
    }
    @keyframes rabbit-dive {
      0% { transform: translateY(0) rotate(0); }
      25% { transform: translateY(-9px) rotate(-8deg); }
      100% { transform: translateY(64px) rotate(12deg); }
    }
    @keyframes rabbit-emerge {
      0% { transform: translateY(64px) rotate(-12deg); }
      60% { transform: translateY(-12px) rotate(8deg); }
      80% { transform: translateY(3px) rotate(-5deg); }
      100% { transform: none; }
    }
    @keyframes rabbit-feature-idle {
      0%, 65%, 100% { transform: none; }
      74% { transform: translateY(-7px) rotate(-7deg); }
      83% { transform: translateY(0) rotate(5deg); }
    }
    @keyframes rabbit-magic {
      0% { opacity: 0; transform: scale(.8) translateY(8px); }
      25%, 50% { opacity: 1; }
      100% { opacity: 0; transform: scale(1.12) translateY(-10px); }
    }
    @keyframes mercury-arrive {
      from { transform: translate(-45px, 12px) rotate(-14deg); opacity: .2; }
      70% { transform: translate(4px, -4px) rotate(5deg); opacity: 1; }
      to { transform: none; opacity: 1; }
    }
    @keyframes mercury-notes {
      from { opacity: 0; transform: translate(10px, 5px) scale(.5) rotate(-12deg); }
      20% { opacity: 1; }
      to { opacity: .65; transform: translate(var(--note-x), var(--note-y)) scale(1); }
    }
    @keyframes mercury-sound {
      from { opacity: .2; transform: scale(.8); }
      45% { opacity: .9; }
      to { opacity: .65; transform: scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .rabbit-ears, .tutorial-rabbit .rabbit-ears, .tutorial-rabbit[data-phase] .rabbit-ears,
      .tutorial-rabbit[data-phase] .tutorial-magic, .tutorial-spotlight.is-magical .tutorial-magic,
      .tutorial-mercury.is-arriving, .is-arriving .mercury-note, .is-arriving .mercury-sound,
      .tutorial-playlist-flow span { animation: none; }
      .tutorial-rabbit, .tutorial-spotlight, .decentbusking-tutorial-card, .tutorial-mercury.is-following { transition: none; }
    }
    @media (max-width: 640px) {
      .decentbusking-tutorial-card { padding: 16px 14px 14px; }
      .decentbusking-tutorial-body { font-size: .84rem; line-height: 1.45; margin-top: 9px; }
      .decentbusking-tutorial-actions { margin-top: 4px; gap: 7px; }
      .decentbusking-tutorial-step { font-size: .7rem; }
      .decentbusking-tutorial-kicker { font-size: .65rem; min-height: 40px; margin-bottom: 6px; }
      .decentbusking-tutorial-progress { display: none; }
      .tutorial-home-hole { height: 48px; }
      .tutorial-home-hole > .rabbit-burrow, .tutorial-rabbit.at-home { transform: scale(.667); transform-origin: top center; }
      .rabbit-tour-launch { right: 10px; bottom: 150px; padding-right: 9px; }
      .rabbit-tour-launch .rabbit-launch-label { max-width: 88px; font-size: 11px; }
    }
  `;
  document.head.appendChild(style);
}

function _button(label, onClick, attrs = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    button.setAttribute(key, value);
  });
  button.addEventListener('click', onClick);
  return button;
}

function _burrow() {
  const burrow = document.createElement('span');
  burrow.className = 'rabbit-burrow';
  burrow.setAttribute('aria-hidden', 'true');
  const windowEl = document.createElement('span');
  windowEl.className = 'rabbit-window';
  const ears = document.createElement('span');
  ears.className = 'rabbit-ears';
  ears.textContent = '🐇';
  windowEl.append(ears);
  burrow.append(windowEl);
  return burrow;
}

function _ensureLauncher() {
  if (document.getElementById('rabbit-tour-launch')) return;
  const launcher = _button('', startTutorial, {
    id: 'rabbit-tour-launch',
    'aria-label': 'Follow the white rabbit: explore DecentBusking',
    'aria-haspopup': 'dialog',
  });
  _decorateLauncher(launcher);
  (document.querySelector('main') || document.body).appendChild(launcher);
  _syncLandingLauncher();
}

function _decorateLauncher(launcher) {
  if (launcher.dataset.rabbitStyled) return;
  launcher.dataset.rabbitStyled = '1';
  launcher.classList.add('rabbit-tour-launch');
  launcher.setAttribute('aria-label', 'Follow the white rabbit: explore DecentBusking');
  launcher.setAttribute('aria-haspopup', 'dialog');
  const label = document.createElement('span');
  label.className = 'rabbit-launch-label';
  label.textContent = 'Follow the white rabbit';
  const hint = document.createElement('small');
  hint.textContent = 'Explore DecentBusking';
  label.append(hint);
  launcher.replaceChildren(_burrow(), label);
}

function _syncLandingLauncher() {
  const launcher = document.getElementById('rabbit-tour-launch');
  const requested = new URLSearchParams(window.location?.search || '').get('tutorial');
  if (launcher) launcher.hidden = _dismissed || _completed ||
    (_playlistCompleted && requested === 'playlists') || (_splitCompleted && requested === 'splits');
}

function _ensureOverlay() {
  if (_overlay || typeof document === 'undefined') return _overlay;
  _ensureStyles();

  _overlay = document.createElement('div');
  _overlay.id = TUTORIAL_OVERLAY_ID;
  _overlay.className = 'decentbusking-tutorial-overlay';
  _overlay.hidden = true;
  _overlay.setAttribute('aria-hidden', 'true');

  _backdrop = document.createElement('div');
  _backdrop.className = 'decentbusking-tutorial-backdrop';
  _overlay.addEventListener('click', event => event.stopPropagation());
  _overlay.addEventListener('pointerdown', event => event.stopPropagation());

  _spotlight = document.createElement('div');
  _spotlight.className = 'tutorial-spotlight';
  _spotlight.setAttribute('aria-hidden', 'true');
  const featureMagic = document.createElement('span');
  featureMagic.className = 'tutorial-magic';
  _spotlight.append(featureMagic);
  _rabbit = document.createElement('div');
  _rabbit.className = 'tutorial-rabbit';
  _rabbit.setAttribute('aria-hidden', 'true');
  const rabbitMagic = document.createElement('span');
  rabbitMagic.className = 'tutorial-magic';
  _rabbit.append(_burrow(), rabbitMagic);

  _panel = document.createElement('section');
  _panel.className = 'decentbusking-tutorial-card';
  _panel.setAttribute('role', 'dialog');
  _panel.setAttribute('aria-modal', 'false');
  _panel.setAttribute('aria-labelledby', 'decentbusking-tutorial-title');
  _panel.setAttribute('aria-describedby', 'decentbusking-tutorial-body');
  _panel.tabIndex = -1;

  const kicker = document.createElement('p');
  kicker.className = 'decentbusking-tutorial-kicker';
  const themeTitle = document.createElement('span');
  themeTitle.textContent = 'Follow the White Rabbit';
  _stepLabelEl = document.createElement('span');
  _stepLabelEl.className = 'decentbusking-tutorial-step';
  kicker.append(themeTitle, _stepLabelEl);

  const mercury = _mercury = document.createElement('span');
  mercury.className = 'tutorial-mercury';
  mercury.setAttribute('aria-hidden', 'true');
  const money = document.createElement('span');
  money.className = 'mercury-money';
  money.textContent = '💸';
  const symbol = document.createElement('span');
  symbol.className = 'mercury-symbol';
  symbol.textContent = '☿';
  _propEl = document.createElement('span');
  _propEl.className = 'mercury-prop';
  const sound = document.createElement('span');
  sound.className = 'mercury-sound';
  const notes = document.createElement('span');
  notes.className = 'mercury-notes';
  ['♪', '♫', '♪'].forEach(glyph => {
    const note = document.createElement('span');
    note.className = 'mercury-note';
    note.textContent = glyph;
    notes.append(note);
  });
  mercury.append(money, symbol, _propEl, sound, notes);

  _homeHole = document.createElement('div');
  _homeHole.className = 'tutorial-home-hole';
  _homeHole.setAttribute('aria-hidden', 'true');
  _homeHole.append(_burrow());

  _titleEl = document.createElement('h2');
  _titleEl.id = 'decentbusking-tutorial-title';

  _bodyEl = document.createElement('p');
  _bodyEl.className = 'decentbusking-tutorial-body';
  _bodyEl.id = 'decentbusking-tutorial-body';
  _bodyEl.setAttribute('aria-live', 'polite');
  _illustration = document.createElement('div');
  _illustration.className = 'tutorial-playlist-illustration';
  _illustration.hidden = true;

  const footer = document.createElement('div');
  footer.className = 'decentbusking-tutorial-footer';

  _progressEl = document.createElement('span');
  _progressEl.className = 'decentbusking-tutorial-progress';

  const buttonRow = document.createElement('div');
  buttonRow.className = 'decentbusking-tutorial-actions';

  _backButton = _button('Back', previousTutorialStep);
  _skipButton = _button('Leave tour', skipTutorial);
  _nextButton = _button('Next', nextTutorialStep, { 'data-tutorial-primary': '1' });
  _closeButton = _button('✕', skipTutorial, { 'aria-label': 'Close tutorial' });
  _closeButton.style.position = 'absolute';
  _closeButton.style.top = '12px';
  _closeButton.style.right = '12px';
  _closeButton.style.width = '36px';
  _closeButton.style.height = '36px';
  _closeButton.style.padding = '0';
  _closeButton.style.borderRadius = '50%';

  buttonRow.append(_backButton, _skipButton, _nextButton);
  footer.append(_progressEl, buttonRow);

  _panel.append(mercury, kicker, _closeButton, _titleEl, _homeHole, _bodyEl, _illustration, footer);
  _overlay.append(_backdrop, _spotlight, _rabbit, _panel);
  document.body?.appendChild(_overlay);
  return _overlay;
}

function _clearHighlight() {
  if (_currentTarget?.classList?.remove) _currentTarget.classList.remove(TUTORIAL_HIGHLIGHT_CLASS);
  _currentTarget = null;
}

function _highlightTarget(target) {
  _clearHighlight();
  if (!target) return;
  _currentTarget = target;
  if (target.classList?.add) target.classList.add(TUTORIAL_HIGHLIGHT_CLASS);
  if (typeof target.scrollIntoView === 'function') {
    try {
      target.scrollIntoView({ block: _splitOnly || TUTORIAL_STEPS[_currentStep].id === 'playlists' ? 'start' : 'nearest', inline: 'nearest', behavior: 'instant' });
    } catch {
      /* ignore scroll errors */
    }
  }
}

function _resolveTarget(selector) {
  if (!selector || typeof document?.querySelector !== 'function') return null;
  let root = document;
  const parts = selector.split(' >>> ');
  for (let i = 0; i < parts.length; i++) {
    const match = root?.querySelector(parts[i]);
    if (i === parts.length - 1) return match;
    root = match?.shadowRoot;
  }
  return null;
}

function _closeSurface() {
  _surfaceCleanup?.();
  _surfaceCleanup = null;
  _surfaceName = null;
}

function _explainBlockedTour(message, root = document.body) {
  _notice?.remove();
  _notice = document.createElement('p');
  _notice.className = 'tutorial-notice';
  _notice.setAttribute('role', 'status');
  _notice.textContent = message;
  root.appendChild(_notice);
}

function _openSurface(surface) {
  if (surface && surface === _surfaceName) {
    const toggle = document.getElementById(SURFACES[surface]);
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    if (surface === 'playlists') {
      const draft = document.querySelector('.djuke-playlist-draft');
      if (draft) draft.open = true;
    }
    return;
  }
  _closeSurface();
  _surfaceName = surface;
  const toggle = SURFACES[surface] ? document.getElementById(SURFACES[surface]) : null;
  if (toggle) {
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const draft = surface === 'playlists' ? document.querySelector('.djuke-playlist-draft') : null;
    const wasOpen = draft?.open;
    const scroller = surface === 'playlists' ? document.querySelector('.djuke-body') : null;
    const scrollTop = scroller?.scrollTop;
    if (draft) draft.open = true;
    _surfaceCleanup = () => {
      if (draft) draft.open = wasOpen;
      if (scroller) scroller.scrollTop = scrollTop;
      if (toggle.getAttribute('aria-expanded') === 'true') toggle.click();
    };
  } else if (surface === 'briefcase') {
    const modal = document.getElementById('mint-modal');
    if (!modal) return;
    if (_savedMint?.visible) modal.classList.remove('hidden');
    else document.getElementById('guitar-case-btn')?.click();
    _surfaceCleanup = () => {
      if (_savedMint?.visible) modal.classList.add('hidden');
      else document.getElementById('mint-cancel-btn')?.click();
    };
  } else if (surface === 'menu' || surface === 'left-menu') {
    const prefix = surface === 'menu' ? 'decent-header >>> app-title >>> right-ankh >>> ' : 'decent-header >>> app-title >>> .ankh-left ';
    const menu = _resolveTarget(`${prefix}.dropdown-menu`);
    const coin = _resolveTarget(`${prefix}.ankh-coin`);
    if (!menu || !coin) return;
    const display = menu.style.display;
    if (window.getComputedStyle(menu).display === 'none') coin.click();
    _surfaceCleanup = () => { menu.style.display = display; };
  }
}

function _positionScene() {
  if (!_overlay || _overlay.hidden || !window.innerWidth) return;
  const width = window.innerWidth;
  const height = window.innerHeight;
  let bounds = _currentTarget?.getBoundingClientRect();
  if (_splitOnly && _splitHop > 0) {
    const card = _panel.getBoundingClientRect();
    const mobile = width <= 980;
    Object.assign(_panel.style, {
      left: `${mobile ? 16 : Math.max(16, width - card.width - 16)}px`,
      top: `${mobile ? height - card.height - 12 : Math.max(16, (height - card.height) / 2)}px`,
    });
    const surface = _splitHop === 5 ? document.getElementById('admin-modal-inner') : document.getElementById('creator-profile');
    const frame = surface.getBoundingClientRect();
    const top = Math.max(frame.top + 6, bounds.top);
    const bottom = Math.min(frame.bottom - 6, bounds.bottom);
    const left = Math.max(frame.left + 6, bounds.left);
    const right = Math.min(frame.right - 6, bounds.right);
    const visible = right > left && bottom > top;
    _spotlight.hidden = !visible;
    if (visible) Object.assign(_spotlight.style, {
      left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`,
    });
    _featurePosition = visible ? {
      left: `${Math.max(frame.left, right - 72)}px`,
      top: `${Math.max(frame.top, Math.min(frame.bottom - 84, top - 40))}px`,
    } : null;
    _rabbit.hidden = false;
    _positionRabbit();
    return;
  }
  const playlist = TUTORIAL_STEPS[_currentStep].id === 'playlists';
  const stacked = playlist && (width <= 800 || (_panel.getBoundingClientRect().width + (bounds?.width || 0) + 60 > width));
  const wasStacked = document.body.classList.contains('tutorial-playlists-stacked');
  if (stacked) document.body.classList.add('tutorial-playlists-stacked');
  else document.body.classList.remove('tutorial-playlists-stacked');
  if (stacked !== wasStacked) {
    _currentTarget?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'instant' });
    bounds = _currentTarget?.getBoundingClientRect();
  }
  const visible = bounds && bounds.width > 0 && bounds.height > 0;
  const cardHeight = _panel.getBoundingClientRect().height;
  const cardWidth = _panel.getBoundingClientRect().width;
  const mobile = width <= 640 || (bounds && cardWidth + bounds.width + 60 > width);
  let left = (width - cardWidth) / 2;
  let top = (height - cardHeight) / 2;
  if (visible) {
    const targetTop = Math.max(12, Math.min(height - 60, bounds.top));
    const targetLeft = Math.max(10, Math.min(width - 60, bounds.left));
    const targetWidth = Math.max(40, Math.min(width - targetLeft - 10, bounds.width));
    // Large forms/drawers get a window into their top, leaving room for the tour text.
    const mobileWindow = Math.max(40, Math.min(160, height - cardHeight - targetTop - 110));
    const aboveCard = stacked && bounds.top <= height * .65;
    const targetHeight = Math.min(bounds.height, mobile ? mobileWindow : height * .65, height - targetTop - 12,
      aboveCard ? Math.max(20, height - cardHeight - 28 - targetTop) : height);
    Object.assign(_spotlight.style, {
      left: `${targetLeft - 4}px`, top: `${targetTop - 4}px`,
      width: `${targetWidth + 8}px`, height: `${targetHeight + 8}px`,
    });
    const below = targetTop + targetHeight + 90;
    if (mobile) {
      top = stacked ? (aboveCard ? height - cardHeight - 16 : 16) : bounds.top > height / 2 ? 16 : Math.min(height - cardHeight - 16, below);
    } else {
      const onLeft = bounds.left + bounds.width / 2 < width / 2;
      left = onLeft ? width - cardWidth - 28 : 28;
      top = bounds.top > height * .6 ? Math.max(20, bounds.top - cardHeight - 90) : Math.max(100, (height - cardHeight) / 2);
    }
    _featurePosition = {
      left: `${Math.max(8, Math.min(width - 78, targetLeft + targetWidth - 60))}px`,
      top: `${Math.max(4, Math.min(height - 88, mobile && bounds.top <= height / 2 && targetTop >= 85 ? targetTop - 80 : targetTop + targetHeight - 15))}px`,
    };
  } else {
    _featurePosition = null;
  }
  _spotlight.hidden = !visible;
  _rabbit.hidden = false;
  Object.assign(_panel.style, { left: `${Math.max(16, left)}px`, top: `${Math.max(16, Math.min(height - cardHeight - 16, top))}px` });
  _positionRabbit();
}

function _positionRabbit() {
  _rabbit.classList.remove('at-home');
  if (_rabbitAtHome || !_featurePosition) {
    _rabbit.classList.add('at-home');
    if (_rabbit.parentNode !== _homeHole) _homeHole.append(_rabbit);
    Object.assign(_rabbit.style, { position: 'absolute', left: 'calc(50% - 32px)', top: '0px' });
  } else {
    if (_rabbit.parentNode !== _overlay) _overlay.append(_rabbit);
    Object.assign(_rabbit.style, { position: 'fixed', ..._featurePosition });
  }
  const following = TUTORIAL_STEPS[_currentStep].id === 'playlists' && !_rabbitAtHome && !!_featurePosition;
  if (following) {
    _mercury.classList.add('is-following');
    Object.assign(_mercury.style, {
      left: `${Math.max(8, parseFloat(_featurePosition.left) - 76)}px`,
      top: _featurePosition.top,
    });
  } else {
    _mercury.classList.remove('is-following');
    Object.assign(_mercury.style, { left: '', top: '' });
  }
}

function _reducedMotion() {
  return !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function _cancelJourney() {
  if (_journeyTimer !== null) clearTimeout(_journeyTimer);
  _journeyTimer = null;
  _journeyBusy = false;
  _rabbit.dataset.phase = 'resting';
  _spotlight.classList.remove('is-magical');
}

function _afterJourney(delay, callback) {
  _journeyTimer = setTimeout(() => {
    _journeyTimer = null;
    if (_overlay.hidden) return;
    callback();
  }, delay);
}

function _arriveAtFeature() {
  _rabbitAtHome = !_featurePosition;
  _positionRabbit();
  _rabbit.dataset.phase = 'emerging';
  _spotlight.classList.add('is-magical');
  _afterJourney(650, () => {
    _rabbit.dataset.phase = 'resting';
    _journeyBusy = false;
    _backButton.disabled = _splitOnly ? _splitHop === 0 : _playlistOnly ? _playlistHop === 0 : _currentStep === 0;
    _nextButton.disabled = false;
  });
}

function _departCard() {
  _rabbitAtHome = true;
  _positionScene();
  if (_reducedMotion() || !_currentTarget) {
    _rabbitAtHome = !_featurePosition;
    _positionRabbit();
    _journeyBusy = false;
    _backButton.disabled = _splitOnly ? _splitHop === 0 : _playlistOnly ? _playlistHop === 0 : _currentStep === 0;
    _nextButton.disabled = false;
    return;
  }
  _journeyBusy = true;
  _backButton.disabled = true;
  _nextButton.disabled = true;
  // Wait for the card and drawer to settle before diving through the home hole.
  _afterJourney(700, () => {
    _rabbit.dataset.phase = 'diving';
    _afterJourney(350, _arriveAtFeature);
  });
}

function _changeStep(index, hop = 0) {
  if (_journeyBusy) return;
  const showNext = () => {
    _currentStep = index;
    _playlistHop = hop;
    _renderStep();
  };
  if (_reducedMotion() || _rabbitAtHome) {
    showNext();
    return;
  }
  _journeyBusy = true;
  _backButton.disabled = true;
  _nextButton.disabled = true;
  _spotlight.classList.remove('is-magical');
  _rabbit.dataset.phase = 'diving';
  _afterJourney(350, () => {
    _rabbitAtHome = true;
    _positionRabbit();
    _rabbit.dataset.phase = 'emerging';
    _afterJourney(650, showNext);
  });
}

function _schedulePosition() {
  if (_overlay?.hidden !== false || _layoutFrame !== null) return;
  _layoutFrame = window.requestAnimationFrame(() => {
    _layoutFrame = null;
    _positionScene();
  });
}

function _syncButtonsIn(root = document) {
  _ensureStyles();
  if (root !== document && root.appendChild && !root.querySelector?.(`#${TUTORIAL_STYLE_ID}`)) {
    root.appendChild(document.getElementById(TUTORIAL_STYLE_ID).cloneNode(true));
  }
  root?.querySelectorAll?.('[data-tutorial-launch]')?.forEach?.((button) => {
    _decorateLauncher(button);
  });
  _syncLandingLauncher();
}

function _renderStep() {
  if (_splitOnly) {
    _renderSplitStep();
    return;
  }
  const step = TUTORIAL_STEPS[_currentStep] || TUTORIAL_STEPS[0];
  const hop = step.id === 'playlists' ? PLAYLIST_HOPS[_playlistHop] : null;
  _openSurface(step.surface);
  _titleEl.textContent = hop ? `DJuke playlists: ${hop.title}` : step.title;
  _bodyEl.textContent = hop?.body || step.body;
  _renderPlaylistIllustration(hop?.illustration);
  _panel.scrollTop = 0;
  _propEl.textContent = step.prop;
  _propEl.setAttribute('data-instrument', step.propName);
  _stepLabelEl.textContent = `${_currentStep + 1} / ${TUTORIAL_STEPS.length}`;
  _stepLabelEl.setAttribute('aria-label', `Card ${_currentStep + 1} of ${TUTORIAL_STEPS.length}`);
  if (hop) _stepLabelEl.textContent += ` · Hop ${_playlistHop + 1} / ${PLAYLIST_HOPS.length}`;
  _progressEl.textContent = TUTORIAL_STEPS.map((_, i) => i <= _currentStep ? '●' : '○').join(' ');
  _progressEl.setAttribute('aria-label', `Stop ${_currentStep + 1} of ${TUTORIAL_STEPS.length}`);
  _backButton.disabled = _playlistOnly ? _playlistHop === 0 : _currentStep === 0;
  _nextButton.textContent = _playlistOnly && _playlistHop === PLAYLIST_HOPS.length - 1 ? 'Go explore DJuke' : _currentStep === TUTORIAL_STEPS.length - 1 ? 'Go explore' : 'Follow →';
  const target = _resolveTarget(hop?.target || step.target);
  if (hop && !target) _bodyEl.textContent += ' This control is unavailable in this page. Open the full DecentBusking site to follow this step.';
  _highlightTarget(target || document.getElementById(SURFACES[step.surface]) || (step.surface === 'briefcase' ? document.getElementById('guitar-case-btn') : null));
  _panel.querySelector?.('.tutorial-mercury')?.classList.remove('is-arriving');
  _positionScene();
  if (window.requestAnimationFrame) {
    window.requestAnimationFrame(() => _panel.querySelector('.tutorial-mercury')?.classList.add('is-arriving'));
  }
  _panel.focus();
  _departCard();
  _rememberProgress();
}

function _renderSplitStep() {
  const step = SPLIT_HOPS[_splitHop];
  _cancelJourney();
  _openSurface(step.surface);
  _titleEl.textContent = `Collaborators & payments: ${step.title}`;
  _bodyEl.textContent = step.body;
  _illustration.replaceChildren();
  _illustration.hidden = true;
  _panel.scrollTop = 0;
  _propEl.textContent = '🎶';
  _propEl.setAttribute('data-instrument', 'record');
  _stepLabelEl.textContent = `${_splitHop + 1} / ${SPLIT_HOPS.length}`;
  _stepLabelEl.setAttribute('aria-label', `Card ${_splitHop + 1} of ${SPLIT_HOPS.length}`);
  _progressEl.textContent = SPLIT_HOPS.map((_, i) => i <= _splitHop ? '●' : '○').join(' ');
  _progressEl.setAttribute('aria-label', `Stop ${_splitHop + 1} of ${SPLIT_HOPS.length}`);
  _backButton.disabled = _splitHop === 0;
  _nextButton.disabled = false;
  _nextButton.textContent = _splitHop === SPLIT_HOPS.length - 1 ? 'Go explore' : 'Follow →';
  if (_splitHop === 0) {
    _splitSurfaces?.close();
    _splitSurfaces = null;
    document.body.classList.remove('tutorial-split-surfaces');
    _highlightTarget(_resolveTarget(step.target));
  } else {
    document.body.classList.add('tutorial-split-surfaces');
    _splitSurfaces ||= createSplitTutorialSurfaces({ overlay: _overlay });
    _highlightTarget(_splitSurfaces.show(_splitHop));
  }
  _positionScene();
  _panel.focus();
  _departCard();
  _rememberProgress();
}

function _renderPlaylistIllustration(kind) {
  _illustration.replaceChildren();
  _illustration.hidden = !kind;
  if (!kind) return;
  const label = document.createElement('strong');
  label.textContent = kind === 'funds' ? 'Illustration: $3 radio fee → four funds' : 'Illustration only — not live playback';
  const flow = document.createElement('div');
  flow.className = 'tutorial-playlist-flow';
  const labels = kind === 'funds'
    ? ['25% Playback', '25% Top 10', '25% Pinners', '25% Development']
    : ['Current song →', 'Your playlist →', 'Radio rotation'];
  labels.forEach(text => {
    const item = document.createElement('span');
    item.textContent = text;
    flow.append(item);
  });
  _illustration.append(label, flow);
}

function _cancelAutoLaunch() {
  if (_autoLaunchTimer) {
    clearTimeout(_autoLaunchTimer);
    _autoLaunchTimer = null;
  }
}

function _autoLaunch() {
  if (new URLSearchParams(window.location?.search || '').has('promotion')) return;
  const requested = new URLSearchParams(window.location?.search || '').get('tutorial');
  if (requested === 'payroll') return;
  if (requested === 'splits') {
    if (_dismissed || _splitCompleted || _autoLaunchTimer || _overlay?.hidden === false) return;
    _autoLaunchTimer = setTimeout(() => {
      _autoLaunchTimer = null;
      startTutorial({ card: 'splits', resume: true });
    }, 0);
    return;
  }
  if (_dismissed || _completed || _autoLaunchTimer || _overlay?.hidden === false) return;
  if (requested === 'playlists') {
    if (_playlistCompleted) return;
    // Drawer listeners finish wiring during DOMContentLoaded before the linked card opens.
    _autoLaunchTimer = setTimeout(() => {
      _autoLaunchTimer = null;
      startTutorial({ card: 'playlists', resume: true });
    }, 0);
    return;
  }
  _autoLaunchTimer = setTimeout(() => {
    _autoLaunchTimer = null;
    startTutorial({ resume: true });
  }, 500);
}

function _handleKeydown(event) {
  if (!_overlay || _overlay.hidden || event.defaultPrevented) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    skipTutorial();
    return;
  }
  if (document.activeElement !== _panel) return;
  if (event.key === 'ArrowRight' || event.key === ' ') {
    event.preventDefault();
    event.stopImmediatePropagation();
    nextTutorialStep();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    event.stopImmediatePropagation();
    previousTutorialStep();
  }
}

export function initTutorial() {
  if (_initialized || typeof document === 'undefined') return;
  _initialized = true;
  _readProgress();
  _ensureOverlay();
  _ensureLauncher();
  document.addEventListener('keydown', _handleKeydown, true);
  window.addEventListener?.('resize', () => {
    if (_splitOnly && _overlay?.hidden === false) {
      _currentTarget?.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'instant' });
    }
    _schedulePosition();
  });
  document.addEventListener('scroll', _schedulePosition, true);
  _overlay.addEventListener('transitionend', _schedulePosition);
  document.addEventListener('transitionend', _schedulePosition);
  document.addEventListener('dbusk:tutorial:start', () => startTutorial({ source: 'event' }));
  _syncButtonsIn();
  _autoLaunch();
}

export function startTutorial({ card, resume = false } = {}) {
  _ensureOverlay();
  _cancelAutoLaunch();
  if (_overlay.hidden === false) return;
  if (document.getElementById('mint-submit-btn')?.disabled) {
    _explainBlockedTour('Finish your current submission before starting the tour. Your upload will remain open.', document.getElementById('mint-modal-inner') || document.body);
    return;
  }
  if (document.querySelector('dialog[open]')) {
    const dialog = document.querySelector('dialog[open]');
    _explainBlockedTour('Please close this window before starting the tour.', dialog);
    dialog.focus();
    return;
  }
  if (document.getElementById('devert-audio-mode')?.getAttribute('aria-pressed') === 'true') {
    _explainBlockedTour('Return from VertLoop to the main radio before starting the tour to avoid interrupting your listening.');
    return;
  }
  _notice?.remove();
  _notice = null;
  _returnFocus = document.activeElement;
  while (_returnFocus?.shadowRoot?.activeElement) _returnFocus = _returnFocus.shadowRoot.activeElement;
  _savedScroll = { x: window.scrollX || 0, y: window.scrollY || 0 };
  _savedMenus = [
    'decent-header >>> app-title >>> .ankh-left .dropdown-menu',
    'decent-header >>> app-title >>> right-ankh >>> .dropdown-menu',
  ].map(selector => _resolveTarget(selector)).filter(Boolean).map(element => ({ element, display: element.style.display }));
  _savedMenus.forEach(({ element }) => { element.style.display = 'none'; });
  _savedDrawers = DRAWERS.filter(id => document.getElementById(id)?.getAttribute('aria-expanded') === 'true');
  _savedDrawers.forEach(id => document.getElementById(id).click());
  const mint = document.getElementById('mint-modal');
  _savedMint = mint ? { element: mint, visible: !mint.classList.contains('hidden') } : null;
  if (_savedMint?.visible) mint.classList.add('hidden');
  _playlistOnly = card === 'playlists';
  _splitOnly = card === 'splits';
  _splitHop = resume && _splitOnly ? _furthestSplitHop : 0;
  _playlistHop = resume ? _playlistOnly ? _furthestPlaylistHop : _furthest.hop : 0;
  _currentStep = _playlistOnly ? TUTORIAL_STEPS.findIndex(step => step.id === 'playlists') : resume ? _furthest.step : 0;
  _overlay.hidden = false;
  _overlay.setAttribute('aria-hidden', 'false');
  document.body?.classList?.add(TUTORIAL_BODY_CLASS);
  _renderStep();
  _syncButtonsIn();
  _panel?.focus?.();
}

export function previousTutorialStep() {
  if (!_overlay || _overlay.hidden) return;
  if (_journeyBusy) return;
  if (_splitOnly) {
    _splitHop = Math.max(0, _splitHop - 1);
    _renderStep();
    return;
  }
  if (TUTORIAL_STEPS[_currentStep].id === 'playlists' && _playlistHop > 0) {
    _changeStep(_currentStep, _playlistHop - 1);
    return;
  }
  if (_playlistOnly) return;
  if (TUTORIAL_STEPS[_currentStep - 1]?.id === 'playlists') {
    _changeStep(_currentStep - 1, PLAYLIST_HOPS.length - 1);
    return;
  }
  _changeStep(Math.max(0, _currentStep - 1));
}

export function nextTutorialStep() {
  if (!_overlay || _overlay.hidden) return;
  if (_journeyBusy) return;
  if (_splitOnly) {
    if (_splitHop === SPLIT_HOPS.length - 1) _endTutorial();
    else {
      _splitHop++;
      _renderStep();
    }
    return;
  }
  if (TUTORIAL_STEPS[_currentStep].id === 'playlists') {
    if (_playlistHop < PLAYLIST_HOPS.length - 1) {
      _changeStep(_currentStep, _playlistHop + 1);
      return;
    }
    if (_playlistOnly) {
      _endTutorial();
      const toggle = document.getElementById('djuke-tab');
      if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
      const draft = document.querySelector('.djuke-playlist-draft');
      if (draft) draft.open = true;
      document.getElementById('djuke-search')?.focus();
      return;
    }
  }
  if (_currentStep >= TUTORIAL_STEPS.length - 1) {
    completeTutorial();
    return;
  }
  _changeStep(_currentStep + 1);
}

export function completeTutorial() {
  if (_overlay?.hidden !== false || _playlistOnly || _splitOnly || _currentStep !== TUTORIAL_STEPS.length - 1) return;
  try {
    _storage()?.setItem(TUTORIAL_COMPLETED_KEY, '1');
  } catch (error) {
    console.warn('[tutorial] Could not remember tour completion:', error);
  }
  _endTutorial();
}

function _endTutorial() {
  _dismissed = true;
  _notice?.remove();
  _notice = null;
  _cancelAutoLaunch();
  _cancelJourney();
  _splitSurfaces?.close();
  _splitSurfaces = null;
  document.body?.classList?.remove('tutorial-split-surfaces');
  _closeSurface();
  _clearHighlight();
  _mercury?.classList.remove('is-following');
  if (_mercury) Object.assign(_mercury.style, { left: '', top: '' });
  if (_overlay) {
    _overlay.hidden = true;
    _overlay.setAttribute('aria-hidden', 'true');
  }
  document.body?.classList?.remove(TUTORIAL_BODY_CLASS);
  document.body?.classList?.remove('tutorial-playlists-stacked');
  _savedDrawers.forEach(id => {
    const toggle = document.getElementById(id);
    if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
  });
  _savedDrawers = [];
  _savedMenus.forEach(({ element, display }) => { element.style.display = display; });
  _savedMenus = [];
  if (_savedMint?.visible) _savedMint.element.classList.remove('hidden');
  _savedMint = null;
  if (_savedScroll) window.scrollTo?.(_savedScroll.x, _savedScroll.y);
  _savedScroll = null;
  _syncLandingLauncher();
  if (_returnFocus?.isConnected && !_returnFocus.hidden && _returnFocus.getClientRects?.().length !== 0) _returnFocus.focus();
  else {
    const launcher = document.getElementById('rabbit-tour-launch');
    if (launcher && !launcher.hidden) launcher.focus();
    else document.getElementById('guitar-case-btn')?.focus();
  }
  _returnFocus = null;
  _setSeen(true);
  _syncButtonsIn();
}

export function skipTutorial() {
  _endTutorial();
}

export function markTutorialSeen() {
  _setSeen(true);
}

export function isTutorialSeen() {
  return _isSeen();
}

export function shouldAutoLaunchTutorial() {
  const requested = new URLSearchParams(window.location?.search || '').get('tutorial');
  if (requested === 'splits') return !_dismissed && !_splitCompleted;
  return !_dismissed && !_completed && requested !== 'payroll' &&
    !(requested === 'playlists' && _playlistCompleted);
}

export function syncTutorialLaunchButtons(root = document) {
  _syncButtonsIn(root);
}
