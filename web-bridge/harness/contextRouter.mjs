// Chatbot-Harness Single-Layer Progressive Context Router
// 零文件上传：在本地按当前用户提问预匹配 Top 2~3 条高相关规则/记忆线索，
// 首轮仅暴露极简路径与摘要，由模型按需 read_file 读取详情。

const EN_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'your',
  'about', 'into', 'when', 'where', 'what', 'which', 'how', 'why', 'can', 'could',
  'should', 'would', 'please', 'help', 'make', 'need', 'want', 'file', 'code',
  'line', 'path', 'true', 'false', 'null', 'const', 'let', 'var', 'function',
  'return', 'async', 'await', 'import', 'export', 'args', 'tool', 'json',
]);

const ZH_STOP_WORDS = new Set([
  '一下', '一个', '一些', '什么', '怎么', '如何', '为什么', '可以', '能不能',
  '帮我', '帮忙', '看看', '查看', '现在', '目前', '这个', '那个', '我们', '你们',
  '需要', '进行', '相关', '问题', '代码', '文件', '修改', '实现', '开发', '功能',
  '逻辑', '方案', '根据', '文档', '按照', '已经', '是否', '以及', '或者', '但是',
  '然后', '如果', '因为', '所以', '通过', '使用', '方式', '地方', '内容', '当前',
]);

function addWeightedToken(map, token, weight) {
  const t = String(token || '').trim().toLowerCase();
  if (!t || t.length < 2) return;
  if (/^[a-z0-9_.-]+$/.test(t) && (t.length < 3 || EN_STOP_WORDS.has(t))) return;
  if (ZH_STOP_WORDS.has(t)) return;
  const prev = map.get(t) || 0;
  if (weight > prev) map.set(t, weight);
}

/**
 * 从用户原始提问中抽取高信号关键词（保留英文标识、路径名与中文词组）
 */
export function extractPromptKeywords(rawPrompt) {
  const text = String(rawPrompt || '').trim();
  if (!text) return [];
  const tokenWeights = new Map();

  const enMatches = text.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || [];
  for (const m of enMatches) {
    addWeightedToken(tokenWeights, m, 3);
    const parts = m
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[_./-]+/)
      .filter((p) => p.length >= 3);
    for (const p of parts) addWeightedToken(tokenWeights, p, 2);
  }

  const zhRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  for (const run of zhRuns) {
    if (run.length <= 4) {
      addWeightedToken(tokenWeights, run, 2.5);
    }
    const maxN = Math.min(4, run.length);
    for (let n = 2; n <= maxN; n++) {
      for (let i = 0; i <= run.length - n; i++) {
        const gram = run.slice(i, i + n);
        addWeightedToken(tokenWeights, gram, n >= 3 ? 2.2 : 1.5);
      }
    }
  }

  return [...tokenWeights.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, 32)
    .map(([token, weight]) => ({ token, weight }));
}

export function scoreContextEntry(entry, weightedTokens) {
  if (!entry || !weightedTokens.length) return 0;
  const pathLower = String(entry.path || '').toLowerCase();
  const titleLower = String(entry.title || '').toLowerCase();
  const descLower = String(entry.description || '').toLowerCase();
  const fileBase = pathLower.split('/').pop() || '';

  let score = 0;
  let hits = 0;
  for (const { token, weight } of weightedTokens) {
    let matched = false;
    if (fileBase.includes(token)) {
      score += weight * 3.0;
      matched = true;
    } else if (pathLower.includes(token)) {
      score += weight * 2.0;
      matched = true;
    }
    if (titleLower.includes(token)) {
      score += weight * 2.6;
      matched = true;
    }
    if (descLower.includes(token)) {
      score += weight * 1.4;
      matched = true;
    }
    if (matched) hits += 1;
  }

  if (hits === 0) return 0;
  if (entry.alwaysApply) score += 1.2;
  if (entry.isPrimary) score += 0.6;
  return score;
}

function dedupeByBasename(scoredList) {
  const out = [];
  const seenBase = new Set();
  for (const item of scoredList) {
    const base = String(item.entry.path || '').split('/').pop()?.toLowerCase() || '';
    const stem = base.replace(/\.(?:mdc|md)$/i, '');
    if (stem && seenBase.has(stem)) continue;
    if (stem) seenBase.add(stem);
    out.push(item);
  }
  return out;
}

/**
 * 根据用户首轮提问，筛选 Top 2~3 条最相关的规则/记忆线索，拼成极简提示块。
 */
export function buildContextHintsBlock({
  rawPrompt,
  rulesItems = [],
  memoryItems = [],
  maxRules = 2,
  maxMemory = 2,
  maxTotal = 3,
  minScore = 4.2,
} = {}) {
  const tokens = extractPromptKeywords(rawPrompt);
  if (!tokens.length) return '';

  const scoreAndFilter = (items, kindLabel) =>
    dedupeByBasename(
      items
        .map((entry) => ({ kindLabel, entry, score: scoreContextEntry(entry, tokens) }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score)
    );

  const topRules = scoreAndFilter(rulesItems, '规则').slice(0, maxRules);
  const topMemory = scoreAndFilter(memoryItems, '记忆').slice(0, maxMemory);

  const merged = [...topRules, ...topMemory]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTotal);

  if (!merged.length) return '';

  const lines = ['可能相关的本地文档（命中时可直接 `read_file`，不必先拉全量 `get_context`）：'];
  for (const { kindLabel, entry } of merged) {
    const summary = String(entry.description || entry.title || '').replace(/\s+/g, ' ').trim();
    const shortSummary = summary.length > 72 ? summary.slice(0, 72) + '…' : summary;
    lines.push(`- [${kindLabel}] \`${entry.path}\`${shortSummary ? ` — ${shortSummary}` : ''}`);
  }
  return lines.join('\n');
}

/**
 * 对 get_context(query=...) 的命中结果按相关性排序
 */
export function rankContextEntriesByQuery(entries, query) {
  const q = String(query || '').trim();
  if (!q || !Array.isArray(entries) || entries.length <= 1) return entries || [];
  const tokens = extractPromptKeywords(q);
  if (!tokens.length) return entries;
  return [...entries]
    .map((entry, idx) => ({ entry, idx, score: scoreContextEntry(entry, tokens) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .map((x) => x.entry);
}
