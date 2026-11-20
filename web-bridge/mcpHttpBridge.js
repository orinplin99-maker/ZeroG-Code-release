#!/usr/bin/env node
/**
 * Universal Stdio <-> Streamable HTTP MCP Bridge for Antigravity CLI (agy).
 *
 * Solves three common HTTP MCP incompatibilities:
 * 1. Always sends an explicit `Content-Length` header (prevents HTTP 411 on C++/embedded HTTP servers).
 * 2. Preserves JSON-RPC `id` type (coerces string `"1"` back to number `1` when the request used a number).
 * 3. Echoes the client's `params.protocolVersion` in `initialize` responses so strict clients do not disconnect.
 * 4. Fails fast (< 600ms) when a local HTTP MCP server is not running yet instead of stalling startup for 30s,
 *    and transparently handshakes on demand once the server comes online.
 */
const http = require('http');
const https = require('https');
const readline = require('readline');

const args = process.argv.slice(2);
const targetUrlStr = args.find((a) => /^https?:\/\//i.test(a)) || process.env.MCP_HTTP_URL || '';
if (!targetUrlStr) {
  process.stderr.write('[mcp-http-bridge] Missing target URL\n');
  process.exit(1);
}

const extraHeaders = {};
for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--header' || args[i] === '-H') && args[i + 1]) {
    const raw = args[++i];
    const colon = raw.indexOf(':');
    if (colon > 0) {
      extraHeaders[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
    }
  }
}

const targetUrl = new URL(targetUrlStr);
const isLocal = targetUrl.hostname === '127.0.0.1' || targetUrl.hostname === 'localhost';
const CONNECT_TIMEOUT_MS = isLocal ? 800 : 8000;
const CALL_TIMEOUT_MS = 60000;

let mcpSessionId = '';
let remoteInitialized = false;
let clientInitParams = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'antigravity-mcp-bridge', version: '1.0.0' },
};

function parseResponsePayload(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // Support text/event-stream (SSE) responses: pick the last JSON `data:` line
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^data:\s*(\{[\s\S]*\})\s*$/);
      if (m) {
        try { return JSON.parse(m[1]); } catch (_) {}
      }
    }
    return null;
  }
}

function sendHttpRpc(msg, timeoutMs) {
  return new Promise((resolve) => {
    const bodyBuf = Buffer.from(JSON.stringify(msg), 'utf8');
    const mod = targetUrl.protocol === 'https:' ? https : http;
    const headers = {
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': bodyBuf.length,
    };
    if (mcpSessionId) {
      headers['mcp-session-id'] = mcpSessionId;
    }

    const req = mod.request(
      targetUrl,
      { method: 'POST', headers, timeout: timeoutMs },
      (res) => {
        const sid = res.headers['mcp-session-id'];
        if (sid) mcpSessionId = Array.isArray(sid) ? sid[0] : sid;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode || 200, json: parseResponsePayload(text), raw: text });
        });
      }
    );

    req.on('error', (err) => {
      resolve({ status: 0, error: err.message || 'Connection failed' });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'Request timed out' });
    });

    req.write(bodyBuf);
    req.end();
  });
}

async function ensureRemoteInitialized() {
  if (remoteInitialized && mcpSessionId) return true;
  const initMsg = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: clientInitParams,
  };
  const res = await sendHttpRpc(initMsg, CONNECT_TIMEOUT_MS);
  if (res.status >= 200 && res.status < 300 && res.json && res.json.result) {
    remoteInitialized = true;
    await sendHttpRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, CONNECT_TIMEOUT_MS);
    return true;
  }
  return false;
}

function normalizeResponse(reqMsg, resJson) {
  if (!resJson || typeof resJson !== 'object') return resJson;
  if (reqMsg.id !== undefined && resJson.id !== undefined && typeof resJson.id !== typeof reqMsg.id) {
    resJson.id = reqMsg.id;
  }
  if (reqMsg.method === 'initialize' && resJson.result && reqMsg.params?.protocolVersion) {
    resJson.result.protocolVersion = reqMsg.params.protocolVersion;
  }
  return resJson;
}

function writeStdout(obj) {
  if (!obj) return;
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // Notifications from client (no id)
  if (msg.id === undefined) {
    if (msg.method === 'notifications/initialized') {
      if (remoteInitialized) {
        await sendHttpRpc(msg, CONNECT_TIMEOUT_MS);
      }
      return;
    }
    await sendHttpRpc(msg, CONNECT_TIMEOUT_MS);
    return;
  }

  if (msg.method === 'initialize') {
    if (msg.params) clientInitParams = msg.params;
    const proto = msg.params?.protocolVersion || '2025-03-26';
    const res = await sendHttpRpc(msg, CONNECT_TIMEOUT_MS);
    if (res.status >= 200 && res.status < 300 && res.json && res.json.result) {
      remoteInitialized = true;
      writeStdout(normalizeResponse(msg, res.json));
      return;
    }
    // Offline fallback so agy does not stall for 30s when a local editor/service isn't running yet
    remoteInitialized = false;
    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: proto,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-http-bridge (offline)', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list' || msg.method === 'resources/list' || msg.method === 'prompts/list') {
    const ok = await ensureRemoteInitialized();
    if (!ok) {
      const key = msg.method.split('/')[0];
      writeStdout({ jsonrpc: '2.0', id: msg.id, result: { [key]: [] } });
      return;
    }
    const res = await sendHttpRpc(msg, CONNECT_TIMEOUT_MS * 2);
    if (res.json) {
      writeStdout(normalizeResponse(msg, res.json));
    } else {
      const key = msg.method.split('/')[0];
      writeStdout({ jsonrpc: '2.0', id: msg.id, result: { [key]: [] } });
    }
    return;
  }

  // Tool calls or other requests: ensure initialized, and retry once if session expired
  const ok = await ensureRemoteInitialized();
  if (!ok) {
    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: `MCP server at ${targetUrlStr} is offline or unreachable.` },
    });
    return;
  }

  let res = await sendHttpRpc(msg, CALL_TIMEOUT_MS);
  if ((res.status === 400 || res.status === 404 || res.status === 410 || !res.json) && mcpSessionId) {
    mcpSessionId = '';
    remoteInitialized = false;
    if (await ensureRemoteInitialized()) {
      res = await sendHttpRpc(msg, CALL_TIMEOUT_MS);
    }
  }

  if (res.json) {
    writeStdout(normalizeResponse(msg, res.json));
  } else {
    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32000, message: res.error || `Empty response from ${targetUrlStr}` },
    });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleMessage(msg).catch((err) => {
      if (msg && msg.id !== undefined) {
        writeStdout({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: err.message } });
      }
    });
  } catch (_) {}
});
