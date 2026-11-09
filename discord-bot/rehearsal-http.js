import { LiveAudioError } from './live-audio-errors.js';

export async function handleRehearsalRequest(request, response, { service, allowedOrigins = [] }) {
  const url = new URL(request.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/private-rehearsal/')) return false;
  const origin = String(request.headers.origin || ''), allowed = allowedOrigins.includes(origin);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store',
    ...(allowed ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}) };
  const send = (status, data) => { response.writeHead(status, headers); response.end(JSON.stringify(data)); };
  if (request.method === 'OPTIONS') {
    response.writeHead(allowed ? 204 : 403, { ...headers, 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization' }); response.end(); return true;
  }
  if (request.method === 'GET' && url.pathname === '/api/private-rehearsal/status') {
    send(service?.configured ? 200 : 503, { configured: !!service?.configured }); return true;
  }
  if (!allowed) { send(403, { error: 'Rehearsal origin is not allowed' }); return true; }
  if (!service?.configured) { send(503, { error: 'Private rehearsal is not configured' }); return true; }
  if (request.method !== 'POST') { send(405, { error: 'Rehearsal action requires POST' }); return true; }
  try {
    let text = '';
    for await (const chunk of request) {
      text += chunk;
      if (Buffer.byteLength(text) > 8192) throw new Error('Request too large');
    }
    const input = JSON.parse(text || '{}');
    if (url.pathname === '/api/private-rehearsal/challenge') send(200, await service.challenge(input, origin));
    else if (url.pathname === '/api/private-rehearsal/session') send(200, await service.authorize(input, origin));
    else if (url.pathname === '/api/private-rehearsal/control') {
      const token = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
      send(200, await service.command(token, input, origin));
    } else send(404, { error: 'Unknown rehearsal route' });
  } catch (error) {
    send(400, { error: error instanceof LiveAudioError ? error.message : 'Private rehearsal unavailable; retry or contact the operator' });
  }
  return true;
}
