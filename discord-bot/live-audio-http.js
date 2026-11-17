import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { LiveAudioError } from './live-audio-errors.js';
import { LiveDirectionError } from './live-direction.js';

let clientScript;
async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (Buffer.byteLength(text) > 32 * 1024) throw new Error('Room request is too large');
  }
  return JSON.parse(text || '{}');
}

export async function handleLiveAudioRequest(request, response, { service, allowedOrigins = [] }) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/live-audio/')) return false;
  const origin = String(request.headers.origin || '');
  const allowed = allowedOrigins.includes(origin);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(allowed ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}) };
  const send = (status, data) => { response.writeHead(status, headers); response.end(JSON.stringify(data)); };
  if (request.method === 'OPTIONS') {
    response.writeHead(allowed ? 204 : 403, { ...headers,
      'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' });
    response.end(); return true;
  }
  try {
    if (request.method === 'GET' && url.pathname === '/api/live-audio/client.js') {
      clientScript ||= await readFile(createRequire(import.meta.url).resolve('livekit-client'));
      response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=3600',
        'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
      response.end(clientScript); return true;
    }
    if (!service?.configured) { send(503, { error: 'Live audio is not configured', status: 'OFF-AIR' }); return true; }
    if (request.method === 'GET' && url.pathname === '/api/live-audio/state') {
      send(200, await service.state(url.searchParams.get('bookingId'))); return true;
    }
    if (!allowed) { send(403, { error: 'Room origin is not allowed' }); return true; }
    if (request.method !== 'POST') { send(405, { error: 'Room action requires POST' }); return true; }
    const input = await body(request);
    if (url.pathname === '/api/live-audio/recording-preview') send(200, await service.previewRecording(input, origin));
    else if (url.pathname === '/api/live-audio/recording-publish') send(200, await service.publishRecording(input, origin));
    else if (url.pathname === '/api/live-audio/challenge') send(200, await service.challenge(input, origin));
    else if (url.pathname === '/api/live-audio/session') send(200, await service.authorize(input, origin));
    else if (url.pathname === '/api/live-audio/control') {
      const token = String(request.headers.authorization || '').replace(/^Bearer /, '');
      send(200, await service.command(token, input, origin));
    } else if (url.pathname === '/api/live-audio/listen') send(200, await service.listener(input.bookingId, input.telemetryPageId, input.transport));
    else send(404, { error: 'Unknown room route' });
  } catch (error) {
    // Never return provider errors: they can contain stream keys, tokens or signed URLs.
    if (!(error instanceof LiveAudioError)) console.warn('[live-audio] Request failed:', {
      route: ['/api/live-audio/recording-preview', '/api/live-audio/recording-publish',
        '/api/live-audio/session', '/api/live-audio/challenge', '/api/live-audio/control'].includes(url.pathname) ? url.pathname : 'other',
      kind: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'Error',
      code: ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENOENT', 'EACCES',
        'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(error.code) ? error.code : undefined,
    });
    send(error instanceof LiveDirectionError ? error.status : 400,
      { error: error instanceof LiveAudioError ? error.message : 'Live audio request unavailable; retry or contact the operator',
        ...(error instanceof LiveDirectionError ? { code: error.code } : {}) });
  }
  return true;
}
