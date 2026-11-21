// Gemini 网页 (gemini.google.com) <-> 本地 Antigravity (agy acp) & ZeroG Code 插件 双向桥接与零 Token ReAct 服务
// 监听: http://127.0.0.1:18765
// 功能：
//   1. LocalToolExecutor：本地零 Token 原子工具执行器 (read_file / edit_file / write_file / search_code / list_dir / run_command)
//   2. WebBrain ReAct Orchestrator：解析网页端 ```json:local-tool 数组或 # @local-agent，本地执行后自动回填网页继续下一轮
//   3. Web 模型与 Effort 同步控制：支持从 VS Code 插件实时查看并切换网页端 Gemini 的模型与思考档位 (如 Argon 高/中/低)
//   4. 兼容正向本地 AGY ACP 调用

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  normalizeUiMode,
  getModePolicy,
  isReadOnlyMode,
  evaluateToolPermission,
  buildModeChangeNotice,
} from './harness/modes.mjs';
import {
  buildContextHintsBlock,
  rankContextEntriesByQuery,
} from './harness/contextRouter.mjs';

import {
  appendSessionEvent,
  createLoopGuardState,
  enqueueSteer,
  drainSteerBlock,
  evaluateBatchLoopGuard,
} from './harness/loopGuard.mjs';
import {
  loadTaskState,
  applyUpdatePlan,
  recordTouchedFile,
  bumpContextBudget,
  shouldProactiveRollover,
  formatTaskStateForHandoff,
  toClientPlanEntries,
} from './harness/taskState.mjs';
import {
  resolveSubagentRolePreset,
  buildRoleSubagentProtocol,
} from './harness/subagentRoles.mjs';

const SERVER_STARTED_AT = Date.now();

const sessionLastUiMode = new Map();
const pendingApprovalResolvers = new Map();

function requiresAskModeApproval(toolName, args = {}, execContext = {}) {
  if (execContext.isSubagent || !execContext.parentTask) return false;
  const mode = normalizeUiMode(execContext.parentTask.uiMode || execContext.uiMode);
  if (mode !== 'default') return false;
  if (toolName === 'edit_file' || toolName === 'write_file' || toolName === 'mcp_call') return true;
  if (toolName === 'run_command') {
    const cmd = String(args.command || args.CommandLine || '').trim();
    return !/^(git\s+(status|log|diff|branch|show)|ls|dir|pwd|cat|type|head|tail|Get-ChildItem|Get-Content|Select-String|Test-Path|node\s+--check)\b/i.test(cmd);
  }
  return false;
}

function requestWebTaskApproval(task, { toolName, title, args }, isCancelled) {
  const approvalId = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const approvalPayload = {
    approvalId,
    requestId: task.requestId,
    toolName,
    title: String(title || toolName).slice(0, 120),
    args: args || {},
    createdAt: Date.now(),
  };
  task.pendingApproval = approvalPayload;
  task.updatedAt = Date.now();
  appendSessionEvent(task.sessionId, 'approval_requested', {
    requestId: task.requestId,
    approvalId,
    toolName,
    title: approvalPayload.title,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decisionObj) => {
      if (settled) return;
      settled = true;
      clearInterval(watchTimer);
      pendingApprovalResolvers.delete(approvalId);
      if (task.pendingApproval?.approvalId === approvalId) task.pendingApproval = null;
      task.updatedAt = Date.now();
      resolve(decisionObj);
    };
    const watchTimer = setInterval(() => {
      if ((isCancelled && isCancelled()) || task.status === 'cancelled') {
        finish({ decision: 'cancelled' });
      }
    }, 250);
    pendingApprovalResolvers.set(approvalId, { task, finish });
  });
}

const require = createRequire(import.meta.url);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_FILE = path.join(DIR, 'bridge.log');
const BRIDGE_CONFIG_FILE = path.join(DIR, 'bridge.config.json');

let bridgeConfig = {};
try {
  if (fs.existsSync(BRIDGE_CONFIG_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') bridgeConfig = parsed;
  }
} catch {}

const PORT = Number(process.env.WEB_BRIDGE_PORT || bridgeConfig.port || 18765);
const DEFAULT_CWD = process.env.WEB_BRIDGE_CWD || bridgeConfig.cwd || process.cwd();

// 本机接口访问控制：放行本机原生客户端（无 Origin）与浏览器扩展，其余来源默认拒绝。
// 否则任意网页都能 POST /ask 让本机执行 run_command；gemini.google.com 是扩展注入页
// 直连 Bridge 的既有通道（content.js 的兜底 fetch），只放行这一个站点。
const PAGE_ORIGINS = new Set(
  [
    'https://gemini.google.com',
    ...(Array.isArray(bridgeConfig.allowedOrigins) ? bridgeConfig.allowedOrigins : []),
    ...String(process.env.WEB_BRIDGE_ALLOWED_ORIGINS || '').split(','),
  ]
    .map((s) => String(s || '').trim())
    .filter(Boolean)
);

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  process.stdout.write(line);
}

let state = {
  sessionId: null,
  cwd: DEFAULT_CWD,
  backend: 'local-tool', // 'local-tool' (0额度纯工具) | 'agy' (本地AGY大模型)
  webModel: '',
  webEffort: 'high',
  webAvailableModels: [],
  webModelsUpdatedAt: 0,
};
try {
  if (fs.existsSync(STATE_FILE)) {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  }
} catch {}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch {}
}

// ─── 改造 1：本地零 Token 原子工具执行器 (LocalToolExecutor) ───
function resolveSafePath(rawPath, cwd) {
  const base = cwd || state.cwd || DEFAULT_CWD;
  if (!rawPath) return base;
  let cleaned = String(rawPath).trim().replace(/^file:\/\/\/?/i, '');
  const home = os.homedir();
  if (cleaned === '~' || /^~[\\/]/.test(cleaned)) {
    cleaned = path.join(home, cleaned.slice(1).replace(/^[\\/]+/, ''));
  } else if (/%USERPROFILE%/i.test(cleaned)) {
    cleaned = cleaned.replace(/%USERPROFILE%/gi, home);
  } else if (/^\$HOME(?:[\\/]|$)/.test(cleaned)) {
    cleaned = cleaned.replace(/^\$HOME/, home);
  }
  if (path.isAbsolute(cleaned)) return path.normalize(cleaned);
  return path.resolve(base, cleaned);
}

function toDisplayPath(rawPath) {
  const s = String(rawPath || '').replace(/\\/g, '/');
  const home = os.homedir();
  if (!home) return s;
  const normHome = home.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normHome) return s;
  if (IS_WIN) {
    if (s.toLowerCase() === normHome.toLowerCase()) return '~';
    if (s.toLowerCase().startsWith(normHome.toLowerCase() + '/')) return '~' + s.slice(normHome.length);
  } else {
    if (s === normHome) return '~';
    if (s.startsWith(normHome + '/')) return '~' + s.slice(normHome.length);
  }
  return s;
}

function normalizeHomePathsInText(raw) {
  const s = String(raw || '');
  const home = os.homedir();
  if (!home) return s;
  const normFwd = home.replace(/\\/g, '/').replace(/\/+$/, '');
  const normBwd = home.replace(/\//g, '\\').replace(/\\+$/, '');
  let out = s;
  if (normBwd) {
    const reBwd = new RegExp(normBwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(reBwd, '~');
  }
  if (normFwd && normFwd !== normBwd) {
    const reFwd = new RegExp(normFwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(reFwd, '~');
  }
  return out;
}

function stripAnsiCodes(raw) {
  return String(raw || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function sanitizeToolOutputForWeb(raw) {
  let s = normalizeHomePathsInText(stripAnsiCodes(raw));
  s = s.replace(
    /\b(figd_[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{25,}|xox[baprs]-[A-Za-z0-9-]{12,})/g,
    (m) => m.slice(0, 5) + '[REDACTED]'
  );
  s = s.replace(
    /(["']?[A-Z0-9_]*(?:API_KEY|SECRET|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|COOKIE)[A-Z0-9_]*["']?\s*[:=]\s*["'])([^"'\r\n]{8,})(["'])/gi,
    '$1<REDACTED>$3'
  );
  return s;
}

const REFUSAL_SENSITIVE_LINE_RE =
  /chrome\.proxy|simulateClick|ClipboardEvent|execCommand|SystemPrompt|CANNED_REFUSAL|罐头拒答|降敏|脱敏|绕过|风控|劫持|内容过滤|API_KEY|SECRET|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|COOKIE/i;

function buildSanitizedRetrySummary(rawToolOutput, maxLen = 4500, headersOnly = false) {
  let lines = normalizeHomePathsInText(stripAnsiCodes(rawToolOutput)).split(/\r?\n/);
  if (headersOnly) {
    lines = lines.filter((line) =>
      /^(?:===\s*\[\d+\]|\[\d+\]\s+[a-z_]+|文件:|目录\s*\(|搜索\s*"|按文件名搜索|命令执行结果|已成功|MCP\s*\[|\[Subagent:|###\s*(?:本地|工作区|规则|记忆|技能|工具))/.test(
        line.trim()
      )
    );
  } else {
    lines = lines.filter((line) => !REFUSAL_SENSITIVE_LINE_RE.test(line));
  }
  return lines.join('\n').trim().slice(0, maxLen);
}

function isRuleDocPath(filePath, workCwd = '', globalRulesDir = DEFAULT_RULES_DIR) {
  if (!filePath) return false;
  const norm = path.resolve(String(filePath)).replace(/\\/g, '/').toLowerCase();
  const base = path.basename(norm);
  if (/\.mdc$/i.test(base) || base === 'claude.md' || base === 'agents.md' || base === '.cursorrules') {
    return true;
  }
  if (/\/(?:\.cursor|\.claude|\.gemini)\/rules\//i.test(norm)) {
    return true;
  }
  if (globalRulesDir) {
    const gr = path.resolve(String(globalRulesDir)).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/';
    if (norm.startsWith(gr)) return true;
  }
  return false;
}

/**
 * 规则文档去提示词注入化：仅作用于 .mdc / .cursor/rules / CLAUDE.md 等规范文档，绝不修改普通源码。
 * 严格保持原始总行数不变（不偏移行号），仅把高敏感的“系统劫持/命令式”套话软化为常规工程约定。
 */
function neutralizeRuleDocForWeb(rawContent) {
  const lines = String(rawContent || '').split(/\r?\n/);
  let inFrontmatter = false;
  if (lines.length >= 3 && lines[0].trim() === '---') {
    inFrontmatter = true;
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];
    if (inFrontmatter) {
      if (i === 0) {
        out.push('<!-- doc-meta -->');
        continue;
      }
      if (ln.trim() === '---') {
        inFrontmatter = false;
        out.push('<!-- /doc-meta -->');
        continue;
      }
      if (/^\s*(?:alwaysApply|globs|applyTo)\s*:/i.test(ln)) {
        out.push('');
        continue;
      }
    }
    ln = ln
      .replace(/[（(]\s*AI\s*必须遵循\s*[）)]/gi, '（项目工程约定）')
      .replace(/\bAI\s*必须遵循/gi, '工程约定')
      .replace(/\bAI\s*自检清单/gi, '工程核对清单')
      .replace(/\bAI\s*禁止/gi, '规范避免')
      .replace(/绝对禁止|严格禁止|严禁/g, '避免')
      .replace(/必须遵循/g, '遵循')
      .replace(/强制日志格式/g, '统一日志格式')
      .replace(/强制要求/g, '统一要求')
      .replace(/红线条款/g, '核心约束条款')
      .replace(/红线（/g, '核心约束（')
      .replace(/触发条件/g, '适用场景')
      .replace(/入口路由器/g, '索引目录')
      .replace(/开发路由器/g, '开发索引');
    out.push(ln);
  }
  return out.join('\n');
}

function extractRuleQuickTip(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').slice(0, 3200);
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !l.startsWith('#') &&
          !l.startsWith('```') &&
          !l.startsWith('|') &&
          !l.startsWith('---') &&
          !l.startsWith('<!--')
      );
    for (const l of lines) {
      const cleaned = l.replace(/^>\s*/, '').replace(/^[-*]\s*/, '').trim();
      if (cleaned.length >= 12) {
        return neutralizeRuleDocForWeb(cleaned).slice(0, 90);
      }
    }
  } catch {}
  return '';
}

function runProcess(file, args, opts) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

const IS_WIN = process.platform === 'win32';
const PWSH_EXE = IS_WIN && fs.existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  : 'pwsh';

function decodeShellOutput(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (!buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function runShell(command, opts) {
  const cmdStr = String(command || '');
  if (IS_WIN) {
    const psScript = [
      '$OutputEncoding = [Text.UTF8Encoding]::new($false)',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      cmdStr,
    ].join('\n');
    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const runWith = (exe) =>
      new Promise((resolve) => {
        execFile(
          exe,
          ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
          { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...opts, encoding: 'buffer' },
          (err, stdout, stderr) =>
            resolve({
              err,
              stdout: decodeShellOutput(stdout),
              stderr: decodeShellOutput(stderr),
            })
        );
      });
    return runWith(PWSH_EXE).then((r) => (r.err?.code === 'ENOENT' ? runWith('powershell.exe') : r));
  }

  const primaryShell = process.env.SHELL || '/bin/bash';
  const runPosix = (exe, flag) =>
    new Promise((resolve) => {
      execFile(
        exe,
        [flag, cmdStr],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, ...opts },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') })
      );
    });
  return runPosix(primaryShell, '-lc').then((r) => (r.err?.code === 'ENOENT' ? runPosix('/bin/sh', '-c') : r));
}

// 通用忽略目录集合（覆盖主流语言/框架/引擎构建产物，支持通过 bridge.config.json skipDirs 或 WEB_BRIDGE_SKIP_DIRS 追加）
const SEARCH_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.jj', '.vs', '.idea',
  'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.cache', 'coverage',
  '__pycache__', '.venv', 'venv', '.gradle',
  'Library', 'Temp', 'Obj',
  'Intermediate', 'Saved', 'Binaries', 'DerivedDataCache',
  ...(Array.isArray(bridgeConfig.skipDirs) ? bridgeConfig.skipDirs.map((s) => String(s || '').trim()).filter(Boolean) : []),
  ...String(process.env.WEB_BRIDGE_SKIP_DIRS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
]);
async function nodeSearch(pattern, searchPath, glob, maxCount = 50) {
  let re;
  try { re = new RegExp(pattern); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
  const globRe = glob
    ? new RegExp('^' + String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
    : null;
  const out = [];
  const stack = [searchPath];
  let scanned = 0;
  while (stack.length && out.length < maxCount && scanned < 30000) {
    const cur = stack.pop();
    let st;
    try { st = await fs.promises.stat(cur); } catch { continue; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch {}
      for (const e of entries) {
        if (e.isDirectory() && SEARCH_SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(cur, e.name));
      }
      continue;
    }
    if (st.size > 1024 * 1024 || (globRe && !globRe.test(path.basename(cur)))) continue;
    scanned++;
    let text;
    try { text = await fs.promises.readFile(cur, 'utf8'); } catch { continue; }
    if (text.slice(0, 1024).includes('\0')) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && out.length < maxCount; i++) {
      if (re.test(lines[i])) out.push(`${cur}:${i + 1}:${lines[i].slice(0, 240)}`);
    }
  }
  return out.join('\n');
}

function globToRegExp(glob) {
  const s = String(glob || '*').trim() || '*';
  return new RegExp('^' + s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
}

async function findFilesAsync(pattern, searchPath, maxCount = 80) {
  const raw = String(pattern || '*').trim();
  const re = raw.includes('*') || raw.includes('?') ? globToRegExp(raw) : new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const out = [];
  const stack = [searchPath];
  let visited = 0;
  while (stack.length && out.length < maxCount && visited < 40000) {
    const cur = stack.pop();
    visited++;
    let st;
    try { st = await fs.promises.stat(cur); } catch { continue; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch {}
      for (const e of entries) {
        if (e.isDirectory() && SEARCH_SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(cur, e.name));
      }
    } else if (re.test(path.basename(cur)) || re.test(cur)) {
      out.push(cur);
    }
  }
  return out;
}

const GEMINI_CONFIG_DIR = path.join(os.homedir(), '.gemini', 'config');
const GEMINI_SKILLS_DIR = path.join(GEMINI_CONFIG_DIR, 'skills');
const DEFAULT_RULES_DIR = resolveSafePath(
  process.env.WEB_BRIDGE_RULES_DIR || bridgeConfig.rulesDir || path.join(GEMINI_CONFIG_DIR, 'rules'),
  DIR
);
const MCP_CONFIG_PATH = resolveSafePath(
  process.env.WEB_BRIDGE_MCP_CONFIG || bridgeConfig.mcpConfigPath || path.join(GEMINI_CONFIG_DIR, 'mcp_config.json'),
  DIR
);
const MCP_CACHE_DIR = resolveSafePath(
  process.env.WEB_BRIDGE_MCP_CACHE_DIR || bridgeConfig.mcpCacheDir || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp'),
  DIR
);
const DEFAULT_MEMORY_DIR = resolveSafePath(
  process.env.WEB_BRIDGE_MEMORY_DIR || bridgeConfig.memoryDir || path.join(os.homedir(), '.gemini', 'memory'),
  DIR
);

function loadMcpServersConfig() {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) return {};
    const parsed = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
    return parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

function listMcpServersSummary(filterServer) {
  const servers = loadMcpServersConfig();
  const lines = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (spec?.disabled || name === 'gemini-web-agent') continue;
    if (filterServer && name !== filterServer) continue;
    const cacheDir = path.join(MCP_CACHE_DIR, name);
    let tools = [];
    try {
      if (fs.existsSync(cacheDir)) {
        tools = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
      }
    } catch {}
    lines.push(`- ${name}: ${tools.length ? tools.join(', ') : '(无本地缓存 schema，可直接 mcp_call 尝试或查 mcp_config.json)'}`);
    if (filterServer && tools.length) {
      lines.push(`  Schema 目录: ${cacheDir}（可用 read_file 读取 <tool>.json 参数定义）`);
    }
  }
  return lines.length ? lines.join('\n') : '未找到匹配的已启用 MCP 服务';
}

function parseJsonOrSse(text, contentType = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (!contentType.includes('text/event-stream') && (raw.startsWith('{') || raw.startsWith('['))) {
    try { return JSON.parse(raw); } catch {}
  }
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try { last = JSON.parse(payload); } catch {}
      }
    }
  }
  return last;
}

// 外部编辑器或重计算类 MCP 工具可能耗时较长，给足 180s
const MCP_CALL_TIMEOUT_MS = 180000;

async function callMcpToolOnce(serverName, toolName, toolArgs = {}) {
  const servers = loadMcpServersConfig();
  const spec = servers[serverName];
  if (!spec || spec.disabled) throw new Error(`未找到或已禁用的 MCP 服务: ${serverName}`);
  const httpUrl = spec._bridgeUrl || spec.serverUrl || spec.url || '';

  const initPayload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gemini-web-bridge', version: '2.4' } },
  };
  const callPayload = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: toolArgs || {} },
  };

  if (httpUrl) {
    let sessionId = '';
    const postHttp = async (bodyObj) => {
      const r = await fetch(httpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(MCP_CALL_TIMEOUT_MS),
      });
      const sid = r.headers.get('mcp-session-id');
      if (sid) sessionId = sid;
      const txt = await r.text();
      return parseJsonOrSse(txt, r.headers.get('content-type') || '');
    };
    await postHttp(initPayload).catch(() => null);
    await postHttp({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }).catch(() => null);
    const res = await postHttp(callPayload);
    if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
    return res?.result ?? res;
  }

  if (!spec.command) throw new Error(`MCP "${serverName}" 缺少 command 或 url`);
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.command, Array.isArray(spec.args) ? spec.args : [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(spec.env || {}) },
    });
    let done = false;
    let buf = '';
    let errBuf = '';
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(
      () => finish(new Error(`MCP ${serverName}.${toolName} 调用超时 (${MCP_CALL_TIMEOUT_MS / 1000}s): ${errBuf.slice(-300)}`)),
      MCP_CALL_TIMEOUT_MS
    );
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      if (!done) finish(new Error(`MCP 进程提前退出 (code=${code}): ${errBuf.slice(-400)}`));
    });
    child.stderr.on('data', (d) => { errBuf += String(d); });
    child.stdout.on('data', (d) => {
      buf += String(d);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify(callPayload) + '\n');
          } catch (e) { finish(e); }
        } else if (msg.id === 2) {
          if (msg.error) finish(new Error(msg.error.message || JSON.stringify(msg.error)));
          else finish(null, msg.result);
        }
      }
    });
    try { child.stdin.write(JSON.stringify(initPayload) + '\n'); } catch (e) { finish(e); }
  });
}

const PARALLEL_LOCAL_TOOLS = new Set([
  'get_context',
  'read_file',
  'list_dir',
  'search_code',
  'find_files',
  'mcp_list',
  'web_subagent',
]);
const READ_TOOL_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.WEB_READ_TOOL_CONCURRENCY || 6)));

async function runWithConcurrency(items, limit, worker) {
  const cap = Math.max(1, Math.min(limit, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: cap }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function summarizeInitialToolTitle(toolName, rawArgs) {
  if (toolName === 'get_context') {
    const kind = String(rawArgs.kind || rawArgs.type || rawArgs.scope || 'all').trim();
    const q = String(rawArgs.query || rawArgs.filter || '').trim();
    return q ? `${kind} (${q.slice(0, 32)})` : kind;
  }
  if (toolName === 'web_subagent') {
    return String(rawArgs.role || rawArgs.Role || rawArgs.title || rawArgs.name || 'Subagent').trim().slice(0, 60);
  }
  return (
    rawArgs.path ||
    rawArgs.Path ||
    rawArgs.pattern ||
    rawArgs.query ||
    rawArgs.Query ||
    rawArgs.command ||
    rawArgs.CommandLine ||
    (rawArgs.server ? `${rawArgs.server}:${rawArgs.mcpTool || rawArgs.ToolName || ''}` : toolName)
  );
}

class LocalToolExecutor {
  static async executeOne(rawSpec, cwd, execContext = {}) {
    const toolName = String(rawSpec?.tool || rawSpec?.name || '').trim();
    const args = rawSpec?.args && typeof rawSpec.args === 'object' ? rawSpec.args : rawSpec || {};
    const workCwd = cwd || state.cwd || DEFAULT_CWD;
    const rawPath = args.path || args.Path || args.file || '';
    const targetPath = rawPath ? resolveSafePath(rawPath, workCwd) : '';

    try {
      const perm = evaluateToolPermission(toolName, args, execContext);
      if (!perm.allowed) {
        if (execContext.parentTask?.sessionId) {
          appendSessionEvent(execContext.parentTask.sessionId, 'tool_blocked', {
            tool: toolName,
            code: perm.code,
            uiMode: execContext.uiMode || execContext.parentTask.uiMode,
          });
        }
        return {
          ok: false,
          tool: toolName,
          title:
            rawPath ||
            (toolName === 'run_command' ? String(args.command || args.CommandLine || '').slice(0, 60) : toolName),
          output: perm.reason || `当前模式禁止调用 ${toolName}`,
        };
      }

      if (requiresAskModeApproval(toolName, args, execContext)) {
        const approvalTitle = summarizeInitialToolTitle(toolName, args);
        const decisionRes = await requestWebTaskApproval(
          execContext.parentTask,
          { toolName, title: approvalTitle, args },
          execContext.isCancelled
        );
        if (decisionRes.decision === 'cancelled') {
          return {
            ok: false,
            cancelled: true,
            tool: toolName,
            title: approvalTitle,
            output: '任务已取消',
          };
        }
        if (decisionRes.decision !== 'allow') {
          return {
            ok: false,
            tool: toolName,
            title: approvalTitle,
            output: `用户已拒绝在 Ask 模式下执行 ${toolName} (${approvalTitle})。请不要强行重试相同写入操作，先调整方案或向用户确认下一步。`,
          };
        }
      }

      if (toolName === 'read_file') {
        if (!targetPath) {
          return { ok: false, tool: toolName, title: rawPath || 'read_file', output: `文件不存在: ${targetPath}` };
        }
        let stat;
        try {
          stat = await fs.promises.stat(targetPath);
        } catch {
          return { ok: false, tool: toolName, title: rawPath || 'read_file', output: `文件不存在: ${targetPath}` };
        }
        if (stat.isDirectory()) {
          return { ok: false, tool: toolName, title: rawPath, output: `目标是目录而非文件: ${targetPath}，请使用 list_dir` };
        }
        const rawContent = await fs.promises.readFile(targetPath, 'utf8');
        const rulesDirOpt = execContext.protocolOpts?.rulesDir || execContext.parentTask?.protocolOpts?.rulesDir || DEFAULT_RULES_DIR;
        const ruleDocNormalized = isRuleDocPath(targetPath, workCwd, rulesDirOpt);
        const content = ruleDocNormalized ? neutralizeRuleDocForWeb(rawContent) : rawContent;
        const lines = content.split(/\r?\n/);
        const startLine = Math.max(1, Number(args.startLine || args.StartLine || 1));
        const maxLines = 1200;
        const requestedEnd = Number(args.endLine || args.EndLine || startLine + 249);
        const endLine = Math.min(lines.length, Math.min(requestedEnd, startLine + maxLines - 1));
        const numbered = lines
          .slice(startLine - 1, endLine)
          .map((line, idx) => `${startLine + idx}: ${line}`)
          .join('\n');
        return {
          ok: true,
          tool: toolName,
          title: `${path.basename(targetPath)}:${startLine}-${endLine}`,
          args: { Path: targetPath, StartLine: startLine, EndLine: endLine },
          output: `文件: ${targetPath} (行 ${startLine}-${endLine} / 共 ${lines.length} 行)\n${numbered}`,
          readMeta: {
            targetPath,
            startLine,
            endLine,
            totalLines: lines.length,
          },
        };
      }

      if (toolName === 'list_dir') {
        const dirPath = targetPath || workCwd;
        let allEntries;
        try {
          allEntries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        } catch {
          return { ok: false, tool: toolName, title: rawPath || dirPath, output: `目录不存在: ${dirPath}` };
        }
        const limit = 250;
        const entries = allEntries.slice(0, limit);
        const formatted = entries
          .map((d) => `${d.isDirectory() ? '[DIR]  ' : '[FILE] '}${d.name}`)
          .join('\n');
        const truncNote =
          allEntries.length > limit
            ? `\n...(共 ${allEntries.length} 项，仅显示前 ${limit} 项；如需查找特定文件请使用 find_files)`
            : '';
        return {
          ok: true,
          tool: toolName,
          title: path.basename(dirPath) || dirPath,
          args: { Path: dirPath },
          output: `目录 (${dirPath}) 共 ${allEntries.length} 项:\n${formatted}${truncNote}`,
        };
      }

      if (toolName === 'search_code') {
        const pattern = String(args.pattern || args.query || args.Query || '').trim();
        const searchDir = targetPath || workCwd;
        if (!pattern) {
          return { ok: false, tool: toolName, title: 'search_code', output: '缺少 pattern / query 参数' };
        }
        const maxCount = Math.max(1, Math.min(500, Number(args.maxCount || args.max_count || 80)));
        const rgArgs = ['-n', `--max-count=${maxCount}`, '--max-columns=240'];
        if (args.glob) {
          rgArgs.push('-g', String(args.glob));
        }
        rgArgs.push('--', pattern, searchDir);
        // 异步执行：同步子进程会阻塞整个 Bridge 事件循环，导致 VS Code 轮询超时报错
        const r = await runProcess('rg', rgArgs, { cwd: workCwd, timeout: 60000 });
        const out =
          r.err?.code === 'ENOENT'
            ? await nodeSearch(pattern, searchDir, args.glob, maxCount)
            : r.stdout || (r.err ? '未找到匹配结果' : '');
        const trimmed = String(out || '').trim().slice(0, 16000);
        return {
          ok: true,
          tool: toolName,
          title: pattern,
          args: { Query: pattern, Path: searchDir },
          output: `搜索 "${pattern}" (${searchDir}):\n${trimmed || '无匹配项'}`,
        };
      }

      if (toolName === 'edit_file') {
        if (!targetPath || !fs.existsSync(targetPath)) {
          return { ok: false, tool: toolName, title: rawPath || 'edit_file', output: `文件不存在: ${targetPath}` };
        }
        const before = fs.readFileSync(targetPath, 'utf8');
        const target = String(args.target ?? args.Target ?? args.old_string ?? args.oldText ?? '');
        const replacement = String(args.replacement ?? args.Replacement ?? args.new_string ?? args.newText ?? '');
        if (!target) {
          return { ok: false, tool: toolName, title: path.basename(targetPath), output: 'edit_file 缺少 target 参数' };
        }
        let actualTarget = target;
        let actualReplacement = replacement;
        if (!before.includes(actualTarget)) {
          const eol = before.includes('\r\n') ? '\r\n' : '\n';
          const normalizedTarget = target.replace(/\r\n|\r|\n/g, eol);
          if (normalizedTarget !== target && before.includes(normalizedTarget)) {
            actualTarget = normalizedTarget;
            actualReplacement = replacement.replace(/\r\n|\r|\n/g, eol);
          } else {
            return {
              ok: false,
              tool: toolName,
              title: path.basename(targetPath),
              output: `edit_file 失败：在 ${targetPath} 中未找到完全匹配的 target 片段，请先用 read_file 确认原文`,
            };
          }
        }
        const after = before.split(actualTarget).join(actualReplacement);
        fs.writeFileSync(targetPath, after, 'utf8');
        if (execContext.parentTask?.sessionId && !execContext.isSubagent) {
          try {
            recordTouchedFile(execContext.parentTask.sessionId, toDisplayPath(targetPath), execContext.uiMode);
          } catch (_) {}
        }
        return {
          ok: true,
          tool: toolName,
          title: path.basename(targetPath),
          args: { Path: targetPath, Target: target, Replacement: replacement },
          output: `已成功修改文件: ${targetPath}`,
        };
      }

      if (toolName === 'write_file') {
        if (!targetPath) {
          return { ok: false, tool: toolName, title: 'write_file', output: 'write_file 缺少 path 参数' };
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const content = String(args.content ?? args.Content ?? '');
        fs.writeFileSync(targetPath, content, 'utf8');
        if (execContext.parentTask?.sessionId && !execContext.isSubagent) {
          try {
            recordTouchedFile(execContext.parentTask.sessionId, toDisplayPath(targetPath), execContext.uiMode);
          } catch (_) {}
        }
        return {
          ok: true,
          tool: toolName,
          title: path.basename(targetPath),
          args: { Path: targetPath, Content: content },
          output: `已成功写入文件: ${targetPath} (${content.length} 字符)`,
        };
      }

      if (toolName === 'update_plan') {
        const sid = execContext.parentTask?.sessionId || execContext.sessionId || 'default';
        const planArg = Array.isArray(args.plan) ? args.plan : (Array.isArray(args.steps) ? args.steps : undefined);
        const st = applyUpdatePlan(sid, { ...args, plan: planArg }, execContext.uiMode);
        const entries = toClientPlanEntries(st);
        if (execContext.parentTask) {
          execContext.parentTask.planEntries = entries;
          execContext.parentTask.updatedAt = Date.now();
        }
        appendSessionEvent(sid, 'plan_updated', {
          requestId: execContext.parentTask?.requestId || '',
          stepCount: entries.length,
          completedCount: entries.filter((e) => e.status === 'completed').length,
        });
        return {
          ok: true,
          tool: toolName,
          title: `更新任务进度 (${entries.length} 步)`,
          args: { goal: st.goal, plan: st.plan },
          output: `已更新本地任务状态机（共 ${entries.length} 步，已完成 ${entries.filter((e) => e.status === 'completed').length} 步）。`,
        };
      }

      if (toolName === 'run_command') {
        const command = String(args.command || args.CommandLine || '').trim();
        if (!command) {
          return { ok: false, tool: toolName, title: 'run_command', output: 'run_command 缺少 command 参数' };
        }
        const cmdCwd = args.cwd ? resolveSafePath(args.cwd, workCwd) : workCwd;
        // 默认 180s，最长 600s（编译 / 脚本 / 慢命令）；工具在后台跑，不阻塞 Bridge
        const timeoutMs = Math.min(600000, Math.max(3000, Number(args.timeoutMs || 180000)));
        const r = await runShell(command, { cwd: cmdCwd, timeout: timeoutMs });
        const stdoutText = String(r.stdout || '').trim();
        const stderrText = String(r.stderr || '').trim();
        const errHead = r.err
          ? `[Exit Code ${r.err.code ?? r.err.signal ?? 'ERR'}]${r.err.killed ? ' (killed/timeout)' : ''}`
          : '';
        const errDetail = r.err && !stdoutText && !stderrText ? ` ${r.err.message}` : '';
        const out = r.err
          ? [errHead + errDetail, stdoutText, stderrText].filter(Boolean).join('\n')
          : [r.stdout, r.stderr].filter((s) => String(s || '').trim()).join('\n');
        return {
          ok: !r.err,
          tool: toolName,
          title: command.slice(0, 60),
          args: { CommandLine: command, Cwd: cmdCwd },
          output: `命令执行结果 (${command}):\n${String(out || '(无输出)').slice(0, 16000)}`,
        };
      }

      if (toolName === 'find_files') {
        const searchDir = targetPath || workCwd;
        const pat = String(args.pattern || args.glob || args.query || '*').trim();
        const found = await findFilesAsync(pat, searchDir);
        const rels = found.map((f) => {
          const rel = path.relative(workCwd, f);
          return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : f;
        });
        return {
          ok: true,
          tool: toolName,
          title: pat,
          args: { Pattern: pat, Path: searchDir },
          output: `按路径模式搜索 "${pat}" (${searchDir})，命中 ${rels.length} 个:\n${rels.join('\n') || '无匹配文件'}`,
        };
      }

      if (toolName === 'mcp_list') {
        const server = String(args.server || args.ServerName || '').trim();
        return {
          ok: true,
          tool: toolName,
          title: server || 'MCP Servers',
          args: { Server: server },
          output: listMcpServersSummary(server),
        };
      }

      if (toolName === 'mcp_call') {
        const serverName = String(args.server || args.ServerName || '').trim();
        const mcpTool = String(args.mcpTool || args.toolName || args.ToolName || args.method || '').trim();
        const mcpArgs = args.args || args.Arguments || args.arguments || {};
        if (!serverName || !mcpTool) {
          return { ok: false, tool: toolName, title: 'mcp_call', output: 'mcp_call 需要 server 与 mcpTool (或 args.ToolName) 参数' };
        }
        const res = await callMcpToolOnce(serverName, mcpTool, mcpArgs);
        const txt = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
        return {
          ok: true,
          tool: toolName,
          title: `${serverName}:${mcpTool}`,
          args: { ServerName: serverName, ToolName: mcpTool },
          output: `MCP [${serverName}.${mcpTool}] 返回:\n${String(txt || '').slice(0, 20000)}`,
        };
      }

      if (toolName === 'get_context') {
        const kind = String(args.kind || args.type || args.scope || 'all').trim().toLowerCase() || 'all';
        const query = String(args.query || args.filter || args.topic || '').trim();
        const opts = execContext.protocolOpts || execContext.parentTask?.protocolOpts || {};
        const output = buildContextQueryOutput(workCwd, opts, kind, query);
        return {
          ok: true,
          tool: toolName,
          title: query ? `${kind} (${query.slice(0, 32)})` : kind,
          args: { kind, ...(query ? { query } : {}) },
          output,
        };
      }

      if (toolName === 'web_subagent') {
        return await runWebSubagentTool(args, workCwd, execContext);
      }

      return {
        ok: false,
        tool: toolName || 'unknown',
        title: toolName || 'unknown',
        output: `未知的本地工具 "${toolName}"，可用工具: get_context, read_file, edit_file, write_file, search_code, find_files, list_dir, run_command, mcp_list, mcp_call, web_subagent`,
      };
    } catch (err) {
      return {
        ok: false,
        tool: toolName || 'error',
        title: toolName || 'error',
        output: `工具执行异常 (${toolName}): ${err.message}`,
      };
    }
  }

  static formatOutputForBudget(entry, budgetChars) {
    const raw = String(entry?.output || '');
    if (raw.length <= budgetChars) return raw;

    // 对 read_file 按完整行边界优雅截断，并重写精确止行和续读 startLine，避免模型猜行号重复读同一段
    if (entry?.tool === 'read_file' && entry?.readMeta) {
      const { targetPath, startLine, totalLines } = entry.readMeta;
      const allLines = raw.split('\n');
      const bodyLines = allLines.slice(1);
      const reserveChars = 190 + String(targetPath || '').length;
      const bodyBudget = Math.max(400, budgetChars - reserveChars);
      const kept = [];
      let used = 0;
      let actualEndLine = startLine - 1;
      for (let i = 0; i < bodyLines.length; i++) {
        const ln = bodyLines[i];
        const addLen = ln.length + (kept.length ? 1 : 0);
        if (kept.length > 0 && used + addLen > bodyBudget) break;
        if (kept.length === 0 && ln.length > bodyBudget) {
          kept.push(ln.slice(0, bodyBudget) + '...(单行过长已截断)');
          actualEndLine = startLine + i;
          break;
        }
        kept.push(ln);
        used += addLen;
        actualEndLine = startLine + i;
      }
      const nextLine = actualEndLine + 1;
      const header = `文件: ${targetPath} (已返回行 ${startLine}-${actualEndLine} / 共 ${totalLines} 行)`;
      const footer =
        nextLine <= totalLines
          ? `\n...(本批单次配额已达上限，如需续读请从 startLine: ${nextLine} 开始)`
          : '';
      return `${header}\n${kept.join('\n')}${footer}`;
    }

    const tailNote = '\n...(单工具输出过长已截断，可缩小范围或分段查询)';
    const sliceLimit = Math.max(300, budgetChars - tailNote.length);
    const sliced = raw.slice(0, sliceLimit);
    const lastNl = sliced.lastIndexOf('\n');
    const clean = lastNl > sliceLimit * 0.6 ? sliced.slice(0, lastNl) : sliced;
    return clean + tailNote;
  }

  static assembleBatchResults(entries) {
    const valid = entries.filter(Boolean);
    if (!valid.length) return '';

    const hasSubagent = valid.some((e) => e.tool === 'web_subagent');
    const totalBatchBudget = hasSubagent ? 24000 : 20000;
    const perToolMaxCap = (e) => (e.tool === 'web_subagent' ? 16000 : 10000);
    const headerOf = (e) =>
      e.statusTag === 'ok'
        ? `[${e.idx + 1}] ${e.tool}\n`
        : `[${e.idx + 1}] ${e.tool} (${e.statusTag === 'cancelled' ? '已取消' : '未命中/失败'})\n`;

    // 先做单工具上限裁剪，再估算总开销
    const overhead = valid.reduce((sum, e) => sum + headerOf(e).length + 2, 0);
    const usableTotal = Math.max(3000, totalBatchBudget - overhead);

    // 两段式弹性分摊：短输出原样保留，剩余预算公平分给超长工具，避免排在后面的工具被整段切没
    const budgets = new Map();
    const pending = valid.map((e) => ({
      entry: e,
      desired: Math.min(String(e.output || '').length, perToolMaxCap(e)),
    }));
    let remainingBudget = usableTotal;
    let remainingItems = pending.slice();

    while (remainingItems.length > 0) {
      const fairShare = Math.max(600, Math.floor(remainingBudget / remainingItems.length));
      const fits = [];
      const over = [];
      for (const item of remainingItems) {
        if (item.desired <= fairShare) fits.push(item);
        else over.push(item);
      }
      if (!fits.length) {
        for (const item of over) {
          budgets.set(item.entry.idx, Math.min(perToolMaxCap(item.entry), fairShare));
        }
        break;
      }
      for (const item of fits) {
        budgets.set(item.entry.idx, item.desired);
        remainingBudget = Math.max(0, remainingBudget - item.desired);
      }
      remainingItems = over;
    }

    return valid
      .map((e) => {
        const cap = budgets.get(e.idx) ?? Math.min(perToolMaxCap(e), usableTotal);
        const body = LocalToolExecutor.formatOutputForBudget(e, cap);
        return `${headerOf(e)}${body}`;
      })
      .join('\n\n');
  }

  static async executeBatch(toolSpecs, cwd, onProgress, execContext = {}) {
    const specs = Array.isArray(toolSpecs) ? toolSpecs : [toolSpecs];
    const orderedEntries = new Array(specs.length);

    const runIndexedSpec = async (spec, idx) => {
      if (execContext.isCancelled && execContext.isCancelled()) {
        const cancelledName = String(spec?.tool || spec?.name || 'tool').trim();
        orderedEntries[idx] = {
          idx,
          tool: cancelledName,
          statusTag: 'cancelled',
          output: '任务已取消',
        };
        return;
      }

      const toolId = `lt_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`;
      const toolName = String(spec?.tool || spec?.name || 'tool').trim();
      const rawArgs = spec?.args && typeof spec.args === 'object' ? spec.args : spec || {};
      let progressSeq = 0;

      const reportProgress = (patch) => {
        if (!onProgress) return;
        progressSeq += 1;
        onProgress({
          id: toolId,
          toolCallId: toolId,
          name: patch.name || toolName,
          title: patch.title || summarizeInitialToolTitle(toolName, rawArgs),
          status: patch.status || 'in_progress',
          args: patch.args || rawArgs,
          progressSeq,
        });
      };

      reportProgress({
        name: toolName,
        title: summarizeInitialToolTitle(toolName, rawArgs),
        status: 'in_progress',
        args: rawArgs,
      });

      const res = await LocalToolExecutor.executeOne(spec, cwd, {
        ...execContext,
        toolId,
        onToolProgress: reportProgress,
      });

      reportProgress({
        name: res.tool,
        title: res.title,
        status: res.ok ? 'completed' : res.cancelled ? 'cancelled' : 'failed',
        args: res.args || rawArgs,
      });

      orderedEntries[idx] = {
        idx,
        tool: res.tool,
        statusTag: res.ok ? 'ok' : 'error',
        output: String(res.output || ''),
        readMeta: res.readMeta || null,
        rawResult: res,
      };
    };

    // 按原有顺序分段：连续的只读/子代理工具组内并发，遇到有副作用工具（edit/write/run_command/mcp_call）作为有序屏障串行执行
    let cursor = 0;
    while (cursor < specs.length) {
      if (execContext.isCancelled && execContext.isCancelled()) break;
      const firstTool = String(specs[cursor]?.tool || specs[cursor]?.name || '').trim();
      if (PARALLEL_LOCAL_TOOLS.has(firstTool)) {
        const group = [];
        while (cursor < specs.length) {
          const tn = String(specs[cursor]?.tool || specs[cursor]?.name || '').trim();
          if (!PARALLEL_LOCAL_TOOLS.has(tn)) break;
          group.push({ spec: specs[cursor], idx: cursor });
          cursor += 1;
        }
        if (group.length === 1) {
          await runIndexedSpec(group[0].spec, group[0].idx);
        } else {
          log(`[LocalTool] 并发执行 ${group.length} 个只读/子代理工具: ${group.map((g) => g.spec?.tool || g.spec?.name).join(', ')}`);
          await runWithConcurrency(group, READ_TOOL_CONCURRENCY, ({ spec, idx }) => runIndexedSpec(spec, idx));
        }
      } else {
        await runIndexedSpec(specs[cursor], cursor);
        cursor += 1;
      }
    }

    if (typeof execContext.onBatchResults === 'function') {
      try {
        execContext.onBatchResults(orderedEntries.filter(Boolean).map((e) => e.rawResult).filter(Boolean));
      } catch {}
    }
    return LocalToolExecutor.assembleBatchResults(orderedEntries);
  }
}

// ─── 改造 2：解析网页返回的 json:local-tool 或 # @local-agent 工具调用块 ───
function getSkillSearchDirs(workCwd, explicitDirs) {
  let rawList = null;
  if (Array.isArray(explicitDirs)) {
    rawList = explicitDirs;
  } else if (process.env.WEB_BRIDGE_SKILL_DIRS) {
    rawList = String(process.env.WEB_BRIDGE_SKILL_DIRS).split(path.delimiter);
  } else if (Array.isArray(bridgeConfig.skillDirs)) {
    rawList = bridgeConfig.skillDirs;
  } else {
    rawList = [GEMINI_SKILLS_DIR];
  }

  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const trimmed = String(item || '').trim();
    if (!trimmed) continue;
    const resolved = resolveSafePath(trimmed, workCwd || DEFAULT_CWD);
    const key = IS_WIN ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(resolved);
    }
  }
  return out;
}

function getInstalledSkillNames(workCwd, explicitDirs) {
  const names = [];
  const seen = new Set();
  for (const dir of getSkillSearchDirs(workCwd, explicitDirs)) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if ((!d.isDirectory() && !d.isSymbolicLink()) || seen.has(d.name)) continue;
        if (fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) {
          seen.add(d.name);
          names.push(d.name);
        }
      }
    } catch {}
  }
  return names;
}

function getEnabledMcpNames() {
  return Object.entries(loadMcpServersConfig())
    .filter(([n, s]) => !s?.disabled && n !== 'gemini-web-agent')
    .map(([n]) => n);
}

const LOCAL_TOOL_INDEX_FILE = resolveSafePath(
  process.env.WEB_BRIDGE_TOOL_INDEX || bridgeConfig.toolIndexFile || path.join(DIR, 'LOCAL_TOOL_INDEX.md'),
  DIR
);

function loadLocalToolIndexMarkdown(workCwd) {
  try {
    if (!fs.existsSync(LOCAL_TOOL_INDEX_FILE)) return '';
    let md = fs.readFileSync(LOCAL_TOOL_INDEX_FILE, 'utf8').trim();
    if (workCwd) {
      const normCwd = toDisplayPath(workCwd);
      md = md.replace(/\$\{WORKSPACE\}/g, normCwd);
    }
    return normalizeHomePathsInText(md);
  } catch {
    return '';
  }
}

function toContextPath(absPath, workCwd) {
  const full = path.resolve(String(absPath || ''));
  if (workCwd) {
    const base = path.resolve(String(workCwd));
    const rel = path.relative(base, full);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, '/');
    }
  }
  return toDisplayPath(full);
}

function extractMarkdownFrontmatterMeta(filePath, fallbackTitle = '') {
  const meta = { description: '', alwaysApply: false, title: fallbackTitle };
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const head = raw.slice(0, 2400);
    const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const yaml = fm[1];
      const descM = yaml.match(/^[ \t]*description[ \t]*:[ \t]*([^\r\n]+)$/m);
      if (descM) {
        meta.description = descM[1].trim().replace(/^['"]|['"]$/g, '').slice(0, 140);
      }
      const aaM = yaml.match(/^[ \t]*alwaysApply[ \t]*:[ \t]*(true|false)/im);
      if (aaM) meta.alwaysApply = aaM[1].toLowerCase() === 'true';
    }
    const body = fm ? head.slice(fm[0].length) : head;
    const h1 = body.match(/^[ \t]*#[ \t]+([^\r\n]+)$/m);
    if (h1) meta.title = h1[1].trim().slice(0, 120);
  } catch {}
  return meta;
}

function listMarkdownFilesShallow(dir, maxDepth = 2, out = [], depth = 0) {
  if (!dir || depth > maxDepth) return out;
  try {
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.') && depth > 0) continue;
      const full = path.join(dir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (!isDir && !isFile && ent.isSymbolicLink()) {
        try {
          const st = fs.statSync(full);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {}
      }
      if (isDir) {
        if (depth < maxDepth) listMarkdownFilesShallow(full, maxDepth, out, depth + 1);
      } else if (isFile && /\.(md|mdc|txt)$/i.test(ent.name)) {
        out.push(full);
      }
    }
  } catch {}
  return out;
}

function toClaudeProjectSlug(dirPath) {
  return path.resolve(String(dirPath || '')).replace(/[^a-zA-Z0-9]/g, '-');
}

function findClaudeProjectMemoryDirs(workCwd) {
  const dirs = [];
  if (!workCwd) return dirs;
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    if (!fs.existsSync(projectsRoot)) return dirs;
    const entries = fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink());
    const byLower = new Map(entries.map((d) => [d.name.toLowerCase(), d.name]));
    let cur = path.resolve(String(workCwd));
    const seen = new Set();
    for (let up = 0; up < 4; up += 1) {
      const slug = toClaudeProjectSlug(cur).toLowerCase();
      const matchedName = byLower.get(slug);
      if (matchedName && !seen.has(matchedName)) {
        seen.add(matchedName);
        const memDir = path.join(projectsRoot, matchedName, 'memory');
        if (fs.existsSync(memDir)) dirs.push(memDir);
      }
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      cur = parent;
    }
  } catch {}
  return dirs;
}

function resolveMemoryDirs(workCwd, explicitMemoryDir) {
  const primaryWriteDir = resolveSafePath(explicitMemoryDir || DEFAULT_MEMORY_DIR, workCwd || DEFAULT_CWD);
  const candidates = [primaryWriteDir];
  if (workCwd) {
    candidates.push(path.join(workCwd, '.gemini', 'memory'));
    candidates.push(path.join(workCwd, '.claude', 'memory'));
  }
  candidates.push(...findClaudeProjectMemoryDirs(workCwd));

  const readDirs = [];
  const seen = new Set();
  for (const d of candidates) {
    if (!d) continue;
    const resolved = path.resolve(d);
    const key = IS_WIN ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    readDirs.push(resolved);
  }
  return { primaryWriteDir, readDirs };
}

function matchesQuery(text, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = String(text || '').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((tok) => hay.includes(tok));
}

function listRuleEntries(workCwd, opts = {}) {
  const globalRulesDir = opts.rulesDir ? resolveSafePath(opts.rulesDir, workCwd) : DEFAULT_RULES_DIR;
  const searchDirs = [];
  const seenDir = new Set();
  const addDir = (label, dirPath) => {
    if (!dirPath) return;
    const resolved = path.resolve(dirPath);
    const key = IS_WIN ? resolved.toLowerCase() : resolved;
    if (seenDir.has(key)) return;
    seenDir.add(key);
    if (fs.existsSync(resolved)) searchDirs.push({ label, dir: resolved });
  };

  if (workCwd) {
    addDir('workspace/.cursor/rules', path.join(workCwd, '.cursor', 'rules'));
    addDir('workspace/.claude/rules', path.join(workCwd, '.claude', 'rules'));
    addDir('workspace/.gemini/rules', path.join(workCwd, '.gemini', 'rules'));
  }
  addDir('global rulesDir', globalRulesDir);

  const items = [];
  const seenFile = new Set();

  if (workCwd) {
    for (const rootDoc of ['CLAUDE.md', 'AGENTS.md', '.cursorrules']) {
      const p = path.join(workCwd, rootDoc);
      if (fs.existsSync(p)) {
        const key = IS_WIN ? p.toLowerCase() : p;
        seenFile.add(key);
        const meta = extractMarkdownFrontmatterMeta(p, rootDoc);
        items.push({
          scope: 'workspace',
          path: toContextPath(p, workCwd),
          title: meta.title || rootDoc,
          description: meta.description,
          alwaysApply: true,
        });
      }
    }
  }

  for (const { label, dir } of searchDirs) {
    const files = listMarkdownFilesShallow(dir, 2);
    for (const f of files) {
      const key = IS_WIN ? f.toLowerCase() : f;
      if (seenFile.has(key)) continue;
      seenFile.add(key);
      const meta = extractMarkdownFrontmatterMeta(f, path.basename(f));
      const tip = !meta.description ? extractRuleQuickTip(f) : '';
      items.push({
        scope: label,
        path: toContextPath(f, workCwd),
        title: neutralizeRuleDocForWeb(meta.title || path.basename(f)),
        description: neutralizeRuleDocForWeb(meta.description || tip),
        alwaysApply: meta.alwaysApply,
      });
    }
  }

  return { globalRulesDir, items };
}

function collectRulesSummary(workCwd, opts = {}, query = '') {
  const { globalRulesDir, items } = listRuleEntries(workCwd, opts);
  const filtered = rankContextEntriesByQuery(
    items.filter((it) => matchesQuery(`${it.path} ${it.title} ${it.description}`, query)),
    query
  );
  if (!filtered.length) {
    return [
      '### 规则索引 (rules)',
      query
        ? `未找到匹配 "${query}" 的规则文件（共扫描 ${items.length} 份规则；全局规则目录: \`${toDisplayPath(globalRulesDir)}\`）。`
        : `当前未发现规则文件（全局规则目录: \`${toDisplayPath(globalRulesDir)}\`）。`,
    ].join('\n');
  }

  const lines = [
    `### 规则索引 (rules · 共 ${filtered.length}${query ? ` / ${items.length}` : ''} 条；仅按当前任务需要读取最相关的 1~2 份即可，不必一次读取全部文档)`,
  ];
  for (const it of filtered.slice(0, 60)) {
    const tag = it.alwaysApply ? '[常驻] ' : '';
    const desc = it.description && it.description !== it.title ? `${it.title}：${it.description}` : it.description || it.title;
    lines.push(`- ${tag}\`${it.path}\`${desc ? ` — ${desc}` : ''}`);
  }
  if (filtered.length > 60) {
    lines.push(`...(其余 ${filtered.length - 60} 条已省略，可传 query 关键词筛选)`);
  }
  return lines.join('\n');
}

function listMemoryEntries(workCwd, opts = {}) {
  const { primaryWriteDir, readDirs } = resolveMemoryDirs(workCwd, opts.memoryDir);
  const entries = [];
  const indexFiles = [];
  for (const dir of readDirs) {
    if (!fs.existsSync(dir)) continue;
    const isPrimary = path.resolve(dir).toLowerCase() === path.resolve(primaryWriteDir).toLowerCase();
    const files = listMarkdownFilesShallow(dir, 2);
    if (!files.length) continue;
    const indexFile = files.find((f) => path.basename(f).toLowerCase() === 'memory.md');
    if (indexFile) indexFiles.push(indexFile);
    for (const f of files) {
      const rel = toContextPath(f, workCwd);
      const meta = extractMarkdownFrontmatterMeta(f, path.basename(f));
      entries.push({
        path: rel,
        title: meta.title || path.basename(f),
        description: meta.description || meta.title || '',
        isPrimary,
        isIndex: path.basename(f).toLowerCase() === 'memory.md',
      });
    }
  }
  return { primaryWriteDir, entries, indexFiles };
}

function collectMemorySummary(workCwd, opts = {}, query = '') {
  const { primaryWriteDir, entries, indexFiles } = listMemoryEntries(workCwd, opts);
  const lines = [
    '### 记忆索引 (memory)',
    `- 独立写入目录（新增/更新长期记忆请使用 write_file/edit_file 写入此处）: \`${toDisplayPath(primaryWriteDir)}\``,
  ];

  const totalFiles = entries.length;
  const matched = rankContextEntriesByQuery(
    entries.filter((e) => matchesQuery(`${e.path} ${e.title} ${e.description}`, query)),
    query
  );

  if (!query) {
    for (const indexFile of indexFiles) {
      try {
        const raw = normalizeHomePathsInText(fs.readFileSync(indexFile, 'utf8').trim());
        if (raw) {
          const preview = raw.length > 1400 ? raw.slice(0, 1400) + '\n...(索引已截断，完整内容请 read_file 读取)' : raw;
          lines.push(`\n#### 索引摘要 \`${toContextPath(indexFile, workCwd)}\`\n${preview}`);
        }
      } catch {}
    }
  }

  if (matched.length) {
    const cap = query ? 40 : 35;
    lines.push(`\n#### 可读取的记忆文件 (${matched.length}${query ? ` / ${totalFiles}` : ''})`);
    for (const e of matched.slice(0, cap)) {
      const tag = e.isPrimary ? '主写' : '兼容只读';
      lines.push(`- [${tag}] \`${e.path}\`${e.description ? ` — ${e.description}` : ''}`);
    }
    if (matched.length > cap) {
      lines.push(`...(其余 ${matched.length - cap} 条已省略，建议传 query 关键词精准筛选)`);
    }
  } else {
    lines.push(
      query
        ? `未找到匹配 "${query}" 的记忆文件（共 ${totalFiles} 个文件）。`
        : '当前尚无记忆文件；需要持久化记录时可直接用 write_file 写入上述独立写入目录。'
    );
  }
  return lines.join('\n');
}

function collectSkillsSummary(workCwd, opts = {}, query = '') {
  const dirs = getSkillSearchDirs(workCwd, opts.skillDirs);
  const items = [];
  const seen = new Set();
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if ((!d.isDirectory() && !d.isSymbolicLink()) || seen.has(d.name)) continue;
        const skillFile = path.join(dir, d.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        seen.add(d.name);
        const meta = extractMarkdownFrontmatterMeta(skillFile, d.name);
        items.push({
          name: d.name,
          path: toDisplayPath(skillFile),
          summary: meta.description || meta.title || '',
        });
      }
    } catch {}
  }

  const filtered = items.filter((it) => matchesQuery(`${it.name} ${it.summary}`, query));
  if (!filtered.length) {
    return [
      '### 技能索引 (skills)',
      query
        ? `未找到匹配 "${query}" 的技能（共发现 ${items.length} 个技能）。`
        : `未发现已安装技能（搜索目录: ${dirs.map((d) => `\`${toDisplayPath(d)}\``).join(', ')}）。`,
    ].join('\n');
  }

  const lines = [
    `### 技能索引 (skills · 共 ${filtered.length}${query ? ` / ${items.length}` : ''} 个，命中场景时用 read_file 读取对应 SKILL.md)`,
  ];
  for (const it of filtered.slice(0, 60)) {
    lines.push(`- \`${it.name}\` (\`${it.path}\`)${it.summary ? ` — ${it.summary}` : ''}`);
  }
  if (filtered.length > 60) {
    lines.push(`...(其余 ${filtered.length - 60} 个技能已省略，可传 query 关键词筛选)`);
  }
  return lines.join('\n');
}

function collectIndexSummary(workCwd, query = '') {
  const mcps = getEnabledMcpNames();
  const md = loadLocalToolIndexMarkdown(workCwd);
  const lines = ['### 工具与项目索引 (index)'];
  if (mcps.length) {
    lines.push(`- 已启用 MCP 服务 (${mcps.length}): ${mcps.join(', ')}（可用 \`mcp_list\` 查工具列表，\`mcp_call\` 调用）`);
  } else {
    lines.push('- 已启用 MCP 服务: 无');
  }

  if (md) {
    if (query) {
      const matchedLines = md.split(/\r?\n/).filter((line) => matchesQuery(line, query));
      if (matchedLines.length) {
        lines.push(`\n#### LOCAL_TOOL_INDEX.md 匹配行 ("${query}")\n${matchedLines.slice(0, 80).join('\n')}`);
      } else {
        lines.push(`\n- LOCAL_TOOL_INDEX.md 中未匹配 "${query}"（完整路径: \`${toDisplayPath(LOCAL_TOOL_INDEX_FILE)}\`）`);
      }
    } else {
      const capped = md.length > 8000 ? md.slice(0, 8000) + '\n...(已截断，完整内容请 read_file 读取)' : md;
      lines.push(`\n#### 本地工具索引 (\`${toDisplayPath(LOCAL_TOOL_INDEX_FILE)}\`)\n${capped}`);
    }
  } else {
    lines.push(`- 未配置自定义 LOCAL_TOOL_INDEX.md（可选路径: \`${toDisplayPath(LOCAL_TOOL_INDEX_FILE)}\`）`);
  }
  return lines.join('\n');
}

function buildContextQueryOutput(workCwd, opts = {}, kind = 'all', query = '') {
  const k = String(kind || 'all').trim().toLowerCase();
  if (k === 'rules' || k === 'rule') return collectRulesSummary(workCwd, opts, query);
  if (k === 'memory' || k === 'memories' || k === 'mem') return collectMemorySummary(workCwd, opts, query);
  if (k === 'skills' || k === 'skill') return collectSkillsSummary(workCwd, opts, query);
  if (k === 'index' || k === 'tools' || k === 'mcp') return collectIndexSummary(workCwd, query);

  const sections = [
    collectRulesSummary(workCwd, opts, query),
    collectMemorySummary(workCwd, opts, query),
    collectSkillsSummary(workCwd, opts, query),
    collectIndexSummary(workCwd, query),
  ];
  const combined = sections.join('\n\n---\n\n');
  if (combined.length > 10500) {
    return combined.slice(0, 10500) + '\n...(总览已截断，请分别传 kind="rules"|"memory"|"skills"|"index" 或 query 按需查询)';
  }
  return combined;
}

function detectMultiModuleResearchHint(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  if (text.length < 10) return '';
  if (/:\d+(?:-\d+)?\b/.test(text) && text.length < 80) return '';
  const hasBroadSignal = /(全链路|调用链|排查|梳理|对比|架构|跨模块|一起查|分别查|为什么会|怎么实现|原理|机制|影响面|全量|盘点|分析一下|定位一下)/.test(text);
  const hasMultiLayer = /(lua.*c\+\+|c\+\+.*lua|前端.*后端|客户端.*服务|配表.*代码|代码.*配表|插件.*扩展|server.*content)/i.test(text);
  if (!hasBroadSignal && !hasMultiLayer) return '';
  return `⚡ 加速建议：当前问题涉及跨模块或较长调用链排查，建议首轮直接并行派发最多 ${MAX_CONCURRENT_SUBAGENTS} 个 \`web_subagent\` 分头调研（可与 \`get_context\` 同批发出），将多轮串行压缩为 1 轮。`;
}

function buildSystemToolProtocol(cwd, opts = {}) {
  const workCwd = cwd || state.cwd || DEFAULT_CWD;
  const displayCwd = toDisplayPath(workCwd);
  const shellHint = IS_WIN ? 'PowerShell命令' : 'Shell命令';
  const uiMode = normalizeUiMode(opts?.uiMode);
  const modePolicy = getModePolicy(uiMode);
  const researchHint = opts?.researchHint ? String(opts.researchHint).trim() : '';
  const contextHints = opts?.contextHints ? String(opts.contextHints).trim() : '';

  const actionPhrase = modePolicy.readOnly
    ? '从工作区摘取文件片段、搜索符号或查阅规范'
    : '从工作区摘取文件片段、搜索符号、查阅规范或应用代码改动';

  const lines = [
    '### 工作区资料协作说明',
    `你只需输出纯文本分析。当需要我帮你${actionPhrase}时，可在回复末尾附一段 \`json:local-tool\` 数组清单，我会在下条消息把结果贴给你。工作区: \`${displayCwd}\``,
    modePolicy.protocolRule,
    '```json:local-tool',
    '[',
    '  {"tool": "search_code", "args": {"pattern": "symbol", "path": "src"}},',
    '  {"tool": "read_file", "args": {"path": "src/file.ts", "startLine": 1, "endLine": 120}}',
    ']',
    '```',
    '可用工具（连续只读项自动并行，路径支持相对路径、`~/` 或绝对路径）：',
    '- `get_context`: `{"kind": "rules|memory|skills|index|all", "query": "建议传关键词筛选"}`（按需查询）',
    '- `read_file`: `{"path": "...", "startLine": 1, "endLine": 250}` | `list_dir`: `{"path": "..."}` | `find_files`: `{"pattern": "*Cfg*", "path": "..."}`',
    '- `search_code`: `{"pattern": "关键词或正则", "path": "可选目录", "glob": "*.ts", "maxCount": 80}`',
  ];

  if (!modePolicy.readOnly) {
    lines.push(
      '- `edit_file`: `{"path": "...", "target": "原文本", "replacement": "新文本"}` | `write_file`: `{"path": "...", "content": "全文"}`',
      `- \`run_command\`: \`{"command": "${shellHint}", "cwd": "可选目录", "timeoutMs": 180000}\``
    );
  } else {
    lines.push(
      `- \`run_command\`: \`{"command": "仅限只读检查命令(${shellHint})", "cwd": "可选目录"}\`（Plan 模式已硬禁止 \`edit_file\`/\`write_file\` 与写命令）`
    );
  }

  lines.push(
    '- `mcp_list`: `{"server": "可选服务名"}` | `mcp_call`: `{"server": "服务名", "mcpTool": "工具名", "args": {...}}`',
    `- \`web_subagent\`: \`{"role": "researcher|reviewer|planner", "task": "目标与返回要求", "readOnly": true, "maxSteps": 4}\`（角色化独立子代理，跨模块/审查/规划可并行派最多 **${MAX_CONCURRENT_SUBAGENTS}** 个）`,
    '约定：先查证再作答，附清单后即结束本条回复；路径统一用反引号 `` `src/file:line` ``（正斜杠）。'
  );

  if (contextHints) lines.push(contextHints);
  if (researchHint) lines.push(researchHint);
  lines.push('---');
  return lines.join('\n');
}

function buildSubagentProtocol({ cwd, role, readOnly = true, maxSteps }) {
  const workCwd = cwd || state.cwd || DEFAULT_CWD;
  const displayCwd = toDisplayPath(workCwd);
  const shellHint = IS_WIN ? 'PowerShell命令' : 'Shell命令 (bash/zsh)';
  return buildRoleSubagentProtocol({
    displayCwd,
    rawRole: role,
    readOnly,
    maxSteps,
    shellHint,
  }).protocolText;
}

const VALID_LOCAL_TOOLS = [
  'get_context',
  'read_file',
  'edit_file',
  'write_file',
  'search_code',
  'find_files',
  'list_dir',
  'run_command',
  'mcp_list',
  'mcp_call',
  'update_plan',
  'web_subagent',
];

function tryParseJsonLenient(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (_) {}
  const noTrailingComma = txt.replace(/,\s*([\]}])/g, '$1');
  try {
    return JSON.parse(noTrailingComma);
  } catch (_) {}
  try {
    const fixedSlashes = noTrailingComma.replace(/(?<!\\)\\(?![\\"/bfnrtu]|u[0-9a-fA-F]{4})/g, '\\\\');
    return JSON.parse(fixedSlashes);
  } catch (_) {}
  return null;
}

function parseToolCallsFromMarkdown(rawMarkdown) {
  if (!rawMarkdown) return null;
  // 回复在代码块未闭合时被截取（或模型漏写结尾围栏）：补一个结尾围栏，避免整批工具调用被忽略
  let markdownText = String(rawMarkdown).replace(/\r\n/g, '\n');
  if ((markdownText.match(/```/g) || []).length % 2 === 1) markdownText += '\n```';
  // 匹配所有代码块：显式标注的 local-tool/local-agent JSON 块按出现顺序合并，避免前序块被覆盖丢弃
  const fenceRegex = /```([^\r\n]*)\r?\n([\s\S]*?)```/g;
  const isValidToolSpecs = (arr) =>
    arr.length > 0 && arr.every((x) => x && VALID_LOCAL_TOOLS.includes(x.tool || x.name));
  let match;
  const explicitSpecs = [];
  let lastNaturalTask = null;
  let fallbackJsonSpecs = null;

  while ((match = fenceRegex.exec(markdownText)) !== null) {
    const info = (match[1] || '').trim().toLowerCase();
    const body = (match[2] || '').trim();
    if (!body || body.includes('请在这里写你要交给本地 Agent 执行的具体任务')) continue;

    // 1. 显式标记为 json:local-tool 或 local-tool
    if (info.includes('local-tool') || info.includes('local-agent')) {
      const cleaned = body.replace(/^#\s*@?local-(?:tool|agent)\s*\r?\n/i, '').trim();
      const parsed = tryParseJsonLenient(cleaned);
      if (parsed) {
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        if (isValidToolSpecs(arr)) {
          explicitSpecs.push(...arr);
          continue;
        }
      }
    }

    // 2. 代码块首行是 # @local-tool 或 # @local-agent
    const lines = body.split(/\r?\n/);
    const firstLine = lines[0].trim();
    if (/^#\s*@?local-(?:tool|agent)$/i.test(firstLine)) {
      const rest = lines.slice(1).join('\n').trim();
      if (!rest) continue;
      const parsed = tryParseJsonLenient(rest);
      if (parsed) {
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        if (isValidToolSpecs(arr)) {
          explicitSpecs.push(...arr);
        }
      } else {
        lastNaturalTask = { kind: 'natural-task', task: rest };
      }
      continue;
    }

    // 3. 未标注 local-tool 的普通 JSON 代码块，仅当无显式工具块且位于回复末尾（后续非空文本 <= 80 字符）时才兜底触发，
    // 避免正文中间用于说明协议/示范的示例 JSON 被误当成真实工具调用执行
    const afterBlockText = markdownText.slice(match.index + match[0].length).trim();
    if (
      explicitSpecs.length === 0 &&
      afterBlockText.length <= 80 &&
      ((body.startsWith('[') && body.endsWith(']')) || (body.startsWith('{') && body.endsWith('}')))
    ) {
      const parsed = tryParseJsonLenient(body);
      if (parsed) {
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        if (isValidToolSpecs(arr)) {
          fallbackJsonSpecs = arr;
        }
      }
    }
  }
  if (explicitSpecs.length > 0) return { kind: 'json-tools', specs: explicitSpecs };
  if (lastNaturalTask) return lastNaturalTask;
  if (fallbackJsonSpecs) return { kind: 'json-tools', specs: fallbackJsonSpecs };

  // 4. 兜底：模型没写围栏，直接在回复末尾输出了 [{"tool": ...}] 数组
  const tailIdx = markdownText.lastIndexOf('[{');
  const altIdx = markdownText.lastIndexOf('[\n');
  const start = Math.max(tailIdx, altIdx);
  if (start >= 0) {
    const tail = markdownText.slice(start).replace(/```\s*$/, '').trim();
    const end = tail.lastIndexOf(']');
    if (end > 0) {
      const arr = tryParseJsonLenient(tail.slice(0, end + 1));
      if (Array.isArray(arr) && arr.length && arr.every((x) => x && VALID_LOCAL_TOOLS.includes(x.tool || x.name))) {
        return { kind: 'json-tools', specs: arr };
      }
    }
  }
  return null;
}

function findTrailingCodeBlock(rawMarkdown) {
  const text = String(rawMarkdown || '').replace(/\r\n/g, '\n');
  const fenceIndices = [];
  const fenceLineRe = /^[ \t]*```([^\n]*)$/gm;
  let m;
  while ((m = fenceLineRe.exec(text)) !== null) {
    fenceIndices.push({
      start: m.index,
      end: m.index + m[0].length,
      info: String(m[1] || '').trim(),
    });
  }
  if (!fenceIndices.length) return null;

  let openFence;
  let closeFence = null;
  if (fenceIndices.length % 2 === 1) {
    openFence = fenceIndices[fenceIndices.length - 1];
  } else {
    openFence = fenceIndices[fenceIndices.length - 2];
    closeFence = fenceIndices[fenceIndices.length - 1];
  }

  const tailAfter = closeFence ? text.slice(closeFence.end).trim() : '';
  if (tailAfter.length > 80) return null;

  const bodyStart = openFence.end + (text[openFence.end] === '\n' ? 1 : 0);
  const bodyEnd = closeFence ? closeFence.start : text.length;
  return {
    prefixText: text.slice(0, openFence.start).trimEnd(),
    info: openFence.info.toLowerCase(),
    body: text.slice(bodyStart, bodyEnd),
    unclosed: !closeFence,
  };
}

function isTruncatedToolCallReply(rawMarkdown) {
  const text = String(rawMarkdown || '').replace(/\r\n/g, '\n').trim();
  if (!text) return false;
  if (parseToolCallsFromMarkdown(text)) return false;

  const block = findTrailingCodeBlock(text);
  if (block) {
    const body = block.body.trim();
    if (!body) return block.unclosed && (block.info.includes('local-tool') || block.info.includes('local-agent'));
    if (block.info.includes('local-tool') || block.info.includes('local-agent')) {
      return true;
    }
    if (/^#\s*@?local-(?:tool|agent)\b/i.test(body)) {
      return true;
    }
    if (
      (body.startsWith('[') || body.startsWith('{')) &&
      (/"tool"\s*:|"args"\s*:|\[\s*\{\s*"tool/i.test(body) || (block.unclosed && /^\[\s*\{\s*"t/i.test(body)))
    ) {
      return true;
    }
  }

  const tail = text.slice(-450);
  if (/(?:```(?:json:local-tool|local-tool)\b|\[\s*\{\s*"tool"\s*:)/i.test(tail)) {
    return true;
  }
  return false;
}

function extractCompleteReadOnlyToolsFromTruncatedStream(rawMarkdown) {
  const text = String(rawMarkdown || '').replace(/\r\n/g, '\n');
  if (!text || parseToolCallsFromMarkdown(text)) return null;

  let prefixText = '';
  let body = '';
  const block = findTrailingCodeBlock(text);
  if (block) {
    prefixText = block.prefixText;
    body = block.body.trim();
  } else {
    const startIdx = Math.max(text.lastIndexOf('[{'), text.lastIndexOf('[\n'));
    if (startIdx < 0) return null;
    prefixText = text.slice(0, startIdx).trimEnd();
    body = text.slice(startIdx).trim();
  }

  body = body.replace(/^#\s*@?local-(?:tool|agent)\s*\n/i, '').trim();
  const arrStart = body.indexOf('[');
  if (arrStart < 0) return null;

  const specs = [];
  let inStr = false;
  let escape = false;
  let depth = 0;
  let objStart = -1;

  for (let i = arrStart + 1; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth += 1;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && objStart >= 0) {
        const snippet = body.slice(objStart, i + 1);
        objStart = -1;
        const parsed = tryParseJsonLenient(snippet);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return null;
        }
        const toolName = String(parsed.tool || parsed.name || '').trim();
        if (!VALID_LOCAL_TOOLS.includes(toolName)) {
          return null;
        }
        // 保守安全：截断流里仅抢救纯只读工具，避免半截写操作/命令破坏原子性
        if (!PARALLEL_LOCAL_TOOLS.has(toolName)) {
          return null;
        }
        specs.push(parsed);
      }
    }
  }

  if (!specs.length) return null;
  const fencedJson = '```json:local-tool\n' + JSON.stringify(specs, null, 2) + '\n```';
  const normalizedMarkdown = prefixText ? `${prefixText}\n\n${fencedJson}` : fencedJson;
  return {
    kind: 'json-tools',
    specs,
    partialRescued: true,
    normalizedMarkdown,
  };
}

function isCompleteLongAnswerForRescue(rawText) {
  const trimmed = String(rawText || '').trim();
  if (trimmed.length < 400) return false;
  if (isCannedRefusalReply(trimmed) || isTransientErrorReply(trimmed)) return false;
  if ((trimmed.match(/```/g) || []).length % 2 !== 0) return false;
  if (isTruncatedToolCallReply(trimmed)) return false;
  const tail = trimmed.slice(-240);
  if (/json:local-tool|#\s*@?local-(?:tool|agent)|\[\s*\{\s*"tool"|"tool"\s*:/i.test(tail)) {
    return false;
  }
  return true;
}

// ─── 可选：本地 ACP 客户端 (供切回本地 AGY 大模型时使用) ───
let buildAcpSessionMcpServers = () => [];
let ensureGlobalHttpBridgeInstalled = () => {};

function resolveMcpManagerPath() {
  const explicit = process.env.WEB_BRIDGE_MCP_MANAGER || bridgeConfig.mcpManagerPath || '';
  const candidates = [
    explicit ? resolveSafePath(explicit, DIR) : '',
    path.join(DIR, 'mcpManager.js'),
    path.resolve(DIR, '..', 'src', 'mcpManager.js'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || '';
}

try {
  const mcpMgrPath = resolveMcpManagerPath();
  if (mcpMgrPath) {
    const mcpMgr = require(mcpMgrPath);
    if (mcpMgr.buildAcpSessionMcpServers) buildAcpSessionMcpServers = mcpMgr.buildAcpSessionMcpServers;
    if (mcpMgr.ensureGlobalHttpBridgeInstalled) ensureGlobalHttpBridgeInstalled = mcpMgr.ensureGlobalHttpBridgeInstalled;
  }
} catch {}

function resolveAgyExecutable() {
  const explicit = String(process.env.WEB_BRIDGE_AGY_PATH || bridgeConfig.agyExecutable || '').trim();
  if (explicit) return resolveSafePath(explicit, DIR);
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  if (IS_WIN && process.env.LOCALAPPDATA) {
    dirs.unshift(path.join(process.env.LOCALAPPDATA, 'agy', 'bin'));
    dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'agy'));
    dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'antigravity-cli'));
  }
  if (home) {
    dirs.push(path.join(home, '.local', 'bin'));
    dirs.push(path.join(home, '.antigravity', 'bin'));
  }
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, 'agy' + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return 'agy';
}

class LocalAcpBridge {
  constructor() {
    this.proc = null;
    this.initPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.currentTurn = null;
  }

  async ensureStarted() {
    if (this.proc && !this.proc.killed && this.initPromise) return this.initPromise;
    this.initPromise = this._startInternal().catch((err) => {
      this.initPromise = null;
      this.proc = null;
      throw err;
    });
    return this.initPromise;
  }

  async _startInternal() {
    const exe = resolveAgyExecutable();
    try { ensureGlobalHttpBridgeInstalled(); } catch {}
    log(`启动 ACP 进程: ${exe} acp (cwd=${state.cwd})`);

    const proc = spawn(exe, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
      cwd: fs.existsSync(state.cwd) ? state.cwd : process.cwd(),
    });
    this.proc = proc;

    const decoder = new StringDecoder('utf8');
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) this._handleLine(line);
      }
    });

    const errDecoder = new StringDecoder('utf8');
    proc.stderr.on('data', (chunk) => {
      const txt = errDecoder.write(chunk).trim();
      if (txt) log(`[acp stderr] ${txt}`);
    });

    proc.on('close', (code, sig) => {
      log(`ACP 进程退出: code=${code} sig=${sig}`);
      this.proc = null;
      this.initPromise = null;
      for (const [, p] of this.pending) {
        p.reject(new Error(`ACP exited (${code ?? sig})`));
      }
      this.pending.clear();
    });

    const res = await this._sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'gemini-web-bridge', version: '2.0.0' },
    });
    log('ACP initialize 成功');
    return res;
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.method === 'session/update' && msg.id === undefined) {
      const u = msg.params?.update;
      if (!u || !this.currentTurn || msg.params?.sessionId !== this.currentTurn.sessionId) return;

      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        this.currentTurn.text += u.content.text;
      } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.text) {
        this.currentTurn.thoughts += u.content.text;
      } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
        const id = u.toolCallId || u.name || 'tool';
        const existing = this.currentTurn.tools.find((t) => t.id === id);
        const title = u.title || u.name || 'tool';
        const status = u.status || 'in_progress';
        if (existing) {
          existing.title = title;
          existing.status = status;
        } else {
          this.currentTurn.tools.push({ id, name: u.name || title, title, status });
        }
      }
      return;
    }

    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/request_permission') {
        const options = msg.params?.options || [];
        const allowOpt = options.find((o) => o.kind?.startsWith('allow')) || options[0];
        this._write({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            outcome: allowOpt ? { outcome: 'selected', optionId: allowOpt.optionId } : { outcome: 'cancelled' },
          },
        });
        return;
      }
      this._write({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not supported: ${msg.method}` },
      });
      return;
    }

    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  _write(obj) {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      throw new Error('ACP server not running');
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  _sendRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async ensureSession(cwd, forceNew = false) {
    await this.ensureStarted();
    const targetCwd = cwd || state.cwd || DEFAULT_CWD;
    let mcpServers = [];
    try { mcpServers = buildAcpSessionMcpServers(targetCwd); } catch {}

    if (!forceNew && state.sessionId) {
      try {
        const res = await this._sendRequest('session/load', {
          sessionId: state.sessionId,
          cwd: targetCwd,
          mcpServers,
        });
        state.sessionId = res.sessionId || state.sessionId;
        state.cwd = targetCwd;
        saveState();
        await this._sendRequest('session/set_config_option', {
          sessionId: state.sessionId,
          configId: 'mode',
          value: 'accept-edits',
        }).catch(() => {});
        return state.sessionId;
      } catch (_) {}
    }

    const res = await this._sendRequest('session/new', { cwd: targetCwd, mcpServers });
    state.sessionId = res.sessionId;
    state.cwd = targetCwd;
    saveState();

    await this._sendRequest('session/set_config_option', {
      sessionId: state.sessionId,
      configId: 'mode',
      value: 'accept-edits',
    }).catch(() => {});

    return state.sessionId;
  }

  async ask(promptText, opts = {}) {
    if (this.currentTurn) {
      throw new Error('本地 Agent 正在执行上一条任务，请等待完成或点击停止');
    }
    const sid = await this.ensureSession(opts.cwd, Boolean(opts.newSession));
    this.currentTurn = {
      sessionId: sid,
      startedAt: Date.now(),
      prompt: promptText,
      text: '',
      thoughts: '',
      tools: [],
    };

    try {
      const res = await this._sendRequest('session/prompt', {
        sessionId: sid,
        prompt: [{ type: 'text', text: promptText }],
      });
      const reply = this.currentTurn.text.trim();
      const tools = this.currentTurn.tools;
      return {
        sessionId: sid,
        stopReason: res?.stopReason || 'end_turn',
        reply: reply || '(本地 Agent 已完成操作，无额外文本输出)',
        tools,
      };
    } finally {
      this.currentTurn = null;
    }
  }

  cancelCurrent() {
    if (this.currentTurn && this.proc && !this.proc.killed) {
      try {
        this._write({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId: this.currentTurn.sessionId },
        });
      } catch {}
    }
  }
}

const acpBridge = new LocalAcpBridge();

// ─── WebBrain ReAct 状态机与浏览器模型控制 (支持多标签页独立会话游标并发) ───
let lastBrowserHeartbeat = 0;
const webTasks = new Map(); // requestId -> task
const pendingBrowserOps = new Map(); // opId -> { resolve, reject, timer }
let pendingBrowserCommandQueue = [];

function enqueueBrowserOp(commandObj, timeoutMs = 25000) {
  const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserOps.delete(opId);
      reject(new Error('等待浏览器扩展响应超时（请确认 Chrome 已打开并已在 chrome://extensions 刷新扩展）'));
    }, timeoutMs);
    pendingBrowserOps.set(opId, { resolve, reject, timer });
    pendingBrowserCommandQueue.push({ ...commandObj, opId });
  });
}

function stripInjectedUserPrefixes(rawUserText) {
  let s = String(rawUserText || '').replace(/\r\n/g, '\n').trim();
  let hadProtocol = false;
  if (/### 工作区资料协作说明|### 本地协作约定|### 本地开发工作区工具说明|\[System Tool Protocol\]|json:local-tool/.test(s)) {
    hadProtocol = true;
  }
  // 依次剥离桥接器注入的系统协议头、历史同步头、自动技能头、回合提示与自动附带文件内容块（兼容 DOM 换行折为空格的情况）
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^(?:### 工作区资料协作说明|### 本地协作约定|### 本地开发工作区工具说明|\[System Tool Protocol\])[\s\S]*?(?:\n---\s*\n+|\s+---\s+)/i, '')
      .replace(/^【历史与跨通道对话上下文同步】[\s\S]*?(?:\n---\s*\n+|\s+---\s+)/i, '')
      .replace(/^【已自动加载本地技能[\s\S]*?(?:\n---\s*\n+|\s+---\s+)/i, '')
      .replace(/^(?:\[本地工具已就绪[^\]]*\]|（本地工作区工具已就绪[^）]*）)\s*/i, '')
      .trim();
  } while (s !== prev);

  // 剥离自动注入的 📎 附加文件 / 焦点文件块，保留用户真正输入的正文
  while (/^📎\s*(?:附加文件|当前编辑器焦点文件)/.test(s)) {
    const fenced = s.match(/^📎[^\n]*\n```[\s\S]*?```\s*\n+/);
    if (fenced) {
      s = s.slice(fenced[0].length).trim();
      continue;
    }
    const singleLine = s.match(/^📎[^\n]*(?:\n+|\s{2,})/);
    if (singleLine) {
      s = s.slice(singleLine[0].length).trim();
      continue;
    }
    break;
  }
  return { cleanText: s, hadProtocol };
}

function stripRawLocalToolBlocks(mdText) {
  const s = String(mdText || '').replace(/\r\n/g, '\n');
  return s
    .replace(/```([^\n`]*)\n([\s\S]*?)```/g, (full, info, body) => {
      const lang = String(info || '').trim().toLowerCase();
      if (lang.includes('local-tool') || lang.includes('local-agent')) return '';
      const trimmed = String(body || '').trim();
      if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        const parsed = tryParseJsonLenient(trimmed);
        const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        if (arr.length > 0 && arr.every((x) => x && VALID_LOCAL_TOOLS.includes(x.tool || x.name))) {
          return '';
        }
      }
      return full;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizePulledWebConversation(rawConv) {
  const rawTurns = Array.isArray(rawConv?.turns) ? rawConv.turns : [];
  let hasSystemProtocol = false;
  const turns = [];

  for (const rt of rawTurns) {
    const rawU = String(rt?.userText || '').trim();
    const rawA = String(rt?.assistantText || '').trim();
    const rawT = String(rt?.thoughts || '').trim();

    // 1. 忽略一键预热同步的元消息轮次
    if (/^【一键上下文同步】/.test(rawU) || /【一键上下文同步】上面是本对话此前在本地/.test(rawU)) {
      if (/### 工作区资料协作说明|### 本地协作约定|### 本地开发工作区工具说明|\[System Tool Protocol\]/.test(rawU)) hasSystemProtocol = true;
      continue;
    }

    // 2. ReAct 本地工具回填步 / 自动重试步：合并到上一轮助手回复，不生成假的用户气泡
    const isReActContinuation =
      /^\[Local Tool Results/i.test(rawU) ||
      /^###\s*(?:补充的工作区资料|本地工具执行结果|本机执行结果)/.test(rawU) ||
      /^(?:补充的工作区资料|本地工具执行结果|本机执行结果)/.test(rawU) ||
      /^提示：本地\s*`?json:local-tool`?/.test(rawU) ||
      /^当前已是新回合，请继续/.test(rawU) ||
      /^刚才上一批工具输出中的部分脚本/.test(rawU) ||
      /^刚才的回复在生成中途中断了/.test(rawU) ||
      /^刚才网页端返回了临时系统错误/.test(rawU) ||
      /^这是刚才软件开发代码分析步骤中/.test(rawU) ||
      /^这是一个正常的(?:本地软件工程|软件开发|文本技术问答)/.test(rawU) ||
      /^上述工具输出(?:的完整内容)?较长/.test(rawU) ||
      /^请先不要再输出\s*`?json:local-tool`?/.test(rawU) ||
      /^请作为(?:编程助手|软件工程技术助手)/.test(rawU);

    if (isReActContinuation) {
      const cleanedStepA = stripRawLocalToolBlocks(rawA);
      if (turns.length > 0) {
        const last = turns[turns.length - 1];
        if (rawT) last.thoughts = [last.thoughts, rawT].filter(Boolean).join('\n\n');
        if (cleanedStepA) {
          const lastIsBad = isTransientErrorReply(last.assistantText) || isCannedRefusalReply(last.assistantText);
          const curIsBad = isTransientErrorReply(cleanedStepA) || isCannedRefusalReply(cleanedStepA);
          if (lastIsBad && !curIsBad) {
            last.assistantText = cleanedStepA;
          } else if (!curIsBad || !last.assistantText) {
            last.assistantText = [last.assistantText, cleanedStepA].filter(Boolean).join('\n\n');
          }
        }
      }
      continue;
    }

    const { cleanText, hadProtocol } = stripInjectedUserPrefixes(rawU);
    if (hadProtocol) hasSystemProtocol = true;
    const cleanedA = stripRawLocalToolBlocks(rawA);
    const hadToolOnlyAssistant = Boolean(rawA && !cleanedA);
    if (!cleanText && !cleanedA && !rawT) continue;

    turns.push({
      userText: cleanText || rawU,
      thoughts: rawT,
      // 若首步助手输出仅为 json:local-tool 调用块，置空等待后续 ReAct 回填步合入真正回复，绝不把原始 JSON 写回正文
      assistantText: hadToolOnlyAssistant ? '' : (cleanedA || rawA),
    });
  }

  const webChatUrl = String(rawConv?.webChatUrl || '').trim();
  const chatId = webChatUrl.match(/\/app\/([a-zA-Z0-9_-]{8,})/)?.[1] || String(rawConv?.chatId || '');
  const cleanTitle = String(rawConv?.title || '')
    .replace(/^\s*Google\s+Gemini\s*[-–—·|]\s*/i, '')
    .replace(/\s*[-–—·|]\s*Google\s+Gemini\s*$/i, '')
    .replace(/^Gemini\s*$/i, '')
    .trim();

  return {
    webChatUrl: chatId ? `https://gemini.google.com/app/${chatId}` : webChatUrl,
    chatId,
    title: cleanTitle || (turns[0]?.userText ? turns[0].userText.replace(/\s+/g, ' ').slice(0, 56) : 'Web Conversation'),
    modelLabel: String(rawConv?.modelLabel || '').trim(),
    hasSystemProtocol,
    turns,
  };
}
function normalizeDiscoveredWebModels(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const label = String(typeof item === 'string' ? item : item?.label || item?.name || item?.id || '').trim();
    if (!label) continue;
    const id = String(typeof item === 'object' && item?.id ? item.id : label).trim();
    const description = typeof item === 'object' && item?.description ? String(item.description).trim() : '';
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      label,
      ...(description ? { description } : {}),
    });
  }
  return out;
}

let lastAutoModelSyncAt = 0;
let webModelState = {
  currentLabel: '', // 例如 "Argon 高"
  availableOptions: normalizeDiscoveredWebModels(state.webAvailableModels), // 网页端抓取到的模型/档位菜单项列表
  updatedAt: Number(state.webModelsUpdatedAt || 0),
  desiredModel: state.webModel || '',
  desiredEffort: state.webEffort || 'high',
};

function isBrowserOnline() {
  return Date.now() - lastBrowserHeartbeat < 8000;
}

function pruneOldWebTasks() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, t] of webTasks) {
    if (
      (t.status === 'completed' || t.status === 'error' || t.status === 'cancelled') &&
      t.updatedAt < cutoff
    ) {
      webTasks.delete(id);
    }
  }
}

function upsertWebTaskTool(task, toolInfo) {
  if (!task) return;
  const idx = task.tools.findIndex((t) => t.id === toolInfo.id);
  if (idx >= 0) {
    task.tools[idx] = { ...task.tools[idx], ...toolInfo };
  } else {
    task.tools.push(toolInfo);
  }
}

const CANNED_REFUSAL_RE =
  /^(?:[•·\-\s]*)(?:请?恕我爱莫能助|由于(?:我的)?(?:程序代码|程序逻辑|程序设计|系统|技术|功能|能力)?的?(?:局限|限制)[\s\S]{0,60}|我(?:只会|只能|仅能)(?:生成|处理|回复)文本|我(?:只是|仅是)(?:一个|一名)?(?:基于文本的\s*|文本\s*|大型?\s*)?(?:AI|人工智能|语言模型)|(?:身为|作为|我是)(?:一个|一名)?(?:基于文本的\s*|文本\s*|大型?\s*)?(?:AI|人工智能|语言模型)[\s\S]{0,80}?(?:无法|不能|没(?:有)?办法|没法子?|办不到|做不到|帮不了|帮不上|帮上忙|爱莫能助|无能为力|无权|不支持|尚未支持|超出|理解不了|不具备|能力有限|还?在学习|没有学会|还没学会)|(?:很?抱歉|对不起|不好意思)[，,、\s]*(?:我)?(?:目前|暂时|实在)?(?:无法|不能|没(?:有)?办法|没法子?|办不到|做不到|无能为力)(?:提供|协助|帮助|处理|回答|满足|理解|帮上忙|办到|做到)?|我(?:目前|暂时)?(?:无法|不能|没(?:有)?办法|没法子?|办不到|做不到)(?:提供这方面的帮助|提供帮助|协助(?:您|你)?|帮(?:助)?(?:您|你)|满足(?:您|你)|回答这个问题|理解这个问题|帮上忙|帮到你|办到|做到|处理(?:您|你)的(?:这个)?请求)|(?:(?:你|您)提出的问题|这个问题|(?:你|您)的请求|该问题|这)?超出了我的(?:程序逻辑|设计用途|能力|处理|知识|服务|使用)?(?:范畴|范围|用途)|我(?:目前)?(?:还|仍)(?:在学习如何|没有学会|还没学会|不具备|无法)(?:回答|处理|理解|协助)|Sorry,?\s+I\s+(?:can'?t|cannot|am\s+unable\s+to|am\s+not\s+able\s+to)\s+(?:help|assist)|I'?m\s+(?:just|only)\s+an?\s+(?:text-based\s+)?(?:AI|language\s+model)|(?:I'?m|As)\s+an?\s+(?:text-based\s+)?(?:AI|language\s+model)\b[\s\S]{0,100}?(?:can'?t|cannot|unable|not\s+able|don'?t\s+have\s+the\s+ability|outside|beyond|capacity|help|assist|programmed)|I\s+(?:only|can\s+only)\s+(?:generate|process|work\s+with)\s+text|I\s+(?:can'?t|cannot|am\s+unable\s+to|am\s+not\s+(?:able|programmed)\s+to)\s+(?:help|assist)(?:\s+you)?\s+with\s+(?:that|this)|(?:That|This|Your\s+(?:request|question))\s+is\s+(?:outside|beyond)\s+(?:of\s+)?my\s+(?:capabilities|abilities|programming|scope|design)|I'?m\s+still\s+learning\s+how\s+to\s+answer\s+this\s+question)[\s\S]{0,140}$/i;
const TRANSIENT_ERROR_REPLY_RE =
  /^(?:[•·\-\s]*)(?:I\s+encountered\s+an\s+error(?:\s+doing\s+what\s+you\s+asked)?[\s.,!?:;]*(?:Could\s+you\s+try\s+again\??|Please\s+try\s+again\.?)?|Something\s+went\s+wrong[\s.,!?:;]*(?:Please\s+try\s+again\.?|Could\s+you\s+try\s+again\??)?|Sorry,?\s+(?:I\s+)?(?:encountered\s+an\s+error|something\s+went\s+wrong|couldn'?t\s+(?:process|complete)\s+your\s+request)[\s\S]{0,120}|There\s+was\s+an\s+error\s+generating\s+a\s+response[\s\S]{0,120}|An\s+error\s+occurred[\s.,!?:;]*(?:Please\s+try\s+again\.?)?|A\s+network\s+error\s+occurred[\s\S]{0,120}|Unable\s+to\s+(?:process|complete)\s+your\s+request[\s\S]{0,120}|(?:执行|处理)(?:您|你)的请求时(?:遇到错误|出错)[\s\S]{0,80}|(?:抱歉[，,]?\s*)?(?:出了点问题|出错了|生成回复时出错|无法处理(?:您|你)的请求|系统繁忙)[。，,.！!\s]*(?:请(?:稍后)?(?:再试|重试)[。！!]?)?)$/i;
const FALSE_LIMIT_RE =
  /(?:本轮|当前|会话)?(?:工具调用|工具|调用)(?:次数|步数|配额|预算).{0,12}(?:已达上限|达到上限|已用完|用尽|清零|耗尽)|已达到工具调用上限/;

function isCannedRefusalReply(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (/```|local-tool|"tool"\s*:/.test(trimmed)) return false;
  if (trimmed.split(/\r?\n/).filter(Boolean).length > 3) return false;
  return CANNED_REFUSAL_RE.test(trimmed);
}

function isTransientErrorReply(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.length > 260) return false;
  if (/```|local-tool|"tool"\s*:/.test(trimmed)) return false;
  return TRANSIENT_ERROR_REPLY_RE.test(trimmed);
}

const MAX_CONCURRENT_SUBAGENTS = Math.max(1, Math.min(4, Number(process.env.WEB_SUBAGENT_CONCURRENCY || 2)));
const REACT_STEP_MIN_DELAY_MS = Math.max(0, Number(process.env.WEB_REACT_MIN_DELAY_MS ?? 2200));
const REACT_STEP_JITTER_MS = Math.max(0, Number(process.env.WEB_REACT_JITTER_MS ?? 2000));
const REFUSAL_RETRY_BASE_MS = Math.max(0, Number(process.env.WEB_REFUSAL_RETRY_BASE_MS ?? 2500));

function computeReActStepDelayMs(step, everRefused = false) {
  if (REACT_STEP_MIN_DELAY_MS <= 0 && REACT_STEP_JITTER_MS <= 0) return 0;
  // 测试或显式极速模式保持原样不放大
  if (REACT_STEP_MIN_DELAY_MS <= 100 && REACT_STEP_JITTER_MS === 0) return REACT_STEP_MIN_DELAY_MS;
  let minFactor = 1;
  let jitterFactor = 1;
  if (everRefused || step >= 6) {
    minFactor = 2.0;
    jitterFactor = 1.5;
  } else if (step >= 3) {
    minFactor = 1.45;
    jitterFactor = 1.25;
  }
  const base = Math.round(REACT_STEP_MIN_DELAY_MS * minFactor);
  const jitter = Math.round(REACT_STEP_JITTER_MS * jitterFactor);
  return base + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
}

function buildRolloverHandoffPrompt(task) {
  const protocol = buildSystemToolProtocol(task.cwd, {
    ...(task.protocolOpts || {}),
    uiMode: task.uiMode,
  });
  const rawQuestion = normalizeHomePathsInText(
    stripInjectedUserPrefixes(task.rawUserPrompt || '').cleanText || task.rawUserPrompt || ''
  )
    .trim()
    .slice(0, 1200);

  // 去重整理已执行工具记录，避免新窗口重复读相同文件
  const toolLines = [];
  const seenTools = new Set();
  for (const t of Array.isArray(task.tools) ? task.tools : []) {
    if (!t || !t.name) continue;
    const item = `${t.name}: ${normalizeHomePathsInText(String(t.title || '')).slice(0, 80)} (${t.status || 'completed'})`;
    if (seenTools.has(item)) continue;
    seenTools.add(item);
    toolLines.push(`- ${item}`);
    if (toolLines.length >= 28) break;
  }

  const prevAnalysis = normalizeHomePathsInText(stripRawLocalToolBlocks(task.accumulatedPrefixText || ''))
    .trim()
    .slice(-2000);
  const recentSnippet = task.lastToolResultText
    ? buildSanitizedRetrySummary(task.lastToolResultText, 1800, false)
    : '';

  const sections = [
    protocol,
    '',
    '### 续接前序任务摘要',
    '刚才的对话窗口因内容较长中断，已切换到新的干净窗口续接。请基于以下摘要直接推进剩余分析或修改，避免重复读取已列出的相同范围。',
  ];
  if (rawQuestion) {
    sections.push('', '#### 原始需求', rawQuestion);
  }
  if (toolLines.length) {
    sections.push('', `#### 已查阅与操作记录 (${toolLines.length} 项)`, toolLines.join('\n'));
  }
  if (prevAnalysis) {
    sections.push('', '#### 已有阶段性分析', prevAnalysis);
  }
  if (recentSnippet) {
    sections.push('', '#### 最近一批补充资料摘录', '```text', recentSnippet, '```');
  }
  sections.push(
    '',
    '请承接以上进展继续完成任务：若还需补充查证或修改，建议本次仅附 1~2 个精简的 `json:local-tool` 清单；若已有足够信息，请直接给出纯文本最终结论（路径用反引号 `` `path:line` ``）。'
  );
  return sections.join('\n');
}

let activeSubagentSlots = 0;
const subagentWaitQueue = [];

function acquireSubagentSlot(isCancelled) {
  if (isCancelled && isCancelled()) return Promise.resolve(false);
  if (activeSubagentSlots < MAX_CONCURRENT_SUBAGENTS) {
    activeSubagentSlots += 1;
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const entry = {
      resolved: false,
      wake(granted) {
        if (this.resolved) return;
        this.resolved = true;
        clearInterval(this.cancelTimer);
        resolve(granted);
      },
      cancelTimer: null,
    };
    entry.cancelTimer = setInterval(() => {
      if (isCancelled && isCancelled()) {
        const idx = subagentWaitQueue.indexOf(entry);
        if (idx >= 0) subagentWaitQueue.splice(idx, 1);
        entry.wake(false);
      }
    }, 250);
    subagentWaitQueue.push(entry);
  });
}

function releaseSubagentSlot() {
  activeSubagentSlots = Math.max(0, activeSubagentSlots - 1);
  while (subagentWaitQueue.length > 0 && activeSubagentSlots < MAX_CONCURRENT_SUBAGENTS) {
    const next = subagentWaitQueue.shift();
    if (!next || next.resolved) continue;
    activeSubagentSlots += 1;
    next.wake(true);
  }
}

function extractModelTokenFromOption(opt) {
  const rawLabel = String(typeof opt === 'string' ? opt : opt?.label || opt?.id || '').trim();
  const rawDesc = typeof opt === 'object' && opt?.description ? String(opt.description).trim() : '';
  const modelRe = /(?:\d+(?:\.\d+)?\s+[A-Za-z]+|flash-lite|flash|hydrogen|carbon|neon|argon|pro|ultra)/i;
  if (modelRe.test(rawLabel)) return rawLabel;
  if (rawDesc) {
    const first = rawDesc.split(/\s*[·•|]\s*/)[0]?.trim() || '';
    if (first && modelRe.test(first)) return first;
  }
  return rawLabel;
}

function pickDefaultSubagentModel(parentModel = '') {
  const opts = Array.isArray(webModelState.availableOptions) ? webModelState.availableOptions : [];
  const tokens = opts.map(extractModelTokenFromOption).filter(Boolean);
  const hydrogen = tokens.find((t) => /\bhydrogen\b/i.test(t));
  if (hydrogen) return hydrogen;
  const flash = tokens.find((t) => /\bflash\b/i.test(t) && !/flash-lite/i.test(t));
  if (flash) return flash;
  if (!tokens.length) return '4 Hydrogen';
  return String(parentModel || '').trim() || tokens[0] || '4 Hydrogen';
}

function cancelWebTaskTree(task) {
  let count = 0;
  if (!task) return count;
  if (task.status === 'queued' || task.status === 'dispatched' || task.status === 'streaming') {
    task.wasDispatchedBeforeCancel = Boolean(task.dispatched);
    task.status = 'cancelled';
    task.updatedAt = Date.now();
    count += 1;
  }
  if (task.childRequestIds && task.childRequestIds.size > 0) {
    for (const childId of [...task.childRequestIds]) {
      const childTask = webTasks.get(childId);
      if (childTask) count += cancelWebTaskTree(childTask);
    }
  }
  return count;
}

function scheduleSubagentTabClose(sessionId, webChatUrl, delayMs = 0) {
  if (!sessionId && !webChatUrl) return;
  const pushClose = () => {
    if (!isBrowserOnline()) return;
    pendingBrowserCommandQueue.push({
      action: 'close_tab',
      sessionId: String(sessionId || ''),
      webChatUrl: String(webChatUrl || ''),
      all: false,
    });
  };
  if (delayMs > 0) {
    setTimeout(pushClose, delayMs);
  } else {
    pushClose();
  }
}

async function runWebSubagentTool(args, workCwd, execContext = {}) {
  const role = String(args.role || args.Role || args.title || args.name || 'Subagent').trim().slice(0, 60) || 'Subagent';
  const taskText = String(args.task || args.prompt || args.Prompt || args.query || '').trim();
  if (!taskText) {
    return {
      ok: false,
      tool: 'web_subagent',
      title: role,
      output: 'web_subagent 缺少 task 参数（请清晰描述子任务目标、目录与期望返回内容）',
    };
  }
  if (!isBrowserOnline()) {
    return {
      ok: false,
      tool: 'web_subagent',
      title: role,
      output: '浏览器扩展离线，无法启动 web_subagent（请确认 Chrome 已打开并启用 ZeroG Code Bridge 扩展）',
    };
  }

  const parentTask = execContext.parentTask || null;
  const isParentCancelled = () => Boolean(execContext.isCancelled?.() || parentTask?.status === 'cancelled');
  const rawModel = String(args.model || args.Model || '')
    .trim()
    .replace(/^web:/i, '')
    .trim();
  const resolvedModel = rawModel || pickDefaultSubagentModel(parentTask?.webModel || '');
  const { preset: rolePreset } = resolveSubagentRolePreset(role);
  const resolvedEffort = String(args.effort || args.Effort || 'low').trim().toLowerCase() || 'low';
  const readOnly = Boolean(isReadOnlyMode(parentTask?.uiMode) || (rolePreset.defaultReadOnly && args.readOnly !== false));
  const maxSteps = Math.max(1, Math.min(8, Number(args.maxSteps || args.max_steps || rolePreset.defaultMaxSteps || 4)));
  const timeoutMs = Math.max(30000, Math.min(600000, Number(args.timeoutMs || args.timeout_ms || 240000)));
  const subCwd = args.cwd ? resolveSafePath(args.cwd, workCwd) : workCwd;
  const startedAt = Date.now();

  const buildToolArgsPayload = (stepInfo, subTaskRef, summaryPreview = '') => {
    const compactSubTools = Array.isArray(subTaskRef?.tools)
      ? subTaskRef.tools.slice(-24).map((st) => ({
          name: st.name,
          title: String(st.title || '').slice(0, 80),
          status: st.status,
        }))
      : [];
    return {
      role,
      task: taskText.slice(0, 500),
      model: resolvedModel,
      effort: resolvedEffort,
      readOnly,
      maxSteps,
      step: subTaskRef ? subTaskRef.step + 1 : 0,
      stepInfo,
      elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      subTools: compactSubTools,
      ...(summaryPreview ? { summaryPreview: summaryPreview.slice(0, 1500) } : {}),
    };
  };

  const emitProgress = (stepInfo, subTaskRef, status = 'in_progress', summaryPreview = '') => {
    if (!execContext.onToolProgress) return;
    execContext.onToolProgress({
      name: 'web_subagent',
      title: `${role}${resolvedModel ? ` (${resolvedModel})` : ''}${stepInfo ? ` · ${stepInfo}` : ''}`,
      status,
      args: buildToolArgsPayload(stepInfo, subTaskRef, summaryPreview),
    });
  };

  if (activeSubagentSlots >= MAX_CONCURRENT_SUBAGENTS) {
    emitProgress('排队等待并发槽位', null);
  }
  const slotAcquired = await acquireSubagentSlot(isParentCancelled);
  if (!slotAcquired) {
    return {
      ok: false,
      cancelled: true,
      tool: 'web_subagent',
      title: role,
      args: buildToolArgsPayload('已取消', null),
      output: `[Subagent:${role}] 已取消`,
    };
  }

  const rand = Math.random().toString(36).slice(2, 7);
  const parentShort = String(parentTask?.sessionId || 'root').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'root';
  const subRequestId = `wb_sub_${Date.now()}_${rand}`;
  const subSessionId = `sub_${parentShort}_${Date.now().toString(36)}_${rand}`;
  const subPrompt = `${buildSubagentProtocol({ cwd: subCwd, role, readOnly, maxSteps })}\n\n### 你的子任务\n${taskText}`;

  const subTask = {
    requestId: subRequestId,
    sessionId: subSessionId,
    isSubagent: true,
    parentRequestId: parentTask?.requestId || '',
    subagentRole: role,
    readOnly,
    childRequestIds: new Set(),
    cwd: subCwd,
    protocolOpts: parentTask?.protocolOpts || execContext?.protocolOpts || {},
    rawUserPrompt: taskText,
    newChat: true,
    webChatUrl: '',
    webCursor: null,
    autoCloseTab: true,
    serverReAct: true,
    maxSteps,
    step: 0,
    images: null,
    webModel: resolvedModel,
    webEffort: resolvedEffort,
    currentStepPrompt: subPrompt,
    accumulatedPrefixText: '',
    currentStepText: '',
    bestStepText: '',
    lastToolResultText: '',
    lastCallSig: '',
    sameCallStreak: 0,
    refusalRetries: 0,
    falseLimitRetries: 0,
    text: '',
    thoughts: '',
    tools: [],
    status: 'queued',
    error: null,
    dispatched: false,
    sentAt: 0,
    wasDispatchedBeforeCancel: false,
    cancelDispatched: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  webTasks.set(subRequestId, subTask);
  if (parentTask) {
    if (!parentTask.childRequestIds) parentTask.childRequestIds = new Set();
    parentTask.childRequestIds.add(subRequestId);
  }
  log(
    `[WebSubagent] 启动子代理 role="${role}" requestId=${subRequestId} session=${subSessionId} model=${resolvedModel} readOnly=${readOnly} maxSteps=${maxSteps}`
  );
  emitProgress('Step 1 · 排队发送', subTask);

  let lastProgressSig = '';
  let closeDelayMs = 0;

  try {
    while (true) {
      if (isParentCancelled()) {
        cancelWebTaskTree(subTask);
        return {
          ok: false,
          cancelled: true,
          tool: 'web_subagent',
          title: role,
          args: buildToolArgsPayload('已取消', subTask),
          output: `[Subagent:${role}] 已随主任务取消`,
        };
      }

      if (subTask.status === 'completed') {
        closeDelayMs = 900;
        const cleanSummary = stripRawLocalToolBlocks(subTask.text || subTask.bestStepText || '').trim();
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const finalStepInfo = `${subTask.step + 1} 步 · ${elapsedSec}s`;
        const finalSummary = cleanSummary || '(子代理已完成但未输出额外文本)';
        log(
          `[WebSubagent] 子代理完成 role="${role}" requestId=${subRequestId} steps=${subTask.step + 1} tools=${subTask.tools.length} elapsed=${elapsedSec}s len=${finalSummary.length}`
        );
        return {
          ok: true,
          tool: 'web_subagent',
          title: role,
          args: buildToolArgsPayload(finalStepInfo, subTask, finalSummary),
          output:
            `[Subagent: ${role} | model=${resolvedModel} | steps=${subTask.step + 1} | tools=${subTask.tools.length} | ${elapsedSec}s]\n` +
            finalSummary,
        };
      }

      if (subTask.status === 'error') {
        const partial = stripRawLocalToolBlocks(subTask.text || subTask.bestStepText || '').trim();
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        log(`[WebSubagent] 子代理失败 role="${role}" requestId=${subRequestId}: ${subTask.error}`);
        return {
          ok: false,
          tool: 'web_subagent',
          title: role,
          args: buildToolArgsPayload(`失败 · ${elapsedSec}s`, subTask, partial || subTask.error || ''),
          output:
            `[Subagent 失败: ${role} | model=${resolvedModel} | ${elapsedSec}s] ${subTask.error || '未知错误'}` +
            (partial ? `\n\n已完成的部分输出：\n${partial.slice(0, 6000)}` : ''),
        };
      }

      if (subTask.status === 'cancelled') {
        return {
          ok: false,
          cancelled: true,
          tool: 'web_subagent',
          title: role,
          args: buildToolArgsPayload('已取消', subTask),
          output: `[Subagent:${role}] 已取消`,
        };
      }

      if (Date.now() - startedAt > timeoutMs) {
        cancelWebTaskTree(subTask);
        const partial = stripRawLocalToolBlocks(subTask.text || subTask.bestStepText || '').trim();
        const elapsedSec = Math.round(timeoutMs / 1000);
        log(`[WebSubagent] 子代理超时 (${elapsedSec}s) role="${role}" requestId=${subRequestId}`);
        return {
          ok: false,
          tool: 'web_subagent',
          title: role,
          args: buildToolArgsPayload(`超时 ${elapsedSec}s`, subTask, partial),
          output:
            `[Subagent 超时: ${role} | 超过 ${elapsedSec}s]` +
            (partial ? `\n\n超时前已输出内容：\n${partial.slice(0, 6000)}` : ''),
        };
      }

      const lastTool = subTask.tools.length ? subTask.tools[subTask.tools.length - 1] : null;
      const phase = subTask.runningTools
        ? lastTool
          ? `Step ${subTask.step + 1} · ${lastTool.name} ${String(lastTool.title || '').slice(0, 24)}`
          : `Step ${subTask.step + 1} · 执行本地工具`
        : subTask.status === 'streaming'
          ? `Step ${subTask.step + 1} · 生成中`
          : subTask.status === 'dispatched'
            ? subTask.sentAt
              ? `Step ${subTask.step + 1} · 思考中`
              : `Step ${subTask.step + 1} · 发送中`
            : `Step ${subTask.step + 1} · 排队中`;
      const progressSig = `${phase}|${subTask.tools.length}|${lastTool?.status || ''}`;
      if (progressSig !== lastProgressSig) {
        lastProgressSig = progressSig;
        emitProgress(phase, subTask);
      }

      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    if (parentTask?.childRequestIds) {
      parentTask.childRequestIds.delete(subRequestId);
    }
    releaseSubagentSlot();
    // 兜底安全关闭子代理独立标签页（正常完成时延迟 900ms 让 content.js 自闭环先执行，异常/取消时立即关闭）
    scheduleSubagentTabClose(subSessionId, subTask.webChatUrl, closeDelayMs);
  }
}

async function runReActToolStep(task, parsedCall) {
  const callSig = JSON.stringify(parsedCall);
  if (callSig === task.lastCallSig) {
    task.sameCallStreak = (task.sameCallStreak || 0) + 1;
  } else {
    task.lastCallSig = callSig;
    task.sameCallStreak = 1;
  }

  let toolResultText = '';
  let batchResults = [];
  if (parsedCall.kind === 'json-tools') {
    log(
      `[WebBrain ReAct${task.isSubagent ? `:Sub:${task.subagentRole || ''}` : ''}] 本地零 Token 执行 ${parsedCall.specs.length} 个工具...`
    );
    toolResultText = await LocalToolExecutor.executeBatch(
      parsedCall.specs,
      task.cwd,
      (toolProgress) => upsertWebTaskTool(task, toolProgress),
      {
        parentTask: task,
        protocolOpts: task.protocolOpts || {},
        uiMode: task.uiMode,
        isSubagent: Boolean(task.isSubagent),
        readOnly: Boolean(task.readOnly),
        isCancelled: () => task.status === 'cancelled',
        onBatchResults: (resList) => {
          batchResults = Array.isArray(resList) ? resList : [];
        },
      }
    );
  } else if (parsedCall.kind === 'natural-task') {
    if (state.backend === 'agy') {
      const r = await acpBridge.ask(parsedCall.task, { cwd: task.cwd });
      toolResultText = r.reply;
    } else {
      toolResultText =
        '当前为本地工具模式，请使用 ```json:local-tool 数组格式调用 get_context / read_file / search_code / find_files / list_dir / run_command / mcp_call / web_subagent。';
    }
  }

  if (task.sameCallStreak >= 3) {
    toolResultText += '\n\n注意：你已连续 3 次发起完全相同的请求，请基于已有结果推进下一步或调整参数。';
  }

  // 渐进式拟人冷却间隔，长对话/曾触发拦截时自动拉宽步间节奏，降低高频自动化风控概率
  const delayMs = computeReActStepDelayMs(task.step || 0, Boolean(task.everRefused));
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (task.status === 'cancelled') {
    task.runningTools = false;
    return;
  }

  task.lastToolResultText = sanitizeToolOutputForWeb(String(toolResultText || '')).slice(0, 24500);
  task.accumulatedPrefixText = task.text + '\n\n';
  task.currentStepText = '';
  task.bestStepText = '';
  const hadPartialRescue = Boolean(task.partialRescueNotice);
  task.partialRescueNotice = false;
  task.step += 1;
  // 默认 maxSteps === 0 表示无步数上限；只有显式设置了 maxSteps > 0 时才会在末步收尾
  const isFinal = task.maxSteps > 0 && task.step >= task.maxSteps - 1;
  if (isFinal) task.forcedFinal = true;
  const headerSuffix =
    task.maxSteps > 0 ? ` · 剩余 ${Math.max(0, task.maxSteps - task.step - 1)} 批` : '';
  const partialHint = hadPartialRescue
    ? '（注：上一条回复在生成后续清单中途被网页中断，已先整理已完整收到的只读资料；如需继续建议单批仅附 1~2 项精简查询。）\n'
    : '';
  const batchSpecs = parsedCall?.kind === 'json-tools' && Array.isArray(parsedCall.specs) ? parsedCall.specs : [];
  const usedSubagentThisBatch = batchSpecs.some((s) => (s?.tool || s?.name) === 'web_subagent');
  const isPureLocalReadBatch =
    batchSpecs.length > 0 &&
    !usedSubagentThisBatch &&
    batchSpecs.every((s) => {
      const t = s?.tool || s?.name;
      return t === 'read_file' || t === 'search_code' || t === 'find_files' || t === 'list_dir';
    });
  if (!task.isSubagent) {
    if (usedSubagentThisBatch) task.readOnlyStreak = 0;
    else if (isPureLocalReadBatch) task.readOnlyStreak = (task.readOnlyStreak || 0) + 1;
    else task.readOnlyStreak = 0;
  }
  const serialSubagentHint =
    !task.isSubagent && !isFinal && (task.readOnlyStreak || 0) >= 2
      ? `\n⚡ 加速提示：已连续串行检索 ${task.readOnlyStreak} 批；若后续仍需追踪其他模块或长调用链，建议本轮直接并行派发最多 ${MAX_CONCURRENT_SUBAGENTS} 个 \`web_subagent\` 一次性收口，减少来回轮次。`
      : '';

  const nextStepInstruction = isFinal
    ? task.isSubagent
      ? `已补充 ${task.step} 批资料，请立即基于以上内容输出精炼结构化结论（控制在 600 字内，文件路径用反引号 \`src/file:line\`），不再附清单块。`
      : `本轮已补充 ${task.step} 批资料，请基于以上内容直接给出最终或阶段性纯文本结论，并说明待确认项，不再附清单块。`
    : task.isSubagent
      ? `${partialHint}以上是你要的资料。若核心位置被截断请立即补读该行段，否则请合并只读查询尽早收口；证据充分后直接输出精炼结论（路径用反引号 \`\` \`path:line\` \`\`）。`
      : `${partialHint}以上是你要的资料。若还需${task.readOnly ? '查证' : '查看或改动'}其他位置，请继续在末尾附精简 \`json:local-tool\` 清单（已知单点直查 1~3 项，跨模块调研可并行派发最多 ${MAX_CONCURRENT_SUBAGENTS} 个 \`web_subagent\`）；若信息已足够，请直接给出纯文本结论（路径用反引号 \`\` \`path:line\` \`\`）。${serialSubagentHint}`;

  // Phase 3 & 4：记录工具批次审计事件、Break-Loop 熔断检测与 Steer 纠偏注入
  if (!task.isSubagent) {
    appendSessionEvent(task.sessionId, 'tool_batch', {
      requestId: task.requestId,
      step: task.step,
      tools: batchResults.map((r) => ({ tool: r.tool, ok: Boolean(r.ok), title: String(r.title || '').slice(0, 60) })),
    });
  }
  const loopGuardRes = !task.isSubagent && batchResults.length ? evaluateBatchLoopGuard(task, batchResults) : { triggered: false, directive: '' };
  if (loopGuardRes.triggered) {
    appendSessionEvent(task.sessionId, 'loop_guard', {
      requestId: task.requestId,
      step: task.step,
      code: loopGuardRes.code,
      reason: loopGuardRes.reason,
    });
  }
  const steerRes = !task.isSubagent ? drainSteerBlock(task) : { count: 0, block: '' };
  if (steerRes.count > 0) {
    appendSessionEvent(task.sessionId, 'steer_injected', {
      requestId: task.requestId,
      step: task.step,
      count: steerRes.count,
    });
  }

  // Phase 2：累计上下文预算并在达到阈值时触发 Proactive Rollover（主动换页压缩）
  let proactiveRolloverTriggered = false;
  if (!task.isSubagent && !isFinal && task.webChatUrl) {
    try {
      const charsDelta = String(task.lastToolResultText || '').length + String(task.currentStepText || '').length;
      const st = bumpContextBudget(task.sessionId, { stepDelta: 1, charsDelta, mode: task.uiMode });
      const rolloverCheck = shouldProactiveRollover(st);
      if (rolloverCheck.needed && !task.proactiveRolledOver) {
        proactiveRolloverTriggered = true;
        task.proactiveRolledOver = true;
        task.rolledOverFromWebChatUrl = task.webChatUrl;
        task.forceNewChatNextDispatch = true;
        task.webChatUrl = '';
        task.webCursor = null;
        const resetSt = bumpContextBudget(task.sessionId, { resetTabBudget: true, mode: task.uiMode });
        const handoffBrief = formatTaskStateForHandoff(resetSt);
        task.thoughts = [
          task.thoughts,
          `🔄 上下文预算达到主动换页阈值（${rolloverCheck.reason}），已自动保存进度并切换全新网页页签无损续跑…`,
        ].filter(Boolean).join('\n');
        appendSessionEvent(task.sessionId, 'proactive_rollover', {
          requestId: task.requestId,
          step: task.step,
          reason: rolloverCheck.reason,
          oldUrl: task.rolledOverFromWebChatUrl,
        });
        task.currentStepPrompt = [
          buildSystemToolProtocol(task.cwd, task.protocolOpts || {}),
          '---',
          handoffBrief ? `### 前序任务交接简报
${handoffBrief}` : '',
          steerRes.block || '',
          loopGuardRes.triggered ? loopGuardRes.directive : '',
          `### 最新一批工作区资料（第 ${task.step} 批${headerSuffix}）`,
          '```text',
          task.lastToolResultText,
          '```',
          nextStepInstruction,
        ].filter(Boolean).join('\n\n');
      }
    } catch (_) {}
  }

  if (!proactiveRolloverTriggered) {
    task.currentStepPrompt = [
      steerRes.block || '',
      loopGuardRes.triggered ? loopGuardRes.directive : '',
      `### 补充的工作区资料（第 ${task.step} 批${headerSuffix}）`,
      '```text',
      task.lastToolResultText,
      '```',
      nextStepInstruction,
    ].filter(Boolean).join('\n');
  }
  task.retryAttempt = 0;
  task.runningTools = false;
  task.status = 'queued';
  task.dispatched = false;
  task.updatedAt = Date.now();
}

// 看门狗：区分真实内容进展（lastProgressAt）、活跃流式生成（activelyGenerating）与空心跳（lastReportAt），杜绝旧节点误判或空心跳导致的死锁
const WEB_TASK_ACK_TIMEOUT_MS = 15000;
const WEB_TASK_SEND_TIMEOUT_MS = 45000;
const WEB_TASK_DEAD_AIR_TIMEOUT_MS = 105000;
const WEB_TASK_NO_PROGRESS_TIMEOUT_MS = 300000;
const WEB_TASK_IDLE_TIMEOUT_MS = 120000;
setInterval(() => {
  const now = Date.now();
  for (const t of webTasks.values()) {
    if (t.runningTools) continue;
    const requeueOnceOrFail = (reasonLog, finalError) => {
      if ((t.retryAttempt || 0) < 2) {
        t.retryAttempt = (t.retryAttempt || 0) + 1;
        t.status = 'queued';
        t.dispatched = false;
        t.ackAt = 0;
        t.sentAt = 0;
        t.activelyGenerating = false;
        t.currentStepText = '';
        t.bestStepText = '';
        t.text = t.accumulatedPrefixText.replace(/\n\n$/, '');
        t.nextDispatchAt = now + 2000 * t.retryAttempt;
        t.lastProgressAt = now;
        t.updatedAt = now;
        log(`[WebBrain] ${reasonLog}，自动重试当前步 (retry=${t.retryAttempt}/2): requestId=${t.requestId} step=${t.step + 1}`);
      } else {
        t.status = 'error';
        t.error = finalError;
        t.updatedAt = now;
        log(`[WebBrain] ${reasonLog}，重试后仍失败: requestId=${t.requestId} step=${t.step + 1}`);
      }
    };

    if (t.status === 'dispatched' && !t.ackAt && !t.lastReportAt && now - (t.dispatchedAt || now) > WEB_TASK_ACK_TIMEOUT_MS) {
      requeueOnceOrFail(
        '浏览器 15s 未确认接收',
        '浏览器未接收任务：请确认 Chrome 已打开 gemini.google.com，并在 chrome://extensions 刷新扩展后按 F5 刷新 Gemini 页签'
      );
    } else if (t.status === 'dispatched' && t.ackAt && !t.sentAt && now - (t.dispatchedAt || now) > WEB_TASK_SEND_TIMEOUT_MS) {
      requeueOnceOrFail(
        '消息 45s 仍未在网页发出',
        '网页输入框未能成功发出消息（可能页面弹窗阻塞或未登录），请检查对应 Gemini 页签后发送“继续”重试'
      );
    } else if (
      (t.status === 'dispatched' || t.status === 'streaming') &&
      now - Math.max(t.lastReportAt || 0, t.dispatchedAt || 0) > WEB_TASK_IDLE_TIMEOUT_MS
    ) {
      requeueOnceOrFail(
        '浏览器超过 2 分钟未回传任何状态（页签可能失去响应或旧脚本未刷新）',
        '浏览器页签超过 2 分钟未响应，请在 chrome://extensions 刷新扩展并发送“继续”重试'
      );
    } else if (
      (t.status === 'dispatched' || t.status === 'streaming') &&
      t.activelyGenerating === false &&
      now - Math.max(t.lastProgressAt || 0, t.dispatchedAt || 0) > WEB_TASK_DEAD_AIR_TIMEOUT_MS
    ) {
      requeueOnceOrFail(
        '网页端非生成状态下超过 105s 无新内容',
        '网页端停止响应且未输出任何正文，已自动中止防卡死（请直接发送“继续”续跑）'
      );
    } else if (
      (t.status === 'dispatched' || t.status === 'streaming') &&
      now - Math.max(t.lastProgressAt || 0, t.dispatchedAt || 0) > WEB_TASK_NO_PROGRESS_TIMEOUT_MS
    ) {
      t.status = 'error';
      t.error = '网页端超过 5 分钟无任何新内容输出，已自动中止防卡死（请直接发送“继续”续跑）';
      t.updatedAt = now;
      log(`[WebBrain] 网页端超过 5 分钟无实质进展，任务中止: requestId=${t.requestId} step=${t.step + 1}`);
    }
  }
}, 5000);

// ─── 网页端用量：Gemini 网页没有公开的配额接口，这里只做本机记账（经桥接发出的每条消息）+ 网页限额提示抓取 ───
const USAGE_FILE = path.join(DIR, 'web_usage.json');
let lastUsageRefreshAt = 0;
let webUsage = { events: [], limitNotice: null };
try {
  if (fs.existsSync(USAGE_FILE)) webUsage = { ...webUsage, ...JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) };
} catch {}

function saveWebUsage() {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(webUsage), 'utf8'); } catch {}
}

function recordWebUsageEvent(evt) {
  const cutoff = Date.now() - 8 * 24 * 3600 * 1000;
  webUsage.events = webUsage.events.filter((e) => e.ts >= cutoff);
  webUsage.events.push(evt);
  saveWebUsage();
}

function summarizeWebUsage() {
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const windows = [
    { key: '5h', label: 'Last 5 hours', since: now - 5 * 3600 * 1000 },
    { key: 'today', label: 'Today', since: dayStart.getTime() },
    { key: '7d', label: 'Last 7 days', since: now - 7 * 24 * 3600 * 1000 },
  ];
  return {
    windows: windows.map((w) => {
      const byModel = {};
      let messages = 0, promptChars = 0, replyChars = 0;
      for (const e of webUsage.events) {
        if (e.ts < w.since) continue;
        messages++;
        promptChars += e.promptChars || 0;
        replyChars += e.replyChars || 0;
        const m = e.model || 'Unknown';
        byModel[m] = (byModel[m] || 0) + 1;
      }
      return { key: w.key, label: w.label, messages, promptChars, replyChars, byModel };
    }),
    limitNotice: webUsage.limitNotice,
    quota: webUsage.quota || null,
    currentLabel: webModelState.currentLabel,
    browserOnline: isBrowserOnline(),
  };
}

// ─── HTTP 路由 ───
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (PAGE_ORIGINS.has(origin)) return true;
  return origin.startsWith('chrome-extension://');
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const origin = String(req.headers.origin || '');
  if (!isAllowedOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Origin not allowed' }));
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // 只有网页来源会走 Chrome 的 Private Network Access 预检；扩展来源不需要该头
    if (PAGE_ORIGINS.has(origin)) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  // POST 只收 application/json：拦住 no-cors 的 text/plain 简单请求，无需依赖 Origin 判断
  if (req.method === 'POST') {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return sendJson(res, 415, { ok: false, error: 'Content-Type must be application/json' });
    }
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  try {
    if (req.method === 'GET' && pathname === '/gemini-local-agent.user.js') {
      const scriptPath = path.join(DIR, 'gemini-local-agent.user.js');
      const js = fs.readFileSync(scriptPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(js);
    }

    if (req.method === 'GET' && pathname === '/protocol') {
      const qCwd = parsedUrl.searchParams.get('cwd') || state.cwd || DEFAULT_CWD;
      return sendJson(res, 200, { ok: true, protocol: buildSystemToolProtocol(qCwd) });
    }

    // 1. 通用状态查询
    if (req.method === 'GET' && pathname === '/status') {
      const turn = acpBridge.currentTurn;
      const runningTasks = [...webTasks.values()].filter(
        (t) => t.status === 'queued' || t.status === 'dispatched' || t.status === 'streaming'
      );
      const statusCwd = state.cwd || DEFAULT_CWD;
      const memDirs = resolveMemoryDirs(statusCwd);
      return sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        startedAt: SERVER_STARTED_AT,
        sessionId: state.sessionId,
        cwd: state.cwd,
        backend: state.backend,
        busy: Boolean(turn),
        elapsedSec: turn ? Math.floor((Date.now() - turn.startedAt) / 1000) : 0,
        liveText: turn ? turn.text.slice(-500) : '',
        tools: turn ? turn.tools.slice(-6) : [],
        browserOnline: isBrowserOnline(),
        webModelState,
        webTaskBusy: runningTasks.length > 0,
        activeWebRequestId: runningTasks[0]?.requestId || null,
        contextSources: {
          rulesDir: toDisplayPath(DEFAULT_RULES_DIR),
          memoryWriteDir: toDisplayPath(memDirs.primaryWriteDir),
          memoryReadDirs: memDirs.readDirs.map((d) => toDisplayPath(d)),
          skillDirs: getSkillSearchDirs(statusCwd).map((d) => toDisplayPath(d)),
          toolIndexFile: toDisplayPath(LOCAL_TOOL_INDEX_FILE),
        },
      });
    }

    // 1.1 优雅停机端点：供 /restart-bridge 在 Windows 下无权限依赖地即时释放端口
    if (req.method === 'POST' && pathname === '/admin/shutdown') {
      if (origin) return sendJson(res, 403, { ok: false, error: 'Local native client only' });
      log(`[Bridge] 收到 /admin/shutdown 指令，准备优雅退出 (PID=${process.pid})`);
      const srvRef = res.socket?.server || null;
      sendJson(res, 200, { ok: true, pid: process.pid, shuttingDown: true });
      setTimeout(() => {
        try {
          if (srvRef) srvRef.close(() => process.exit(0));
        } catch (_) {}
        setTimeout(() => process.exit(0), 250).unref();
      }, 40);
      return;
    }

    // 2. 浏览器扩展轮询待执行指令 (/browser/poll)
    if (req.method === 'GET' && pathname === '/browser/poll') {
      const now = Date.now();
      lastBrowserHeartbeat = now;
      const curLabel = parsedUrl.searchParams.get('modelLabel');
      if (curLabel) {
        webModelState.currentLabel = curLabel;
      }

      const activeSessionIds = [
        ...new Set(
          [...webTasks.values()]
            .filter((t) => t.status === 'queued' || t.status === 'dispatched' || t.status === 'streaming')
            .map((t) => t.sessionId)
            .filter(Boolean)
        ),
      ];

      // 仅对「正在向网页粘贴并点击发送（约 1.5~3s）」这一动作做全局串行锁（最长保护 10s）；
      // 一旦前一个页签已发出消息（sentAt > 0 或进入 streaming），立即放行下一个会话页签发送，实现真正的「串行发送 + 独立页签并发生成」
      const sendingTask = [...webTasks.values()].find(
        (t) => t.status === 'dispatched' && !t.sentAt && now - (t.dispatchedAt || 0) < 10000
      );
      // 同一会话（同一个 Gemini 页签）内部仍严格串行：上一步未完成前不下发同会话下一步
      const inFlightSessions = new Set(
        [...webTasks.values()]
          .filter((t) => t.status === 'dispatched' || t.status === 'streaming')
          .map((t) => t.sessionId)
          .filter(Boolean)
      );

      let command = null;

      // 优先处理单会话精准取消指令（仅当该任务确实已派发到浏览器且不在跑本地工具时才通知对应页签点停止）
      for (const task of webTasks.values()) {
        if (task.status === 'cancelled' && !task.cancelDispatched) {
          task.cancelDispatched = true;
          if ((task.wasDispatchedBeforeCancel || task.dispatched) && !task.runningTools) {
            command = {
              requestId: task.requestId,
              sessionId: task.sessionId || '',
              webChatUrl: task.webChatUrl || '',
              action: 'cancel',
            };
            break;
          }
        }
      }

      // 其次按队列顺序串行下发待发送任务（不同会话各自绑定独立页签，发完即放行下一个会话）
      if (!command && !sendingTask) {
        for (const task of webTasks.values()) {
          if (task.status === 'queued' && !task.dispatched) {
            if (task.sessionId && inFlightSessions.has(task.sessionId)) continue;
            if (task.nextDispatchAt && now < task.nextDispatchAt) continue;
            task.nextDispatchAt = 0;
            task.dispatched = true;
            task.status = 'dispatched';
            task.ackAt = 0;
            task.sentAt = 0;
            task.activelyGenerating = false;
            task.lastReportAt = 0;
            task.lastProgressAt = now;
            task.dispatchedAt = now;
            task.updatedAt = now;
            const dispatchNewChat = task.forceNewChatNextDispatch ? true : task.step === 0 ? task.newChat : false;
            task.forceNewChatNextDispatch = false;
            command = {
              requestId: task.requestId,
              step: task.step,
              retryAttempt: task.retryAttempt || 0,
              sessionId: task.sessionId || task.requestId,
              action: 'send',
              prompt: task.currentStepPrompt,
              images: task.step === 0 && Array.isArray(task.images) && task.images.length ? task.images : [],
              newChat: dispatchNewChat,
              webChatUrl: dispatchNewChat ? '' : task.webChatUrl || '',
              webCursor: dispatchNewChat ? null : task.webCursor || null,
              webModel: task.webModel || '',
              webEffort: task.webEffort || '',
              autoCloseTab: task.autoCloseTab !== false,
            };
            log(
              `[WebBrain] 下发第 ${task.step + 1} 步任务给浏览器: requestId=${task.requestId} session=${task.sessionId || 'anon'} cursor=${task.webCursor?.cId || 'new'}${dispatchNewChat ? ' newChat=true' : ''}`
            );
            break;
          }
        }
      }

      // 最后在无发送冲突时消费辅助浏览器指令（close_tab / list_conversations / fetch_conversation / set_model / refresh_usage）
      if (!command && pendingBrowserCommandQueue.length > 0) {
        const idx = sendingTask
          ? pendingBrowserCommandQueue.findIndex((c) => c?.action === 'close_tab')
          : 0;
        if (idx >= 0) {
          const [cmd] = pendingBrowserCommandQueue.splice(idx, 1);
          command = cmd;
        }
      }

      return sendJson(res, 200, { ok: true, command, activeSessionIds });
    }

    // 3. 浏览器扩展回传网页端流式输出、思维链、游标、模型菜单项与完成事件 (/browser/report)
    if (req.method === 'POST' && pathname === '/browser/report') {
      lastBrowserHeartbeat = Date.now();
      const body = await readJsonBody(req);
      const reportTask = body.requestId ? webTasks.get(body.requestId) : null;

      if (body.currentModelLabel && !reportTask?.isSubagent) {
        webModelState.currentLabel = String(body.currentModelLabel).trim();
      }
      if (Array.isArray(body.availableModels) && body.availableModels.length > 0) {
        const normalizedModels = normalizeDiscoveredWebModels(body.availableModels);
        if (normalizedModels.length > 0) {
          webModelState.availableOptions = normalizedModels;
          webModelState.updatedAt = Date.now();
          state.webAvailableModels = normalizedModels;
          state.webModelsUpdatedAt = webModelState.updatedAt;
          saveState();
          log(
            `[WebBrain] 已同步网页端可用模型 (${normalizedModels.length} 个): ${normalizedModels.map((m) => m.label).join(', ')}`
          );
        }
      }
      if (body.opId && pendingBrowserOps.has(body.opId)) {
        const entry = pendingBrowserOps.get(body.opId);
        pendingBrowserOps.delete(body.opId);
        clearTimeout(entry.timer);
        if (body.error && !body.webConversationsList && !body.fetchedConversation) {
          entry.reject(new Error(String(body.error)));
        } else {
          entry.resolve(body);
        }
        return sendJson(res, 200, { ok: true });
      }

      if (body.webQuota && typeof body.webQuota === 'object') {
        // 扩展刷新后，已打开页签里残留的旧 content.js 仍会直连上报旧解析结果，这里直接丢弃
        if (body.webQuota.parser !== 2) {
          log('[WebBrain] 忽略旧版扩展脚本的用量上报（请刷新 Gemini 页签）');
          return sendJson(res, 200, { ok: true, ignored: true });
        }
        const buckets = Array.isArray(body.webQuota.buckets) ? body.webQuota.buckets.slice(0, 6) : [];
        webUsage.quota = {
          buckets,
          error: String(body.webQuota.error || ''),
          fetchedAt: Date.now(),
        };
        saveWebUsage();
        log(
          buckets.length
            ? `[WebBrain] 网页用量: ${buckets.map((b) => `${b.window}=${b.usedPct}% ${b.resetText || ''}`).join(' | ')}`
            : `[WebBrain] 用量页未解析到进度条，页面文本: ${String(body.webQuota.rawText || '').slice(0, 400)}`
        );
        return sendJson(res, 200, { ok: true });
      }

      if (typeof body.limitNotice === 'string' && body.limitNotice.trim()) {
        webUsage.limitNotice = {
          text: body.limitNotice.trim().slice(0, 240),
          model: webModelState.currentLabel || '',
          detectedAt: Date.now(),
        };
        saveWebUsage();
        log(`[WebBrain] 网页端出现限额提示: ${webUsage.limitNotice.text}`);
      }

      if (body.tabClosed && body.sessionId) {
        for (const t of webTasks.values()) {
          if (
            t.sessionId === body.sessionId &&
            (t.status === 'dispatched' || (t.status === 'streaming' && !t.runningTools))
          ) {
            t.status = 'error';
            t.error = '绑定的 Gemini 网页标签页已被关闭，请重新发送';
            t.updatedAt = Date.now();
            log(`[WebBrain] 绑定页签关闭，中止任务: requestId=${t.requestId} session=${t.sessionId}`);
          }
        }
        return sendJson(res, 200, { ok: true });
      }

      const task = body.requestId ? webTasks.get(body.requestId) : null;
      // 只接收当前这一步的上报：迟到的上一步上报、残留旧脚本的上报、任务已结束后的上报都丢弃，避免串步/覆盖
      const isStaleReport =
        task &&
        ((typeof body.step === 'number' && body.step !== task.step) ||
          task.status === 'queued' ||
          task.status === 'completed' ||
          task.status === 'error' ||
          task.runningTools);
      if (task && isStaleReport) {
        return sendJson(res, 200, { ok: true, ignored: true });
      }
      if (task && task.status !== 'cancelled') {
        task.lastReportAt = Date.now();
        if (body.status === 'accepted') {
          task.ackAt = Date.now();
          task.lastProgressAt = Date.now();
          return sendJson(res, 200, { ok: true });
        }
        if (body.status === 'sent') {
          task.ackAt = task.ackAt || Date.now();
          task.sentAt = Date.now();
          task.images = null;
          task.lastProgressAt = Date.now();
          if (
            typeof body.webChatUrl === 'string' &&
            /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]+/i.test(body.webChatUrl)
          ) {
            task.webChatUrl = body.webChatUrl;
          }
          return sendJson(res, 200, { ok: true });
        }
        if (!task.sentAt && (body.status === 'completed' || body.text || body.thoughts)) {
          task.sentAt = Date.now();
        }
        if (typeof body.activelyGenerating === 'boolean') {
          task.activelyGenerating = body.activelyGenerating;
        }
        if (body.webCursor && body.webCursor.cId) {
          task.webCursor = body.webCursor;
        }
        if (
          typeof body.webChatUrl === 'string' &&
          /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]+/i.test(body.webChatUrl)
        ) {
          task.webChatUrl = body.webChatUrl;
        }
        if (typeof body.text === 'string') {
          if (body.text && body.text !== task.currentStepText) {
            task.lastProgressAt = Date.now();
          }
          task.currentStepText = body.text;
          task.text = task.accumulatedPrefixText + body.text;
          const trimmedText = body.text.trim();
          if (
            trimmedText &&
            !isCannedRefusalReply(trimmedText) &&
            !isTransientErrorReply(trimmedText) &&
            (body.text.length >= (task.bestStepText || '').length || Boolean(parseToolCallsFromMarkdown(body.text)))
          ) {
            task.bestStepText = body.text;
          }
        }
        if (typeof body.bestStreamText === 'string' && body.bestStreamText.trim()) {
          const streamCand = body.bestStreamText;
          if (
            !isCannedRefusalReply(streamCand) &&
            !isTransientErrorReply(streamCand) &&
            (streamCand.length >= (task.bestStepText || '').length || Boolean(parseToolCallsFromMarkdown(streamCand)))
          ) {
            task.bestStepText = streamCand;
          }
        }
        if (typeof body.thoughts === 'string' && body.thoughts.trim()) {
          if (body.thoughts !== task.thoughts) {
            task.lastProgressAt = Date.now();
          }
          task.thoughts = body.thoughts;
        }
        if (body.error) {
          if (body.retryable && !body.limitNotice && (task.retryAttempt || 0) < 2) {
            task.retryAttempt = (task.retryAttempt || 0) + 1;
            task.status = 'queued';
            task.dispatched = false;
            task.ackAt = 0;
            task.sentAt = 0;
            task.activelyGenerating = false;
            task.currentStepText = '';
            task.bestStepText = '';
            task.text = task.accumulatedPrefixText.replace(/\n\n$/, '');
            task.nextDispatchAt = Date.now() + 2000 * task.retryAttempt;
            task.lastProgressAt = Date.now();
            task.updatedAt = Date.now();
            log(
              `[WebBrain] 浏览器上报可重试异常 (${body.error})，自动重试当前步 (retry=${task.retryAttempt}/2): requestId=${task.requestId} step=${task.step + 1}`
            );
            return sendJson(res, 200, { ok: true, retryingStep: true });
          }
          task.error =
            typeof body.step === 'number'
              ? body.error
              : `${body.error}（检测到旧版扩展脚本：请在 chrome://extensions 刷新扩展，并按 F5 刷新所有 Gemini 页签）`;
          task.status = 'error';
          return sendJson(res, 200, { ok: true });
        }

        if (body.status === 'streaming') {
          if (task.sentAt) {
            task.status = 'streaming';
          }
          task.updatedAt = Date.now();
          return sendJson(res, 200, { ok: true });
        }

        if (body.status === 'completed') {
          let stepReply = task.currentStepText || '';
          log(
            `[WebBrain] 浏览器完成第 ${task.step + 1} 步生成: requestId=${body.requestId} cursor=${task.webCursor?.cId || ''} len=${stepReply.length}`
          );
          recordWebUsageEvent({
            ts: Date.now(),
            model: task.isSubagent
              ? task.webModel || body.currentModelLabel || ''
              : webModelState.currentLabel || task.webModel || '',
            promptChars: String(task.currentStepPrompt || '').length,
            replyChars: stepReply.length,
          });

          const rawIsRefusalOrErr = isCannedRefusalReply(stepReply) || isTransientErrorReply(stepReply);
          const rawIsTruncatedTools = task.serverReAct && !task.forcedFinal && isTruncatedToolCallReply(stepReply);
          let rescuedPartialCall = null;

          if ((rawIsRefusalOrErr || rawIsTruncatedTools) && (task.bestStepText || rawIsTruncatedTools)) {
            const candidate = rawIsTruncatedTools ? stepReply : task.bestStepText;
            const rescuedCall = !task.forcedFinal && candidate ? parseToolCallsFromMarkdown(candidate) : null;
            const partialCall =
              !rescuedCall && !task.forcedFinal && candidate
                ? extractCompleteReadOnlyToolsFromTruncatedStream(candidate)
                : null;
            if (rescuedCall) {
              log(`[WebBrain] 从网页后置异常/拦截前抢救出已流式生成的完整工具调用块: requestId=${task.requestId} step=${task.step + 1}`);
              stepReply = candidate;
              task.currentStepText = candidate;
              task.text = task.accumulatedPrefixText + candidate;
            } else if (partialCall) {
              log(
                `[WebBrain] 从被拦截截断的工具流中抢救出 ${partialCall.specs.length} 个完整只读工具: requestId=${task.requestId} step=${task.step + 1}`
              );
              rescuedPartialCall = partialCall;
              task.partialRescueNotice = true;
              stepReply = partialCall.normalizedMarkdown;
              task.currentStepText = partialCall.normalizedMarkdown;
              task.text = task.accumulatedPrefixText + partialCall.normalizedMarkdown;
            } else if (rawIsRefusalOrErr && candidate && isCompleteLongAnswerForRescue(candidate)) {
              log(`[WebBrain] 从网页后置异常/拦截前抢救出已流式生成的完整长回答: requestId=${task.requestId} step=${task.step + 1}`);
              stepReply = candidate;
              task.currentStepText = candidate;
              task.text = task.accumulatedPrefixText + candidate;
            } else if (rawIsRefusalOrErr && candidate) {
              log(
                `[WebBrain] 丢弃拦截前不完整的流式残留 (len=${candidate.length})，交由拒答自动续跑恢复: requestId=${task.requestId} step=${task.step + 1}`
              );
            }
          }

          const parsedCall =
            rescuedPartialCall || (task.serverReAct && !task.forcedFinal ? parseToolCallsFromMarkdown(stepReply) : null);
          if (parsedCall) {
            task.refusalRetries = 0;
            task.transientErrorRetries = 0;
            task.falseLimitRetries = 0;
            // 先立即回包给浏览器，工具在后台执行；工具耗时长时不会把浏览器的上报请求挂住
            task.status = 'streaming';
            task.runningTools = true;
            task.updatedAt = Date.now();
            sendJson(res, 200, { ok: true, continuingReAct: true });
            runReActToolStep(task, parsedCall).catch((err) => {
              task.runningTools = false;
              task.error = `本地工具执行异常: ${err.message}`;
              task.status = 'error';
              log(`[WebBrain ReAct] 工具执行异常 requestId=${task.requestId}: ${err.message}`);
            });
            return;
          }

          const isEmptyReply = !stepReply.trim();
          const isTransientErr = isTransientErrorReply(stepReply);
          if ((isTransientErr || isEmptyReply) && !body.limitNotice && (task.transientErrorRetries || 0) < 2) {
            task.transientErrorRetries = (task.transientErrorRetries || 0) + 1;
            const briefErr = isEmptyReply ? '空白回复' : stepReply.trim().slice(0, 120);
            const backoffMs = task.transientErrorRetries === 1 ? 2500 : 4500;
            log(
              `[WebBrain] 检测到网页端临时错误/空回复 (${briefErr})，${Math.round(backoffMs / 1000)}s 后自动重试 (${task.transientErrorRetries}/2): requestId=${task.requestId} step=${task.step + 1}`
            );
            task.currentStepText = '';
            task.bestStepText = '';
            task.text = task.accumulatedPrefixText.replace(/\n\n$/, '');
            if (task.transientErrorRetries === 1) {
              if (task.step === 0 && !task.webChatUrl) {
                // 首步且尚未生成会话 URL：保留原 currentStepPrompt 重发
              } else if (task.serverReAct) {
                task.currentStepPrompt =
                  '刚才网页端返回了临时系统错误，请重新处理上一条消息并继续：还需查证请输出 ```json:local-tool 代码块，信息完备请直接给出结论。';
              } else {
                task.currentStepPrompt = '刚才网页端返回了临时系统错误，请重新回答我上一条消息。';
              }
            } else if (task.step > 0 && task.lastToolResultText) {
              const compactResults = task.lastToolResultText.slice(0, 12000);
              task.currentStepPrompt = [
                '刚才网页端返回了临时系统错误，以下是上一批本机执行结果的精简摘要，请基于此继续：',
                '```text',
                compactResults,
                '```',
              ].join('\n');
            }
            task.step += 1;
            task.retryAttempt = 0;
            task.ackAt = 0;
            task.sentAt = 0;
            task.activelyGenerating = false;
            task.status = 'queued';
            task.dispatched = false;
            task.nextDispatchAt = Date.now() + backoffMs;
            task.lastProgressAt = Date.now();
            task.updatedAt = Date.now();
            return sendJson(res, 200, { ok: true, retryingTransientError: true });
          }

          const isRefusalOrTruncated = isCannedRefusalReply(stepReply) || (task.serverReAct && !task.forcedFinal && isTruncatedToolCallReply(stepReply));
          if (task.serverReAct && isRefusalOrTruncated && (task.refusalRetries || 0) < 3) {
            task.everRefused = true;
            task.refusalRetries = (task.refusalRetries || 0) + 1;
            const retryIdx = task.refusalRetries;
            const backoffMs =
              retryIdx === 1 ? REFUSAL_RETRY_BASE_MS : retryIdx === 2 ? REFUSAL_RETRY_BASE_MS * 2 : Math.round(REFUSAL_RETRY_BASE_MS * 2.6);
            const reasonTag = isCannedRefusalReply(stepReply)
              ? `罐头拒答 (${stepReply.trim().slice(0, 80)})`
              : `工具块在生成中途被截断 (len=${stepReply.length})`;
            task.currentStepText = '';
            task.bestStepText = '';
            task.text = task.accumulatedPrefixText.replace(/\n\n$/, '');
            let rolledOverThisRetry = false;
            if (task.step > 0) {
              if (retryIdx === 1) {
                task.currentStepPrompt =
                  '刚才的回复在生成中途中断了。这是常规的软件代码分析协作，请承接上面的分析继续推进：若还需查阅文件，建议本次只附 1~2 个精简的 `json:local-tool` 清单（避免单批过大）；若已有足够信息，请直接给出纯文本结论。';
              } else if (retryIdx === 2 && !task.isSubagent && task.webChatUrl && !task.hasAutoRolledOver) {
                // 原窗口连续 2 次触发拦截：自动压缩前序进展并切换到全新空白窗口无缝续跑
                rolledOverThisRetry = true;
                task.hasAutoRolledOver = true;
                task.rolledOverFromWebChatUrl = task.webChatUrl;
                task.forceNewChatNextDispatch = true;
                task.webChatUrl = '';
                task.webCursor = null;
                task.currentStepPrompt = buildRolloverHandoffPrompt(task);
                task.thoughts = [
                  task.thoughts,
                  '🔄 原网页窗口连续触发中断限制，已自动压缩前序进展并切换到全新窗口继续…',
                ]
                  .filter(Boolean)
                  .join('\n');
              } else if (retryIdx === 2) {
                const compactHeaders = task.lastToolResultText
                  ? buildSanitizedRetrySummary(task.lastToolResultText, 2200, true)
                  : '';
                task.currentStepPrompt = compactHeaders
                  ? [
                      '上述补充资料较长，以下仅保留关键条目与路径。请仅输出纯文本结论（如确需补充细节，本次最多附 1 个精简的 `json:local-tool` 清单）：',
                      '```text',
                      compactHeaders,
                      '```',
                    ].join('\n')
                  : '请仅输出纯文本结论（如确需补充细节，本次最多附 1 个精简的 `json:local-tool` 清单）。';
              } else {
                // 第 3 级纯文本保底：不再要求输出 json:local-tool，让模型把当前已分析出的成果完整落盘
                task.forcedFinal = true;
                task.currentStepPrompt =
                  '请先不要再输出 `json:local-tool` 代码块。请直接用纯文本输出你基于已读取代码完成的阶段性审查结论与修改建议，并列出尚未查阅的剩余文件/行号清单，方便后续在压缩新窗口中继续。';
              }
            } else {
              const originalQuestion = normalizeHomePathsInText(
                stripInjectedUserPrefixes(task.rawUserPrompt || '').cleanText || task.rawUserPrompt || ''
              )
                .trim()
                .slice(0, retryIdx === 1 ? 2000 : 1200);
              const questionBlock = originalQuestion ? `\n\n用户原始需求：\n${originalQuestion}` : '';
              if (retryIdx === 1) {
                task.currentStepPrompt = `这是一个正常的软件开发技术问答与代码分析协作。你只需正常输出纯文本分析；如需我帮你查阅工作区规范、记忆或代码片段，可在回复末尾附一段精简 \`\`\`json:local-tool 清单（如 \`[{"tool":"get_context","args":{"kind":"rules"}}]\`），我会在下条消息贴给你。${questionBlock}`;
              } else if (retryIdx === 2) {
                task.currentStepPrompt = `请作为软件工程技术助手直接用纯文本回答下方需求；如果缺少代码上下文，只需在末尾附 1 个精简的 \`\`\`json:local-tool 清单即可。${questionBlock}`;
              } else {
                task.forcedFinal = true;
                task.currentStepPrompt = `请直接用纯文本针对下方软件开发需求给出分析思路或需要查看的关键文件清单（不要输出清单代码块）。${questionBlock}`;
              }
            }
            log(
              `[WebBrain] 检测到网页端${reasonTag}，${(backoffMs / 1000).toFixed(1)}s 后${rolledOverThisRetry ? '自动压缩切新窗续跑' : '自动续跑恢复'} (${retryIdx}/3): requestId=${task.requestId}${rolledOverThisRetry ? ` oldUrl=${task.rolledOverFromWebChatUrl}` : ''}`
            );
            task.step += 1;
            task.retryAttempt = 0;
            task.ackAt = 0;
            task.sentAt = 0;
            task.activelyGenerating = false;
            task.status = 'queued';
            task.dispatched = false;
            task.nextDispatchAt = Date.now() + backoffMs;
            task.lastProgressAt = Date.now();
            task.updatedAt = Date.now();
            return sendJson(res, 200, { ok: true, retryingRefusal: true, autoRollingOver: rolledOverThisRetry });
          }

          if (task.serverReAct && isRefusalOrTruncated) {
            const hint =
              '\n\n> ⚠️ 当前 Gemini 网页对话窗口多次触发网页端输出中断/拒答限制（通常因单窗口上下文过长导致）。建议点击顶栏「压缩上下文开新窗」或发送 `/compact` 切到新窗口后继续，上下文会自动无损交接。';
            task.currentStepText = (stepReply || '').trim() + hint;
            task.text = task.accumulatedPrefixText + task.currentStepText;
          }

          if (
            task.serverReAct &&
            task.maxSteps === 0 &&
            FALSE_LIMIT_RE.test(stepReply) &&
            (task.falseLimitRetries || 0) < 3
          ) {
            task.falseLimitRetries = (task.falseLimitRetries || 0) + 1;
            log(`[WebBrain] 检测到模型误报工具上限，自动发起新回合续跑 (${task.falseLimitRetries}/3): requestId=${task.requestId}`);
            task.accumulatedPrefixText = task.text + '\n\n';
            task.currentStepText = '';
            task.bestStepText = '';
            task.step += 1;
            task.retryAttempt = 0;
            task.ackAt = 0;
            task.sentAt = 0;
            task.activelyGenerating = false;
            task.currentStepPrompt =
              '当前已是新回合，请继续完成刚才列出的剩余步骤：如需查证或修改请附 ```json:local-tool 请求块，若全部核验完毕请直接给出最终总结。';
            task.status = 'queued';
            task.dispatched = false;
            task.lastProgressAt = Date.now();
            task.updatedAt = Date.now();
            return sendJson(res, 200, { ok: true, retryingFalseLimit: true });
          }

          task.status = 'completed';
          task.updatedAt = Date.now();
          return sendJson(res, 200, {
            ok: true,
            turnCompleted: true,
            autoCloseTab: task.autoCloseTab !== false,
          });
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // 4. 在 VS Code 插件或悬浮窗中设置/切换网页端的模型与 Effort (/web-brain/set-model)
    if (req.method === 'POST' && pathname === '/web-brain/set-model') {
      const body = await readJsonBody(req);
      if (typeof body.model === 'string') {
        webModelState.desiredModel = body.model.trim();
        state.webModel = webModelState.desiredModel;
      }
      if (typeof body.effort === 'string') {
        webModelState.desiredEffort = body.effort.trim().toLowerCase();
        state.webEffort = webModelState.desiredEffort;
      }
      if (typeof body.backend === 'string') {
        state.backend = body.backend;
      }
      saveState();

      pendingBrowserCommandQueue.push({
        action: 'set_model',
        sessionId: body.sessionId ? String(body.sessionId) : '',
        webModel: webModelState.desiredModel,
        webEffort: webModelState.desiredEffort,
        discover: Boolean(body.discover),
      });
      log(
        `[WebBrain] 请求切换网页端模型/档位: model="${webModelState.desiredModel}" effort="${webModelState.desiredEffort}"`
      );
      return sendJson(res, 200, { ok: true, webModelState });
    }

    // 4.1 主动同步/发现 Gemini 网页端当前账号可用模型列表 (/web-brain/models/sync)
    if (req.method === 'POST' && pathname === '/web-brain/models/sync') {
      if (!isBrowserOnline()) {
        return sendJson(res, 200, {
          ok: false,
          error: '未检测到在线的 Chrome 扩展（请确认 Chrome 已打开并已启用 Gemini Web Bridge 扩展）',
          webModelState,
        });
      }
      lastAutoModelSyncAt = Date.now();
      try {
        await enqueueBrowserOp(
          {
            action: 'set_model',
            webModel: '',
            webEffort: '',
            discover: true,
          },
          16000
        );
        return sendJson(res, 200, { ok: true, webModelState });
      } catch (err) {
        return sendJson(res, 200, {
          ok: false,
          error: err?.message || String(err),
          webModelState,
        });
      }
    }

    // 5. 发起 WebBrain 对话任务 (/web-brain/send)
    if (req.method === 'POST' && pathname === '/web-brain/send') {
      pruneOldWebTasks();
      const body = await readJsonBody(req);
      const rawPrompt = String(body.prompt || '').trim();
      if (!rawPrompt) return sendJson(res, 400, { ok: false, error: 'prompt 不能为空' });

      const taskCwd = body.cwd || state.cwd || DEFAULT_CWD;
      const uiMode = normalizeUiMode(body.uiMode);
      const modePolicy = getModePolicy(uiMode);
      const serverReAct = body.agentMode !== false;
      const alreadyHasProtocol = /### 工作区资料协作说明|### 本地协作约定|### 本地开发工作区工具说明|\[System Tool Protocol\]/.test(rawPrompt);
      const injectProtocol = body.injectProtocol !== false && serverReAct && !alreadyHasProtocol;
      const protocolOpts = {
        skillDirs: Array.isArray(body.skillDirs) ? body.skillDirs : undefined,
        rulesDir: typeof body.rulesDir === 'string' && body.rulesDir.trim() ? body.rulesDir.trim() : undefined,
        memoryDir: typeof body.memoryDir === 'string' && body.memoryDir.trim() ? body.memoryDir.trim() : undefined,
      };

      if (body.webModel) webModelState.desiredModel = String(body.webModel).trim();
      if (body.webEffort) webModelState.desiredEffort = String(body.webEffort).trim().toLowerCase();

      const requestId = `wb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const targetSessionId = String(body.sessionId || requestId);
      const newChat = Boolean(body.newChat);
      const rawMax = Number(body.maxSteps);

      const prevSessionMode = newChat ? null : sessionLastUiMode.get(targetSessionId);
      sessionLastUiMode.set(targetSessionId, uiMode);

      const researchHint = detectMultiModuleResearchHint(rawPrompt);
      let contextHints = '';
      if (injectProtocol) {
        try {
          const cleanForRoute = stripInjectedUserPrefixes(rawPrompt).cleanText || rawPrompt;
          const rulesItems = listRuleEntries(taskCwd, protocolOpts).items;
          const memoryItems = listMemoryEntries(taskCwd, protocolOpts).entries;
          contextHints = buildContextHintsBlock({
            rawPrompt: cleanForRoute,
            rulesItems,
            memoryItems,
          });
        } catch {}
      }
      const modeChangeNotice =
        !injectProtocol && prevSessionMode && prevSessionMode !== uiMode
          ? buildModeChangeNotice(prevSessionMode, uiMode)
          : '';
      const firstPrompt = injectProtocol
        ? `${buildSystemToolProtocol(taskCwd, { ...protocolOpts, uiMode, researchHint, contextHints })}\n\n${rawPrompt}`
        : modeChangeNotice
          ? `${modeChangeNotice}\n\n${rawPrompt}`
          : rawPrompt;

      // 若同一对话栏此前有残留未结任务，仅替换清理本会话的旧任务（含其派生子代理），避免阻塞本会话新消息且不影响其它对话栏
      if (body.sessionId) {
        for (const oldTask of webTasks.values()) {
          if (
            oldTask.sessionId === targetSessionId &&
            (oldTask.status === 'queued' || oldTask.status === 'dispatched' || oldTask.status === 'streaming')
          ) {
            cancelWebTaskTree(oldTask);
            oldTask.cancelDispatched = true;
          }
        }
      }

      const task = {
        requestId,
        sessionId: targetSessionId,
        isSubagent: false,
        parentRequestId: '',
        uiMode,
        readOnly: Boolean(modePolicy.readOnly),
        childRequestIds: new Set(),
        cwd: taskCwd,
        protocolOpts,
        rawUserPrompt: rawPrompt,
        newChat,
        webChatUrl: newChat ? '' : String(body.webChatUrl || ''),
        webCursor: newChat ? null : body.webCursor || null,
        autoCloseTab: body.autoCloseTab !== false,
        serverReAct,
        maxSteps: rawMax > 0 ? rawMax : 0, // 0 表示无步数上限
        step: 0,
        images: Array.isArray(body.images)
          ? body.images
              .filter((im) => im && im.data)
              .slice(0, 4)
              .map((im) => ({ name: im.name || 'image.png', mimeType: im.mimeType || 'image/png', data: im.data }))
          : null,
        webModel: body.webModel ? String(body.webModel).trim() : '',
        webEffort: body.webEffort ? String(body.webEffort).trim().toLowerCase() : '',
        currentStepPrompt: firstPrompt,
        accumulatedPrefixText: '',
        currentStepText: '',
        bestStepText: '',
        lastToolResultText: '',
        lastCallSig: '',
        sameCallStreak: 0,
        refusalRetries: 0,
        everRefused: false,
        forceNewChatNextDispatch: false,
        hasAutoRolledOver: false,
        proactiveRolledOver: false,
        rolledOverFromWebChatUrl: '',
        steerQueue: [],
        loopGuard: createLoopGuardState(),
        pendingApproval: null,
        planEntries: toClientPlanEntries(loadTaskState(targetSessionId, uiMode)),
        falseLimitRetries: 0,
        text: '',
        thoughts: '',
        tools: [],
        status: 'queued',
        error: null,
        dispatched: false,
        sentAt: 0,
        wasDispatchedBeforeCancel: false,
        cancelDispatched: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      webTasks.set(requestId, task);
      appendSessionEvent(targetSessionId, 'turn_start', {
        requestId,
        mode: uiMode,
        newChat,
        model: task.webModel || webModelState.desiredModel || '',
      });
      log(
        `[WebBrain] 新任务 requestId=${requestId} mode=${uiMode} cursor=${task.webCursor?.cId || 'new'} newChat=${newChat} model=${task.webModel || webModelState.desiredModel}`
      );
      return sendJson(res, 200, {
        ok: true,
        requestId,
        browserOnline: isBrowserOnline(),
        webModelState,
      });
    }

    // 6. 轮询 WebBrain 任务进度 (/web-brain/poll)
    if (req.method === 'GET' && pathname === '/web-brain/poll') {
      const reqId = parsedUrl.searchParams.get('requestId');
      const task = reqId ? webTasks.get(reqId) : null;
      if (!task) {
        return sendJson(res, 404, { ok: false, error: '未找到对应的 WebBrain 任务' });
      }
      return sendJson(res, 200, {
        ok: true,
        requestId: task.requestId,
        status: task.status,
        step: task.step,
        text: task.text,
        thoughts: task.thoughts,
        tools: task.tools,
        webChatUrl: task.webChatUrl || '',
        webCursor: task.webCursor || null,
        autoRolledOver: Boolean(task.hasAutoRolledOver),
        proactiveRolledOver: Boolean(task.proactiveRolledOver),
        rolledOverFromWebChatUrl: task.rolledOverFromWebChatUrl || '',
        planEntries: Array.isArray(task.planEntries) ? task.planEntries : [],
        pendingApproval: task.pendingApproval || null,
        steerQueueCount: Array.isArray(task.steerQueue) ? task.steerQueue.length : 0,
        error: task.error,
        browserOnline: isBrowserOnline(),
        webModelState,
      });
    }

    // 6.1 网页端用量（本机记账 + 限额提示）
    if (req.method === 'GET' && pathname === '/web-brain/usage') {
      return sendJson(res, 200, { ok: true, ...summarizeWebUsage() });
    }

    // 6.2 请浏览器重新读取 gemini.google.com/usage（最少间隔 60s，避免频繁开页）
    if (req.method === 'POST' && pathname === '/web-brain/usage/refresh') {
      const now = Date.now();
      const queued = isBrowserOnline() && now - lastUsageRefreshAt >= 60000;
      if (queued) {
        lastUsageRefreshAt = now;
        pendingBrowserCommandQueue.push({ action: 'refresh_usage' });
        log('[WebBrain] 请求浏览器刷新网页用量页');
      }
      return sendJson(res, 200, { ok: true, queued, browserOnline: isBrowserOnline() });
    }

    // 7. 取消 WebBrain 任务 (/web-brain/cancel) —— 严格按 requestId / sessionId 精确取消（并级联取消其子代理），绝不连带取消其它正在运行的网页会话
    if (req.method === 'POST' && pathname === '/web-brain/cancel') {
      const body = await readJsonBody(req).catch(() => ({}));
      let cancelledCount = 0;

      if (body.requestId && webTasks.has(body.requestId)) {
        cancelledCount += cancelWebTaskTree(webTasks.get(body.requestId));
      } else if (body.sessionId) {
        const sid = String(body.sessionId);
        for (const t of webTasks.values()) {
          if (t.sessionId === sid) cancelledCount += cancelWebTaskTree(t);
        }
      } else if (body.all === true) {
        for (const t of webTasks.values()) {
          cancelledCount += cancelWebTaskTree(t);
        }
      }
      log(
        `[WebBrain] 取消任务: requestId=${body.requestId || '-'} session=${body.sessionId || '-'} cancelled=${cancelledCount}`
      );
      return sendJson(res, 200, { ok: true, cancelledCount });
    }

    // 7.0a 运行中插话纠偏 (/web-brain/steer)
    if (req.method === 'POST' && pathname === '/web-brain/steer') {
      const body = await readJsonBody(req).catch(() => ({}));
      const message = String(body.message || body.prompt || '').trim();
      if (!message) return sendJson(res, 400, { ok: false, error: 'steer message 不能为空' });
      let targetTask = body.requestId ? webTasks.get(String(body.requestId)) : null;
      if (!targetTask && body.sessionId) {
        const sid = String(body.sessionId);
        for (const t of webTasks.values()) {
          if (!t.isSubagent && t.sessionId === sid && (t.status === 'queued' || t.status === 'dispatched' || t.status === 'streaming')) {
            targetTask = t;
          }
        }
      }
      if (!targetTask || (targetTask.status !== 'queued' && targetTask.status !== 'dispatched' && targetTask.status !== 'streaming')) {
        return sendJson(res, 404, { ok: false, error: '当前没有可插话的运行中 Web 任务' });
      }
      const entry = enqueueSteer(targetTask, message);
      appendSessionEvent(targetTask.sessionId, 'steer_enqueued', {
        requestId: targetTask.requestId,
        steerId: entry?.id,
        preview: message.slice(0, 120),
      });
      log(`[WebBrain Harness] 收到运行中 Steer requestId=${targetTask.requestId} queued=${targetTask.steerQueue.length}`);
      return sendJson(res, 200, {
        ok: true,
        requestId: targetTask.requestId,
        steerId: entry?.id || '',
        queuedCount: targetTask.steerQueue.length,
      });
    }

    // 7.0b Ask 模式写操作审批决议 (/web-brain/approve)
    if (req.method === 'POST' && pathname === '/web-brain/approve') {
      const body = await readJsonBody(req).catch(() => ({}));
      const approvalId = String(body.approvalId || '').trim();
      const resolver = approvalId ? pendingApprovalResolvers.get(approvalId) : null;
      if (!resolver) {
        return sendJson(res, 404, { ok: false, error: '审批请求不存在或已过期' });
      }
      const decision = String(body.decision || 'deny').trim().toLowerCase();
      const enableAutoMode = Boolean(body.enableAutoMode);
      if (enableAutoMode && resolver.task) {
        resolver.task.uiMode = 'auto';
        resolver.task.readOnly = false;
        sessionLastUiMode.set(resolver.task.sessionId, 'auto');
      }
      appendSessionEvent(resolver.task?.sessionId, 'approval_resolved', {
        requestId: resolver.task?.requestId,
        approvalId,
        decision,
        enableAutoMode,
      });
      resolver.finish({ decision: decision === 'allow' || enableAutoMode ? 'allow' : 'deny' });
      log(`[WebBrain Harness] 审批决议 approvalId=${approvalId} decision=${decision} auto=${enableAutoMode}`);
      return sendJson(res, 200, { ok: true, approvalId, decision });
    }

    // 7.1 读取 Gemini 网页端侧边栏最近历史对话列表 (/web-brain/conversations)
    if (req.method === 'GET' && pathname === '/web-brain/conversations') {
      if (!isBrowserOnline()) {
        return sendJson(res, 200, {
          ok: false,
          error: '未检测到在线的 Chrome 扩展（请确认 Chrome 已打开并已启用 Gemini Web Bridge 扩展）',
          conversations: [],
        });
      }
      const rep = await enqueueBrowserOp({ action: 'list_conversations' }, 22000);
      const list = Array.isArray(rep?.webConversationsList) ? rep.webConversationsList : [];
      log(`[WebBrain] 读取网页历史会话列表成功: count=${list.length}`);
      return sendJson(res, 200, { ok: true, conversations: list });
    }

    // 7.2 拉取指定 Gemini 网页历史对话完整轮次并可选自动关闭页签 (/web-brain/fetch-conversation)
    if (req.method === 'POST' && pathname === '/web-brain/fetch-conversation') {
      if (!isBrowserOnline()) {
        return sendJson(res, 400, {
          ok: false,
          error: '未检测到在线的 Chrome 扩展（请确认 Chrome 已打开并已启用 Gemini Web Bridge 扩展）',
        });
      }
      const body = await readJsonBody(req);
      const rawInput = String(body.webChatUrl || body.chatId || '').trim();
      const cidMatch = rawInput.match(/\/app\/([a-zA-Z0-9_-]{8,})/) || rawInput.match(/^([a-zA-Z0-9_-]{10,32})$/);
      if (!cidMatch) {
        return sendJson(res, 400, {
          ok: false,
          error: '请提供有效的 Gemini 网页对话链接（如 https://gemini.google.com/app/<id>）',
        });
      }
      const targetUrl = `https://gemini.google.com/app/${cidMatch[1]}`;
      const closeAfter = body.closeAfter !== false;
      log(`[WebBrain] 请求拉取网页对话记录: url=${targetUrl} closeAfter=${closeAfter}`);
      const rep = await enqueueBrowserOp(
        { action: 'fetch_conversation', webChatUrl: targetUrl, closeAfter },
        38000
      );
      if (!rep?.fetchedConversation) {
        return sendJson(res, 500, { ok: false, error: rep?.error || '未能从网页提取到对话内容' });
      }
      const normalized = normalizePulledWebConversation(rep.fetchedConversation);
      log(
        `[WebBrain] 网页对话拉取完成: chatId=${normalized.chatId} title="${normalized.title}" turns=${normalized.turns.length}`
      );
      return sendJson(res, 200, { ok: true, conversation: normalized });
    }

    // 7.3 关闭指定会话绑定的浏览器 Gemini 窗口 (/web-brain/close-tab)
    if (req.method === 'POST' && pathname === '/web-brain/close-tab') {
      const body = await readJsonBody(req).catch(() => ({}));
      if (isBrowserOnline() && (body.sessionId || body.webChatUrl || body.all)) {
        pendingBrowserCommandQueue.push({
          action: 'close_tab',
          sessionId: String(body.sessionId || ''),
          webChatUrl: String(body.webChatUrl || ''),
          all: Boolean(body.all),
        });
        log(`[WebBrain] 请求自动关闭网页标签页: session=${body.sessionId || '-'} url=${body.webChatUrl || '-'}`);
      }
      return sendJson(res, 200, { ok: true });
    }

    // 8. 网页端正向直接调用本地执行 (/ask)：默认走 0 额度 LocalToolExecutor，可选走 agy
    if (req.method === 'POST' && pathname === '/ask') {
      const body = await readJsonBody(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return sendJson(res, 400, { ok: false, error: 'prompt 不能为空' });

      const engine = body.engine || state.backend || 'local-tool';
      const targetCwd = body.cwd || state.cwd || DEFAULT_CWD;

      // 优先检查是否是 JSON 工具调用
      const parsedCall = parseToolCallsFromMarkdown('```json:local-tool\n' + prompt + '\n```');
      if (parsedCall && parsedCall.kind === 'json-tools') {
        const executedTools = [];
        const reply = await LocalToolExecutor.executeBatch(parsedCall.specs, targetCwd, (tp) => {
          if (tp.status !== 'in_progress') executedTools.push(tp);
        });
        return sendJson(res, 200, {
          ok: true,
          engine: 'local-tool',
          reply,
          tools: executedTools,
        });
      }

      if (engine === 'local-tool') {
        // 如果用户在网页里用自然语言写了 # @local-agent 但选的是 0 额度模式，尝试判断是否可直接当命令或提示用 json:local-tool
        return sendJson(res, 200, {
          ok: true,
          engine: 'local-tool',
          reply:
            '当前处于「⚡0额度纯工具模式」，请输出如下 JSON 数组调用本地工具（不消耗任何 CLI 额度）：\n' +
            '```json:local-tool\n[{"tool": "search_code", "args": {"pattern": "关键词"}}]\n```\n' +
            '（支持 read_file, search_code, list_dir, edit_file, write_file, run_command；若需调用本地大模型请在右下角切换为「🤖本地AGY」）',
          tools: [],
        });
      }

      const result = await acpBridge.ask(prompt, {
        cwd: targetCwd,
        newSession: body.newSession,
      });
      return sendJson(res, 200, { ok: true, engine: 'agy', ...result });
    }

    if (req.method === 'POST' && pathname === '/new') {
      const body = await readJsonBody(req);
      const sid = await acpBridge.ensureSession(body.cwd || state.cwd, true);
      return sendJson(res, 200, { ok: true, sessionId: sid, cwd: state.cwd });
    }

    if (req.method === 'POST' && pathname === '/cancel') {
      acpBridge.cancelCurrent();
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    log(`请求异常 [${req.method} ${pathname}]: ${err.message}`);
    sendJson(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  if (PORT === 18765) {
    try {
      fs.writeFileSync(path.join(DIR, 'bridge.pid'), String(process.pid), 'ascii');
    } catch {}
  }
  log(`Gemini Web 双向桥接与零 Token ReAct 服务已启动: http://127.0.0.1:${PORT} (PID=${process.pid}, 工作区: ${state.cwd})`);
});
