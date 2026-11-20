const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { getAgyDataDir, getMcpConfigPath, getWorkspaceMcpPaths, expandPath } = require('./configPaths');

function getGlobalMcpConfigPath() {
  return getMcpConfigPath();
}

function getGeminiConfigDir() {
  return path.dirname(getGlobalMcpConfigPath());
}

function getAgyMcpCacheDir() {
  return path.join(getAgyDataDir(), 'mcp');
}

function getInstalledBridgeScriptPath() {
  return path.join(getGeminiConfigDir(), 'mcp-http-bridge.js');
}

/**
 * Ensure `~/.gemini/config/mcp-http-bridge.js` is up to date and heal any raw
 * `serverUrl` / `url` entries in `~/.gemini/config/mcp_config.json` so `agy`
 * never stalls for 30s on HTTP MCP servers that return string JSON-RPC IDs.
 */
function ensureGlobalHttpBridgeInstalled() {
  try {
    const cfgDir = getGeminiConfigDir();
    fs.mkdirSync(cfgDir, { recursive: true });
    const srcBridge = path.join(__dirname, 'mcpHttpBridge.js');
    const dstBridge = getInstalledBridgeScriptPath();
    if (fs.existsSync(srcBridge)) {
      const srcContent = fs.readFileSync(srcBridge, 'utf8');
      const curContent = fs.existsSync(dstBridge) ? fs.readFileSync(dstBridge, 'utf8') : '';
      if (srcContent !== curContent) {
        fs.writeFileSync(dstBridge, srcContent, 'utf8');
      }
    }

    const cfgPath = getGlobalMcpConfigPath();
    if (!fs.existsSync(cfgPath)) return false;
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (!raw || typeof raw.mcpServers !== 'object') return false;

    let changed = false;
    for (const [, spec] of Object.entries(raw.mcpServers)) {
      if (!spec || typeof spec !== 'object') continue;
      const httpUrl = spec.serverUrl || spec.url || '';
      if (httpUrl && /^https?:\/\//i.test(httpUrl) && !spec.command) {
        const extraArgs = [dstBridge, httpUrl];
        if (spec.headers && typeof spec.headers === 'object') {
          for (const [hk, hv] of Object.entries(spec.headers)) {
            extraArgs.push('--header', `${hk}: ${hv}`);
          }
        }
        spec.command = 'node';
        spec.args = extraArgs;
        spec._bridgeUrl = httpUrl;
        delete spec.serverUrl;
        delete spec.url;
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
    }
    return changed;
  } catch (_) {
    return false;
  }
}

/** Extract the underlying HTTP URL if a stdio spec uses `mcpHttpBridge.js` or `mcp-http-bridge.js`. */
function extractBridgedHttpUrl(spec) {
  if (!spec || typeof spec !== 'object') return '';
  if (spec._bridgeUrl) return String(spec._bridgeUrl);
  if (spec.serverUrl || spec.url) return String(spec.serverUrl || spec.url);
  if (Array.isArray(spec.args)) {
    const usesBridge = spec.args.some((a) => /mcp[-_]?http[-_]?bridge\.js$/i.test(String(a)));
    if (usesBridge) {
      const urlArg = spec.args.find((a) => /^https?:\/\//i.test(String(a)));
      if (urlArg) return String(urlArg);
    }
  }
  return '';
}

function readJsonSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Discover workspace MCP servers strictly from configured `agyTabs.workspaceMcpPaths`. */
function readWorkspaceMcpServers(cwd) {
  if (!cwd) return {};
  const candidates = getWorkspaceMcpPaths()
    .map((rel) => expandPath(rel, cwd))
    .filter(Boolean);
  const merged = {};
  for (const file of candidates) {
    const data = readJsonSafe(file);
    const map = data?.mcpServers || data?.servers;
    if (map && typeof map === 'object') {
      for (const [name, spec] of Object.entries(map)) {
        if (spec && typeof spec === 'object' && !merged[name]) {
          merged[name] = { ...spec, _sourceFile: file };
        }
      }
    }
  }
  return merged;
}

/** Convert workspace MCP servers into ACP `session/new` `mcpServers` array format. */
function buildAcpSessionMcpServers(cwd) {
  ensureGlobalHttpBridgeInstalled();
  const globalData = readJsonSafe(getGlobalMcpConfigPath());
  const globalMap = globalData?.mcpServers || {};
  const wsMap = readWorkspaceMcpServers(cwd);
  const bridgePath = getInstalledBridgeScriptPath();
  const result = [];

  for (const [name, spec] of Object.entries(wsMap)) {
    if (!spec || spec.disabled) continue;
    // Skip if already configured globally so agy doesn't duplicate it
    if (globalMap[name]) continue;

    const httpUrl = spec.url || spec.serverUrl || '';
    if (httpUrl && /^https?:\/\//i.test(httpUrl)) {
      const args = [bridgePath, httpUrl];
      if (spec.headers && typeof spec.headers === 'object') {
        for (const [hk, hv] of Object.entries(spec.headers)) {
          args.push('--header', `${hk}: ${hv}`);
        }
      }
      result.push({ name, command: 'node', args, env: [] });
    } else if (spec.command) {
      const envArr = [];
      if (spec.env && typeof spec.env === 'object') {
        for (const [ek, ev] of Object.entries(spec.env)) {
          envArr.push({ name: ek, value: String(ev ?? '') });
        }
      }
      result.push({
        name,
        command: String(spec.command),
        args: Array.isArray(spec.args) ? spec.args.map(String) : [],
        env: envArr,
      });
    }
  }
  return result;
}

/** Probe an HTTP MCP server (`initialize` + `tools/list`) with an 800ms timeout. */
function probeHttpMcpServer(urlStr) {
  return new Promise((resolve) => {
    let targetUrl;
    try {
      targetUrl = new URL(urlStr);
    } catch (_) {
      return resolve({ online: false, tools: [] });
    }

    const post = (msg, sid) =>
      new Promise((resPost) => {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        const mod = targetUrl.protocol === 'https:' ? https : http;
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Content-Length': body.length,
        };
        if (sid) headers['mcp-session-id'] = sid;
        const req = mod.request(targetUrl, { method: 'POST', headers, timeout: 800 }, (res) => {
          const nextSid = res.headers['mcp-session-id'] || sid || '';
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const j = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
              resPost({ status: res.statusCode, sid: Array.isArray(nextSid) ? nextSid[0] : nextSid, json: j });
            } catch (_) {
              resPost({ status: res.statusCode, sid: nextSid, json: null });
            }
          });
        });
        req.on('error', () => resPost({ status: 0, sid: '', json: null }));
        req.on('timeout', () => { req.destroy(); resPost({ status: 0, sid: '', json: null }); });
        req.write(body);
        req.end();
      });

    (async () => {
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zerog-probe', version: '1.0' } },
      });
      if (!init.json || !init.json.result) {
        return resolve({ online: false, tools: [] });
      }
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
      const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid);
      const tools = Array.isArray(list.json?.result?.tools)
        ? list.json.result.tools.map((t) => t.name).filter(Boolean)
        : [];
      resolve({ online: true, tools });
    })();
  });
}

function readCachedToolsForServer(name) {
  try {
    const dir = path.join(getAgyMcpCacheDir(), name);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch (_) {
    return [];
  }
}

/** Populate `~/.gemini/antigravity-cli/mcp/<name>` tool schema files from an online HTTP server if not cached yet. */
async function syncHttpToolsToAgyCache(name, urlStr) {
  try {
    const targetUrl = new URL(urlStr);
    const mod = targetUrl.protocol === 'https:' ? https : http;
    const post = (msg, sid) =>
      new Promise((resPost) => {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        const headers = {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Content-Length': body.length,
        };
        if (sid) headers['mcp-session-id'] = sid;
        const req = mod.request(targetUrl, { method: 'POST', headers, timeout: 1200 }, (res) => {
          const nextSid = res.headers['mcp-session-id'] || sid || '';
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resPost({ sid: Array.isArray(nextSid) ? nextSid[0] : nextSid, json: JSON.parse(Buffer.concat(chunks).toString('utf8').trim()) });
            } catch (_) { resPost({ sid: '', json: null }); }
          });
        });
        req.on('error', () => resPost({ sid: '', json: null }));
        req.on('timeout', () => { req.destroy(); resPost({ sid: '', json: null }); });
        req.write(body);
        req.end();
      });

    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'zerog-sync', version: '1.0' } },
    });
    if (!init.json?.result) return [];
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sid);
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, init.sid);
    const tools = list.json?.result?.tools;
    if (!Array.isArray(tools) || !tools.length) return [];

    const dir = path.join(getAgyMcpCacheDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    const names = [];
    for (const t of tools) {
      if (!t || !t.name) continue;
      names.push(t.name);
      const schemaFile = path.join(dir, `${t.name}.json`);
      fs.writeFileSync(schemaFile, JSON.stringify(t, null, 2), 'utf8');
    }
    return names.sort();
  } catch (_) {
    return [];
  }
}

/** Collect full status of all configured MCP servers (global + workspace). */
async function getMcpServersStatus(cwd) {
  ensureGlobalHttpBridgeInstalled();
  const globalPath = getGlobalMcpConfigPath();
  const globalData = readJsonSafe(globalPath) || { mcpServers: {} };
  const globalMap = globalData.mcpServers || {};
  const wsMap = readWorkspaceMcpServers(cwd);

  const entries = [];
  for (const [name, spec] of Object.entries(globalMap)) {
    if (spec && typeof spec === 'object') {
      entries.push({ name, spec, scope: 'global' });
    }
  }
  for (const [name, spec] of Object.entries(wsMap)) {
    if (spec && typeof spec === 'object' && !globalMap[name]) {
      entries.push({ name, spec, scope: 'workspace' });
    }
  }

  const servers = await Promise.all(
    entries.map(async ({ name, spec, scope }) => {
      const disabled = Boolean(spec.disabled);
      const httpUrl = extractBridgedHttpUrl(spec);
      const type = httpUrl ? 'http' : 'stdio';
      const target = httpUrl || [spec.command, ...(spec.args || [])].filter(Boolean).join(' ');
      let cachedTools = readCachedToolsForServer(name);
      let status = disabled ? 'disabled' : cachedTools.length > 0 ? 'connected' : 'ready';

      if (!disabled && httpUrl) {
        const probe = await probeHttpMcpServer(httpUrl);
        if (probe.online) {
          status = 'connected';
          if (cachedTools.length === 0 && probe.tools.length > 0) {
            cachedTools = await syncHttpToolsToAgyCache(name, httpUrl);
            if (!cachedTools.length) cachedTools = probe.tools;
          }
        } else {
          status = 'offline';
        }
      }

      return {
        name,
        scope,
        type,
        target,
        disabled,
        status,
        toolCount: cachedTools.length,
        tools: cachedTools,
      };
    })
  );

  return {
    configPath: globalPath,
    servers,
  };
}

/** Toggle `disabled` for a server in `~/.gemini/config/mcp_config.json`. */
function setMcpServerDisabled(name, disabled, cwd) {
  const cfgPath = getGlobalMcpConfigPath();
  const cfgDir = path.dirname(cfgPath);
  fs.mkdirSync(cfgDir, { recursive: true });
  const data = readJsonSafe(cfgPath) || { mcpServers: {} };
  if (!data.mcpServers || typeof data.mcpServers !== 'object') {
    data.mcpServers = {};
  }
  if (!data.mcpServers[name] && cwd) {
    const ws = readWorkspaceMcpServers(cwd);
    if (ws[name]) {
      const copy = { ...ws[name] };
      delete copy._sourceFile;
      data.mcpServers[name] = copy;
    }
  }
  if (data.mcpServers[name]) {
    data.mcpServers[name].disabled = Boolean(disabled);
    fs.writeFileSync(cfgPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  ensureGlobalHttpBridgeInstalled();
}

module.exports = {
  ensureGlobalHttpBridgeInstalled,
  buildAcpSessionMcpServers,
  getMcpServersStatus,
  setMcpServerDisabled,
  getGlobalMcpConfigPath,
};
