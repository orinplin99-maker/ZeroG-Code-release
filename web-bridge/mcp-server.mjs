// 标准 stdio MCP Server：将浏览器 gemini.google.com 封装为 MCP 工具
// 提供工具：
//   1. gemini_web_ask: 单轮向网页版 Gemini 提问（支持 newChat、model、effort）
//   2. gemini_web_agent: 多步零 Token ReAct Agent 模式（自动读写本地代码库并返回最终结论）

import http from 'node:http';
import { createInterface } from 'node:readline';

const BRIDGE_PORT = Number(process.env.WEB_BRIDGE_PORT || 18765);

function httpJson(method, endpoint, bodyObj, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: BRIDGE_PORT,
        path: endpoint,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': payload.length } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const data = raw ? JSON.parse(raw) : {};
            if (res.statusCode >= 200 && res.statusCode < 300 && data.ok !== false) {
              resolve(data);
            } else {
              reject(new Error(data.error || `HTTP ${res.statusCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function callWebBrain({ prompt, agentMode, cwd, newChat, maxSteps, model, effort }) {
  const sendRes = await httpJson('POST', '/web-brain/send', {
    prompt,
    agentMode,
    injectProtocol: agentMode,
    cwd,
    newChat: Boolean(newChat),
    maxSteps: maxSteps || 12,
    webModel: model || '',
    webEffort: effort || '',
  });

  const requestId = sendRes.requestId;
  const startedAt = Date.now();
  const maxWaitMs = 20 * 60 * 1000;

  while (Date.now() - startedAt < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 500));
    const poll = await httpJson(
      'GET',
      `/web-brain/poll?requestId=${encodeURIComponent(requestId)}`,
      null,
      10000
    );
    if (poll.status === 'completed') {
      const toolCount = Array.isArray(poll.tools) ? poll.tools.length : 0;
      const header = toolCount > 0 ? `[已完成 ${poll.step + 1} 轮推理，调用了 ${toolCount} 个本地工具]\n\n` : '';
      return header + (poll.text || '');
    }
    if (poll.status === 'error') {
      throw new Error(poll.error || 'Gemini Web 返回错误');
    }
    if (poll.status === 'cancelled') {
      throw new Error('任务已被取消');
    }
  }
  throw new Error('等待 Gemini Web 响应超时');
}

const TOOLS = [
  {
    name: 'gemini_web_ask',
    description:
      '向浏览器已登录的 gemini.google.com 网页发起单轮提问（零 CLI Token 消耗，适合长文分析、方案对比或使用网页联网搜索）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '发送给 Gemini 网页版的问题内容' },
        newChat: { type: 'boolean', description: '是否先在网页端点击“发起新对话”重置上下文（默认 false）' },
        model: { type: 'string', description: '可选，指定网页端模型名称（如 Argon / Pro / Flash）' },
        effort: { type: 'string', description: '可选，指定网页端思考档位（low / medium / high）' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gemini_web_agent',
    description:
      '将复杂代码查询、修改或分析任务交给浏览器 gemini.google.com 外置大脑执行（内置多步零 Token 本地工具 ReAct 循环，支持自动调用 read_file / search_code / list_dir / edit_file / write_file / run_command）。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要交给 Gemini 网页 Agent 完成的具体开发或排查任务' },
        cwd: { type: 'string', description: '可选，本地工作目录路径' },
        newChat: { type: 'boolean', description: '是否开启新网页会话（默认 false）' },
        maxSteps: { type: 'number', description: '最大自动工具调用轮数（默认 12）' },
        model: { type: 'string', description: '可选，指定网页端模型名称（如 Argon / Pro / Flash）' },
        effort: { type: 'string', description: '可选，指定网页端思考档位（low / medium / high）' },
      },
      required: ['task'],
    },
  },
];

function sendRpc(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.id === undefined) return; // notification

  try {
    if (msg.method === 'initialize') {
      return sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'gemini-web-agent', version: '2.0.0' },
        },
      });
    }

    if (msg.method === 'tools/list') {
      return sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools: TOOLS },
      });
    }

    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};

      if (name === 'gemini_web_ask') {
        const text = await callWebBrain({
          prompt: args.prompt,
          agentMode: false,
          newChat: args.newChat,
          model: args.model,
          effort: args.effort,
        });
        return sendRpc({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text }] },
        });
      }

      if (name === 'gemini_web_agent') {
        const text = await callWebBrain({
          prompt: args.task,
          agentMode: true,
          cwd: args.cwd,
          newChat: args.newChat,
          maxSteps: args.maxSteps,
          model: args.model,
          effort: args.effort,
        });
        return sendRpc({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text }] },
        });
      }

      return sendRpc({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
    }

    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {},
    });
  } catch (err) {
    sendRpc({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Error: ${err.message || String(err)}` }],
      },
    });
  }
});
