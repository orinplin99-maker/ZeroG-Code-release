const os = require('os');
const path = require('path');

const DEFAULT_AGY_DATA_DIR = '~/.gemini/antigravity-cli';
const DEFAULT_MCP_CONFIG_PATH = '~/.gemini/config/mcp_config.json';
const DEFAULT_WORKSPACE_MCP_PATHS = ['.mcp.json', '.vscode/mcp.json', '.claude/mcp.json'];
const DEFAULT_SKILL_DIRS = [
  '~/.gemini/config/skills',
  '~/.claude/skills',
  '.agent/skills',
  '.claude/skills',
];
const DEFAULT_RULES_DIR = '~/.gemini/config/rules';
const DEFAULT_MEMORY_DIR = '~/.gemini/memory';
const DEFAULT_WEB_BRIDGE_PORT = 18765;
const DEFAULT_WEB_BRIDGE_SCRIPT = '~/.gemini/web-bridge/server.mjs';

function getAgySetting(key, fallback) {
  try {
    const vscode = require('vscode');
    const val = vscode?.workspace?.getConfiguration('agyTabs')?.get(key);
    if (val !== undefined && val !== null) return val;
  } catch (_) {}
  return fallback;
}

function expandPath(raw, baseCwd = '') {
  const s = String(raw || '').trim();
  if (!s) return '';
  const home = os.homedir();
  let out = s;
  if (out === '~' || /^~[\\/]/.test(out)) {
    out = path.join(home, out.slice(1).replace(/^[\\/]+/, ''));
  } else if (/%USERPROFILE%/i.test(out)) {
    out = out.replace(/%USERPROFILE%/gi, home);
  } else if (/^\$HOME(?:[\\/]|$)/.test(out)) {
    out = out.replace(/^\$HOME/, home);
  }
  if (path.isAbsolute(out)) return path.normalize(out);
  return baseCwd ? path.resolve(baseCwd, out) : path.normalize(out);
}

function getAgyDataDir() {
  const configured = String(getAgySetting('agyDataDir', '') || process.env.AGY_DATA_DIR || '').trim();
  return expandPath(configured || DEFAULT_AGY_DATA_DIR);
}

function getMcpConfigPath() {
  const configured = String(getAgySetting('mcpConfigPath', '') || process.env.WEB_BRIDGE_MCP_CONFIG || '').trim();
  return expandPath(configured || DEFAULT_MCP_CONFIG_PATH);
}

function getWorkspaceMcpPaths() {
  const configured = getAgySetting('workspaceMcpPaths', null);
  if (Array.isArray(configured)) {
    return configured.map((s) => String(s || '').trim()).filter(Boolean);
  }
  return [...DEFAULT_WORKSPACE_MCP_PATHS];
}

function getSkillDirs(cwd = '') {
  const configured = getAgySetting('skillDirs', null);
  const rawList = Array.isArray(configured) ? configured : DEFAULT_SKILL_DIRS;
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const trimmed = String(item || '').trim();
    if (!trimmed) continue;
    // Relative entries only apply when a workspace cwd is known
    const isRel = !path.isAbsolute(trimmed) && !/^~(?:[\\/]|$)/.test(trimmed) && !/%USERPROFILE%/i.test(trimmed) && !/^\$HOME(?:[\\/]|$)/.test(trimmed);
    if (isRel && !cwd) continue;
    const resolved = expandPath(trimmed, cwd);
    if (!resolved) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function getRulesDir(cwd = '') {
  const configured = String(getAgySetting('rulesDir', '') || process.env.WEB_BRIDGE_RULES_DIR || '').trim();
  return expandPath(configured || DEFAULT_RULES_DIR, cwd);
}

function getMemoryDir(cwd = '') {
  const configured = String(getAgySetting('memoryDir', '') || process.env.WEB_BRIDGE_MEMORY_DIR || '').trim();
  return expandPath(configured || DEFAULT_MEMORY_DIR, cwd);
}

function getExtraSearchRoots(cwd = '') {
  const configured = getAgySetting('extraSearchRoots', null);
  if (!Array.isArray(configured) || !configured.length) return [];
  const out = [];
  const seen = new Set();
  for (const item of configured) {
    const resolved = expandPath(item, cwd);
    if (!resolved) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function getWebBridgePort() {
  const configured = Number(getAgySetting('webBridgePort', 0));
  if (Number.isInteger(configured) && configured >= 1024 && configured <= 65535) {
    return configured;
  }
  const envPort = Number(process.env.WEB_BRIDGE_PORT);
  if (Number.isInteger(envPort) && envPort >= 1024 && envPort <= 65535) {
    return envPort;
  }
  return DEFAULT_WEB_BRIDGE_PORT;
}

function getWebBridgeScriptPath() {
  const configured = String(getAgySetting('webBridgeScript', '') || process.env.WEB_BRIDGE_SCRIPT || '').trim();
  return expandPath(configured || DEFAULT_WEB_BRIDGE_SCRIPT);
}

module.exports = {
  DEFAULT_AGY_DATA_DIR,
  DEFAULT_MCP_CONFIG_PATH,
  DEFAULT_WORKSPACE_MCP_PATHS,
  DEFAULT_SKILL_DIRS,
  DEFAULT_RULES_DIR,
  DEFAULT_MEMORY_DIR,
  DEFAULT_WEB_BRIDGE_PORT,
  DEFAULT_WEB_BRIDGE_SCRIPT,
  expandPath,
  getAgyDataDir,
  getMcpConfigPath,
  getWorkspaceMcpPaths,
  getSkillDirs,
  getRulesDir,
  getMemoryDir,
  getExtraSearchRoots,
  getWebBridgePort,
  getWebBridgeScriptPath,
};
