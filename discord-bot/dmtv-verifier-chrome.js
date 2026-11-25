import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const verifierBrowsersDir = fileURLToPath(new URL('./.dmtv-browsers/', import.meta.url));
const manifestName = 'verifier-chrome.json';

// Debian 12 (Render native runtime) packages for chrome-headless-shell's shared libraries.
const debianPackages = {
  'libX11.so.6': 'libx11-6', 'libXau.so.6': 'libxau6', 'libXcomposite.so.1': 'libxcomposite1',
  'libXdamage.so.1': 'libxdamage1', 'libXdmcp.so.6': 'libxdmcp6', 'libXext.so.6': 'libxext6',
  'libXfixes.so.3': 'libxfixes3', 'libXi.so.6': 'libxi6', 'libXrandr.so.2': 'libxrandr2',
  'libXrender.so.1': 'libxrender1', 'libasound.so.2': 'libasound2', 'libatk-1.0.so.0': 'libatk1.0-0',
  'libatk-bridge-2.0.so.0': 'libatk-bridge2.0-0', 'libatspi.so.0': 'libatspi2.0-0', 'libbsd.so.0': 'libbsd0',
  'libdbus-1.so.3': 'libdbus-1-3', 'libdrm.so.2': 'libdrm2', 'libexpat.so.1': 'libexpat1', 'libffi.so.8': 'libffi8',
  'libgbm.so.1': 'libgbm1', 'libgio-2.0.so.0': 'libglib2.0-0', 'libglib-2.0.so.0': 'libglib2.0-0',
  'libgmodule-2.0.so.0': 'libglib2.0-0', 'libgobject-2.0.so.0': 'libglib2.0-0', 'libmd.so.0': 'libmd0',
  'libnspr4.so': 'libnspr4', 'libnss3.so': 'libnss3', 'libnssutil3.so': 'libnss3', 'libplc4.so': 'libnspr4',
  'libplds4.so': 'libnspr4', 'libsmime3.so': 'libnss3', 'libwayland-server.so.0': 'libwayland-server0',
  'libxcb.so.1': 'libxcb1', 'libxkbcommon.so.0': 'libxkbcommon0', 'libxshmfence.so.1': 'libxshmfence1',
};

export function missingLibraries(lddOutput) {
  return [...new Set([...String(lddOutput).matchAll(/^\s*(\S+) => not found$/gm)].map(match => match[1]))];
}

export function packagesForLibraries(libraries) {
  const unknown = libraries.filter(library => !debianPackages[library]);
  if (unknown.length) throw new Error(`No Debian package is known for ${unknown.join(', ')}`);
  return [...new Set(libraries.map(library => debianPackages[library]))].sort();
}

async function findHeadlessShell(dir) {
  for (const entry of (await readdir(dir)).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const platformDir of await readdir(join(dir, entry))) {
      if (platformDir.startsWith('chrome-headless-shell-')) {
        return join(dir, entry, platformDir, 'chrome-headless-shell');
      }
    }
  }
  throw new Error('Chrome Headless Shell was not installed');
}

async function unresolvedLibraries(executablePath, libraryPath) {
  const { stdout } = await run('ldd', [executablePath], {
    env: { PATH: process.env.PATH, ...(libraryPath ? { LD_LIBRARY_PATH: libraryPath } : {}) } });
  return missingLibraries(stdout);
}

// Downloads and unpacks missing Debian libraries without root; Render native builds cannot apt-get install.
async function extractDebianLibraries(packages, root) {
  const apt = join(root, 'apt');
  await mkdir(join(apt, 'lists', 'partial'), { recursive: true });
  await mkdir(join(apt, 'cache', 'archives', 'partial'), { recursive: true });
  await mkdir(join(apt, 'debs'), { recursive: true });
  const options = ['-qq', '-o', `Dir::State::Lists=${join(apt, 'lists')}`, '-o', `Dir::Cache=${join(apt, 'cache')}`,
    '-o', 'Debug::NoLocking=1', '-o', `APT::Sandbox::User=${(await run('id', ['-un'])).stdout.trim()}`];
  await run('apt-get', [...options, 'update'], { maxBuffer: 1 << 24 });
  await run('apt-get', [...options, 'download', ...packages], { cwd: join(apt, 'debs'), maxBuffer: 1 << 24 });
  for (const deb of (await readdir(join(apt, 'debs'))).filter(name => name.endsWith('.deb'))) {
    await run('dpkg-deb', ['-x', join(apt, 'debs', deb), join(root, 'sysroot')]);
  }
  await rm(apt, { recursive: true, force: true });
}

export async function installVerifierChrome({ dir = verifierBrowsersDir, log = console } = {}) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright-core')), 'cli.js');
  await run(process.execPath, [cli, 'install', '--only-shell', 'chromium'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir }, maxBuffer: 1 << 24 });
  const executablePath = await findHeadlessShell(dir);
  let libraryPath = '';
  if (process.platform === 'linux') {
    const multiarch = join(dir, 'sysroot', 'usr', 'lib', 'x86_64-linux-gnu');
    for (let round = 0; round < 3; round++) {
      const missing = await unresolvedLibraries(executablePath, libraryPath);
      if (!missing.length) break;
      log.info(`[dmtv-verifier] Extracting Chrome libraries: ${missing.join(', ')}`);
      await extractDebianLibraries(packagesForLibraries(missing), dir);
      libraryPath = [multiarch, join(dir, 'sysroot', 'lib', 'x86_64-linux-gnu')].join(':');
    }
    const missing = await unresolvedLibraries(executablePath, libraryPath);
    if (missing.length) throw new Error(`Chrome libraries are still missing: ${missing.join(', ')}`);
  }
  await writeFile(join(dir, manifestName), JSON.stringify({ executablePath, libraryPath }));
  log.info(`[dmtv-verifier] Chrome Headless Shell installed at ${executablePath}`);
  return { executablePath, libraryPath };
}

export async function readVerifierChrome(dir = verifierBrowsersDir) {
  const { executablePath, libraryPath } = JSON.parse(await readFile(join(dir, manifestName), 'utf8'));
  if (typeof executablePath !== 'string' || typeof libraryPath !== 'string') throw new Error('Invalid verifier Chrome manifest');
  return { executablePath, libraryPath };
}

// npm postinstall: only the hosted service opts in. A failed install leaves the verifier unready
// (paid radio-video starts stay gated) instead of failing the radio deploy.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.DMTV_RADIO_VERIFIER_IN_SERVICE === 'true') {
    installVerifierChrome().catch(error => {
      console.error(`[dmtv-verifier] CHROME_INSTALL_FAILED ${error.message}`);
    });
  }
}
