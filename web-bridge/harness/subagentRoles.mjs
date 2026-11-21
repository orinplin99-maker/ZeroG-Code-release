// Chatbot-Harness Role-based Boomerang Subagent Presets
// 为 web_subagent 提供标准认知角色（researcher / reviewer / planner），隔离上下文并结构化回传结论。

export const SUBAGENT_ROLE_PRESETS = {
  researcher: {
    id: 'researcher',
    label: 'Researcher（只读调研）',
    defaultReadOnly: true,
    defaultMaxSteps: 4,
    outputContract:
      '输出格式（控制在 600 字内）：1) 核心结论（2~4 句）；2) 关键位置与调用链（反引号 `path:line`）；3) 关键分支或边界注意点。',
    workflowRule:
      '优先用 search_code / find_files 定位落点，再按需 read_file 精准查证；不要做无关发散。',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer（只读审查）',
    defaultReadOnly: true,
    defaultMaxSteps: 3,
    outputContract:
      '输出格式（控制在 700 字内）：按严重度分组列出问题（[严重] / [中等] / [建议]），每条附 `path:line`、触发条件与修复方向；无问题则明确说明已核验的边界。',
    workflowRule:
      '重点检查逻辑漏洞、空值/竞态边界、资源清理与项目规范违背，不做主观代码风格挑刺，不修改文件。',
  },
  planner: {
    id: 'planner',
    label: 'Planner（方案拆解）',
    defaultReadOnly: true,
    defaultMaxSteps: 3,
    outputContract:
      '输出格式（控制在 700 字内）：1) 受影响文件清单（`path:line`）；2) 按先后顺序拆解的实施步骤；3) 关键风险与验证点。',
    workflowRule:
      '基于真实代码现状拆解最小可行改动方案，先核实调用点与数据结构，不修改文件。',
  },
};

export function resolveSubagentRolePreset(rawRole) {
  const text = String(rawRole || '').trim();
  const lower = text.toLowerCase();
  if (lower === 'reviewer' || lower === 'review' || /review|审查|评审|检视/.test(lower)) {
    return { preset: SUBAGENT_ROLE_PRESETS.reviewer, displayRole: text || 'reviewer' };
  }
  if (lower === 'planner' || lower === 'plan' || lower === 'architect' || /plan|规划|拆解|架构/.test(lower)) {
    return { preset: SUBAGENT_ROLE_PRESETS.planner, displayRole: text || 'planner' };
  }
  return { preset: SUBAGENT_ROLE_PRESETS.researcher, displayRole: text || 'researcher' };
}

export function buildRoleSubagentProtocol({ displayCwd, rawRole, readOnly = true, maxSteps, shellHint = 'PowerShell命令' }) {
  const { preset, displayRole } = resolveSubagentRolePreset(rawRole);
  const steps = maxSteps || preset.defaultMaxSteps;
  const lines = [
    `### 本地子任务协作说明（${displayRole} · ${preset.label}）`,
    `你是主对话派发的独立子代理（Boomerang Subagent），只需完成下方指定子任务并输出精炼结构化结论。工作区: \`${displayCwd}\`（最多 ${steps} 轮资料查询，禁止递归调用 web_subagent）。`,
    '需要查阅文件或搜索代码时，在回复末尾附精简的 `json:local-tool` 数组清单（连续只读工具会自动并行执行）：',
    '```json:local-tool',
    '[',
    '  {"tool": "search_code", "args": {"pattern": "关键词", "path": "可选目录"}},',
    '  {"tool": "read_file", "args": {"path": "路径", "startLine": 1, "endLine": 160}}',
    ']',
    '```',
    '可用工具：',
    '- `get_context`: `{"kind": "rules|memory|skills|index", "query": "可选筛选词"}`',
    '- `search_code` / `find_files` / `list_dir` / `read_file`',
    readOnly
      ? `- \`run_command\`: 仅限只读检查命令（${shellHint}）；当前为只读子代理，禁止修改文件`
      : `- \`edit_file\` / \`write_file\` / \`run_command\`（${shellHint}）`,
    `工作约束：${preset.workflowRule}`,
    preset.outputContract,
    '---',
  ];
  return {
    preset,
    displayRole,
    protocolText: lines.join('\n'),
  };
}
