// Background Service Worker (v2.6.8):
// 1. 严格隔离用户手动窗口 + 零残留受管窗口：绝不征用/跳转/关闭用户手动打开的 Gemini 页签，仅复用真实空闲的插件受管页签
// 2. 串行路由 + 实时探活：单飞指令队列防并发抢占，派发前实时探测 streaming/thinking/pendingReply/hasConversation，后台 WEB_TICK 驱动不抢焦点
// 3. 单会话精准中断：停止指令严格按 sessionId / webChatUrl 路由到对应标签页，绝不连带中断其它会话
// 4. 双向同步与 MV3 零页签常驻保活

const BRIDGE_BASE = 'http://127.0.0.1:18765';
let cachedModelLabel = '';
let isPolling = false;
let lastKeepaliveApiAt = 0;
let lastTabRotateAt = 0;
let rotateCursor = 0;
let commandChain = Promise.resolve();

const sessionTabs = new Map(); // sessionId -> tabId
const tabSessions = new Map(); // tabId -> sessionId
const managedTabIds = new Set(); // 仅由桥接器创建并接管的 tabId（允许复用与自动关闭）
const reservedTabIds = new Set(); // 正在路由/导航/派发中的预占 tabId，防止并发指令抢占同一页签
const tempOpTabs = new Map(); // opId -> { tabId, closeAfter: boolean }
const tabLastDispatchedAt = new Map(); // tabId -> timestamp（防止刚派发新任务就被上一轮延迟关掉）
const tabWatchingMap = new Map(); // tabId -> { watching, sent, reqId, streaming, thinking, pendingReply, hasConversation, hasDraft, updatedAt }
let serverActiveSessions = new Set(); // 服务端当前处于 queued / dispatched / streaming 的 sessionId 集合
let mapLoadedPromise = null;

function loadPersistedSessionMap() {
  if (mapLoadedPromise) return mapLoadedPromise;
  mapLoadedPromise = new Promise((resolve) => {
    if (!chrome.storage?.local) return resolve();
    chrome.storage.local.get(['agwb_session_tabs', 'agwb_managed_tabs'], (res) => {
      const hasManagedList = Array.isArray(res?.agwb_managed_tabs);
      if (hasManagedList) {
        for (const tid of res.agwb_managed_tabs) {
          if (Number(tid)) managedTabIds.add(Number(tid));
        }
      }
      const obj = res?.agwb_session_tabs;
      if (obj && typeof obj === 'object') {
        for (const [sid, tid] of Object.entries(obj)) {
          const numTid = Number(tid);
          if (sid && numTid) {
            sessionTabs.set(sid, numTid);
            tabSessions.set(numTid, sid);
            if (!hasManagedList) managedTabIds.add(numTid);
          }
        }
      }
      resolve();
    });
  });
  return mapLoadedPromise;
}

function savePersistedSessionMap() {
  if (!chrome.storage?.local) return;
  const obj = {};
  for (const [sid, tid] of sessionTabs.entries()) {
    obj[sid] = tid;
  }
  chrome.storage.local.set({
    agwb_session_tabs: obj,
    agwb_managed_tabs: [...managedTabIds].slice(-50),
  });
}

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  await loadPersistedSessionMap();
  const sid = tabSessions.get(tabId);
  if (sid) sessionTabs.delete(sid);
  tabSessions.delete(tabId);
  managedTabIds.delete(tabId);
  reservedTabIds.delete(tabId);
  tabLastDispatchedAt.delete(tabId);
  tabWatchingMap.delete(tabId);
  savePersistedSessionMap();
  if (sid) {
    fetch(`${BRIDGE_BASE}/browser/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabClosed: true, sessionId: sid }),
    }).catch(() => {});
  }
});

function ensureLocalhostBypassedInProxy() {
  if (!chrome.proxy?.settings) return;
  try {
    chrome.proxy.settings.get({ incognito: false }, (details) => {
      if (!details || !details.value) return;
      const val = details.value;

      if (val.mode === 'pac_script' && val.pacScript?.data) {
        const pac = String(val.pacScript.data);
        if (!pac.includes('127.0.0.1')) {
          const patchedPac = pac.replace(
            /function\s+FindProxyForURL\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*\{/,
            'function FindProxyForURL($1, $2) {\n  if ($2 === "127.0.0.1" || $2 === "localhost" || $2 === "::1" || isPlainHostName($2)) return "DIRECT";'
          );
          if (patchedPac !== pac) {
            chrome.proxy.settings.set({
              value: { mode: 'pac_script', pacScript: { data: patchedPac } },
              scope: 'regular',
            });
          }
        }
      }

      if (val.mode === 'fixed_servers' && val.rules) {
        const list = Array.isArray(val.rules.bypassList) ? [...val.rules.bypassList] : [];
        let changed = false;
        for (const h of ['127.0.0.1', 'localhost', '<local>']) {
          if (!list.includes(h)) {
            list.push(h);
            changed = true;
          }
        }
        if (changed) {
          chrome.proxy.settings.set({
            value: {
              mode: 'fixed_servers',
              rules: { ...val.rules, bypassList: list },
            },
            scope: 'regular',
          });
        }
      }
    });
  } catch (_) {}
}

function queryGeminiTabs() {
  return new Promise((resolve) => {
    if (!chrome.tabs) return resolve([]);
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => resolve(tabs || []));
  });
}

function queryAllBrowserTabs() {
  return new Promise((resolve) => {
    if (!chrome.tabs) return resolve([]);
    chrome.tabs.query({}, (tabs) => resolve(tabs || []));
  });
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    if (!chrome.tabs || !tabId) return resolve(null);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) resolve(null);
      else resolve(tab);
    });
  });
}

/**
 * 安全关闭指定的网页标签页：
 * 如果该标签页是整个 Chrome 浏览器的唯一标签页，先在后台建一个新空白页再关闭它，防止误退出整个浏览器进程。
 */
async function safeCloseTab(tabId) {
  if (!chrome.tabs || !tabId) return false;
  await loadPersistedSessionMap();
  const target = await getTabById(tabId);
  if (!target) {
    const sid = tabSessions.get(tabId);
    if (sid) sessionTabs.delete(sid);
    tabSessions.delete(tabId);
    managedTabIds.delete(tabId);
    savePersistedSessionMap();
    return false;
  }

  const allTabs = await queryAllBrowserTabs();
  if (allTabs.length <= 1) {
    await new Promise((resolve) => {
      chrome.tabs.create({ url: 'chrome://newtab/', active: false }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  const sid = tabSessions.get(tabId);
  if (sid) sessionTabs.delete(sid);
  tabSessions.delete(tabId);
  managedTabIds.delete(tabId);
  reservedTabIds.delete(tabId);
  tabLastDispatchedAt.delete(tabId);
  tabWatchingMap.delete(tabId);
  savePersistedSessionMap();

  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      void chrome.runtime.lastError;
      resolve(true);
    });
  });
}

function isManagedTab(tabId) {
  return Boolean(tabId && managedTabIds.has(tabId));
}

function isBridgeOwnedTab(tabId) {
  return Boolean(tabId && (managedTabIds.has(tabId) || tabSessions.has(tabId)));
}

function probeTabState(tabId, timeoutMs = 420) {
  return new Promise((resolve) => {
    if (!chrome.tabs || !tabId) return resolve(null);
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: 'WEB_TICK', managed: isBridgeOwnedTab(tabId) },
        (tickRes) => {
          if (chrome.runtime.lastError || !tickRes) {
            finish(null);
            return;
          }
          const st = {
            watching: Boolean(tickRes.watching),
            sent: Boolean(tickRes.sent),
            reqId: tickRes.reqId || '',
            streaming: Boolean(tickRes.streaming),
            thinking: Boolean(tickRes.thinking),
            pendingReply: Boolean(tickRes.pendingReply),
            hasConversation: Boolean(tickRes.hasConversation),
            hasDraft: Boolean(tickRes.hasDraft),
            modelLabel: tickRes.modelLabel || '',
            updatedAt: Date.now(),
          };
          tabWatchingMap.set(tabId, st);
          if (st.modelLabel && isBridgeOwnedTab(tabId)) {
            cachedModelLabel = st.modelLabel;
          }
          finish(st);
        }
      );
    } catch (_) {
      finish(null);
    }
  });
}

function isTabLiveActive(state) {
  return Boolean(state && (state.watching || state.streaming || state.thinking || state.pendingReply));
}

function isTabBusy(tabId, ignoreSessionId = '') {
  if (!tabId) return false;
  if (reservedTabIds.has(tabId)) return true;
  const boundSid = tabSessions.get(tabId);
  if (boundSid && boundSid !== ignoreSessionId && serverActiveSessions.has(boundSid)) return true;
  const w = tabWatchingMap.get(tabId);
  if (isTabLiveActive(w)) return true;
  const recentDispatch = tabLastDispatchedAt.get(tabId) || 0;
  if (Date.now() - recentDispatch < 12000 && (!ignoreSessionId || boundSid !== ignoreSessionId)) return true;
  return false;
}

function isUserViewingUnmanagedGeminiTab(tabs) {
  return (tabs || []).some((t) => t?.id && t.active && !isBridgeOwnedTab(t.id));
}

async function findReusableManagedTab(allTabs, ignoreSessionId = '', { requireBlank = false } = {}) {
  for (const t of allTabs || []) {
    if (!t?.id) continue;
    if (!isManagedTab(t.id)) continue;
    if (tabSessions.has(t.id) || reservedTabIds.has(t.id)) continue;
    if (requireBlank && !isBlankNewChatUrl(t.url)) continue;
    if (t.status && t.status !== 'complete') continue;
    if (isTabBusy(t.id, ignoreSessionId)) continue;
    const live = await probeTabState(t.id, 420);
    if (live) {
      if (isTabLiveActive(live) || live.hasDraft) continue;
      if (requireBlank && live.hasConversation) continue;
    } else if (isTabBusy(t.id, ignoreSessionId)) {
      continue;
    }
    return t;
  }
  return null;
}

/** 关闭除 keepSessionId / keepTabId 及所有活跃任务会话之外的空闲残留受管页签，绝不误关正在运行的会话或用户手动窗口 */
async function closeOtherSessionTabs(keepSessionId = '', keepTabId = 0) {
  await loadPersistedSessionMap();
  const toClose = [];
  for (const [sid, tid] of sessionTabs.entries()) {
    if (
      sid !== keepSessionId &&
      tid !== keepTabId &&
      isManagedTab(tid) &&
      !serverActiveSessions.has(sid) &&
      !isTabBusy(tid, keepSessionId)
    ) {
      const live = await probeTabState(tid, 350);
      if (isTabLiveActive(live)) continue;
      toClose.push(tid);
    }
  }
  for (const tid of toClose) {
    await safeCloseTab(tid);
  }
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      const tab = await getTabById(tabId);
      if (!tab) return resolve(null);
      if (tab.status === 'complete') {
        setTimeout(() => resolve(tab), 800);
        return;
      }
      if (Date.now() - start >= timeoutMs) return resolve(tab);
      setTimeout(check, 250);
    };
    check();
  });
}

function createGeminiTab(url = 'https://gemini.google.com/app', active = true) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active }, async (tab) => {
      if (chrome.runtime.lastError || !tab?.id) return resolve(null);
      managedTabIds.add(tab.id);
      savePersistedSessionMap();
      const readyTab = await waitForTabComplete(tab.id);
      resolve(readyTab || tab);
    });
  });
}

function navigateGeminiTab(tabId, url, active = true) {
  return new Promise((resolve) => {
    managedTabIds.add(tabId);
    savePersistedSessionMap();
    chrome.tabs.update(tabId, { url, active }, async (tab) => {
      if (chrome.runtime.lastError || !tab?.id) return resolve(null);
      const readyTab = await waitForTabComplete(tab.id);
      resolve(readyTab || tab);
    });
  });
}

function isBlankNewChatUrl(url) {
  if (!url) return false;
  return /^https:\/\/gemini\.google\.com\/app\/?(?:\?.*)?$/i.test(String(url).trim());
}

function extractChatIdFromUrl(url) {
  if (!url) return '';
  return String(url).match(/\/app\/([a-zA-Z0-9_-]{8,})/)?.[1] || '';
}

function bindSessionToTab(sessionId, tabId, markManaged = true) {
  if (!sessionId || !tabId) return;
  const oldTabId = sessionTabs.get(sessionId);
  if (oldTabId && oldTabId !== tabId) tabSessions.delete(oldTabId);
  const prevSid = tabSessions.get(tabId);
  if (prevSid && prevSid !== sessionId) sessionTabs.delete(prevSid);
  sessionTabs.set(sessionId, tabId);
  tabSessions.set(tabId, sessionId);
  if (markManaged) managedTabIds.add(tabId);
  savePersistedSessionMap();
}

async function resolveTargetTabForCommand(cmd) {
  await loadPersistedSessionMap();

  const sid = cmd?.sessionId || '';
  const targetChatUrl =
    cmd?.webChatUrl && /^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]+/i.test(cmd.webChatUrl)
      ? cmd.webChatUrl
      : '';
  const isNewChat = Boolean(cmd?.newChat);
  const allowAutoClose = cmd?.autoCloseTab !== false;

  if (cmd?.action === 'cancel') {
    if (sid && sessionTabs.has(sid)) {
      const t = await getTabById(sessionTabs.get(sid));
      if (t) return t;
    }
    const cancelCid = extractChatIdFromUrl(targetChatUrl);
    if (cancelCid) {
      const tabs = await queryGeminiTabs();
      const matched = tabs.find((t) => t.url && t.url.includes(`/app/${cancelCid}`));
      if (matched) return matched;
    }
    // 找不到该会话对应的专属标签页时直接忽略，绝不回退去点其它活跃会话页签的停止按钮！
    return null;
  }

  const allTabs = await queryGeminiTabs();
  const preserveUserFocus = isUserViewingUnmanagedGeminiTab(allTabs);

  if (cmd?.action !== 'send') {
    // 非 send 辅助指令（如 set_model）仅使用空闲的插件受管页签，严禁干扰用户手动打开的 Gemini 窗口
    if (sid && sessionTabs.has(sid)) {
      const t = await getTabById(sessionTabs.get(sid));
      if (t && isBridgeOwnedTab(t.id) && !isTabBusy(t.id, sid)) {
        const live = await probeTabState(t.id, 400);
        if (!isTabLiveActive(live)) return t;
      }
    }
    const managedAppTabs = allTabs.filter(
      (t) =>
        t.id &&
        isBridgeOwnedTab(t.id) &&
        t.url &&
        /^https:\/\/gemini\.google\.com\/app\b/i.test(t.url) &&
        !isTabBusy(t.id, sid)
    );
    for (const cand of [...managedAppTabs.filter((t) => t.active), ...managedAppTabs.filter((t) => !t.active)]) {
      const live = await probeTabState(cand.id, 400);
      if (!isTabLiveActive(live)) return cand;
    }
    if (cmd?.action === 'set_model') {
      // 没有空闲受管页签且需要显式发现模型列表（discover）时，后台临时打开一个受管页签抓取后自动关闭，绝不打扰用户手动页签
      if (cmd?.discover) {
        const tempTab = await createGeminiTab('https://gemini.google.com/app', false);
        if (tempTab?.id && cmd?.opId) {
          tempOpTabs.set(cmd.opId, { tabId: tempTab.id, closeAfter: true });
          setTimeout(() => {
            const entry = tempOpTabs.get(cmd.opId);
            if (entry) {
              tempOpTabs.delete(cmd.opId);
              if (entry.closeAfter) safeCloseTab(entry.tabId);
            }
          }, 15000);
        }
        return tempTab;
      }
      if (cmd?.opId) {
        fetch(`${BRIDGE_BASE}/browser/report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ opId: cmd.opId, error: '当前受管 Gemini 页签正忙，稍后自动同步' }),
        }).catch(() => {});
      }
      return null;
    }
    return await createGeminiTab('https://gemini.google.com/app', !preserveUserFocus);
  }

  // 1. 该 VS Code 对话栏已绑定过存活的浏览器标签页 -> 复用该标签页（若用户正在看自己手动开的 Gemini 页签则不抢焦点）
  if (sid && sessionTabs.has(sid)) {
    const boundTab = await getTabById(sessionTabs.get(sid));
    if (boundTab) {
      reservedTabIds.add(boundTab.id);
      try {
        if (allowAutoClose) await closeOtherSessionTabs(sid, boundTab.id);
        if (isNewChat && !isBlankNewChatUrl(boundTab.url)) {
          return await navigateGeminiTab(boundTab.id, 'https://gemini.google.com/app', !preserveUserFocus);
        }
        // 如果命令指定了历史 webChatUrl 而当前绑定页签不是同一个 chatId，跳回对应历史聊天
        const targetCid = extractChatIdFromUrl(targetChatUrl);
        const curCid = extractChatIdFromUrl(boundTab.url);
        if (!isNewChat && targetCid && curCid !== targetCid) {
          return await navigateGeminiTab(boundTab.id, targetChatUrl, !preserveUserFocus);
        }
        if (!preserveUserFocus) {
          try {
            chrome.tabs.update(boundTab.id, { active: true });
          } catch (_) {}
        }
        return boundTab;
      } finally {
        reservedTabIds.delete(boundTab.id);
      }
    }
    sessionTabs.delete(sid);
    savePersistedSessionMap();
  }

  // 2. 继续对话（带有保存的 webChatUrl）：优先找已打开且空闲的对应 URL 页签；否则仅复用空闲受管页签或新开独立受管页签，绝不抢占用户手动窗口
  if (!isNewChat && targetChatUrl) {
    const chatId = extractChatIdFromUrl(targetChatUrl);
    if (chatId) {
      const matchingTab = allTabs.find((t) => t.id && t.url && t.url.includes(`/app/${chatId}`));
      if (matchingTab) {
        const mSid = tabSessions.get(matchingTab.id);
        const mLive = await probeTabState(matchingTab.id, 420);
        const ownedByOtherActive = Boolean(mSid && mSid !== sid && serverActiveSessions.has(mSid));
        const busyWithOther = Boolean(mLive && (mLive.streaming || mLive.thinking || mLive.pendingReply || (mLive.watching && mLive.reqId !== cmd.requestId)));
        if (!ownedByOtherActive && !busyWithOther && !reservedTabIds.has(matchingTab.id)) {
          if (sid) bindSessionToTab(sid, matchingTab.id, isManagedTab(matchingTab.id));
          if (allowAutoClose) await closeOtherSessionTabs(sid, matchingTab.id);
          if (!preserveUserFocus) {
            try {
              chrome.tabs.update(matchingTab.id, { active: true });
            } catch (_) {}
          }
          return matchingTab;
        }
      }
    }

    const reusableTab = await findReusableManagedTab(allTabs, sid);
    if (reusableTab?.id) {
      reservedTabIds.add(reusableTab.id);
      try {
        const navigated = await navigateGeminiTab(reusableTab.id, targetChatUrl, !preserveUserFocus);
        if (navigated && sid) bindSessionToTab(sid, navigated.id, true);
        if (allowAutoClose) await closeOtherSessionTabs(sid, navigated?.id || reusableTab.id);
        return navigated;
      } finally {
        reservedTabIds.delete(reusableTab.id);
      }
    }

    if (allowAutoClose) await closeOtherSessionTabs(sid, 0);
    const opened = await createGeminiTab(targetChatUrl, !preserveUserFocus);
    if (opened && sid) bindSessionToTab(sid, opened.id, true);
    return opened;
  }

  // 3. 全新对话：仅复用空闲未绑定且无内容的插件受管页签，绝不征用用户手动打开的空白 /app 窗口
  const unboundBlankManagedTab = await findReusableManagedTab(allTabs, sid, { requireBlank: true });
  if (unboundBlankManagedTab) {
    if (sid) bindSessionToTab(sid, unboundBlankManagedTab.id, true);
    if (allowAutoClose) await closeOtherSessionTabs(sid, unboundBlankManagedTab.id);
    if (!preserveUserFocus) {
      try {
        chrome.tabs.update(unboundBlankManagedTab.id, { active: true });
      } catch (_) {}
    }
    return unboundBlankManagedTab;
  }

  const idleManagedTab = await findReusableManagedTab(allTabs, sid);
  if (idleManagedTab?.id) {
    reservedTabIds.add(idleManagedTab.id);
    try {
      const resetTab = await navigateGeminiTab(idleManagedTab.id, 'https://gemini.google.com/app', !preserveUserFocus);
      if (resetTab && sid) bindSessionToTab(sid, resetTab.id, true);
      if (allowAutoClose) await closeOtherSessionTabs(sid, resetTab?.id || idleManagedTab.id);
      return resetTab;
    } finally {
      reservedTabIds.delete(idleManagedTab.id);
    }
  }

  if (allowAutoClose) await closeOtherSessionTabs(sid, 0);
  const freshTab = await createGeminiTab('https://gemini.google.com/app', !preserveUserFocus);
  if (freshTab && sid) bindSessionToTab(sid, freshTab.id, true);
  return freshTab;
}

function reinjectOpenGeminiTabs() {
  if (!chrome.tabs || !chrome.scripting) return;
  chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
    for (const tab of tabs || []) {
      if (!tab.id) continue;
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
        .catch(() => {});
    }
  });
}

// 打开（或刷新已打开的）gemini.google.com/usage，让 content.js 读取 5h / weekly 进度条；我们自己开的后台页签读完即关
let usageTabId = null;
async function refreshUsageTab() {
  const tabs = await queryGeminiTabs();
  const existing = tabs.find((t) => t.url && /^https:\/\/gemini\.google\.com\/usage/i.test(t.url));
  if (existing?.id) {
    chrome.tabs.reload(existing.id);
    return;
  }
  chrome.tabs.create({ url: 'https://gemini.google.com/usage', active: false }, (tab) => {
    if (chrome.runtime.lastError || !tab?.id) return;
    usageTabId = tab.id;
    managedTabIds.add(tab.id);
    const tid = tab.id;
    setTimeout(() => {
      if (usageTabId === tid) {
        safeCloseTab(tid);
        usageTabId = null;
      }
    }, 30000);
  });
}

function dispatchToTabContentScript(tabId, cmd) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXEC_WEB_COMMAND', command: cmd }, (res) => {
      if (chrome.runtime.lastError || !res) {
        if (chrome.scripting) {
          chrome.scripting
            .executeScript({
              target: { tabId },
              files: ['content.js'],
            })
            .then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(
                  tabId,
                  { type: 'EXEC_WEB_COMMAND', command: cmd },
                  (r2) => resolve(Boolean(!chrome.runtime.lastError && r2))
                );
              }, 450);
            })
            .catch(() => resolve(false));
        } else {
          resolve(false);
        }
      } else {
        resolve(true);
      }
    });
  });
}

async function handleCloseTabCommand(cmd) {
  await loadPersistedSessionMap();
  if (cmd?.all) {
    const tids = [...managedTabIds];
    for (const tid of tids) {
      if (!isTabBusy(tid)) await safeCloseTab(tid);
    }
    return true;
  }

  let closed = false;
  if (cmd?.sessionId && sessionTabs.has(cmd.sessionId)) {
    const tid = sessionTabs.get(cmd.sessionId);
    if (isManagedTab(tid) && !isTabBusy(tid, cmd.sessionId)) {
      closed = (await safeCloseTab(tid)) || closed;
    } else {
      sessionTabs.delete(cmd.sessionId);
      if (tabSessions.get(tid) === cmd.sessionId) tabSessions.delete(tid);
      savePersistedSessionMap();
    }
  }
  const chatId = extractChatIdFromUrl(cmd?.webChatUrl);
  if (chatId) {
    const tabs = await queryGeminiTabs();
    for (const t of tabs) {
      if (t.id && t.url && t.url.includes(`/app/${chatId}`) && isManagedTab(t.id) && !isTabBusy(t.id, cmd?.sessionId || '')) {
        closed = (await safeCloseTab(t.id)) || closed;
      }
    }
  }
  return closed;
}

async function handleListConversationsCommand(cmd) {
  const opId = cmd?.opId || '';
  const allTabs = await queryGeminiTabs();
  const openTabItems = allTabs
    .filter((t) => t.url && extractChatIdFromUrl(t.url))
    .map((t) => ({
      chatId: extractChatIdFromUrl(t.url),
      url: `https://gemini.google.com/app/${extractChatIdFromUrl(t.url)}`,
      title: String(t.title || '')
        .replace(/^\s*Google\s+Gemini\s*[-–—·|]\s*/i, '')
        .replace(/\s*[-–—·|]\s*Google\s+Gemini\s*$/i, '')
        .replace(/^Gemini\s*[-–—·|]\s*/i, '')
        .trim(),
      isOpenTab: true,
    }));

  // 仅从空闲受管页签读取侧边栏列表，绝不干扰正在生成或用户手动打开的页签
  const managedAppTabs = allTabs.filter(
    (t) => t.id && isBridgeOwnedTab(t.id) && t.url && /^https:\/\/gemini\.google\.com\/app\b/i.test(t.url) && !isTabBusy(t.id)
  );
  let targetTab = null;
  for (const cand of [...managedAppTabs.filter((t) => t.active), ...managedAppTabs.filter((t) => !t.active)]) {
    const live = await probeTabState(cand.id, 400);
    if (!isTabLiveActive(live)) {
      targetTab = cand;
      break;
    }
  }
  let openedTemp = false;

  if (!targetTab) {
    targetTab = await createGeminiTab('https://gemini.google.com/app', false);
    openedTemp = true;
  }

  if (!targetTab?.id) {
    fetch(`${BRIDGE_BASE}/browser/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opId,
        webConversationsList: openTabItems,
        error: '无法打开 Gemini 网页读取历史列表',
      }),
    }).catch(() => {});
    return false;
  }

  if (opId) {
    tempOpTabs.set(opId, { tabId: targetTab.id, closeAfter: openedTemp });
    setTimeout(() => {
      const entry = tempOpTabs.get(opId);
      if (entry) {
        tempOpTabs.delete(opId);
        if (entry.closeAfter) safeCloseTab(entry.tabId);
      }
    }, 25000);
  }

  cmd.openTabItems = openTabItems;
  const ok = await dispatchToTabContentScript(targetTab.id, cmd);
  if (!ok && opId) {
    tempOpTabs.delete(opId);
    if (openedTemp) safeCloseTab(targetTab.id);
    fetch(`${BRIDGE_BASE}/browser/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opId,
        webConversationsList: openTabItems,
        error: '无法连接 Gemini 页签脚本读取侧边栏列表',
      }),
    }).catch(() => {});
  }
  return ok;
}

async function handleFetchConversationCommand(cmd) {
  const opId = cmd?.opId || '';
  const targetUrl = String(cmd?.webChatUrl || '').trim();
  const chatId = extractChatIdFromUrl(targetUrl);
  if (!chatId) {
    if (opId) {
      fetch(`${BRIDGE_BASE}/browser/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opId, error: `无效的 Gemini 对话链接: ${targetUrl}` }),
      }).catch(() => {});
    }
    return false;
  }

  const canonicalUrl = `https://gemini.google.com/app/${chatId}`;
  const allTabs = await queryGeminiTabs();
  const preserveUserFocus = isUserViewingUnmanagedGeminiTab(allTabs);
  let targetTab = allTabs.find((t) => t.id && t.url && t.url.includes(`/app/${chatId}`)) || null;
  const wasAlreadyOpen = Boolean(targetTab);
  let shouldCloseAfter = cmd?.closeAfter !== false;

  if (!targetTab) {
    // 仅复用未绑定且真实空闲的受管页签，绝不抢占用户手动打开的空白窗口或繁忙页签
    const reusable = await findReusableManagedTab(allTabs);
    if (reusable?.id) {
      reservedTabIds.add(reusable.id);
      try {
        targetTab = await navigateGeminiTab(reusable.id, canonicalUrl, !preserveUserFocus);
      } finally {
        reservedTabIds.delete(reusable.id);
      }
    } else {
      targetTab = await createGeminiTab(canonicalUrl, !preserveUserFocus);
    }
  } else {
    const live = await probeTabState(targetTab.id, 400);
    if (!isManagedTab(targetTab.id) || isTabBusy(targetTab.id) || isTabLiveActive(live) || (wasAlreadyOpen && tabSessions.has(targetTab.id))) {
      shouldCloseAfter = false;
    }
    if (!preserveUserFocus) {
      try {
        chrome.tabs.update(targetTab.id, { active: true });
      } catch (_) {}
    }
    await waitForTabComplete(targetTab.id, 6000);
  }

  if (!targetTab?.id) {
    if (opId) {
      fetch(`${BRIDGE_BASE}/browser/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opId, error: '无法打开目标 Gemini 历史对话窗口' }),
      }).catch(() => {});
    }
    return false;
  }

  if (opId) {
    tempOpTabs.set(opId, { tabId: targetTab.id, closeAfter: shouldCloseAfter });
    setTimeout(() => {
      const entry = tempOpTabs.get(opId);
      if (entry) {
        tempOpTabs.delete(opId);
        if (entry.closeAfter) safeCloseTab(entry.tabId);
      }
    }, 40000);
  }

  const ok = await dispatchToTabContentScript(targetTab.id, cmd);
  if (!ok && opId) {
    tempOpTabs.delete(opId);
    if (shouldCloseAfter) safeCloseTab(targetTab.id);
    fetch(`${BRIDGE_BASE}/browser/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ opId, error: '无法注入脚本读取 Gemini 历史对话内容' }),
    }).catch(() => {});
  }
  return ok;
}

async function sendCommandToGeminiTab(cmd) {
  if (cmd?.action === 'refresh_usage') {
    await refreshUsageTab();
    return true;
  }
  if (cmd?.action === 'close_tab') {
    return await handleCloseTabCommand(cmd);
  }
  if (cmd?.action === 'list_conversations') {
    return await handleListConversationsCommand(cmd);
  }
  if (cmd?.action === 'fetch_conversation') {
    return await handleFetchConversationCommand(cmd);
  }

  const tab = await resolveTargetTabForCommand(cmd);
  if (!tab || !tab.id) {
    if (cmd?.requestId && cmd?.action === 'send') {
      fetch(`${BRIDGE_BASE}/browser/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: cmd.requestId,
          step: cmd.step,
          status: 'error',
          error: '无法打开或定位 Gemini 网页标签页',
        }),
      }).catch(() => {});
    }
    return false;
  }

  if (cmd?.action === 'send') {
    tabLastDispatchedAt.set(tab.id, Date.now());
    tabWatchingMap.set(tab.id, {
      watching: true,
      sent: false,
      reqId: cmd.requestId || '',
      streaming: false,
      thinking: false,
      pendingReply: false,
      hasConversation: true,
      hasDraft: false,
      updatedAt: Date.now(),
    });
  }
  return await dispatchToTabContentScript(tab.id, cmd);
}

function enqueueCommand(fn) {
  commandChain = commandChain.then(fn, fn).catch(() => {});
  return commandChain;
}

async function backgroundPollTick() {
  if (isPolling) return;
  isPolling = true;
  try {
    await loadPersistedSessionMap();
    const now = Date.now();
    // 周期性调用扩展原生异步 API 重置 MV3 Service Worker 30s 空闲计时器，确保 0 个 Gemini 页签时仍常驻在线
    if (now - lastKeepaliveApiAt > 12000 && chrome.runtime?.getPlatformInfo) {
      lastKeepaliveApiAt = now;
      chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    }

    const tabs = await queryGeminiTabs();
    // 先并行探活所有受管页签（带短超时）刷新真实状态，再拉取指令派发，彻底消除 SW 重启后的空闲误判竞态
    const tickPromises = [];
    for (const t of tabs) {
      if (!t.id) continue;
      if (isBridgeOwnedTab(t.id)) {
        tickPromises.push(probeTabState(t.id, 300));
      } else {
        // 非受管页签异步刷新观测态，不阻塞主轮询且绝不覆写全局模型名
        probeTabState(t.id, 300).catch(() => {});
      }
    }
    if (tickPromises.length) {
      await Promise.all(tickPromises);
    }

    const q = cachedModelLabel ? `?modelLabel=${encodeURIComponent(cachedModelLabel)}` : '';
    const res = await fetch(`${BRIDGE_BASE}/browser/poll${q}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data?.activeSessionIds)) {
        serverActiveSessions = new Set(data.activeSessionIds);
      }
      if (data?.command) {
        enqueueCommand(() => sendCommandToGeminiTab(data.command));
      } else {
        // 若用户正停留在自己手动打开的 Gemini 页签上，绝不轮转切走用户焦点（后台受管页签仍由 350ms WEB_TICK 持续驱动解析）
        const userOnManualTab = isUserViewingUnmanagedGeminiTab(tabs);
        const anySendingNow = tabs.some((t) => {
          const w = tabWatchingMap.get(t.id);
          return isBridgeOwnedTab(t.id) && w?.watching && !w?.sent;
        });
        const generatingTabs = tabs.filter((t) => {
          const w = tabWatchingMap.get(t.id);
          return t.id && isBridgeOwnedTab(t.id) && w?.watching && w?.sent;
        });
        if (!userOnManualTab && !anySendingNow && generatingTabs.length >= 2 && now - lastTabRotateAt >= 2200) {
          lastTabRotateAt = now;
          rotateCursor = (rotateCursor + 1) % generatingTabs.length;
          const nextTab = generatingTabs[rotateCursor];
          if (nextTab?.id && !nextTab.active) {
            try {
              chrome.tabs.update(nextTab.id, { active: true });
            } catch (_) {}
          }
        }
      }
    }
  } catch (_) {
  } finally {
    isPolling = false;
  }
}

function ensureKeepaliveAlarm() {
  try {
    if (chrome.alarms) {
      chrome.alarms.create('agwb-keepalive-alarm', { periodInMinutes: 0.4 });
    }
  } catch (_) {}
}

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === 'agwb-keepalive-alarm') {
    backgroundPollTick();
  }
});

setInterval(backgroundPollTick, 350);
ensureKeepaliveAlarm();
loadPersistedSessionMap();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'agwb-keepalive') {
    const tid = port.sender?.tab?.id;
    port.onMessage.addListener((msg) => {
      if (msg?.modelLabel && isBridgeOwnedTab(tid)) {
        cachedModelLabel = msg.modelLabel;
      }
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureLocalhostBypassedInProxy();
  ensureKeepaliveAlarm();
  reinjectOpenGeminiTabs();
});

chrome.runtime.onStartup.addListener(() => {
  ensureLocalhostBypassedInProxy();
  ensureKeepaliveAlarm();
});

ensureLocalhostBypassedInProxy();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'AUTO_CLOSE_TAB') {
    const tid = sender?.tab?.id;
    const delayMs = Math.max(200, Number(msg.delayMs || 700));
    if (tid) {
      const closeScheduledAt = Date.now();
      setTimeout(async () => {
        await loadPersistedSessionMap();
        // 仅关闭由插件创建且空闲的受管页签，绝不关闭用户手动打开的窗口或正在运行的页签
        const lastDisp = tabLastDispatchedAt.get(tid) || 0;
        if (lastDisp > closeScheduledAt || isTabBusy(tid)) return;
        const live = await probeTabState(tid, 350);
        if (isTabLiveActive(live)) return;
        if (managedTabIds.has(tid)) {
          await safeCloseTab(tid);
        }
      }, delayMs);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type !== 'BRIDGE_REQUEST') return false;

  ensureLocalhostBypassedInProxy();

  const { method = 'GET', endpoint = '/status', bodyObj } = msg;
  // 若 content.js 上报时所在标签页 URL 已经是 /app/<chatId>，自动补齐 webChatUrl
  if (endpoint === '/browser/report' && bodyObj && !bodyObj.webChatUrl && extractChatIdFromUrl(sender?.tab?.url)) {
    bodyObj.webChatUrl = sender.tab.url;
  }
  if (
    endpoint === '/browser/report' &&
    sender?.tab?.id &&
    bodyObj?.requestId &&
    (bodyObj.status === 'completed' || bodyObj.status === 'error')
  ) {
    const prev = tabWatchingMap.get(sender.tab.id);
    if (prev && (!prev.reqId || prev.reqId === bodyObj.requestId)) {
      tabWatchingMap.set(sender.tab.id, { ...prev, watching: false, streaming: false, thinking: false, updatedAt: Date.now() });
    }
  }
  if (endpoint === '/browser/report' && bodyObj?.webQuota && sender?.tab?.id && sender.tab.id === usageTabId) {
    const tid = usageTabId;
    usageTabId = null;
    setTimeout(() => safeCloseTab(tid), 300);
  }
  if (endpoint === '/browser/report' && bodyObj?.opId && tempOpTabs.has(bodyObj.opId)) {
    const entry = tempOpTabs.get(bodyObj.opId);
    tempOpTabs.delete(bodyObj.opId);
    if (entry?.closeAfter && entry.tabId) {
      setTimeout(() => safeCloseTab(entry.tabId), 350);
    }
  }

  fetch(`${BRIDGE_BASE}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok !== false) {
        sendResponse({ ok: true, data });
      } else {
        sendResponse({ ok: false, error: data.error || `HTTP ${res.status}` });
      }
    })
    .catch((err) => {
      sendResponse({
        ok: false,
        error: `无法连接 127.0.0.1:18765 (${err?.message || '请确认本地服务已运行'})`,
      });
    });

  return true;
});
