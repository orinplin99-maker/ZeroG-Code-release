// Chatbot-Harness Steer Queue, Break-Loop Circuit Breaker & Audit Log
// 1. 运行中 Steer 插话队列：不中断当前 ReAct，下一轮工具回填顶部优先注入用户纠偏指令。
// 2. Break-Loop 熔断：检测连续编辑/工具失败或无效空转检索，注入强制止损指令。
// 3. Append-Only 审计日志：记录到 ~/.gemini/web-bridge/sessions/<sessionId>.events.jsonl。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSessionKey } from './taskState.mjs';

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.gemini', 'web-bridge', 'sessions');

function getSessionsDir() {
  return process.env.WEB_BRIDGE_SESSIONS_DIR || DEFAULT_SESSIONS_DIR;
}

export function appendSessionEvent(sessionId, eventType, payload = {}) {
  if (!sessionId || !eventType) return;
  const dir = getSessionsDir();
  const file = path.join(dir, `${sanitizeSessionKey(sessionId)}.events.jsonl`);
  const record = {
    ts: new Date().toISOString(),
    type: String(eventType),
    ...payload,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
  } catch {}
}

export function createLoopGuardState() {
  return {
    failureStreaks: {},
    noNewReadStreak: 0,
    seenReadTargets: new Set(),
    triggeredCount: 0,
  };
}

export function enqueueSteer(task, rawMessage) {
  const message = String(rawMessage || '').trim();
  if (!task || !message) return null;
  if (!Array.isArray(task.steerQueue)) task.steerQueue = [];
  const entry = {
    id: `steer_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    message: message.slice(0, 2000),
    at: Date.now(),
  };
  task.steerQueue.push(entry);
  task.steerAckCount = (task.steerAckCount || 0) + 1;
  return entry;
}

export function drainSteerBlock(task) {
  if (!task || !Array.isArray(task.steerQueue) || !task.steerQueue.length) {
    return { count: 0, block: '', items: [] };
  }
  const items = task.steerQueue.splice(0, task.steerQueue.length);
  const body = items
    .map((it, idx) => (items.length > 1 ? `${idx + 1}. ${it.message}` : it.message))
    .join('\n');
  const block = [
    '### 用户中途补充指令（优先响应）',
    body,
    '请优先按上述补充指令调整接下来的排查或修改方向。',
  ].join('\n');
  return { count: items.length, block, items };
}

function makeFailureFingerprint(result) {
  const tool = String(result?.tool || 'unknown').trim();
  const target = String(
    result?.args?.Path || result?.args?.path || result?.args?.CommandLine || result?.title || ''
  )
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return `${tool}:${target || 'generic'}`;
}

function isEffectiveFailure(result) {
  if (!result) return false;
  if (result.ok === false) return true;
  if (result.tool === 'run_command' && /^命令执行结果.*\n\[Exit Code (?!0\b)/m.test(String(result.output || ''))) {
    return true;
  }
  return false;
}

/**
 * 评估本批工具结果是否触发 Break-Loop 熔断。
 * @returns {{ triggered: boolean, code: string, reason: string, directive: string }}
 */
export function evaluateBatchLoopGuard(task, batchResults = []) {
  if (!task) return { triggered: false, code: '', reason: '', directive: '' };
  if (!task.loopGuard) task.loopGuard = createLoopGuardState();
  const lg = task.loopGuard;
  const results = Array.isArray(batchResults) ? batchResults : [];
  if (!results.length) return { triggered: false, code: '', reason: '', directive: '' };

  let editFailHit = null;
  let genericFailHit = null;

  for (const r of results) {
    if (!r || r.cancelled) continue;
    const fp = makeFailureFingerprint(r);
    if (isEffectiveFailure(r)) {
      const next = (lg.failureStreaks[fp] || 0) + 1;
      lg.failureStreaks[fp] = next;
      if (r.tool === 'edit_file' && next >= 2) {
        editFailHit = { fp, count: next, title: r.title || fp };
      } else if (next >= 2) {
        genericFailHit = { fp, count: next, tool: r.tool, title: r.title || fp };
      }
    } else {
      lg.failureStreaks[fp] = 0;
    }
  }

  const READ_TOOLS = new Set(['read_file', 'search_code', 'find_files', 'list_dir']);
  const isPureRead = results.every((r) => READ_TOOLS.has(r?.tool));
  if (isPureRead) {
    let foundNewTarget = false;
    for (const r of results) {
      if (isEffectiveFailure(r)) continue;
      const out = String(r.output || '');
      if (/未找到匹配|无匹配文件|目录不存在/.test(out)) continue;
      const key = `${r.tool}:${String(r.args?.Path || r.args?.path || r.args?.Pattern || r.title || '').toLowerCase()}:${r.args?.StartLine || ''}-${r.args?.EndLine || ''}`;
      if (!lg.seenReadTargets.has(key)) {
        lg.seenReadTargets.add(key);
        foundNewTarget = true;
      }
    }
    if (foundNewTarget) lg.noNewReadStreak = 0;
    else lg.noNewReadStreak += 1;
  } else {
    lg.noNewReadStreak = 0;
  }

  if (editFailHit) {
    lg.triggeredCount += 1;
    return {
      triggered: true,
      code: 'REPEAT_EDIT_FAILURE',
      reason: `edit_file(${editFailHit.title}) 连续失败 ${editFailHit.count} 次`,
      directive: `⚠️ 熔断提示：对 \`${editFailHit.title}\` 的 \`edit_file\` 已连续失败 ${editFailHit.count} 次。禁止继续重复相同替换，必须先用 \`read_file\` 重新确认目标行段原文，或直接向用户汇报卡点。`,
    };
  }

  if (genericFailHit) {
    lg.triggeredCount += 1;
    return {
      triggered: true,
      code: 'REPEAT_TOOL_FAILURE',
      reason: `${genericFailHit.tool}(${genericFailHit.title}) 连续失败 ${genericFailHit.count} 次`,
      directive: `⚠️ 熔断提示：工具 \`${genericFailHit.tool}\` (${genericFailHit.title}) 已连续失败 ${genericFailHit.count} 次。禁止盲目重复原调用，请切换参数/定位路径，或直接向用户说明阻塞原因。`,
    };
  }

  if (lg.noNewReadStreak >= 3) {
    lg.triggeredCount += 1;
    lg.noNewReadStreak = 0;
    return {
      triggered: true,
      code: 'STALLED_READ_LOOP',
      reason: '连续 3 批只读检索未产生新线索',
      directive: '⚠️ 熔断提示：已连续 3 批只读检索未命中新文件或新行段。请停止重复同类查询，改为换用更宽泛的关键词/`find_files`，或基于已有证据直接向用户总结并确认方向。',
    };
  }

  return { triggered: false, code: '', reason: '', directive: '' };
}
