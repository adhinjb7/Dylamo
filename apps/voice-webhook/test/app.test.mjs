import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { createServer } from '../src/app.mjs';
import { hashPin } from '../src/pin.mjs';
import { expectedTwilioSignature } from '../src/signature.mjs';

const authToken = 'test-auth-token';
const accountSid = 'AC00000000000000000000000000000000';
const publicBaseUrl = 'https://example.ngrok.app';
const allowedCallerNumber = '+15065550123';
const pinHash = hashPin('1234', Buffer.alloc(16, 1));
const callSid = (number) => `CA${number.toString(16).padStart(32, '0')}`;

async function withServer(run, options = {}) {
  const server = createServer({ authToken, accountSid, publicBaseUrl, allowedCallerNumber, pinHash, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const localBaseUrl = `http://127.0.0.1:${server.address().port}`;
  const signedPost = async (path, params, signed = true) => {
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (signed) headers['x-twilio-signature'] = expectedTwilioSignature(authToken, `${publicBaseUrl}${path}`, params);
    return fetch(`${localBaseUrl}${path}`, { method: 'POST', headers, body: new URLSearchParams(params) });
  };
  try {
    await run({ localBaseUrl, signedPost, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('daemon upgrade is separately authenticated from Twilio media', async () => {
  const machineId = '00000000-0000-4000-8000-000000000001';
  const token = 'test-only-daemon-token-long-enough-for-handshake';
  const hash = createHash('sha256').update(token).digest('hex');
  await withServer(async ({ localBaseUrl, server }) => {
    const websocket = new WebSocket(localBaseUrl.replace('http:', 'ws:') + '/daemon', {
      headers: { 'x-machine-id': machineId, Authorization: `Bearer ${token}` },
    });
    try {
      await new Promise((resolve, reject) => { websocket.once('open', resolve); websocket.once('error', reject); });
      const registered = new Promise((resolve, reject) => {
        websocket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
        websocket.once('error', reject);
      });
      websocket.send(JSON.stringify({ v: 1, eventId: randomUUID(), machineId, type: 'machine.register', name: 'Test', agents: [] }));
      assert.equal((await registered).type, 'machine.registered');
      assert.equal(server.daemonGateway.status(machineId).online, true);
    } finally {
      websocket.close();
      await new Promise((resolve) => websocket.once('close', resolve));
    }
  }, { daemonCredentials: new Map([[machineId, hash]]) });
});

function callParams(number = 1, from = allowedCallerNumber) {
  return { AccountSid: accountSid, CallSid: callSid(number), From: from };
}

test('health endpoint is reachable locally', async () => {
  await withServer(async ({ localBaseUrl }) => {
    const response = await fetch(`${localBaseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  });
});

test('unsigned call is rejected', async () => {
  await withServer(async ({ signedPost }) => {
    const response = await signedPost('/voice', callParams(), false);
    assert.equal(response.status, 403);
  });
});

test('signed allowlisted call prompts for PIN, then grants access', async () => {
  await withServer(async ({ signedPost }) => {
    const params = callParams();
    const first = await signedPost('/voice', params);
    assert.equal(first.status, 200);
    const prompt = await first.text();
    assert.match(prompt, /<Gather input="dtmf" numDigits="4"/);
    assert.match(prompt, /action="https:\/\/example\.ngrok\.app\/voice\/pin"/);
    assert.doesNotMatch(prompt, /Access granted/);

    const verified = await signedPost('/voice/pin', { ...params, Digits: '1234' });
    assert.equal(verified.status, 200);
    const body = await verified.text();
    assert.match(body, /Access granted/);
    assert.match(body, /<Connect><Stream url="wss:\/\/example\.ngrok\.app\/media">/);
    assert.match(body, /<Parameter name="token" value="[0-9a-f]{48}"/);
  });
});

test('only a signed, PIN-authenticated call can exchange bidirectional media', async () => {
  await withServer(async ({ localBaseUrl, signedPost }) => {
    const params = callParams(7);
    await signedPost('/voice', params);
    const pinResponse = await signedPost('/voice/pin', { ...params, Digits: '1234' });
    const token = (await pinResponse.text()).match(/name="token" value="([0-9a-f]+)"/)?.[1];
    assert.ok(token);
    const streamSid = `MZ${'1'.repeat(32)}`;
    const websocket = new WebSocket(localBaseUrl.replace('http:', 'ws:') + '/media', {
      headers: {
        'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}),
      },
    });
    try {
      await new Promise((resolve, reject) => {
        websocket.once('open', resolve);
        websocket.once('error', reject);
      });
      const outbound = [];
      const received = new Promise((resolve, reject) => {
        websocket.on('message', (data) => {
          outbound.push(JSON.parse(data.toString()));
          if (outbound.length === 2) resolve();
        });
        websocket.once('error', reject);
      });
      websocket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
      websocket.send(JSON.stringify({
        event: 'start', streamSid,
        start: { streamSid, callSid: params.CallSid, accountSid, customParameters: { token } },
      }));
      await received;
      assert.equal(outbound[0].event, 'media');
      assert.equal(outbound[0].streamSid, streamSid);
      assert.equal(Buffer.from(outbound[0].media.payload, 'base64').length, 3200);
      assert.equal(outbound[1].event, 'mark');
      websocket.send(JSON.stringify({ event: 'media', streamSid, media: { track: 'inbound', payload: '/////w==' } }));
      websocket.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'test-tone' } }));
    } finally {
      websocket.close();
      await new Promise((resolve) => websocket.once('close', resolve));
    }
  });
});

test('unsigned WebSocket handshake is rejected', async () => {
  await withServer(async ({ localBaseUrl }) => {
    const websocket = new WebSocket(localBaseUrl.replace('http:', 'ws:') + '/media');
    const status = await new Promise((resolve, reject) => {
      websocket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode);
      });
      websocket.once('open', () => reject(new Error('unsigned socket was accepted')));
      websocket.once('error', reject);
    });
    assert.equal(status, 403);
  });
});

test('signed WebSocket without an authenticated call and token is closed', async () => {
  await withServer(async ({ localBaseUrl }) => {
    const websocket = new WebSocket(localBaseUrl.replace('http:', 'ws:') + '/media', {
      headers: {
        'x-twilio-signature': expectedTwilioSignature(authToken, 'wss://example.ngrok.app/media', {}),
      },
    });
    await new Promise((resolve, reject) => {
      websocket.once('open', resolve);
      websocket.once('error', reject);
    });
    const closed = new Promise((resolve) => websocket.once('close', resolve));
    const streamSid = `MZ${'2'.repeat(32)}`;
    websocket.send(JSON.stringify({
      event: 'start', streamSid,
      start: { streamSid, accountSid, callSid: callSid(8), customParameters: { token: 'wrong' } },
    }));
    assert.equal(await closed, 1008);
  });
});

test('unknown caller is rejected before PIN prompt', async () => {
  await withServer(async ({ signedPost }) => {
    const response = await signedPost('/voice', callParams(2, '+15065550999'));
    assert.match(await response.text(), /<Reject\/>/);
  });
});

test('PIN callback without a matching call is denied', async () => {
  await withServer(async ({ signedPost }) => {
    const response = await signedPost('/voice/pin', { ...callParams(3), Digits: '1234' });
    assert.match(await response.text(), /<Hangup\/>/);
  });
});

test('three incorrect PINs lock the caller across calls', async () => {
  await withServer(async ({ signedPost }) => {
    const params = callParams(4);
    await signedPost('/voice', params);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await signedPost('/voice/pin', { ...params, Digits: '9999' });
      const body = await response.text();
      assert.doesNotMatch(body, /Access granted/);
      if (attempt === 3) assert.match(body, /Too many attempts/);
    }
    const nextCall = await signedPost('/voice', callParams(5));
    assert.match(await nextCall.text(), /<Reject\/>/);
  });
});

test('wrong account SID is rejected even when signed', async () => {
  await withServer(async ({ signedPost }) => {
    const params = { ...callParams(6), AccountSid: 'AC11111111111111111111111111111111' };
    const response = await signedPost('/voice', params);
    assert.equal(response.status, 403);
  });
});
