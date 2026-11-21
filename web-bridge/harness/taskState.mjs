// Chatbot-Harness Local Task State Machine & Proactive Rollover Budget
// 仅在本地 ~/.gemini/web-bridge/sessions/ 维护会话任务进度与上下文预算，零文件上传。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), '.gemini', 'web-bridge', 'sessions');

export const PROACTIVE_ROLLOVER_STEPS = Math.max(
  3,
  Number(process.env.WEB_PROACTIVE_ROLLOVER_STEPS || 8)
);
export const PROACTIVE_ROLLOVER_CHARS = Math.max(
  12000,
  Number(process.env.WEB_PROACTIVE_ROLLOVER_CHARS || 60000)
);

function getSessionsDir() {
  return process.env.WEB_BRIDGE_SESSIONS_DIR || DEFAULT_SESSIONS_DIR;
}

export function sanitizeSessionKey(sessionId) {
  const raw = String(sessionId || 'default').trim();
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return safe || 'default';
}

export function getTaskStateFilePath(sessionId) {
  return path.join(getSessionsDir(), `${sanitizeSessionKey(sessionId)}.state.json`);
}

function normalizeStepStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete' || s === 'finished') return 'completed';
  if (s === 'in_progress' || s === 'in-progress' || s === 'doing' || s === 'running' || s === 'active') {
    return 'in_progress';
  }
  return 'pending';
}

function createEmptyState(sessionId, mode = 'accept-edits') {
  return {
    sessionId: String(sessionId || ''),
    mode: String(mode || 'accept-edits'),
    goal: '',
    plan: [],
    touchedFiles: [],
    keyFindings: [],
    contextBudget: {
      turnCount: 0,
      stepCount: 0,
      approxChars: 0,
      rolloverCount: 0,
    },
    updatedAt: Date.now(),
  };
}

export function loadTaskState(sessionId, fallbackMode = 'accept-edits') {
  const file = getTaskStateFilePath(sessionId);
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        const base = createEmptyState(sessionId, fallbackMode);
        return {
          ...base,
          ...parsed,
          plan: Array.isArray(parsed.plan) ? parsed.plan : [],
          touchedFiles: Array.isArray(parsed.touchedFiles) ? parsed.touchedFiles : [],
          keyFindings: Array.isArray(parsed.keyFindings) ? parsed.keyFindings : [],
          contextBudget: {
            ...base.contextBudget,
            ...(parsed.contextBudget && typeof parsed.contextBudget === 'object' ? parsed.contextBudget : {}),
          },
        };
      }
    }
  } catch {}
  return createEmptyState(sessionId, fallbackMode);
}

export function saveTaskState(sessionId, stateObj) {
  if (!sessionId || !stateObj) return stateObj;
  const dir = getSessionsDir();
  const file = getTaskStateFilePath(sessionId);
  stateObj.updatedAt = Date.now();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stateObj, null, 2), 'utf8');
  } catch {}
  return stateObj;
}

export function resetTaskStateForNewChat(sessionId, mode = 'accept-edits') {
  const fresh = createEmptyState(sessionId, mode);
  return saveTaskState(sessionId, fresh);
}

/**
 * 若当前会话尚未记录任务目标，自动从首轮用户提问回填一条精炼目标，
 * 避免模型未显式调用 update_plan 时换窗交接丢失核心任务。
 */
export function ensureTaskGoal(sessionId, rawGoal, mode = 'accept-edits') {
  if (!sessionId) return null;
  const cleaned = String(rawGoal || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return loadTaskState(sessionId, mode);
  const st = loadTaskState(sessionId, mode);
  if (mode) st.mode = mode;
  if (!st.goal) {
    st.goal = cleaned.slice(0, 240);
    saveTaskState(sessionId, st);
  }
  return st;
}

/**
 * 处理本地工具 update_plan 的入参，落盘并返回最新状态与人类可读反馈。
 */
export function applyUpdatePlan(sessionId, args = {}, mode = 'accept-edits') {
  const st = loadTaskState(sessionId, mode);
  if (mode) st.mode = mode;

  if (typeof args.goal === 'string' && args.goal.trim()) {
    st.goal = args.goal.trim().slice(0, 300);
  }

  if (Array.isArray(args.plan)) {
    const nextPlan = [];
    for (let i = 0; i < args.plan.length && i < 20; i++) {
      const item = args.plan[i];
      if (!item) continue;
      if (typeof item === 'string') {
        const title = item.trim();
        if (title) nextPlan.push({ id: `p${i + 1}`, title: title.slice(0, 160), status: 'pending', evidence: '' });
        continue;
      }
      const title = String(item.title || item.content || item.step || '').trim();
      if (!title) continue;
      nextPlan.push({
        id: String(item.id || `p${i + 1}`).trim().slice(0, 32),
        title: title.slice(0, 160),
        status: normalizeStepStatus(item.status),
        evidence: String(item.evidence || '').trim().slice(0, 160),
      });
    }
    st.plan = nextPlan;
  } else if (args.stepId || args.id) {
    const targetId = String(args.stepId || args.id).trim();
    const hit = st.plan.find((p) => p.id === targetId);
    if (hit) {
      if (args.status) hit.status = normalizeStepStatus(args.status);
      if (typeof args.title === 'string' && args.title.trim()) hit.title = args.title.trim().slice(0, 160);
      if (typeof args.evidence === 'string') hit.evidence = args.evidence.trim().slice(0, 160);
    }
  }

  const findingsToAdd = [];
  if (typeof args.addFinding === 'string' && args.addFinding.trim()) { findingsToAdd.push(args.addFinding.trim()); }
  if (typeof args.finding === 'string' && args.finding.trim()) { findingsToAdd.push(args.finding.trim()); }
  if (Array.isArray(args.findings)) {
    for (const f of args.findings) {
      if (typeof f === 'string' && f.trim()) findingsToAdd.push(f.trim());
    }
  }
  for (const f of findingsToAdd) {
    const clipped = f.slice(0, 240);
    if (!st.keyFindings.includes(clipped)) {
      st.keyFindings.push(clipped);
    }
  }
  if (st.keyFindings.length > 20) {
    st.keyFindings = st.keyFindings.slice(-20);
  }

  saveTaskState(sessionId, st);
  return st;
}

export function recordTouchedFile(sessionId, displayPath, mode = 'accept-edits') {
  if (!sessionId || !displayPath) return null;
  const st = loadTaskState(sessionId, mode);
  const normalized = String(displayPath).replace(/\\/g, '/').trim();
  if (normalized && !st.touchedFiles.includes(normalized)) {
    st.touchedFiles.push(normalized);
    if (st.touchedFiles.length > 40) st.touchedFiles = st.touchedFiles.slice(-40);
    saveTaskState(sessionId, st);
  }
  return st;
}

export function bumpContextBudget(
  sessionId,
  { turnDelta = 0, stepDelta = 0, charsDelta = 0, resetTabBudget = false, countRollover = true, mode } = {}
) {
  const st = loadTaskState(sessionId, mode);
  if (mode) st.mode = mode;
  if (resetTabBudget) {
    st.contextBudget.turnCount = 0;
    st.contextBudget.stepCount = 0;
    st.contextBudget.approxChars = 0;
    if (countRollover !== false) {
      st.contextBudget.rolloverCount = (st.contextBudget.rolloverCount || 0) + 1;
    }
  } else {
    st.contextBudget.turnCount = (st.contextBudget.turnCount || 0) + Math.max(0, Number(turnDelta || 0));
    st.contextBudget.stepCount = (st.contextBudget.stepCount || 0) + Math.max(0, Number(stepDelta || 0));
    st.contextBudget.approxChars = (st.contextBudget.approxChars || 0) + Math.max(0, Number(charsDelta || 0));
  }
  return saveTaskState(sessionId, st);
}

export function getContextBudgetSnapshot(stateObj, opts = {}) {
  const budget = stateObj?.contextBudget || {};
  const stepThreshold = Math.max(3, Number(opts.stepThreshold || PROACTIVE_ROLLOVER_STEPS));
  const charThreshold = Math.max(12000, Number(opts.charThreshold || PROACTIVE_ROLLOVER_CHARS));
  const turnCount = Math.max(0, Number(budget.turnCount || 0));
  const stepCount = Math.max(0, Number(budget.stepCount || 0));
  const approxChars = Math.max(0, Number(budget.approxChars || 0));
  const rolloverCount = Math.max(0, Number(budget.rolloverCount || 0));
  const stepRatio = stepThreshold > 0 ? stepCount / stepThreshold : 0;
  const charRatio = charThreshold > 0 ? approxChars / charThreshold : 0;
  const pct = Math.min(100, Math.round(Math.max(stepRatio, charRatio) * 100));
  return {
    turnCount,
    stepCount,
    approxChars,
    rolloverCount,
    stepThreshold,
    charThreshold,
    pct,
  };
}

export function shouldProactiveRollover(stateObj, opts = {}) {
  if (!stateObj || !stateObj.contextBudget) return { needed: false, reason: '' };
  const stepThreshold = Number(opts.stepThreshold || PROACTIVE_ROLLOVER_STEPS);
  const charThreshold = Number(opts.charThreshold || PROACTIVE_ROLLOVER_CHARS);
  const steps = Number(stateObj.contextBudget.stepCount || 0);
  const chars = Number(stateObj.contextBudget.approxChars || 0);
  if (steps >= stepThreshold) {
    return { needed: true, reason: `stepCount=${steps} >= ${stepThreshold}` };
  }
  if (chars >= charThreshold) {
    return { needed: true, reason: `approxChars=${chars} >= ${charThreshold}` };
  }
  return { needed: false, reason: '' };
}

export function formatTaskStateForHandoff(stateObj) {
  if (!stateObj) return '';
  const parts = [];
  if (stateObj.goal) { parts.push(`- **任务目标**: ${stateObj.goal}`); }
  if (Array.isArray(stateObj.plan) && stateObj.plan.length) {
    parts.push('- **当前计划进度**:');
    for (const p of stateObj.plan) {
      const mark = p.status === 'completed' ? '[x]' : p.status === 'in_progress' ? '[-]' : '[ ]';
      const ev = p.evidence ? `（${p.evidence}）` : '';
      parts.push(`  - ${mark} \`${p.id}\` ${p.title}${ev}`);
    }
  }
  if (Array.isArray(stateObj.keyFindings) && stateObj.keyFindings.length) {
    parts.push('- **关键发现**:');
    for (const f of stateObj.keyFindings.slice(-10)) {
      parts.push(`  - ${f}`);
    }
  }
  if (Array.isArray(stateObj.touchedFiles) && stateObj.touchedFiles.length) {
    parts.push(`- **已改动文件**: ${stateObj.touchedFiles.map((f) => `\`${f}\``).join(', ')}`);
  }
  return parts.join('\n');
}

export function toClientPlanEntries(stateObj) {
  if (!stateObj || !Array.isArray(stateObj.plan)) return [];
  return stateObj.plan.map((p) => ({
    id: p.id,
    content: p.evidence ? `${p.title} (${p.evidence})` : p.title,
    status: p.status,
  }));
}
