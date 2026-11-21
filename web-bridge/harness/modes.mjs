// Chatbot-Harness Mode Policy & Permission Guard
// 统一定义 Web 通道下的模式权限矩阵、只读命令判定与模式协议片段。

export const VALID_UI_MODES = ['plan', 'default', 'accept-edits', 'auto'];

export const READ_ONLY_TOOLS = new Set([
  'get_context',
  'read_file',
  'search_code',
  'find_files',
  'list_dir',
  'mcp_list',
  'web_subagent',
  'update_plan',
]);

export const WRITE_TOOLS = new Set([
  'edit_file',
  'write_file',
]);

export const MODE_POLICIES = {
  plan: {
    id: 'plan',
    label: 'Plan（只读规划）',
    readOnly: true,
    allowEditTools: false,
    allowWriteCommands: false,
    protocolRule:
      '当前模式：**Plan（只读规划）**。禁止修改/新建文件与执行写命令；请先查证代码与规范，输出实施方案、受影响文件及风险点，待用户确认并切出 Plan 模式后再改动。',
  },
  default: {
    id: 'default',
    label: 'Ask（谨慎执行）',
    readOnly: false,
    allowEditTools: true,
    allowWriteCommands: true,
    protocolRule:
      '当前模式：**Ask**。涉及代码修改或写命令前，请先简要说明改动意图与影响面，避免未经说明的大范围改动。',
  },
  'accept-edits': {
    id: 'accept-edits',
    label: 'Accept Edits（默认开发）',
    readOnly: false,
    allowEditTools: true,
    allowWriteCommands: true,
    protocolRule:
      '当前模式：**Accept Edits**。先查后改，按最小改动面推进并做好校验。',
  },
  auto: {
    id: 'auto',
    label: 'Auto（全自动）',
    readOnly: false,
    allowEditTools: true,
    allowWriteCommands: true,
    protocolRule:
      '当前模式：**Auto**。自主完成定位、实现与验证闭环，最后汇报改动清单与校验结果。',
  },
};

export function normalizeUiMode(rawMode) {
  const s = String(rawMode || '').trim().toLowerCase();
  if (s === 'plan' || s === 'architect' || s === 'readonly' || s === 'read-only') return 'plan';
  if (s === 'default' || s === 'ask') return 'default';
  if (s === 'auto' || s === 'yolo' || s === 'full-auto') return 'auto';
  return 'accept-edits';
}

export function getModePolicy(rawMode) {
  return MODE_POLICIES[normalizeUiMode(rawMode)] || MODE_POLICIES['accept-edits'];
}

export function isReadOnlyMode(rawMode) {
  return getModePolicy(rawMode).readOnly === true;
}

// 明显破坏性命令黑名单（所有模式下均拦截）
const DESTRUCTIVE_CMD_PATTERNS = [
  /(?:^|[;&|\s])rm\s+-[a-z]*r[a-z]*f\b/i,
  /(?:^|[;&|\s])remove-item\b[^;&|]*-recurse[^;&|]*-force/i,
  /(?:^|[;&|\s])remove-item\b[^;&|]*-force[^;&|]*-recurse/i,
  /(?:^|[;&|\s])git\s+push\s+[^;&|]*(?:--force|-f)\b/i,
  /(?:^|[;&|\s])git\s+reset\s+--hard\b/i,
  /(?:^|[;&|\s])git\s+clean\s+-[a-z]*f[a-z]*d/i,
  /(?:^|[;&|\s])(?:format-volume|clear-disk|shutdown|restart-computer)\b/i,
];

// Plan/只读模式下允许的只读检查命令白名单
const READ_ONLY_CMD_HEAD_RE =
  /^(?:git\s+(?:status|diff|log|show|branch|rev-parse|ls-files|grep|blame|tag\s+-l)\b|jj\s+(?:status|st|diff|log|show|evolog)\b|p4\s+(?:status|opened|diff|describe|changes|fstat|filelog|info|client\s+-o|dirs|files|where)\b|rg\b|findstr\b|grep\b|Select-String\b|Get-Content\b|Get-ChildItem\b|Get-Item\b|Test-Path\b|Get-Location\b|dir\b|ls\b|cat\b|head\b|tail\b|pwd\b|where\b|which\b|node\s+--check\b|node\s+-v\b|python\s+--version\b|npm\s+run\s+(?:lint|check|typecheck)\b)/i;

// Plan/只读模式下管道后段允许的纯过滤/格式化命令白名单
const READ_ONLY_PIPE_STAGE_RE =
  /^(?:(?:Select-String|Select-Object|select|Where-Object|where|Sort-Object|sort|Group-Object|group|Measure-Object|measure|Format-Table|ft|Format-List|fl|Out-String|ConvertTo-Json|findstr|grep|rg|head|tail|wc|uniq|cut|more)\b|\?(?=\s|\{|$))/i;

const SHELL_WRITE_OPERATOR_RE =
  /(?:(?:^|[^-])>>?\s*[^&\s]|\|\s*(?:Set-Content|Out-File|Add-Content|tee)\b|(?:^|[;&|\s({])(?:Set-Content|Out-File|Add-Content|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Invoke-Expression|iex|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|curl|wget|Start-Process|saps|Invoke-Item|rm|del|erase|rd|rmdir|mkdir|md|mv|move|cp|copy|touch|chmod|chown|npm\s+install|git\s+(?:commit|add|push|checkout|switch|merge|rebase|reset|revert|stash|clean)|p4\s+(?:edit|add|delete|revert|submit|shelve|reconcile|sync))\b)/i;

function splitShellTopLevel(cmd, mode) {
  const out = [];
  let buf = '';
  let quote = '';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    const next = cmd[i + 1];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        buf += cmd[++i];
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (mode === 'chain') {
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        i++;
        continue;
      }
      if (ch === ';') {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
    } else if (mode === 'pipe') {
      if (ch === '|' && next !== '|') {
        if (buf.trim()) out.push(buf.trim());
        buf = '';
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function isDestructiveShellCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  return DESTRUCTIVE_CMD_PATTERNS.some((re) => re.test(cmd));
}

export function isReadOnlyShellCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;
  if (SHELL_WRITE_OPERATOR_RE.test(cmd)) return false;
  const statements = splitShellTopLevel(cmd, 'chain');
  if (!statements.length) return false;
  return statements.every((stmt) => {
    const stages = splitShellTopLevel(stmt, 'pipe');
    if (!stages.length) return false;
    if (!READ_ONLY_CMD_HEAD_RE.test(stages[0])) return false;
    return stages.slice(1).every((stage) => READ_ONLY_CMD_HEAD_RE.test(stage) || READ_ONLY_PIPE_STAGE_RE.test(stage));
  });
}

/**
 * 在 LocalToolExecutor 执行前校验工具权限。
 * @returns {{ allowed: boolean, code?: string, reason?: string }}
 */
export function evaluateToolPermission(toolName, args = {}, execContext = {}) {
  const name = String(toolName || '').trim();
  const uiMode = normalizeUiMode(execContext.uiMode || execContext.parentTask?.uiMode);
  const policy = getModePolicy(uiMode);
  const isSubagent = Boolean(execContext.isSubagent);
  const effectiveReadOnly = Boolean(execContext.readOnly || policy.readOnly);

  if (isSubagent && name === 'web_subagent') {
    return {
      allowed: false,
      code: 'SUBAGENT_NO_RECURSION',
      reason: '子代理不允许递归调用 web_subagent，请直接用本地只读工具完成调研并汇总结果。',
    };
  }

  if (WRITE_TOOLS.has(name) && effectiveReadOnly) {
    if (isSubagent) {
      return {
        allowed: false,
        code: 'SUBAGENT_READ_ONLY',
        reason: `当前只读子代理禁止调用 ${name}，请仅做只读检索分析并把修改建议返回给主对话。`,
      };
    }
    return {
      allowed: false,
      code: 'PLAN_MODE_READ_ONLY',
      reason: `当前处于 Plan（只读规划）模式，已拦截 ${name}。请先基于已查证的代码输出完整方案与改动清单，等待用户确认并切出 Plan 模式后再修改文件。`,
    };
  }

  if (name === 'run_command') {
    const command = String(args.command || args.CommandLine || '').trim();
    if (isDestructiveShellCommand(command)) {
      return {
        allowed: false,
        code: 'DESTRUCTIVE_COMMAND_BLOCKED',
        reason: `已拦截高风险破坏性命令 (${command.slice(0, 80)})。如确需执行，请由用户在终端手动操作。`,
      };
    }
    if (effectiveReadOnly && !isReadOnlyShellCommand(command)) {
      return {
        allowed: false,
        code: 'READ_ONLY_COMMAND_BLOCKED',
        reason: isSubagent
          ? `当前只读子代理仅允许只读检查命令，已拦截: ${command.slice(0, 100)}`
          : `当前处于 Plan（只读规划）模式，仅允许只读检查命令（如 git status/diff/log、rg、Get-Content），已拦截: ${command.slice(0, 100)}`,
      };
    }
  }

  return { allowed: true };
}

export function buildModeChangeNotice(prevMode, nextMode) {
  const prev = normalizeUiMode(prevMode);
  const next = normalizeUiMode(nextMode);
  if (prev === next) return '';
  const policy = getModePolicy(next);
  return `[模式已切换: ${prev} -> ${next}] ${policy.protocolRule}`;
}
