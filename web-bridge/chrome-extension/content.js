(function () {
  'use strict';

  const EXT_RUNTIME_ID = typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : 'userscript';
  const prevInst = window.__AGWB_CONTENT_STATE__;
  if (
    prevInst?.alive &&
    prevInst.runtimeId === EXT_RUNTIME_ID &&
    typeof prevInst.isContextValid === 'function' &&
    prevInst.isContextValid() &&
    document.getElementById('agwb-root-panel')
  ) {
    // 同一扩展实例的存活脚本仍在运行（可能正在监听 activeWatchState），严禁重注入清零状态
    return;
  }

  const oldPanel = document.getElementById('agwb-root-panel');
  if (oldPanel) oldPanel.remove();

  const contentStateHandle = {
    alive: true,
    runtimeId: EXT_RUNTIME_ID,
    isContextValid: () => {
      try {
        return EXT_RUNTIME_ID === 'userscript' || Boolean(chrome?.runtime?.id);
      } catch (_) {
        return false;
      }
    },
  };
  window.__AGWB_CONTENT_STATE__ = contentStateHandle;

  let autoLoop = false; // 默认关闭页面自闭环，避免与 VS Code 服务端 ReAct 循环争抢
  let localEngine = 'local-tool';
  let isBridgeBusy = false;
  let isManagedByBridge = false; // 仅由 background 标记或收到 EXEC_WEB_COMMAND 的受管页签才会主动发现模型/上报全局状态
  let lastExecutedHash = '';
  let stableCandidateHash = '';
  let stableCandidateSince = 0;
  let activeWatchState = null;
  const completedReqIds = new Set();

  let keepalivePort = null;
  function ensureKeepalivePort() {
    if (keepalivePort || typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
    try {
      keepalivePort = chrome.runtime.connect({ name: 'agwb-keepalive' });
      keepalivePort.onDisconnect.addListener(() => {
        keepalivePort = null;
      });
    } catch (_) {}
  }
  ensureKeepalivePort();

  const BOOT_PROMPT = [
    '### 工作区资料协作说明',
    '我正在本地 IDE 中与你协作处理开发任务。你只需输出纯文本分析：当需要我帮你从工作区摘取文件片段、搜索符号、查阅规范/记忆或应用代码改动时，可在回复末尾附一段 `json:local-tool` 清单，我会在下条消息把对应资料贴给你。',
    '```json:local-tool',
    '[',
    '  {"tool": "get_context", "args": {"kind": "rules"}},',
    '  {"tool": "read_file", "args": {"path": "src/index.ts", "startLine": 1, "endLine": 120}}',
    ']',
    '```',
    '可请求项：`get_context`（`rules`/`memory`/`skills`/`index`/`all`）、`read_file`、`find_files`、`search_code`、`list_dir`、`edit_file`、`write_file`、`run_command`、`mcp_list`、`mcp_call`、`web_subagent`（跨模块/长调用链并行调研，单批最多 2 个，后台轻页签用完即关，不占主上下文）。',
    '协作习惯：已知落点直查；跨模块或预计 ≥3 轮调研优先同批并行派发最多 2 个 `web_subagent`；附 `json:local-tool` 清单后结束本条回复并等待资料补充；路径用反引号 `` `相对路径:行号` ``。收到请简短回复“协作已就绪”。',
  ].join('\n');

  function bridgeRequest(method, endpoint, bodyObj) {
    return new Promise((resolve, reject) => {
      const tryDirectFetch = () => {
        fetch(`http://127.0.0.1:18765${endpoint}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: bodyObj ? JSON.stringify(bodyObj) : undefined,
        })
          .then((r) => r.json())
          .then((d) => (d && d.ok !== false ? resolve(d) : reject(new Error(d?.error || 'Error'))))
          .catch((e) => reject(e));
      };

      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
        return tryDirectFetch();
      }

      try {
        chrome.runtime.sendMessage(
          { type: 'BRIDGE_REQUEST', method, endpoint, bodyObj },
          (res) => {
            if (chrome.runtime.lastError) {
              return tryDirectFetch();
            }
            if (res && res.ok) {
              resolve(res.data);
            } else {
              reject(new Error(res?.error || '请求本地 Bridge 失败'));
            }
          }
        );
      } catch (_) {
        tryDirectFetch();
      }
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function simulateClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function simulateHover(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerenter', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
  }

  function cleanButtonLabel(raw) {
    return String(raw || '')
      .replace(
        /\b(keyboard_arrow_down|keyboard_arrow_up|keyboard_arrow_right|expand_more|expand_less|chevron_right|check|done)\b/gi,
        ''
      )
      .replace(/[\^⌄▼▲▸►✓]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function findWebModelSwitcherBtn() {
    const explicit = document.querySelector(
      '[data-test-id="bard-mode-menu-button"], bard-mode-switcher button, .bard-mode-switcher-button, button.input-area-switch'
    );
    if (isVisible(explicit)) return explicit;

    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of candidates) {
      if (!isVisible(b)) continue;
      if (b.closest('#agwb-root-panel')) continue;
      if (b.closest('.cdk-overlay-container')) continue;
      const cleaned = cleanButtonLabel(b.innerText || b.textContent || '');
      if (!cleaned || cleaned.length > 32) continue;
      if (/\b(Neon|Argon|Carbon|Hydrogen|Flash-Lite|Flash|Pro|Ultra|Deep\s*Think)\b/i.test(cleaned)) {
        return b;
      }
    }
    return null;
  }

  function getWebModelCurrentLabel() {
    const btn = findWebModelSwitcherBtn();
    if (!btn) return '';
    return cleanButtonLabel(btn.innerText || btn.textContent || '');
  }

  function parseOverlayModelItems(items) {
    const out = [];
    const seen = new Set();
    for (const it of items) {
      const rawText = String(it.innerText || it.textContent || '').trim();
      if (!rawText) continue;
      if (/思考等级|thinking\s*level|升级|upgrade|管理订阅|manage\s*plan/i.test(rawText)) continue;

      const lines = rawText
        .split(/\r?\n/)
        .map((s) => cleanButtonLabel(s))
        .filter(Boolean);
      if (!lines.length) continue;

      const title = lines[0];
      if (!title || title.length > 40) continue;
      if (/^(低|中|高|超高|极高|low|medium|high|xhigh|minimal|standard|max)$/i.test(title)) continue;

      const description = lines.slice(1).join(' · ').slice(0, 90);
      const normKey = title.toLowerCase();
      if (seen.has(normKey)) continue;
      seen.add(normKey);
      out.push({
        id: title,
        label: title,
        ...(description ? { description } : {}),
      });
    }
    return out;
  }

  function getOverlayMenuItems(switcherBtn) {
    const raw = Array.from(
      document.querySelectorAll(
        '.cdk-overlay-container button, .cdk-overlay-container [role^="menuitem"], .cdk-overlay-container [role="option"], .cdk-overlay-container mat-list-item, .cdk-overlay-container .mat-mdc-menu-item, [role="menu"] button, [role="menu"] [role^="menuitem"], [role="listbox"] [role="option"], bard-mode-switcher button, .bard-mode-list button'
      )
    );
    const seen = new Set();
    const res = [];
    for (const el of raw) {
      if (!isVisible(el)) continue;
      if (el === switcherBtn) continue;
      if (el.closest('#agwb-root-panel')) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      res.push(el);
    }
    return res;
  }

  function closeAnyOpenOverlay() {
    const backdrops = Array.from(document.querySelectorAll('.cdk-overlay-backdrop'));
    if (backdrops.length) {
      for (const bd of backdrops.reverse()) {
        bd.click();
      }
    } else {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }

  const EFFORT_MATCHERS = {
    low: (t) => /(?:^|\s)(低|low|minimal|最小)(?:\s|$)/i.test(t),
    medium: (t) => /(?:^|\s)(中|medium|standard|标准)(?:\s|$)/i.test(t),
    high: (t) => /(?:^|\s)(高|high)(?:\s|$)/i.test(t) && !/超高|极高/.test(t),
    xhigh: (t) => /(?:^|\s)(超高|极高|xhigh|max)(?:\s|$)/i.test(t),
  };

  async function applyWebModelAndEffort(targetModel, targetEffort, forceDiscover = false) {
    let btn = findWebModelSwitcherBtn();
    if (!btn) return { currentLabel: '', availableModels: [] };

    const cleanTargetModel =
      targetModel && targetModel !== 'gemini-web-brain'
        ? String(targetModel)
            .replace(/^🌐\s*Web\s*[·:]\s*/i, '')
            .replace(/\(.*?\)/g, '')
            .trim()
        : '';
    const modelKeyword = cleanTargetModel
      .replace(/^(?:3\.5|4|2\.5)\s*/i, '')
      .trim()
      .toLowerCase();

    const effortKey = String(targetEffort || '').trim().toLowerCase();
    const effortMatcher = EFFORT_MATCHERS[effortKey] || null;

    let curLabel = getWebModelCurrentLabel();
    const modelAlreadyMatches =
      !modelKeyword || curLabel.toLowerCase().includes(modelKeyword);
    const effortAlreadyMatches = !effortMatcher || effortMatcher(curLabel);

    if (!forceDiscover && modelAlreadyMatches && effortAlreadyMatches) {
      return { currentLabel: curLabel, availableModels: [] };
    }

    let availableModels = [];

    if (!modelAlreadyMatches || forceDiscover) {
      simulateClick(btn);
      await new Promise((r) => setTimeout(r, 320));

      const items = getOverlayMenuItems(btn);
      availableModels = parseOverlayModelItems(items);

      if (!modelAlreadyMatches && modelKeyword) {
        const targetItem = items.find((it) => {
          const t = (it.innerText || it.textContent || '').toLowerCase();
          return !/思考等级|thinking\s*level/i.test(t) && t.includes(modelKeyword);
        });
        if (targetItem) {
          simulateClick(targetItem);
          await new Promise((r) => setTimeout(r, 320));
        } else {
          closeAnyOpenOverlay();
          await new Promise((r) => setTimeout(r, 150));
        }
      } else {
        closeAnyOpenOverlay();
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    curLabel = getWebModelCurrentLabel();
    const nowEffortMatches = !effortMatcher || effortMatcher(curLabel);
    if (!nowEffortMatches && effortMatcher && !/flash-lite/i.test(curLabel)) {
      btn = findWebModelSwitcherBtn();
      let items = getOverlayMenuItems(btn);
      if (!items.length && btn) {
        simulateClick(btn);
        await new Promise((r) => setTimeout(r, 280));
        items = getOverlayMenuItems(btn);
      }

      const thinkingTrigger = items.find((it) =>
        /思考等级|thinking\s*level|思考/i.test(it.innerText || it.textContent || '')
      );

      if (thinkingTrigger) {
        simulateHover(thinkingTrigger);
        simulateClick(thinkingTrigger);
        await new Promise((r) => setTimeout(r, 300));

        const subItems = getOverlayMenuItems(btn);
        const effortItem = subItems.find((it) => {
          if (it === thinkingTrigger) return false;
          const t = cleanButtonLabel(it.innerText || it.textContent || '');
          if (/argon|carbon|hydrogen|neon|flash|思考等级/i.test(t)) return false;
          return effortMatcher(t);
        });

        if (effortItem) {
          simulateClick(effortItem);
          await new Promise((r) => setTimeout(r, 260));
        }
      }
    }

    if (getOverlayMenuItems(btn).length > 0) {
      closeAnyOpenOverlay();
      await new Promise((r) => setTimeout(r, 150));
    }

    return {
      currentLabel: getWebModelCurrentLabel(),
      availableModels,
    };
  }

  function findGeminiEditor() {
    return (
      document.querySelector('rich-textarea .ql-editor[contenteditable="true"]') ||
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"][role="textbox"]')
    );
  }

  function findStopButton() {
    const btn = document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="停止"], button.stop-button'
    );
    return isVisible(btn) ? btn : null;
  }

  function isGeminiWebStreaming() {
    return Boolean(findStopButton());
  }

  function getEditorPlainText(editor) {
    return (editor?.innerText || editor?.textContent || '').replace(/\s+/g, '');
  }

  // 长文本走一次性 paste 事件（与用户 Ctrl+V 同路径，几万字也不卡），失败再回退 insertText / innerHTML
  async function fillGeminiEditor(editor, str) {
    editor.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await new Promise((r) => setTimeout(r, 40));

    const expectLen = str.replace(/\s+/g, '').length;
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', str);
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
      await new Promise((r) => setTimeout(r, 160));
      if (getEditorPlainText(editor).length >= expectLen * 0.9) {
        editor.classList.remove('ql-blank');
        editor.dispatchEvent(
          new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertFromPaste' })
        );
        editor.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    } catch (_) {}

    editor.focus();
    document.execCommand('selectAll', false, null);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, str);
    } catch (_) {}

    if (!inserted || !getEditorPlainText(editor)) {
      editor.innerHTML = str
        .split(/\r?\n/)
        .map(
          (line) =>
            `<p>${
              line
                ? line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                : '<br>'
            }</p>`
        )
        .join('');
    }
    editor.classList.remove('ql-blank');
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: str })
    );
    editor.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function base64ToFile(img) {
    const raw = String(img?.data || '');
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], img?.name || 'image.png', { type: img?.mimeType || 'image/png' });
  }

  function countInputMediaPreviews() {
    const root =
      document.querySelector('.input-area-container, input-area-v2, .text-input-field, rich-textarea')?.closest(
        'input-area-v2, .input-area-container, form'
      ) || document;
    return root.querySelectorAll(
      'uploader-file-preview, file-preview, .file-preview-wrapper, [data-test-id*="image-preview"], [data-test-id*="file-preview"], img[src^="blob:"], img[src^="data:"]'
    ).length;
  }

  async function waitForPreviewIncrease(baseline, timeoutMs = 1100) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (countInputMediaPreviews() > baseline) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return countInputMediaPreviews() > baseline;
  }

  // 把 VS Code 粘贴的截图附加到 Gemini 输入框：依次尝试 paste / file input / drop，纯浏览原生操作
  async function attachImagesToGeminiWeb(editor, images) {
    if (!Array.isArray(images) || !images.length || !editor) return false;
    const files = [];
    for (const img of images.slice(0, 4)) {
      if (!img?.data) continue;
      try { files.push(base64ToFile(img)); } catch (_) {}
    }
    if (!files.length) return false;

    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    const baseline = countInputMediaPreviews();

    try {
      editor.focus();
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true })
      );
      if (await waitForPreviewIncrease(baseline, 1000)) return true;
    } catch (_) {}

    const fileInput = document.querySelector('input[type="file"]');
    if (fileInput) {
      try {
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        if (await waitForPreviewIncrease(baseline, 1100)) return true;
      } catch (_) {}
    }

    const dropTarget = editor.closest('.input-area-container, .text-input-field') || editor;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      try {
        dropTarget.dispatchEvent(
          new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, composed: true })
        );
      } catch (_) {}
    }
    return await waitForPreviewIncrease(baseline, 1200);
  }

  async function sendTextToGeminiWeb(text, images = []) {
    const editor = findGeminiEditor();
    if (!editor) return false;

    await fillGeminiEditor(editor, String(text || ''));
    if (Array.isArray(images) && images.length) {
      statusEl.textContent = `📎 正在附加 ${images.length} 张图片到网页输入框...`;
      await attachImagesToGeminiWeb(editor, images);
      // 等待图片缩略图上传完成（或最多 5s）再点发送
      const waitEnd = Date.now() + 5000;
      while (Date.now() < waitEnd) {
        const area = editor.closest('input-area-v2, .input-area-container, form') || document;
        const uploading = area.querySelector('mat-spinner, [role="progressbar"]');
        if (!uploading) break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    const baselineQueries = countUserQueries();
    let attempts = 0;
    let clickRetries = 0;
    const humanJitterMs = 420 + Math.floor(Math.random() * 520);
    const findEnabledSendBtn = () =>
      document.querySelector('button.send-button:not([disabled])') ||
      document.querySelector('button[aria-label*="Send"]:not([disabled])') ||
      document.querySelector('button[aria-label*="发送"]:not([disabled])') ||
      document.querySelector('.send-button-container button:not([disabled])');
    const verifyDelivered = () => {
      if (countUserQueries() > baselineQueries || isGeminiWebStreaming()) return;
      const curEditor = findGeminiEditor();
      if (!curEditor || getEditorPlainText(curEditor).length <= 2) return;
      if (clickRetries >= 5) return;
      clickRetries++;
      curEditor.focus();
      curEditor.classList.remove('ql-blank');
      curEditor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText' }));
      const btn = findEnabledSendBtn();
      if (btn && btn.getAttribute('aria-disabled') !== 'true') {
        simulateClick(btn);
      } else if (clickRetries >= 2) {
        curEditor.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          })
        );
      }
      setTimeout(verifyDelivered, 950);
    };
    const tryClickSend = () => {
      attempts++;
      const sendBtn = findEnabledSendBtn();
      if (sendBtn && sendBtn.getAttribute('aria-disabled') !== 'true') {
        simulateClick(sendBtn);
        setTimeout(verifyDelivered, 950);
      } else if (attempts < 18) {
        setTimeout(tryClickSend, 200 + Math.floor(Math.random() * 120));
      }
    };
    setTimeout(tryClickSend, humanJitterMs);
    return true;
  }

  function getModelResponseNodes() {
    const nodes = Array.from(document.querySelectorAll('model-response'));
    if (nodes.length) return nodes;
    return Array.from(document.querySelectorAll('message-content, .model-response-text'));
  }

  function extractResponseThoughts(respNode) {
    if (!respNode) return '';
    const thoughtEl = respNode.querySelector(
      'model-thoughts .thoughts-content, model-thoughts .markdown, model-thoughts, .thoughts-container, [data-test-id*="thought"]'
    );
    if (!thoughtEl) return '';
    const clone = thoughtEl.cloneNode(true);
    for (const junk of clone.querySelectorAll('button, mat-icon, svg, script, style, .thoughts-header')) {
      junk.remove();
    }
    const raw = (clone.innerText || clone.textContent || '')
      .replace(/^(显示思路|隐藏思路|Show thinking|Hide thinking|Thinking|思考过程)\s*/i, '')
      .trim();
    return raw;
  }

  function domToMarkdown(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = node.tagName.toLowerCase();
    if (
      tag === 'button' ||
      tag === 'mat-icon' ||
      tag === 'svg' ||
      tag === 'script' ||
      tag === 'style' ||
      node.classList?.contains('code-block-decoration') ||
      node.classList?.contains('bottom-container') ||
      node.classList?.contains('response-footer') ||
      node.classList?.contains('thoughts-container') ||
      tag === 'model-thoughts'
    ) {
      return '';
    }

    if (tag === 'pre') {
      const codeEl = node.querySelector('code') || node;
      const body = (codeEl.innerText || codeEl.textContent || '').replace(/\n+$/, '');
      let lang = 'text';
      const wrap = node.closest('code-block, .code-block');
      if (wrap) {
        const hdr = wrap.querySelector('.code-block-decoration span, .code-block-header span');
        const rawLang = (hdr?.textContent || '').trim().toLowerCase();
        if (rawLang && !/copy|复制|代码/.test(rawLang)) lang = rawLang;
      }
      return `\n\`\`\`${lang}\n${body}\n\`\`\`\n\n`;
    }

    if (tag === 'code' && !node.closest('pre')) {
      return '`' + (node.textContent || '') + '`';
    }
    if (tag === 'br') return '\n';

    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (!rows.length) return '';
      const matrix = rows.map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((cell) =>
          domToMarkdown(cell).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim()
        )
      ).filter((r) => r.length > 0);
      if (!matrix.length) return '';
      const colCount = Math.max(...matrix.map((r) => r.length));
      const padRow = (r) => '| ' + Array.from({ length: colCount }, (_, i) => r[i] || '').join(' | ') + ' |';
      const sep = '| ' + Array.from({ length: colCount }, () => '---').join(' | ') + ' |';
      const bodyRows = matrix.slice(1).map(padRow);
      return `\n${[padRow(matrix[0]), sep, ...bodyRows].join('\n')}\n\n`;
    }

    let inner = '';
    for (const child of node.childNodes) {
      inner += domToMarkdown(child);
    }

    if (tag === 'a') {
      const href = (node.getAttribute('href') || '').trim();
      const label = inner.trim();
      if (href && !/^javascript:/i.test(href) && !/^unsafe:/i.test(href)) {
        return `[${label || href}](${href})`;
      }
      return label;
    }
    if (tag === 'strong' || tag === 'b') {
      return inner.trim() ? `**${inner.trim()}**` : '';
    }
    if (tag === 'em' || tag === 'i') {
      return inner.trim() ? `*${inner.trim()}*` : '';
    }
    if (tag === 'blockquote') {
      const lines = inner.trim().split('\n').map((l) => `> ${l}`);
      return lines.length ? `\n${lines.join('\n')}\n\n` : '';
    }
    if (tag === 'hr') return '\n---\n\n';
    if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
      return inner.trim() ? inner + '\n\n' : '';
    }
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return `\n${'#'.repeat(level)} ${inner.trim()}\n\n`;
    }
    if (tag === 'li') return `- ${inner.trim()}\n`;
    if (tag === 'ul' || tag === 'ol') return `\n${inner}\n`;
    return inner;
  }

  function extractResponseMarkdown(respNode) {
    if (!respNode) return '';
    const contentRoot =
      respNode.querySelector('message-content .markdown') ||
      respNode.querySelector('message-content') ||
      respNode.querySelector('.model-response-text') ||
      respNode;
    return domToMarkdown(contentRoot)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 剪贴板 API 在页面未聚焦或弹出权限询问时可能一直不返回，统一加超时，绝不阻塞完成上报
  function withTimeout(promise, ms, fallback) {
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  }

  async function readClipboardText() {
    try {
      if (navigator.clipboard?.readText) {
        const v = await withTimeout(navigator.clipboard.readText().catch(() => null), 1200, null);
        if (v !== null) return v;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      const ok = document.execCommand('paste');
      const v = ta.value;
      ta.remove();
      return ok ? v : null;
    } catch (_) {
      return null;
    }
  }

  async function writeClipboardText(text) {
    try {
      if (navigator.clipboard?.writeText) {
        const ok = await withTimeout(navigator.clipboard.writeText(text).then(() => true, () => false), 1200, false);
        if (ok) return;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (_) {}
  }

  function findResponseCopyButton(respNode) {
    const btns = Array.from(
      respNode.querySelectorAll(
        'copy-button button, button[data-test-id="copy-button"], button[aria-label*="复制"], button[aria-label*="Copy"], button[mattooltip*="复制"], button[mattooltip*="Copy"]'
      )
    ).filter((b) => !b.closest('code-block, .code-block, model-thoughts, .thoughts-container'));
    return btns.length ? btns[btns.length - 1] : null;
  }

  // 点网页自带「复制」按钮拿原始 Markdown（表格/公式/嵌套列表不丢格式）。
  // 只有先能读到用户原剪贴板时才执行，读完立即还原；任何一步失败都回退 DOM 解析结果。
  let clipboardBusy = false;
  async function extractResponseViaCopyButton(respNode, domText) {
    if (document.hidden || clipboardBusy || !respNode) return '';
    const copyBtn = findResponseCopyButton(respNode);
    if (!copyBtn) return '';
    clipboardBusy = true;
    try {
      const prior = await readClipboardText();
      if (prior === null) return '';
      simulateClick(copyBtn);
      await new Promise((r) => setTimeout(r, 260));
      const copied = await readClipboardText();
      await writeClipboardText(prior);
      if (!copied || copied === prior) return '';
      const lenA = copied.replace(/\s+/g, '').length;
      const lenB = String(domText || '').replace(/\s+/g, '').length;
      if (lenB && (lenA < lenB * 0.5 || lenA > lenB * 2.5)) return '';
      return copied.trim();
    } catch (_) {
      return '';
    } finally {
      clipboardBusy = false;
    }
  }

  const LIMIT_NOTICE_RE =
    /(已达到|达到了|已用完|用完了).{0,24}(使用|消息|对话|方案|模型|每日|每周)?.{0,12}(上限|限额|额度)|reached (your|the) .{0,40}limit|usage limit|limit (resets|will reset)/i;

  function detectUsageLimitNotice(respNode) {
    // 只读页面提示条 / 警告栏，不扫普通回复正文，避免模型讨论“工具调用上限”时误报
    const candidates = Array.from(
      document.querySelectorAll(
        'simple-snack-bar, mat-snack-bar-container, .mat-mdc-snack-bar-container, [role="alert"], [role="status"]'
      )
    );
    const hasAnswer = Boolean(respNode && (respNode.innerText || '').trim().length > 120);
    if (!hasAnswer && respNode) candidates.push(respNode);
    for (const el of candidates) {
      if (!el || el.closest('#agwb-root-panel')) continue;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length >= 400 || /工具调用上限/.test(t)) continue;
      if (LIMIT_NOTICE_RE.test(t)) return t;
    }
    return '';
  }

  function extractLatestAgentTask() {
    const blocks = Array.from(
      document.querySelectorAll('model-response pre code, message-content pre code, pre code')
    );
    let found = '';
    for (const codeEl of blocks) {
      if (codeEl.closest('user-query, .user-query-container')) continue;
      const raw = (codeEl.innerText || codeEl.textContent || '').trim();
      if (!raw) continue;
      if (raw.includes('请在这里写你要交给本地 Agent 执行的具体任务')) continue;
      if (raw.includes('"pattern": "functionName"') && raw.includes('"src/index.ts"') && raw.includes('"endLine": 120')) continue;

      const lines = raw.split(/\r?\n/);
      const firstLine = lines[0].trim();
      const headerText = (codeEl.closest('code-block, .code-block')?.innerText || '').toLowerCase();

      if (/^#\s*@?local-(?:tool|agent)$/i.test(firstLine)) {
        const body = lines.slice(1).join('\n').trim();
        if (body) found = body;
      } else if (headerText.includes('local-tool') || headerText.includes('local-agent')) {
        found = raw;
      }
    }
    return found;
  }

  const box = document.createElement('div');
  box.id = 'agwb-root-panel';
  box.style.cssText = [
    'position:fixed;bottom:18px;right:18px;z-index:999999;',
    'background:#18181b;color:#f4f4f5;border:1px solid #3f3f46;',
    'border-radius:10px;padding:10px 12px;width:320px;',
    'box-shadow:0 8px 24px rgba(0,0,0,0.45);font:12px/1.4 system-ui,-apple-system,sans-serif;',
  ].join('');

  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <div style="font-weight:600;display:flex;align-items:center;gap:6px;">
        <span id="agwb-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#71717a;"></span>
        <span>ZeroG Code Bridge v2.6.8</span>
        <span id="agwb-webmodel" style="color:#38bdf8;font-size:11px;font-weight:500;"></span>
      </div>
      <label style="cursor:pointer;display:flex;align-items:center;gap:4px;color:#a1a1aa;" title="仅纯网页对话时勾选；使用 VS Code 插件时保持关闭">
        <input type="checkbox" id="agwb-auto" style="margin:0;"> 网页自闭环
      </label>
    </div>
    <div id="agwb-status" style="color:#a1a1aa;background:#27272a;padding:5px 8px;border-radius:6px;margin-bottom:8px;min-height:18px;word-break:break-all;max-height:72px;overflow:auto;">
      正在连接本地 Bridge (127.0.0.1:18765)...
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;">
      <button id="agwb-btn-boot" style="flex:1;cursor:pointer;padding:5px 6px;border-radius:5px;border:none;background:#2563eb;color:#fff;font-size:11px;">📋 注入协议</button>
      <button id="agwb-btn-run" style="flex:1;cursor:pointer;padding:5px 6px;border-radius:5px;border:none;background:#059669;color:#fff;font-size:11px;">▶️ 执行最新块</button>
      <button id="agwb-btn-engine" style="flex:1;cursor:pointer;padding:5px 6px;border-radius:5px;border:none;background:#7c3aed;color:#fff;font-size:11px;">⚡ 0额度纯工具</button>
    </div>
    <div style="display:flex;gap:6px;margin-top:6px;">
      <button id="agwb-btn-sel" style="flex:1;cursor:pointer;padding:4px 6px;border-radius:5px;border:1px solid #3f3f46;background:#27272a;color:#e4e4e7;font-size:11px;">📤 发选中文字</button>
      <button id="agwb-btn-stop" style="flex:1;cursor:pointer;padding:4px 6px;border-radius:5px;border:1px solid #7f1d1d;background:#450a0a;color:#fca5a5;font-size:11px;">⏹️ 停止执行</button>
    </div>
  `;
  document.body.appendChild(box);

  const dotEl = box.querySelector('#agwb-dot');
  const webModelEl = box.querySelector('#agwb-webmodel');
  const statusEl = box.querySelector('#agwb-status');
  const autoChk = box.querySelector('#agwb-auto');
  const engineBtn = box.querySelector('#agwb-btn-engine');

  autoChk.onchange = () => { autoLoop = autoChk.checked; };
  engineBtn.onclick = () => {
    localEngine = localEngine === 'local-tool' ? 'agy' : 'local-tool';
    engineBtn.textContent = localEngine === 'local-tool' ? '⚡ 0额度纯工具' : '🤖 本地AGY';
    engineBtn.style.background = localEngine === 'local-tool' ? '#7c3aed' : '#d97706';
    bridgeRequest('POST', '/web-brain/set-model', { backend: localEngine }).catch(() => {});
  };

  // ─── ISOLATED DOM 流式监控（不注入 MAIN 世界，不篡改 XHR/fetch）───
  async function reportWithRetry(body, tries = 4) {
    for (let i = 0; i < tries; i++) {
      try {
        const data = await bridgeRequest('POST', '/browser/report', body);
        return { ok: true, data };
      } catch (_) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    return { ok: false, data: null };
  }

  function extractChatIdFromHref(rawHref) {
    if (!rawHref) return '';
    return String(rawHref).match(/\/app\/([a-zA-Z0-9_-]{8,})/)?.[1] || '';
  }

  function getSelectedSidebarChatId() {
    const activeItem = document.querySelector(
      'conversations-list .selected, conversations-list [aria-current="page"], [data-test-id="conversation"].selected, a[aria-current="page"][href*="/app/"]'
    );
    if (!activeItem) return '';
    const href = activeItem.getAttribute('href') || activeItem.querySelector('a[href*="/app/"]')?.getAttribute('href') || '';
    const cidFromHref = extractChatIdFromHref(href);
    if (cidFromHref) return cidFromHref;
    const jslog = activeItem.getAttribute('jslog') || activeItem.querySelector('[jslog]')?.getAttribute('jslog') || '';
    return jslog.match(/\bc_([0-9a-f]{12,32})\b/i)?.[1] || '';
  }

  function resolveCurrentChatUrl(excludeSidebarChatId = '') {
    if (extractChatIdFromHref(window.location.href)) return window.location.href;
    // 新会话首轮刚结束时，仅在对话已产生用户消息且侧边栏高亮项非发送前旧会话时，才采纳侧边栏 /app/<chatId>
    if (countUserQueries() > 0) {
      const cid = getSelectedSidebarChatId();
      if (cid && (!excludeSidebarChatId || cid !== excludeSidebarChatId)) {
        return `https://gemini.google.com/app/${cid}`;
      }
    }
    return window.location.href;
  }

  async function waitForConversationUrl(maxWaitMs = 2200, excludeSidebarChatId = '') {
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end) {
      const url = resolveCurrentChatUrl(excludeSidebarChatId);
      if (extractChatIdFromHref(url)) return url;
      await new Promise((r) => setTimeout(r, 160));
    }
    return resolveCurrentChatUrl(excludeSidebarChatId);
  }

  function hasUnclosedFence(text) {
    return ((String(text || '').match(/```/g) || []).length % 2) === 1;
  }

  function countUserQueries() {
    return document.querySelectorAll('user-query, .user-query-container').length;
  }

  // 仅检查本轮新增的回复节点是否处于「思考中」，绝不扫描上一轮已结束的旧 model-thoughts 节点（否则会误置 hasStarted=true 导致死锁）
  function isGeminiThinking(baselineCount = -1) {
    const nodes = getModelResponseNodes();
    if (typeof baselineCount === 'number' && baselineCount >= 0 && nodes.length <= baselineCount) {
      return false;
    }
    const last = nodes[nodes.length - 1];
    if (!last) return false;
    const spinner = last.querySelector(
      '.loading-content-spinner, mat-spinner, mat-progress-spinner, [role="progressbar"], [data-test-id*="loading"]'
    );
    if (spinner && isVisible(spinner)) return true;
    const thoughtHeader = last.querySelector(
      'model-thoughts button, .thoughts-header, [data-test-id*="thoughts-header"]'
    );
    if (thoughtHeader) {
      const hdr = (thoughtHeader.innerText || thoughtHeader.textContent || '').replace(/\s+/g, ' ').trim();
      if (/正在思考|思考中|^Thinking\.{0,3}$/i.test(hdr) && !/显示思路|隐藏思路|Show thinking|Hide thinking/i.test(hdr)) {
        return true;
      }
    }
    return false;
  }

  const PAGE_ERROR_RE =
    /出了点问题|出错了|遇到错误|无法生成|无法处理|请稍后再试|请再试一次|网络连接|Something went wrong|encountered an error|Couldn'?t generate|Could you try again|try again later|There was an error/i;

  function detectPageErrorNotice() {
    const els = Array.from(
      document.querySelectorAll(
        'simple-snack-bar, mat-snack-bar-container, .mat-mdc-snack-bar-container, [role="alert"]'
      )
    );
    for (const el of els) {
      if (!el || el.closest('#agwb-root-panel')) continue;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 300 && PAGE_ERROR_RE.test(t)) return t;
    }
    return '';
  }

  const CANNED_REFUSAL_RE =
    /^(?:[•·\-\s]*)(?:请?恕我爱莫能助|由于(?:我的)?(?:程序代码|程序逻辑|程序设计|系统|技术|功能|能力)?的?(?:局限|限制)[\s\S]{0,60}|我(?:只会|只能|仅能)(?:生成|处理|回复)文本|我(?:只是|仅是)(?:一个|一名)?(?:基于文本的\s*|文本\s*|大型?\s*)?(?:AI|人工智能|语言模型)|(?:身为|作为|我是)(?:一个|一名)?(?:基于文本的\s*|文本\s*|大型?\s*)?(?:AI|人工智能|语言模型)[\s\S]{0,80}?(?:无法|不能|没(?:有)?办法|没法子?|办不到|做不到|帮不了|帮不上|帮上忙|爱莫能助|无能为力|无权|不支持|尚未支持|超出|理解不了|不具备|能力有限|还?在学习|没有学会|还没学会)|(?:很?抱歉|对不起|不好意思)[，,、\s]*(?:我)?(?:目前|暂时|实在)?(?:无法|不能|没(?:有)?办法|没法子?|办不到|做不到|无能为力)(?:提供|协助|帮助|处理|回答|满足|理解|帮上忙|办到|做到)?|我(?:目前|暂时)?(?:无法|不能|没(?:有)?办法|没法子?|办不到|做不到)(?:提供这方面的帮助|提供帮助|协助(?:您|你)?|帮(?:助)?(?:您|你)|满足(?:您|你)|回答这个问题|理解这个问题|帮上忙|帮到你|办到|做到|处理(?:您|你)的(?:这个)?请求)|(?:(?:你|您)提出的问题|这个问题|(?:你|您)的请求|该问题|这)?超出了我的(?:程序逻辑|设计用途|能力|处理|知识|服务|使用)?(?:范畴|范围|用途)|我(?:目前)?(?:还|仍)(?:在学习如何|没有学会|还没学会|不具备|无法)(?:回答|处理|理解|协助)|Sorry,?\s+I\s+(?:can'?t|cannot|am\s+unable\s+to|am\s+not\s+able\s+to)\s+(?:help|assist)|I'?m\s+(?:just|only)\s+an?\s+(?:text-based\s+)?(?:AI|language\s+model)|(?:I'?m|As)\s+an?\s+(?:text-based\s+)?(?:AI|language\s+model)\b[\s\S]{0,100}?(?:can'?t|cannot|unable|not\s+able|don'?t\s+have\s+the\s+ability|outside|beyond|capacity|help|assist|programmed)|I\s+(?:only|can\s+only)\s+(?:generate|process|work\s+with)\s+text|I\s+(?:can'?t|cannot|am\s+unable\s+to|am\s+not\s+(?:able|programmed)\s+to)\s+(?:help|assist)(?:\s+you)?\s+with\s+(?:that|this)|(?:That|This|Your\s+(?:request|question))\s+is\s+(?:outside|beyond)\s+(?:of\s+)?my\s+(?:capabilities|abilities|programming|scope|design)|I'?m\s+still\s+learning\s+how\s+to\s+answer\s+this\s+question)/i;

  const TRANSIENT_ERROR_REPLY_RE =
    /^(?:[•·\-\s]*)(?:I\s+encountered\s+an\s+error(?:\s+doing\s+what\s+you\s+asked)?[\s.,!?:;]*(?:Could\s+you\s+try\s+again\??|Please\s+try\s+again\.?)?|Something\s+went\s+wrong[\s.,!?:;]*(?:Please\s+try\s+again\.?|Could\s+you\s+try\s+again\??)?|Sorry,?\s+(?:I\s+)?(?:encountered\s+an\s+error|something\s+went\s+wrong|couldn'?t\s+(?:process|complete)\s+your\s+request)[\s\S]{0,120}|There\s+was\s+an\s+error\s+generating\s+a\s+response[\s\S]{0,120}|An\s+error\s+occurred[\s.,!?:;]*(?:Please\s+try\s+again\.?)?|A\s+network\s+error\s+occurred[\s\S]{0,120}|Unable\s+to\s+(?:process|complete)\s+your\s+request[\s\S]{0,120}|(?:执行|处理)(?:您|你)的请求时(?:遇到错误|出错)[\s\S]{0,80}|(?:抱歉[，,]?\s*)?(?:出了点问题|出错了|生成回复时出错|无法处理(?:您|你)的请求|系统繁忙)[。，,.！!\s]*(?:请(?:稍后)?(?:再试|重试)[。！!]?)?)$/i;

  function isCannedOrTransientErrorReply(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || trimmed.length > 260) return false;
    if (/```|local-tool|"tool"\s*:/.test(trimmed)) return false;
    return CANNED_REFUSAL_RE.test(trimmed) || TRANSIENT_ERROR_REPLY_RE.test(trimmed);
  }

  function stepActiveWatch() {
    if (!activeWatchState) return;
    const st = activeWatchState;
    if (completedReqIds.has(st.cmdKey)) {
      activeWatchState = null;
      return;
    }

    const nodes = getModelResponseNodes();
    const streaming = isGeminiWebStreaming();
    const thinking = isGeminiThinking(st.baselineCount);
    let currentText = '';
    let currentThoughts = '';

    if (nodes.length > st.baselineCount) {
      st.hasStarted = true;
      const targetNode = nodes[nodes.length - 1];
      currentText = extractResponseMarkdown(targetNode);
      currentThoughts = extractResponseThoughts(targetNode);
    } else if (nodes.length === st.baselineCount && st.baselineCount > 0) {
      const targetNode = nodes[nodes.length - 1];
      const latest = extractResponseMarkdown(targetNode);
      if (latest && latest !== st.baselineLastText) {
        st.hasStarted = true;
        currentText = latest;
        currentThoughts = extractResponseThoughts(targetNode);
      }
    }

    if (streaming || thinking) st.hasStarted = true;
    // 用户消息已出现在对话里 = 已发出；立即通知服务端释放「串行发送锁」，允许其它对话栏开始发送
    if (!st.sent && (countUserQueries() > st.baselineUserCount || nodes.length > st.baselineCount)) {
      st.sent = true;
      bridgeRequest('POST', '/browser/report', {
        requestId: st.reqId,
        step: st.step,
        status: 'sent',
        ...(extractChatIdFromHref(window.location.href) ? { webChatUrl: window.location.href } : {}),
      }).catch(() => {});
    }
    const now = Date.now();

    // 若消息迟迟未发出（独立于 hasStarted 判定！）：12s 自动重填补点一次，42s 上报可重试错误由服务端重派发
    if (!st.sent && !streaming && nodes.length <= st.baselineCount) {
      if (!st.resendTried && st.prompt && now - st.startedAt > 12000) {
        st.resendTried = true;
        statusEl.textContent = '🔄 检测到消息尚未发出，正在自动补发...';
        sendTextToGeminiWeb(st.prompt, []).catch(() => {});
        return;
      }
      if (now - st.startedAt > 42000) {
        const reqId = st.reqId;
        const step = st.step;
        completedReqIds.add(st.cmdKey);
        activeWatchState = null;
        statusEl.textContent = '❌ 消息未能发出，正在交由本地服务重试';
        const limitNotice = detectUsageLimitNotice(null);
        const pageErr = detectPageErrorNotice();
        reportWithRetry({
          requestId: reqId,
          step,
          status: 'error',
          retryable: !limitNotice,
          error: limitNotice
            ? `Gemini 网页提示已达用量上限: ${limitNotice}`
            : pageErr
              ? `Gemini 网页提示异常: ${pageErr}`
              : '消息 42s 内没有出现在 Gemini 对话里（输入框或发送按钮未响应）',
          limitNotice,
        });
        return;
      }
    }

    if (currentText && !isCannedOrTransientErrorReply(currentText)) {
      const prevBest = st.bestText || '';
      const curHasTool = /local-tool|"tool"\s*:/.test(currentText);
      const prevHasTool = /local-tool|"tool"\s*:/.test(prevBest);
      if (currentText.length >= prevBest.length || (curHasTool && !prevHasTool)) {
        st.bestText = currentText;
      }
    }

    if (
      (currentText && currentText !== st.lastReportedText) ||
      (currentThoughts && currentThoughts !== st.lastReportedThoughts)
    ) {
      st.lastReportedText = currentText;
      st.lastReportedThoughts = currentThoughts;
      st.stableTicks = 0;
      st.lastChangeAt = now;
      st.lastHeartbeatAt = now;
      bridgeRequest('POST', '/browser/report', {
        requestId: st.reqId,
        step: st.step,
        status: 'streaming',
        activelyGenerating: true,
        text: currentText,
        thoughts: currentThoughts,
        webChatUrl: window.location.href,
        currentModelLabel: getWebModelCurrentLabel(),
      }).catch(() => {});
    } else if (st.hasStarted && !streaming && currentText) {
      st.stableTicks++;
      // 停止按钮消失后再稳定一会儿；代码块围栏没闭合说明还没输出完，继续等（最多 20s 兜底）
      const quietMs = now - (st.lastChangeAt || st.startedAt);
      const fenceOpen = hasUnclosedFence(currentText) && quietMs < 20000;
      if (st.stableTicks >= 4 && quietMs >= 1500 && !fenceOpen) {
        const reqId = st.reqId;
        const step = st.step;
        const bestText = st.bestText || '';
        completedReqIds.add(st.cmdKey);
        activeWatchState = null;
        const finalNodes = getModelResponseNodes();
        const respNode = finalNodes[finalNodes.length - 1];
        (async () => {
          const copiedMd = await withTimeout(extractResponseViaCopyButton(respNode, currentText), 4000, '');
          const finalText = copiedMd || currentText;
          const excludeSid = st.baselineChatId ? '' : st.baselineSidebarChatId || '';
          const finalChatUrl = await waitForConversationUrl(2200, excludeSid);
          const isTransientErrReply = isCannedOrTransientErrorReply(finalText);
          statusEl.textContent = isTransientErrReply
            ? '⚠️ 检测到网页端异常/拒答回复，已交由本地 Bridge 抢救或自动续跑...'
            : `✅ 已同步网页回复 (${finalText.length} 字${copiedMd && finalText === copiedMd ? ' · 原始 Markdown' : ''})`;
          dotEl.style.background = isTransientErrReply ? '#f59e0b' : '#22c55e';
          const rep = await reportWithRetry({
            requestId: reqId,
            step,
            status: 'completed',
            text: finalText,
            ...(bestText && bestText !== finalText ? { bestStreamText: bestText } : {}),
            thoughts: currentThoughts,
            webChatUrl: finalChatUrl,
            currentModelLabel: getWebModelCurrentLabel(),
            limitNotice: detectUsageLimitNotice(respNode),
          });
          if (!rep.ok) {
            statusEl.textContent = '❌ 回复已生成，但回传本地 Bridge 失败（请确认 start-bridge.ps1 在运行）';
          } else if (
            rep.data?.turnCompleted &&
            rep.data?.autoCloseTab !== false &&
            extractChatIdFromHref(finalChatUrl) &&
            typeof chrome !== 'undefined' &&
            chrome.runtime?.sendMessage
          ) {
            statusEl.textContent = '✅ 回复已同步本地，正在自动关闭网页窗口...';
            try {
              chrome.runtime.sendMessage({ type: 'AUTO_CLOSE_TAB', delayMs: 650 });
            } catch (_) {}
          }
        })();
      }
    } else if (st.hasStarted && !streaming && !thinking && !currentText) {
      st.stableTicks++;
      const quietMs = now - (st.lastChangeAt || st.startedAt);
      // 留足 15s 缓冲避开深度思考结束到正文首字渲染的切换间隙；只读取本轮新增节点正文，绝不误读上一轮旧回复或内部思维链
      if (st.stableTicks >= 32 && quietMs >= 15000) {
        const reqId = st.reqId;
        const step = st.step;
        completedReqIds.add(st.cmdKey);
        activeWatchState = null;
        const finalNodes = getModelResponseNodes();
        const newRespNode = finalNodes.length > st.baselineCount ? finalNodes[finalNodes.length - 1] : null;
        const limitNotice = detectUsageLimitNotice(newRespNode);
        const pageErr = detectPageErrorNotice();
        const lateMd = newRespNode ? extractResponseMarkdown(newRespNode) : '';
        if (lateMd && !limitNotice) {
          statusEl.textContent = `✅ 已同步网页回复 (${lateMd.length} 字)`;
          reportWithRetry({
            requestId: reqId,
            step,
            status: 'completed',
            text: lateMd,
            thoughts: newRespNode ? extractResponseThoughts(newRespNode) : '',
            webChatUrl: resolveCurrentChatUrl(st.baselineChatId ? '' : st.baselineSidebarChatId || ''),
            currentModelLabel: getWebModelCurrentLabel(),
          });
        } else {
          statusEl.textContent = '❌ 网页端停止生成但未返回正文';
          reportWithRetry({
            requestId: reqId,
            step,
            status: 'error',
            retryable: !limitNotice,
            error: limitNotice
              ? `Gemini 网页提示已达用量上限: ${limitNotice}`
              : pageErr
                ? `Gemini 网页提示异常: ${pageErr}`
                : '网页端已停止生成但未返回有效正文',
            limitNotice,
          });
        }
      }
    } else if ((st.hasStarted || st.sent) && now - (st.lastHeartbeatAt || st.startedAt) > 15000) {
      st.lastHeartbeatAt = now;
      const idleMs = now - (st.lastChangeAt || st.startedAt);
      const activelyGen = Boolean(streaming || thinking);
      if ((!activelyGen && idleMs > 90000) || idleMs > 300000) {
        const reqId = st.reqId;
        completedReqIds.add(st.cmdKey);
        activeWatchState = null;
        const limitNotice = detectUsageLimitNotice(null);
        const pageErr = detectPageErrorNotice();
        statusEl.textContent = '❌ 网页端长时间无响应，已释放当前步骤';
        reportWithRetry({
          requestId: reqId,
          step: st.step,
          status: 'error',
          retryable: !limitNotice,
          error: limitNotice
            ? `Gemini 网页提示已达用量上限: ${limitNotice}`
            : pageErr
              ? `Gemini 网页提示异常: ${pageErr}`
              : activelyGen
                ? '网页端超过 5 分钟没有任何新内容输出，已自动释放防卡死'
                : '消息已发到 Gemini 网页，但页面超过 90 秒无任何生成迹象',
          limitNotice,
        });
        return;
      }
      statusEl.textContent = activelyGen
        ? `🧠 网页端思考/生成中 (${Math.round((now - st.startedAt) / 1000)}s)...`
        : `⏳ 消息已发出，等待网页开始响应 (${Math.round((now - st.startedAt) / 1000)}s)...`;
      bridgeRequest('POST', '/browser/report', {
        requestId: st.reqId,
        step: st.step,
        status: 'streaming',
        activelyGenerating: activelyGen,
        text: currentText || st.lastReportedText || '',
      }).catch(() => {});
    }
  }

  function cleanSidebarTitle(raw) {
    return String(raw || '')
      .replace(/\b(more_vert|more_horiz|push_pin|keep|delete|edit|share)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collectSidebarConversationItems() {
    const map = new Map();
    const put = (chatId, title, isCurrent = false) => {
      if (!chatId || chatId.length < 8 || /^(?:download|settings|usage|gems|updates)$/i.test(chatId)) return;
      const clean = cleanSidebarTitle(title);
      const prev = map.get(chatId);
      if (!prev || (!prev.title && clean)) {
        map.set(chatId, {
          chatId,
          url: `https://gemini.google.com/app/${chatId}`,
          title: clean || prev?.title || `Web Chat (${chatId.slice(0, 8)})`,
          isCurrent: Boolean(isCurrent || prev?.isCurrent),
        });
      }
    };

    // 1. 当前页本身如果是 /app/<chatId>
    const curCid = extractChatIdFromHref(window.location.href);
    if (curCid) {
      const docTitle = String(document.title || '')
        .replace(/^\s*Google\s+Gemini\s*[-–—·|]\s*/i, '')
        .replace(/\s*[-–—·|]\s*Google\s+Gemini\s*$/i, '')
        .replace(/^Gemini\s*$/i, '')
        .trim();
      put(curCid, docTitle, true);
    }

    // 2. <a href*="/app/...">
    const anchors = Array.from(document.querySelectorAll('a[href*="/app/"]'));
    for (const a of anchors) {
      if (a.closest('#agwb-root-panel, model-response, user-query')) continue;
      const cid = extractChatIdFromHref(a.getAttribute('href') || a.href || '');
      if (!cid) continue;
      const titleEl = a.querySelector('.conversation-title, [data-test-id="conversation-title"]') || a;
      put(cid, titleEl.innerText || titleEl.textContent || '', cid === curCid);
    }

    // 3. Angular 侧边栏会话节点 [data-test-id="conversation"] / conversations-list .conversation（jslog 中含 c_<hex>）
    const convEls = Array.from(
      document.querySelectorAll(
        '[data-test-id="conversation"], conversations-list .conversation, .conversation-items-container'
      )
    );
    for (const el of convEls) {
      let cid = '';
      const innerA = el.tagName.toLowerCase() === 'a' ? el : el.querySelector('a[href*="/app/"]');
      if (innerA) cid = extractChatIdFromHref(innerA.getAttribute('href') || '');
      if (!cid) {
        const jslog =
          el.getAttribute('jslog') ||
          el.querySelector('[jslog]')?.getAttribute('jslog') ||
          el.closest('[jslog]')?.getAttribute('jslog') ||
          '';
        cid = jslog.match(/\bc_([0-9a-f]{12,32})\b/i)?.[1] || '';
      }
      if (!cid) continue;
      const titleEl = el.querySelector('.conversation-title, [data-test-id="conversation-title"]') || el;
      put(cid, titleEl.innerText || titleEl.textContent || '', cid === curCid);
    }

    return [...map.values()];
  }

  async function scrapeSidebarConversations(openTabItems = []) {
    let items = collectSidebarConversationItems();
    // 若侧边栏处于折叠状态导致列表未渲染，尝试展开侧边栏菜单读取
    if (items.length <= 1) {
      const menuBtn = document.querySelector(
        '[data-test-id="side-nav-menu-button"], button[aria-label*="主菜单"], button[aria-label*="Main menu"], button[aria-label*="菜单"], button[aria-label*="Menu"]'
      );
      if (menuBtn && isVisible(menuBtn)) {
        simulateClick(menuBtn);
        const waitEnd = Date.now() + 2400;
        while (Date.now() < waitEnd) {
          await new Promise((r) => setTimeout(r, 250));
          items = collectSidebarConversationItems();
          if (items.length > 1) break;
        }
      }
    }

    const merged = new Map();
    for (const it of [...(Array.isArray(openTabItems) ? openTabItems : []), ...items]) {
      if (!it?.chatId) continue;
      const prev = merged.get(it.chatId);
      if (!prev) {
        merged.set(it.chatId, it);
      } else {
        if ((!prev.title || /^Google Gemini$|^Gemini$/i.test(prev.title)) && it.title) prev.title = it.title;
        if (it.isOpenTab) prev.isOpenTab = true;
      }
    }
    return [...merged.values()].slice(0, 50);
  }

  function extractCleanUserQueryText(userNode) {
    if (!userNode) return '';
    const target = userNode.querySelector('.query-text, .user-query-text') || userNode;
    const clone = target.cloneNode(true);
    for (const junk of clone.querySelectorAll(
      '.cdk-visually-hidden, .visually-hidden, button, mat-icon, svg, script, style'
    )) {
      junk.remove();
    }
    return String(clone.innerText || clone.textContent || '')
      .replace(/^(?:你说|You said)\s*\r?\n+/i, '')
      .trim();
  }

  function findConversationScroller() {
    const explicit = document.querySelector(
      'infinite-scroller.chat-history, infinite-scroller, .chat-history-scroll-container, chat-window'
    );
    if (explicit && explicit.scrollHeight > explicit.clientHeight + 20) return explicit;
    let cur = document.querySelector('model-response, user-query')?.parentElement || null;
    while (cur && cur !== document.body) {
      if (cur.scrollHeight > cur.clientHeight + 20) return cur;
      cur = cur.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function collectTurnItemsFromDom() {
    const streamNodes = Array.from(document.querySelectorAll('user-query, model-response'));
    const items = [];
    for (const el of streamNodes) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'user-query') {
        const text = extractCleanUserQueryText(el);
        if (text) items.push({ el, role: 'user', userText: text });
      } else if (tag === 'model-response') {
        const thoughts = extractResponseThoughts(el);
        const assistantText = extractResponseMarkdown(el);
        if (assistantText || thoughts) items.push({ el, role: 'model', thoughts, assistantText });
      }
    }
    return items;
  }

  function pairStreamItemsIntoTurns(streamItems) {
    const rawTurns = [];
    let pendingUser = null;
    for (const item of streamItems) {
      if (item.role === 'user') {
        if (pendingUser !== null) {
          rawTurns.push({ userText: pendingUser, thoughts: '', assistantText: '' });
        }
        pendingUser = item.userText;
      } else if (item.role === 'model') {
        const thoughts = item.thoughts || '';
        const assistantText = item.assistantText || '';
        if (pendingUser !== null) {
          rawTurns.push({ userText: pendingUser, thoughts, assistantText });
          pendingUser = null;
        } else if (rawTurns.length > 0 && !rawTurns[rawTurns.length - 1].assistantText) {
          rawTurns[rawTurns.length - 1].thoughts = thoughts;
          rawTurns[rawTurns.length - 1].assistantText = assistantText;
        } else if (assistantText || thoughts) {
          rawTurns.push({ userText: '', thoughts, assistantText });
        }
      }
    }
    if (pendingUser !== null) {
      rawTurns.push({ userText: pendingUser, thoughts: '', assistantText: '' });
    }
    return rawTurns;
  }

  async function scrapeCurrentConversationTurns() {
    // 1. 等待页面历史气泡加载出来
    const waitEnd = Date.now() + 14000;
    while (Date.now() < waitEnd) {
      const hasTurns = document.querySelectorAll('user-query, model-response').length > 0;
      const loading = document.querySelector('mat-progress-bar, .loading-history-spinner');
      if (hasTurns && !loading) break;
      await new Promise((r) => setTimeout(r, 260));
    }
    await new Promise((r) => setTimeout(r, 400));

    // 2. 先持续滚到最顶部触发长对话历史懒加载，再从顶到底分段增量采集，防止虚拟列表卸载顶部节点
    const scroller = findConversationScroller();
    const collected = [];
    const seenEls = new WeakSet();
    const seenFingerprints = new Set();
    const itemFp = (it) => {
      const body = it.role === 'user' ? it.userText : `${it.thoughts || ''}||${it.assistantText || ''}`;
      const compact = String(body || '').replace(/\s+/g, ' ').trim();
      return `${it.role}:${compact.length}:${compact.slice(0, 120)}:${compact.slice(-80)}`;
    };
    const mergeWindowItems = (windowItems) => {
      for (const it of windowItems) {
        if (it.el && seenEls.has(it.el)) continue;
        const fp = itemFp(it);
        if (seenFingerprints.has(fp)) {
          if (it.el) seenEls.add(it.el);
          continue;
        }
        if (it.el) seenEls.add(it.el);
        seenFingerprints.add(fp);
        collected.push(it);
      }
    };

    if (scroller) {
      let stableTopRounds = 0;
      for (let i = 0; i < 16; i++) {
        const beforeCount = document.querySelectorAll('user-query, model-response').length;
        const beforeHeight = scroller.scrollHeight;
        scroller.scrollTop = 0;
        await new Promise((r) => setTimeout(r, 450));
        const loading = document.querySelector('mat-progress-bar, .loading-history-spinner');
        if (loading) {
          await new Promise((r) => setTimeout(r, 450));
        }
        const afterCount = document.querySelectorAll('user-query, model-response').length;
        const afterHeight = scroller.scrollHeight;
        if (afterCount === beforeCount && afterHeight === beforeHeight && scroller.scrollTop <= 10) {
          stableTopRounds++;
          if (stableTopRounds >= 2) break;
        } else {
          stableTopRounds = 0;
        }
      }

      // 从顶部逐步向下扫描，每一步采集当前 DOM 气泡
      const stepPx = Math.max(360, Math.floor((scroller.clientHeight || 700) * 0.75));
      scroller.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 200));
      mergeWindowItems(collectTurnItemsFromDom());

      for (let step = 0; step < 40; step++) {
        const maxTop = Math.max(0, scroller.scrollHeight - (scroller.clientHeight || 0));
        if (scroller.scrollTop >= maxTop - 16) break;
        const nextTop = Math.min(maxTop, scroller.scrollTop + stepPx);
        scroller.scrollTop = nextTop;
        await new Promise((r) => setTimeout(r, 140));
        mergeWindowItems(collectTurnItemsFromDom());
        if (nextTop >= maxTop - 16) break;
      }

      // 确保末尾最新节点全部采集到
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise((r) => setTimeout(r, 240));
      mergeWindowItems(collectTurnItemsFromDom());
    } else {
      mergeWindowItems(collectTurnItemsFromDom());
    }

    // 3. 若当前完整 DOM 中气泡数不少于分段采集数，优先采用完整 DOM 顺序避免重复文本去重误删
    const finalDomItems = collectTurnItemsFromDom();
    const effectiveItems = finalDomItems.length >= collected.length ? finalDomItems : collected;
    const rawTurns = pairStreamItemsIntoTurns(effectiveItems);

    const url = await waitForConversationUrl(800);
    const cid = extractChatIdFromHref(url);
    const sidebarItems = collectSidebarConversationItems();
    const matchedSidebar = cid ? sidebarItems.find((x) => x.chatId === cid) : null;
    const rawDocTitle = String(document.title || '')
      .replace(/^\s*Google\s+Gemini\s*[-–—·|]\s*/i, '')
      .replace(/\s*[-–—·|]\s*Google\s+Gemini\s*$/i, '')
      .replace(/^Gemini\s*$/i, '')
      .trim();

    return {
      webChatUrl: url,
      chatId: cid,
      title: matchedSidebar?.title || rawDocTitle || '',
      modelLabel: getWebModelCurrentLabel(),
      turns: rawTurns,
    };
  }

  const executedCommandKeys = new Set();
  async function handleIncomingWebBrainCommand(cmd) {
    if (!cmd) return;
    const cmdKey = `${cmd.requestId || cmd.opId || ''}:${cmd.step || 0}:${cmd.retryAttempt || 0}`;
    if (cmd.requestId && executedCommandKeys.has(cmdKey) && cmd.action === 'send') return;
    if (cmd.requestId && cmd.action === 'send') executedCommandKeys.add(cmdKey);

    if (cmd.action === 'list_conversations') {
      statusEl.textContent = '📚 正在读取网页端历史对话列表...';
      try {
        const list = await scrapeSidebarConversations(cmd.openTabItems || []);
        statusEl.textContent = `✅ 已读取 ${list.length} 条网页对话列表`;
        await reportWithRetry({ opId: cmd.opId, webConversationsList: list }, 2);
      } catch (e) {
        await reportWithRetry({ opId: cmd.opId, webConversationsList: [], error: e.message || String(e) }, 2);
      }
      return;
    }

    if (cmd.action === 'fetch_conversation') {
      statusEl.textContent = '📥 正在拉取当前网页对话完整记录到本地...';
      dotEl.style.background = '#38bdf8';
      try {
        const conv = await scrapeCurrentConversationTurns();
        statusEl.textContent = cmd.closeAfter !== false
          ? `✅ 已拉取 ${conv.turns.length} 轮对话记录，正在关闭窗口...`
          : `✅ 已拉取 ${conv.turns.length} 轮对话记录到本地`;
        dotEl.style.background = '#22c55e';
        await reportWithRetry({ opId: cmd.opId, fetchedConversation: conv }, 3);
      } catch (e) {
        statusEl.textContent = `❌ 拉取失败: ${e.message}`;
        await reportWithRetry({ opId: cmd.opId, error: e.message || String(e) }, 2);
      }
      return;
    }

    if (cmd.action === 'cancel') {
      if (cmd.requestId && activeWatchState && activeWatchState.reqId !== cmd.requestId) {
        return;
      }
      const stopBtn = findStopButton();
      if (stopBtn) simulateClick(stopBtn);
      activeWatchState = null;
      statusEl.textContent = '⏹️ 已响应 VS Code 停止生成';
      return;
    }

    if (cmd.action === 'set_model') {
      const isDiscoverOnly = Boolean(cmd.discover) && !cmd.webModel && !cmd.webEffort;
      statusEl.textContent = isDiscoverOnly
        ? '🔍 正在同步网页端可用模型列表...'
        : `🔄 正在切换网页端模型 (${cmd.webModel || '当前'} · ${cmd.webEffort || ''})...`;
      const info = await applyWebModelAndEffort(cmd.webModel, cmd.webEffort, Boolean(cmd.discover));
      if (info.currentLabel) webModelEl.textContent = `[${info.currentLabel}]`;
      statusEl.textContent = isDiscoverOnly
        ? `✅ 已同步 ${info.availableModels.length} 个网页端模型`
        : `✅ 网页模型已切为: ${info.currentLabel || '默认'}`;
      dotEl.style.background = '#22c55e';
      try {
        keepalivePort?.postMessage({ modelLabel: info.currentLabel });
      } catch (_) {}
      await reportWithRetry(
        {
          ...(cmd.opId ? { opId: cmd.opId } : {}),
          currentModelLabel: info.currentLabel,
          availableModels: info.availableModels,
        },
        2
      );
      return;
    }

    if (cmd.action === 'send' && cmd.requestId) {
      isManagedByBridge = true;
      const reqId = cmd.requestId;
      const step = typeof cmd.step === 'number' ? cmd.step : 0;
      // 先确认收到，服务端据此判断「浏览器接到了任务」，否则 45s 后会重新派发
      bridgeRequest('POST', '/browser/report', { requestId: reqId, step, status: 'accepted' }).catch(() => {});

      // 上一条回复还在生成或深度思考时先等它结束，避免把新消息塞进正在流式/思考中的输入框
      const busyEnd = Date.now() + 90000;
      while ((isGeminiWebStreaming() || isGeminiThinking(-1)) && Date.now() < busyEnd) {
        await new Promise((r) => setTimeout(r, 500));
      }

      let waitEditorTries = 0;
      while (!findGeminiEditor() && waitEditorTries < 40) {
        waitEditorTries++;
        await new Promise((r) => setTimeout(r, 250));
      }

      if (cmd.webModel || cmd.webEffort) {
        const info = await applyWebModelAndEffort(cmd.webModel, cmd.webEffort, false);
        if (info.currentLabel) webModelEl.textContent = `[${info.currentLabel}]`;
      }

      const baselineNodes = getModelResponseNodes();
      const baselineCount = baselineNodes.length;
      const baselineLastText =
        baselineCount > 0 ? extractResponseMarkdown(baselineNodes[baselineCount - 1]) : '';
      const baselineChatId = extractChatIdFromHref(window.location.href);
      const baselineSidebarChatId = baselineChatId ? '' : getSelectedSidebarChatId();

      activeWatchState = {
        reqId,
        step,
        cmdKey,
        prompt: String(cmd.prompt || ''),
        resendTried: false,
        baselineCount,
        baselineLastText,
        baselineChatId,
        baselineSidebarChatId,
        hasStarted: false,
        lastReportedText: '',
        lastReportedThoughts: '',
        bestText: '',
        stableTicks: 0,
        startedAt: Date.now(),
        lastChangeAt: 0,
        lastHeartbeatAt: 0,
        baselineUserCount: countUserQueries(),
        sent: false,
      };

      statusEl.textContent = `🌐 正在当前绑定窗口连续对话...`;
      dotEl.style.background = '#38bdf8';

      const ok = await sendTextToGeminiWeb(cmd.prompt, cmd.images || []);
      if (!ok) {
        activeWatchState = null;
        reportWithRetry({
          requestId: reqId,
          step,
          status: 'error',
          error: '未找到 Gemini 网页输入框，请确认页面已登录',
        });
      }
    }
  }

  function getPageActivityState() {
    const streaming = isGeminiWebStreaming();
    const thinking = isGeminiThinking(-1);
    const userCount = countUserQueries();
    const responseCount = getModelResponseNodes().length;
    const editor = findGeminiEditor();
    const draftLen = editor ? getEditorPlainText(editor).length : 0;
    const hasConversation =
      userCount > 0 ||
      responseCount > 0 ||
      Boolean(extractChatIdFromHref(window.location.href));
    return {
      streaming,
      thinking,
      pendingReply: userCount > responseCount,
      hasConversation,
      hasDraft: draftLen > 0,
      userCount,
      responseCount,
    };
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!document.body.contains(box)) {
        contentStateHandle.alive = false;
        return false;
      }
      if (msg?.type === 'EXEC_WEB_COMMAND' && msg.command) {
        if (msg.command.action === 'send' || msg.command.action === 'set_model') {
          isManagedByBridge = true;
        }
        handleIncomingWebBrainCommand(msg.command);
        sendResponse({ ok: true });
        return false;
      }
      if (msg?.type === 'WEB_TICK') {
        if (typeof msg.managed === 'boolean') {
          isManagedByBridge = msg.managed;
        }
        const curLabel = getWebModelCurrentLabel();
        if (curLabel) webModelEl.textContent = `[${curLabel}]`;
        if (activeWatchState) stepActiveWatch();
        const activity = getPageActivityState();
        sendResponse({
          ok: true,
          modelLabel: curLabel,
          watching: Boolean(activeWatchState),
          sent: Boolean(
            activeWatchState?.sent ||
              (activeWatchState && getModelResponseNodes().length > activeWatchState.baselineCount)
          ),
          reqId: activeWatchState?.reqId || '',
          streaming: activity.streaming,
          thinking: activity.thinking,
          pendingReply: activity.pendingReply,
          hasConversation: activity.hasConversation,
          hasDraft: activity.hasDraft,
        });
        return false;
      }
      return false;
    });
  }

  async function executePromptOnLocal(taskText) {
    if (!taskText || isBridgeBusy || activeWatchState) return;
    isBridgeBusy = true;
    dotEl.style.background = '#eab308';
    statusEl.textContent = `⏳ 本地执行中 (${localEngine === 'local-tool' ? '0额度工具' : 'AGY'}): ${taskText.slice(0, 50)}...`;

    try {
      const res = await bridgeRequest('POST', '/ask', {
        prompt: taskText,
        engine: localEngine,
      });
      dotEl.style.background = '#22c55e';

      const toolSummary =
        Array.isArray(res.tools) && res.tools.length
          ? `（已执行 ${res.tools.length} 个工具: ${res.tools.map((t) => t.name || t.tool).join(', ')}）`
          : '';
      statusEl.textContent = `✅ 本地执行完成 ${toolSummary}，已回填网页`;

      const replyMsg = [
        `[Local Tool Results] ${toolSummary}`,
        '```text',
        String(res.reply || '').slice(0, 16000),
        '```',
        '请根据以上真实结果继续下一步；若已完成全部任务，请直接给出最终回答（不要再输出 local-tool 块）。',
      ].join('\n');
      await sendTextToGeminiWeb(replyMsg);
    } catch (err) {
      dotEl.style.background = '#ef4444';
      statusEl.textContent = `❌ 失败: ${err.message}`;
    } finally {
      isBridgeBusy = false;
    }
  }

  box.querySelector('#agwb-btn-boot').onclick = async () => {
    try {
      const res = await bridgeRequest('GET', '/protocol');
      await sendTextToGeminiWeb(res?.protocol || BOOT_PROMPT);
    } catch (_) {
      await sendTextToGeminiWeb(BOOT_PROMPT);
    }
  };
  box.querySelector('#agwb-btn-run').onclick = () => {
    const task = extractLatestAgentTask();
    if (!task) return alert('当前页面未找到 json:local-tool 或 # @local-agent 代码块');
    lastExecutedHash = task;
    executePromptOnLocal(task);
  };
  box.querySelector('#agwb-btn-sel').onclick = () => {
    const sel = String(window.getSelection() || '').trim();
    if (!sel) return alert('请先在网页上用鼠标选中一段文字');
    executePromptOnLocal(sel);
  };
  box.querySelector('#agwb-btn-stop').onclick = async () => {
    try {
      const stopBtn = findStopButton();
      if (stopBtn) simulateClick(stopBtn);
      activeWatchState = null;
      await bridgeRequest('POST', '/cancel', {});
      statusEl.textContent = '⏹️ 已发送停止指令';
    } catch (e) {
      statusEl.textContent = `❌ ${e.message}`;
    }
  };

  // ─── 读取 gemini.google.com/usage（设置 → 用量限额）页面文字：纯 DOM 只读 ───
  // 页面结构（中文）：「ULTRA 方案的用量限额… 当前用量 已使用 1% 重置时间：12:29 每周限额 重置时间：11月23日15:29 已使用 0%」
  // 进度条不是 role=progressbar（侧栏的加载圈才是），所以按「标题分段 + 段内文字」解析
  const USAGE_SECTIONS = [
    { window: '5h', re: /当前用量|current usage|5\s*小时|5[-\s]hour/i },
    { window: 'weekly', re: /每周限额|每周用量|weekly limit|weekly usage/i },
  ];
  let lastPathname = location.pathname;
  let usageScrapeTimer = null;

  function isUsagePage() {
    return /^\/usage\b/.test(location.pathname);
  }

  function scrapeUsageLimitsPage() {
    const root = document.querySelector('main') || document.body;
    const text = (root.innerText || root.textContent || '').replace(/\s+/g, ' ');
    const marks = [];
    for (const s of USAGE_SECTIONS) {
      const m = s.re.exec(text);
      if (m) marks.push({ window: s.window, idx: m.index });
    }
    marks.sort((a, b) => a.idx - b.idx);
    const tier = (text.match(/\b(ULTRA|PRO|PLUS|FREE)\s*方案|\b(Ultra|Pro|Plus|Free)\s+plan/i) || [])
      .slice(1)
      .find(Boolean) || '';

    const buckets = [];
    marks.forEach((mk, i) => {
      const seg = text.slice(mk.idx, i + 1 < marks.length ? marks[i + 1].idx : mk.idx + 200);
      let usedPct = null;
      let m = seg.match(/(?:已使用|已用|used)\s*(\d{1,3}(?:\.\d+)?)\s*%/i) ||
        seg.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:已使用|已用|used)/i);
      if (m) usedPct = Number(m[1]);
      else {
        m = seg.match(/(?:剩余|还剩|remaining|left)\s*(\d{1,3}(?:\.\d+)?)\s*%/i) ||
          seg.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:剩余|remaining|left)/i);
        if (m) usedPct = 100 - Number(m[1]);
      }
      if (usedPct === null) return;
      const r = seg.match(/重置时间\s*[:：]\s*(\S+)/) ||
        seg.match(/resets?\s*(?:at|on|in)?\s*[:：]?\s*(.{1,30}?)(?=\s+(?:used|\d{1,3}\s*%|weekly|current)|$)/i);
      buckets.push({
        window: mk.window,
        usedPct: Math.max(0, Math.min(100, usedPct)),
        resetText: r ? `Resets ${r[1].trim()}` : '',
        tier: tier.toUpperCase(),
        raw: seg.slice(0, 160).trim(),
      });
    });
    return buckets;
  }

  function startUsageScrape() {
    if (usageScrapeTimer) clearInterval(usageScrapeTimer);
    const startedAt = Date.now();
    let lastSig = '';
    let stable = 0;
    usageScrapeTimer = setInterval(() => {
      if (!isUsagePage()) {
        clearInterval(usageScrapeTimer);
        usageScrapeTimer = null;
        return;
      }
      const buckets = scrapeUsageLimitsPage();
      const sig = JSON.stringify(buckets.map((b) => [b.window, b.usedPct]));
      if (buckets.length && sig === lastSig) stable++;
      else stable = 0;
      lastSig = sig;
      const timedOut = Date.now() - startedAt > 20000;
      const enough = buckets.length >= 2 || (buckets.length && Date.now() - startedAt > 8000);
      if ((enough && stable >= 2) || timedOut) {
        clearInterval(usageScrapeTimer);
        usageScrapeTimer = null;
        const mainText = (document.querySelector('main') || document.body).innerText || '';
        statusEl.textContent = buckets.length
          ? `📊 已读取网页用量 (${buckets.map((b) => `${b.window} ${b.usedPct}%`).join(' · ')})`
          : '⚠ 未能在用量页解析到进度条';
        bridgeRequest('POST', '/browser/report', {
          webQuota: {
            parser: 2,
            buckets,
            error: buckets.length ? '' : 'Could not parse 当前用量 / 每周限额 on gemini.google.com/usage',
            rawText: buckets.length ? '' : mainText.replace(/\s+/g, ' ').slice(0, 800),
          },
        }).catch(() => {});
      }
    }, 700);
  }

  if (isUsagePage()) startUsageScrape();

  // 仅由插件创建的受管 Gemini 页签才在空闲时静默抓取可用模型列表；用户手动打开的新窗口绝不自动点开模型菜单
  let initialModelsDiscovered = false;
  setTimeout(async () => {
    if (
      initialModelsDiscovered ||
      !isManagedByBridge ||
      isUsagePage() ||
      isBridgeBusy ||
      activeWatchState ||
      isGeminiWebStreaming() ||
      isGeminiThinking(-1)
    ) {
      return;
    }
    if (!findWebModelSwitcherBtn()) return;
    initialModelsDiscovered = true;
    try {
      const info = await applyWebModelAndEffort('', '', true);
      if (info.currentLabel) webModelEl.textContent = `[${info.currentLabel}]`;
      if (info.availableModels?.length || info.currentLabel) {
        bridgeRequest('POST', '/browser/report', {
          currentModelLabel: info.currentLabel,
          availableModels: info.availableModels,
        }).catch(() => {});
      }
    } catch (_) {}
  }, 2600);

  const fastTimer = setInterval(() => {
    if (!document.body.contains(box)) {
      contentStateHandle.alive = false;
      clearInterval(fastTimer);
      return;
    }
    if (activeWatchState) stepActiveWatch();
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      if (isUsagePage()) startUsageScrape();
    }
  }, 280);

  const statusTimer = setInterval(async () => {
    if (!document.body.contains(box)) {
      contentStateHandle.alive = false;
      clearInterval(statusTimer);
      return;
    }
    ensureKeepalivePort();
    const curLabel = getWebModelCurrentLabel();
    if (curLabel) {
      webModelEl.textContent = `[${curLabel}]`;
      if (isManagedByBridge) {
        try {
          keepalivePort?.postMessage({ modelLabel: curLabel });
        } catch (_) {}
      }
    }
    try {
      const st = await bridgeRequest('GET', '/status');
      if (st.busy) {
        dotEl.style.background = '#eab308';
        const lastTool = st.tools?.length ? st.tools[st.tools.length - 1] : null;
        const toolStr = lastTool ? `🔧 ${lastTool.title || lastTool.name}` : '思考中...';
        statusEl.textContent = `⏳ 执行中 (${st.elapsedSec}s) | ${toolStr}`;
        return;
      } else if (!isBridgeBusy && !activeWatchState) {
        dotEl.style.background = '#22c55e';
        if (
          statusEl.textContent.startsWith('正在连接') ||
          statusEl.textContent.startsWith('❌')
        ) {
          statusEl.textContent = `🟢 双向就绪 (${st.cwd})`;
        }
      }
    } catch {
      dotEl.style.background = '#ef4444';
      if (!isBridgeBusy) {
        statusEl.textContent = '❌ 未连接本地 127.0.0.1:18765 (请运行 start-bridge.ps1)';
      }
      return;
    }

    if (!autoLoop || isBridgeBusy || activeWatchState || isGeminiWebStreaming()) return;
    const candidate = extractLatestAgentTask();
    if (!candidate || candidate === lastExecutedHash) return;

    if (candidate !== stableCandidateHash) {
      stableCandidateHash = candidate;
      stableCandidateSince = Date.now();
      return;
    }
    if (Date.now() - stableCandidateSince >= 1500) {
      lastExecutedHash = candidate;
      executePromptOnLocal(candidate);
    }
  }, 1500);
})();
