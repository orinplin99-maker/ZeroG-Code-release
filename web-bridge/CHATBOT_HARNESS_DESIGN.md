# ZeroG Code Chatbot-Harness 架构设计与演进规划

> 状态：规划中（Draft）
> 适用范围：ZeroG Code（VS Code / Cursor 插件）+ `web-bridge`（本地桥接服务）+ Chrome 扩展

---

## 1. 背景与核心原则

社区对 Agent 系统的共识是 **`Agent = Model + Harness`**：模型本身只负责无状态推理，真正决定工程稳定性的是模型之外的 **Harness**（工具循环、上下文工程、权限边界、任务状态持久化与熔断纠偏）。

ZeroG Code 的 Web 通道本质上是一个 **Web-Chatbot Harness**：用浏览器中的 Gemini Web Chat 窗口充当推理算力，在本地补齐工具执行与编排能力。

### 核心设计原则

1. **算力与状态解耦**：网页标签页仅作为可随时替换的无状态推理窗口；任务进度、模式权限、上下文预算与审计日志全部收归本地 Harness 管理。
2. **按需拉取，不强制上传文件**：坚持本地按需 `read_file` / `get_context` 的拉取策略，不依赖将工作区规则、记忆或源码上传到云端沙盒，满足严格的数据合规要求。
3. **协议去“系统注入味”**：避免动辄数千 Token 的厚重工具说明书，保持极简、自然的人机协作约定，降低网页端误触发拒答的概率并减少 Context Rot（上下文腐化）。
4. **确定性逻辑下沉到本地 Hook**：权限拦截、路由筛选、失败熔断、审批挂起与换页压缩均由本地确定性代码兜底，只把需要推理的决策交给模型。

---

## 2. 社区开源 Harness 借鉴清单

| 参考项目 | 核心借鉴点 | 在本系统中的落地方式 |
|---|---|---|
| **Pi** | 极简基础提示词 + 渐进式披露（Progressive Disclosure）+ 运行中 Steer 插话纠偏 | 压缩首轮协作协议；规则/记忆改为单层本地预匹配按需读取；新增 `/web-brain/steer` 插话队列 |
| **OpenCode** | Plan（只读规划）与 Build（读写执行）硬隔离 + 上下文压缩 | 打通前端 `uiMode` 到 `web-bridge`，在执行器层按模式实施工具白名单与写操作门控 |
| **Roo Code** | 多角色认知分离 + Boomerang Tasks（回旋镖隔离式子任务） | 将现有 `web_subagent` 升级为角色化子任务（`researcher` / `reviewer` / `planner`），仅回传结构化结论 |
| **Codex CLI** | 按阈值触发的主动上下文压缩与线程持久化 | 基于本地任务状态文件实现 Proactive Rollover（主动换页压缩） |
| **DeepSeek Harness** | 核心循环模块化解耦 + Append-Only 会话事件日志 | 从单文件 `server.mjs` 拆出 `harness/*.mjs` 模块，并落盘 `events.jsonl` 审计轨迹 |

---

## 3. 总体架构与目录规划

现有 `web-bridge/server.mjs` 已接近 4000 行，新能力不再继续堆叠在单文件内，而是在 `web-bridge/harness/` 下拆分为 5 个高内聚模块，由 `server.mjs` 在请求入口（`/web-brain/send`）、工具执行器（`LocalToolExecutor`）与 ReAct 步进循环（`runReActToolStep`）三个挂载点接入：

```text
ZeroG Code 插件 (media/chat.js -> src/chatPanel.js -> src/webBrainClient.js)
   │  透传 uiMode / Steer 插话 / 写操作审批响应 / 任务进度渲染
   ▼
本地 Harness 编排层 (web-bridge/server.mjs + web-bridge/harness/*.mjs)
   ├── harness/modes.mjs           # 模式注册表：角色协议 + 工具白名单 + 写操作审批门控
   ├── harness/contextRouter.mjs   # 单层渐进式路由：按提问命中 Top 2~3 规则/记忆线索
   ├── harness/taskState.mjs       # 本地任务状态机（plan/findings）+ 主动换页压缩阈值
   ├── harness/loopGuard.mjs       # Break-Loop 熔断 + 运行中 Steer 插话队列
   └── harness/subagentRoles.mjs   # 角色化 Boomerang 子任务模板 (researcher/reviewer/planner)
   │  极简纯文本协议 + 工具结果回填
   ▼
Chrome 扩展 (content.js) <-> Gemini Web Chat 窗口（无状态推理算力）
```

本地运行时状态目录（仅存本地，不提交到仓库）：

```text
~/.gemini/web-bridge/sessions/
  ├── <sessionId>.state.json       # 当前会话任务状态、计划步骤、已改文件、上下文预算
  └── <sessionId>.events.jsonl     # Append-only 审计与调优事件日志
```

---

## 4. 五大核心模块详细设计

### 4.1 模块 1：Mode 权限与协议硬隔离（`harness/modes.mjs`）

**现状问题**：前端 `media/chat.js` 已定义 `default` / `accept-edits` / `plan` / `auto` 四种 `MODE_DEFS`，但 Web 通道在 `src/chatPanel.js` 调用 `runWebBrainTurn` 时未透传 `uiMode`，`src/webBrainClient.js` 固定发送 `agentMode: true`，导致所有模式在 Web 通道下行为完全一致。

**设计方案**：

- 全链路透传 `uiMode`：`media/chat.js` -> `src/chatPanel.js` -> `src/webBrainClient.js` -> `POST /web-brain/send` -> `task.uiMode`。
- 按模式同时控制 **首轮协议中暴露的工具清单** 与 **`LocalToolExecutor` 运行时权限拦截**：

| `uiMode` | 允许工具集 | 写操作策略（`edit_file` / `write_file` / `run_command`） | 协议行为侧重 |
|---|---|---|---|
| `plan` | 仅只读工具（`get_context`, `read_file`, `search_code`, `find_files`, `list_dir`, `mcp_list`, `update_plan`, 只读 `web_subagent`） | **硬拒绝**：执行器直接拦截并反馈“当前处于 Plan 模式，请输出方案等待用户确认，不要修改文件” | 先查证代码、列出受影响文件与风险，输出可执行方案 |
| `default` (Ask) | 全量工具 | **挂起审批**：写入文件或执行写命令前暂停 ReAct，通知插件弹出确认卡片，用户批准后再执行 | 修改前简述改动目的与影响范围 |
| `accept-edits` | 全量工具 | 工作区内 `edit_file` / `write_file` 自动放行；非只读或高风险 `run_command` 走审批 | 默认主力开发模式，兼顾效率与安全 |
| `auto` | 全量工具 | 本会话读写与常规验证命令自动放行（仍保留破坏性命令黑名单，如强制推送、危险删除等） | 全自动实现与自测闭环 |

---

### 4.2 模块 2：单层渐进式上下文路由（`harness/contextRouter.mjs`）

**现状问题**：当前首轮协议（`buildSystemToolProtocol`）偏向让模型先发一轮 `get_context(rules)` + `get_context(memory)`，固定多消耗 1 轮往返；且全量返回记忆索引容易超长截断。

**设计方案**：

- **零上传本地预匹配**：`/web-brain/send` 收到首轮 `rawPrompt` 后，在本地复用 `collectRulesSummary` / `collectMemorySummary` 的元数据，结合提问关键词、路径片段与规则描述进行轻量打分，仅筛选 **Top 2~3 条高相关线索**。
- **极简线索提示**：不内联全文，仅在首轮协议末尾附加 2~3 行路径线索，提示模型按需直接 `read_file`，省掉无意义的盲查轮次。
- **优化 `get_context` 返回**：无 `query` 时返回精简目录索引；带 `query` 时按相关性排序截断。
- **首轮协议瘦身**：将 `buildSystemToolProtocol` 精简至约 300~500 字，并按当前 `uiMode` 动态裁剪工具说明。

---

### 4.3 模块 3：本地任务状态机与主动换页压缩（`harness/taskState.mjs`）

**现状问题**：当前 `buildRolloverHandoffPrompt` 仅在网页报错或拒答时被动换页；长任务推进 8~10 轮后网页上下文容易膨胀退化，且缺少结构化进度追踪。

**设计方案**：

1. **本地状态文件 Schema（`<sessionId>.state.json`）**：

```json
{
  "sessionId": "sess_xxx",
  "mode": "accept-edits",
  "goal": "实现模式硬隔离与上下文路由",
  "plan": [
    { "id": "p1", "title": "打通 uiMode 透传", "status": "done", "evidence": "src/webBrainClient.js" },
    { "id": "p2", "title": "实现 modes.mjs 工具门控", "status": "in_progress", "evidence": "" }
  ],
  "touchedFiles": ["src/chatPanel.js", "src/webBrainClient.js"],
  "keyFindings": ["Web 分支原未透传 uiMode"],
  "contextBudget": {
    "turnCount": 6,
    "stepCount": 7,
    "approxChars": 52000
  },
  "updatedAt": 1794972550958
}
```

2. **新增本地工具 `update_plan`**：
   - 入参：`{ goal?, plan?: [{ id, title, status, evidence? }], addFinding?: string }`。
   - 执行器落盘更新 `state.json`，并通过 `/web-brain/poll` 将最新 `taskState` 同步给插件前端渲染进度条。
3. **主动换页压缩（Proactive Rollover）**：
   - 在 `runReActToolStep` 的工具步边界检查上下文预算（默认阈值：`step >= 8` 或 `approxChars >= 60000`，可配置）。
   - 到达阈值且当前不处于收尾步时，Harness 主动设置 `forceNewChatNextDispatch = true`，基于 `state.json` 生成紧凑的结构化 Handoff 简报（目标 + 计划进度 + 关键发现 + 已改文件 + 本批最新工具输出），在新干净页签无缝续跑。

---

### 4.4 模块 4：运行中 Steer 插话与 Break-Loop 熔断（`harness/loopGuard.mjs`）

**现状问题**：ReAct 连续跑多批工具时，用户发现方向偏差只能中断重来；工具连续失败时缺少强约束止损机制。

**设计方案**：

1. **Steer 插话纠偏**：
   - `server.mjs` 新增端点 `POST /web-brain/steer`，接收 `{ requestId, sessionId, message }`，将指令推入 `task.steerQueue`。
   - 插件前端在 `isStreaming === true` 时支持提交“纠偏插话”（不取消当前任务），在 UI 上展示待注入状态。
   - `runReActToolStep` 组装下一轮 `task.currentStepPrompt` 时，若 `steerQueue` 非空，自动在工具输出顶部注入 `### 用户中途补充指令（优先响应）` 段落并清空队列。
2. **Break-Loop 熔断**：
   - 追踪每步失败指纹：同一目标文件 `edit_file` 连续失败 >= 2 次、同一工具调用连续报错 >= 2 次、或连续 3 批只读检索未产生新线索。
   - 触发熔断时，Harness 在下一轮回填顶部注入强制纠偏提示：禁止重复相同操作，必须重新读取上下文/切换定位路径，或直接向用户汇报阻塞点。

---

### 4.5 模块 5：角色化 Boomerang 子任务与审计日志（`harness/subagentRoles.mjs`）

**现状问题**：现有 `web_subagent` 使用单一通用协议；缺少便于排查长链路耗时与失败原因的结构化轨迹。

**设计方案**：

1. **内置 3 类标准子任务角色**（兼容现有自由 `role` 文本）：
   - `researcher`（默认，只读，限 4 步）：跨模块定位与调用链排查，强制输出“结论 + `path:line` + 关键分支”。
   - `reviewer`（只读，限 3 步）：基于 diff 或指定文件做缺陷、边界条件与规范审查，输出按严重度分级的问题清单。
   - `planner`（只读，限 3 步）：基于代码现状拆解实施步骤、改动文件列表与验证点。
2. **Append-Only 审计日志（`<sessionId>.events.jsonl`）**：
   - 每行记录一个 JSON 事件：`turn_start`、`mode_change`、`tool_exec`（含耗时与成功状态）、`approval_wait`、`steer_injected`、`loop_guard_triggered`、`proactive_rollover`、`subagent_done`、`turn_end`。
   - 用于事后复盘协议命中率、轮次耗时和换页效果，且严格留在本地运行目录。

---

## 5. 接口与协议增量清单

| 端点 / 字段 | 方向 | 说明 |
|---|---|---|
| `POST /web-brain/send` 新增 `uiMode` | 插件 -> Bridge | 取值 `plan` / `default` / `accept-edits` / `auto` |
| `POST /web-brain/steer` | 插件 -> Bridge | `{ requestId, sessionId, message }`，向运行中任务追加插话指令 |
| `POST /web-brain/approve` | 插件 -> Bridge | `{ requestId, approvalId, approved, reason? }`，响应 `default` 模式的写操作审批 |
| `GET /web-brain/poll` 扩展返回 | Bridge -> 插件 | 新增 `taskState`（计划进度）、`pendingApproval`（待确认写操作）、`steerAck` |
| 本地工具 `update_plan` | 模型 -> Bridge | 读写 `<sessionId>.state.json`，零 Token 更新结构化任务进度 |

---

## 6. 分阶段实施路线图

每阶段独立可测，优先落地收益最高、改动面最可控的能力。

### Phase 1：Mode 硬隔离 + 极简上下文路由（优先落地）

- [x] `src/chatPanel.js`、`src/webBrainClient.js`：Web 通道透传 `uiMode` 到 `/web-brain/send`
- [x] `web-bridge/harness/modes.mjs`：定义 4 种模式的工具白名单、写操作策略与协议片段
- [x] `web-bridge/harness/contextRouter.mjs`：实现首轮规则/记忆轻量预匹配（Top 2~3 线索）与 `get_context` 排序精简
- [x] `web-bridge/server.mjs`：在 `buildSystemToolProtocol` 和 `LocalToolExecutor` 接入 `modes.mjs` 与 `contextRouter.mjs`
- **验收标准**：
  1. 切换 `plan` 模式后发起修改请求，执行器拦截 `edit_file` / `write_file` 并促使模型仅输出方案。
  2. 提问命中已有规则或记忆主题时，首轮协议直接给出精简路径线索，模型可跳过全量 `get_context` 直接 `read_file`。
  3. 保持零文件上传，现有 `accept-edits` 与 `web_subagent` 流程无回归。

### Phase 2：本地任务状态机 + 主动换页压缩

- [x] `web-bridge/harness/taskState.mjs`：实现 `sessions/<sessionId>.state.json` 读写与 Handoff 简报生成
- [x] `web-bridge/server.mjs`：注册 `update_plan` 本地工具；在 `runReActToolStep` 接入上下文预算估算与 Proactive Rollover
- [x] `src/chatPanel.js`、`media/chat.js`：消费 `/web-brain/poll` 的 `planEntries`，复用侧边栏任务进度卡片实时渲染
- **验收标准**：
  1. 多步复杂任务中模型能通过 `update_plan` 持续刷新步骤状态，前端实时可见。
  2. 达到步数/字符阈值后自动开启新网页页签续跑，不丢失目标、已完成步骤和修改记录。

### Phase 3：运行中 Steer 插话 + 写操作审批门控 + Break-Loop 熔断

- [x] `web-bridge/harness/loopGuard.mjs`：实现 `steerQueue` 注入逻辑与连续失败熔断检测
- [x] `web-bridge/server.mjs`：新增 `/web-brain/steer` 与 `/web-brain/approve` 端点；在 `default` 模式落地写前挂起审批
- [x] `src/chatPanel.js`、`media/chat.js`：流式运行期间支持排队栏一键 `⚡ Steer` 纠偏插话，并复用待审批写操作确认卡片
- **验收标准**：
  1. ReAct 运行中途发一条插话，下一轮工具回填立刻携带该指令并调整方向，无需取消重来。
  2. `default` 模式下发起 `edit_file` 时任务挂起等待点击确认；拒绝后安全回退给模型处理。
  3. 同一编辑连续失败 2 次自动触发熔断提示，不再无意义重试。

### Phase 4：角色化 Boomerang 子任务 + 审计日志 + 仓库同步校验

- [x] `web-bridge/harness/subagentRoles.mjs`：落地 `researcher` / `reviewer` / `planner` 角色模板与结构化输出约定
- [x] `web-bridge/server.mjs`：接入 `events.jsonl` Append-Only 审计日志与子代理角色分派
- [x] 同步仓库与本地运行时，执行语法、单测与脱敏门禁校验
- **验收标准**：
  1. 可按角色派发只读调研/审查/规划子代理，返回精炼结构化结论。
  2. 会话目录正常记录 `events.jsonl`，无敏感数据泄漏到仓库目录。

---

## 7. 维护与同步约束

1. **单一真源修改**：所有代码修改先落在仓库目录（`package/web-bridge/` 与 `package/src/`、`package/media/`），再同步到本机运行时目录（`~/.gemini/web-bridge/`）并重启 Bridge 验证，避免运行时与仓库产生漂移。
2. **脱敏边界**：仓库文档与代码中禁止出现具体业务项目名、内部路径、个人账号或私有规则内容；运行期产生的 `sessions/` 状态与日志留在 `~/.gemini/web-bridge/sessions/` 且不入库。
