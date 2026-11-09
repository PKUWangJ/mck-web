/* Marchkov web helper — personal ride QR page.
 *
 * This page is static (hostable on GitHub Pages). All PKU requests go to the
 * user's own local service, which is reached with a bearer token. No account
 * password is ever stored here. */
(() => {
  'use strict';

  const KEYS = {
    api: 'mck.api',
    token: 'mck.token',
    username: 'mck.username',
    theme: 'mck.theme',
    lastQr: 'mck.lastQr',
    historyDays: 'mck.historyDays',
  };

  const TITLES = {
    qr: '乘车码',
    buses: '班车',
    history: '乘车记录',
    settings: '设置',
  };

  const ICONS = {
    qr:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="6" height="6" rx="1.4"/><rect x="14.5" y="3.5" width="6" height="6" rx="1.4"/><rect x="3.5" y="14.5" width="6" height="6" rx="1.4"/><path d="M14.5 14.5h2.2v2.2h-2.2zM19.5 14.5H21M21 18.5v2.5h-4M14.5 21h2.5"/></g></svg>',
    bus:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="14" rx="3"/><path d="M4 10.5h16M7.5 17.5v2.5M16.5 17.5v2.5"/><circle cx="8" cy="14" r=".9" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r=".9" fill="currentColor" stroke="none"/></g></svg>',
    history:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/></g></svg>',
    settings:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h8M16 7h4M4 17h4M12 17h8"/><circle cx="14" cy="7" r="2.2"/><circle cx="10" cy="17" r="2.2"/></g></svg>',
    refresh:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 4v7h-7"/></g></svg>',
  };

  const TABS = [
    { id: 'qr', label: '乘车码', icon: 'qr' },
    { id: 'buses', label: '班车', icon: 'bus' },
    { id: 'history', label: '记录', icon: 'history' },
    { id: 'settings', label: '设置', icon: 'settings' },
  ];

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const state = {
    token: '',
    username: '',
    apiBase: '',
    theme: 'auto',
    tab: 'qr',
    authMessage: '',
    qr: null,
    qrLoading: false,
    qrError: '',
    qrShown: {},
    buses: [],
    busesDate: '',
    busesLoadedDate: '',
    busesLoading: false,
    busesError: '',
    reservations: [],
    history: null,
    historyLoading: false,
    historyError: '',
    historyDays: 30,
    busyAction: false,
    fullscreenNode: null,
    req: { qr: 0, buses: 0, history: 0 },
  };

  // ------------------------------------------------------------- small helpers
  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      /* storage may be unavailable in private mode */
    }
  }

  function remove(key) {
    try {
      localStorage.removeItem(key);
    } catch (err) {
      /* ignore */
    }
  }

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function ymd(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function shiftDays(offset) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    return date;
  }

  function weekdayOf(dateText) {
    const parts = String(dateText).split('-').map(Number);
    if (parts.length !== 3) return '';
    return WEEKDAYS[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
  }

  function monthDay(text) {
    const parts = String(text || '').slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || !parts[0]) return '—';
    return `${parts[1]}月${parts[2]}日`;
  }

  function timePart(text) {
    const value = String(text || '');
    const match = value.match(/(\d{2}:\d{2})/);
    return match ? match[1] : '';
  }

  function qrWhenText(text) {
    const day = String(text || '').slice(0, 10);
    const time = timePart(text);
    if (day && day !== ymd(new Date())) {
      return `${monthDay(text)} ${time}`.trim();
    }
    return time;
  }

  function clock(iso) {
    const value = String(iso || '');
    const part = value.slice(11, 16);
    return /^\d{2}:\d{2}$/.test(part) ? part : '';
  }

  function clockFromMs(ms) {
    if (!ms) return '';
    const date = new Date(ms);
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function nowText() {
    const date = new Date();
    return `${ymd(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function $(selector) {
    return document.querySelector(selector);
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      Object.entries(props).forEach(([key, value]) => {
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'value') node.value = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? '' : value);
      });
    }
    children.flat().forEach((child) => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  let toastTimer = 0;
  function toast(message) {
    const node = $('#toast');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    const duration = Math.min(6000, 1800 + String(message).length * 120);
    toastTimer = setTimeout(() => {
      node.hidden = true;
    }, duration);
  }

  // ----------------------------------------------------------------- service
  /* The page can be served either by GitHub Pages (or any static host) or by
   * the local service itself (loopback / Tailscale Serve).  Only in the
   * latter case is the API on the same origin, so only then may the server
   * address be left empty. */
  function isLocalServiceOrigin() {
    const host = location.hostname.toLowerCase();
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '[::1]' ||
      host === '::1' ||
      host.endsWith('.ts.net')
    );
  }

  function needsApiBase() {
    return !isLocalServiceOrigin();
  }

  /* Accept "host.tailnet.ts.net" from the iPhone keyboard as well. */
  function normalizeBase(value) {
    let text = String(value || '').trim().replace(/\/+$/, '');
    if (text && !/^https?:\/\//i.test(text)) text = `https://${text}`;
    return text;
  }

  function apiBase() {
    const saved = (state.apiBase || '').replace(/\/+$/, '');
    if (saved) return saved;
    return needsApiBase() ? '' : location.origin;
  }

  class ApiFail extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiFail';
      this.status = status;
    }
  }

  async function api(path, options = {}) {
    const { skipAuthHandling = false, method = 'GET', body = null } = options;
    const base = apiBase();
    if (!base) {
      throw new ApiFail('还没有填写本机服务地址，请在下方“服务地址”中填写', 0);
    }

    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    let response;
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (err) {
      throw new ApiFail(
        '连不上本机服务：' + (err && err.message ? err.message : '网络错误'),
        0
      );
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      if (response.status === 401 && !skipAuthHandling) {
        if (state.token) {
          state.authMessage = '登录已失效，请重新登录';
          clearAuth();
          state.qr = null;
          state.qrShown = {};
          state.buses = [];
          state.reservations = [];
          state.history = null;
          closeFullscreen();
          render();
          toast(state.authMessage);
        }
      }
      const message =
        (payload && payload.error) || `请求失败：HTTP ${response.status}`;
      throw new ApiFail(message, response.status);
    }
    return payload;
  }

  function clearAuth() {
    state.token = '';
    remove(KEYS.token);
  }

  // -------------------------------------------------------------------- theme
  function prefersDark() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function applyTheme() {
    const theme = ['light', 'dark', 'auto'].includes(state.theme)
      ? state.theme
      : 'auto';
    document.documentElement.dataset.theme = theme;
    const dark = theme === 'dark' || (theme === 'auto' && prefersDark());
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0f0f11' : '#f4f4f5');
  }

  function setTheme(theme) {
    if (!['light', 'dark', 'auto'].includes(theme)) return;
    state.theme = theme;
    write(KEYS.theme, theme);
    applyTheme();
    document.querySelectorAll('.segment').forEach((button) => {
      const active = button.dataset.value === theme;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  // ------------------------------------------------------------------ render
  function render() {
    applyTheme();
    const app = $('#app');
    if (!app) return;
    app.replaceChildren();
    if (!state.token) {
      app.append(renderAuth());
      return;
    }
    app.append(renderShell());
    renderMain();
    updateChrome();
  }

  function renderShell() {
    const topbar = el(
      'header',
      { class: 'topbar' },
      el(
        'div',
        { class: 'topbar-text' },
        el('h1', { text: TITLES[state.tab] || '乘车码' }),
        el('div', { class: 'subtitle', id: 'subtitle', text: subtitleText() })
      )
    );

    if (state.tab !== 'settings') {
      topbar.append(
        el('button', {
          class: `icon-button${isLoadingForTab() ? ' spinning' : ''}`,
          id: 'refresh-btn',
          type: 'button',
          'aria-label': '刷新',
          html: ICONS.refresh,
          onclick: refreshCurrent,
        })
      );
    }

    return el(
      'div',
      { class: 'shell' },
      topbar,
      el('main', { class: 'main', id: 'main' }),
      renderTabbar()
    );
  }

  function renderTabbar() {
    return el(
      'nav',
      { class: 'tabbar', 'aria-label': '主导航' },
      TABS.map((tab) =>
        el(
          'button',
          {
            class: `tab${state.tab === tab.id ? ' active' : ''}`,
            type: 'button',
            'aria-label': tab.label,
            'aria-current': state.tab === tab.id ? 'page' : null,
            onclick: () => switchTab(tab.id),
          },
          el('span', { class: 'tab-icon', html: ICONS[tab.icon] }),
          el('span', { text: tab.label })
        )
      )
    );
  }

  function renderMain() {
    const main = $('#main');
    if (!main) return;
    main.replaceChildren();
    if (state.tab === 'qr') main.append(...renderQr());
    else if (state.tab === 'buses') main.append(...renderBuses());
    else if (state.tab === 'history') main.append(...renderHistory());
    else main.append(...renderSettings());
    updateChrome();
  }

  function updateChrome() {
    const title = document.querySelector('.topbar h1');
    if (title) title.textContent = TITLES[state.tab] || '乘车码';
    const subtitle = $('#subtitle');
    if (subtitle) subtitle.textContent = subtitleText();
    const refresh = $('#refresh-btn');
    if (refresh) refresh.classList.toggle('spinning', isLoadingForTab());
  }

  function isLoadingForTab() {
    if (state.tab === 'qr') return state.qrLoading;
    if (state.tab === 'buses') return state.busesLoading;
    if (state.tab === 'history') return state.historyLoading;
    return false;
  }

  function subtitleText() {
    if (state.tab === 'qr') {
      if (state.qrLoading && !state.qr) return '正在获取乘车码…';
      if (state.qr) {
        if (state.qr.cached) {
          return `缓存于 ${clockFromMs(state.qr.cachedAt) || '—'}`;
        }
        if (state.qr.updated) return `更新于 ${clock(state.qr.updated) || '—'}`;
      }
      return ymd(new Date());
    }
    if (state.tab === 'buses') {
      if (state.busesLoading && state.busesLoadedDate !== state.busesDate) {
        return '正在获取班次…';
      }
      return `${state.busesDate} · ${state.buses.length} 个班次`;
    }
    if (state.tab === 'history') {
      if (state.historyLoading && !state.history) return '正在获取乘车记录…';
      return `近 ${state.historyDays} 天 · ${historyInRange().length} 次`;
    }
    return state.username ? `账号 ${state.username}` : '本机设置';
  }

  function emptyState(icon, title, text, buttonText, onClick) {
    const node = el(
      'div',
      { class: 'empty' },
      el('div', { class: 'empty-icon', text: icon }),
      el('h3', { text: title }),
      el('p', { text })
    );
    if (buttonText && onClick) {
      node.append(
        el('button', {
          class: 'button primary',
          type: 'button',
          text: buttonText,
          onclick: onClick,
        })
      );
    }
    return node;
  }

  // ---------------------------------------------------------------- auth page
  function renderAuth() {
    const errorNode = el('div', {
      class: 'notice warn',
      id: 'auth-error',
      text: state.authMessage || '',
      hidden: !state.authMessage,
    });

    const apiInput = el('input', {
      id: 'api-base',
      type: 'url',
      inputmode: 'url',
      placeholder: 'https://xxx.ts.net',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      value: state.apiBase || '',
    });

    const userInput = el('input', {
      id: 'username',
      type: 'text',
      inputmode: 'numeric',
      placeholder: '学号',
      autocomplete: 'username',
      autocapitalize: 'off',
      spellcheck: 'false',
      value: state.username || '',
    });

    const passInput = el('input', {
      id: 'password',
      type: 'password',
      placeholder: '密码',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
    });
    passInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        doLogin();
      }
    });

    const baseHint = needsApiBase()
      ? '必填。填写 Tailscale Serve 的 https 地址，例如 https://你的设备.你的tailnet.ts.net'
      : '当前页面由本机服务提供，可以留空。';

    return el(
      'div',
      { class: 'auth-screen' },
      el(
        'div',
        { class: 'auth-card' },
        el('div', { class: 'brand', text: '乘' }),
        el('h1', { class: 'auth-title', text: '乘车码' }),
        el('p', {
          class: 'auth-sub',
          text: '账号密码只发送到你自己电脑上的本机服务；GitHub 上只有这个静态页面。',
        }),
        errorNode,
        el(
          'div',
          { class: 'auth-form' },
          el(
            'label',
            { class: 'field' },
            el('span', { text: '本机服务地址' }),
            apiInput
          ),
          el('p', {
            class: 'panel-hint',
            text: baseHint,
          }),
          el(
            'label',
            { class: 'field' },
            el('span', { text: '学号' }),
            userInput
          ),
          el(
            'label',
            { class: 'field' },
            el('span', { text: '密码' }),
            passInput
          ),
          el('button', {
            class: 'button primary wide',
            id: 'login-btn',
            type: 'button',
            text: '登录',
            onclick: doLogin,
          }),
          el(
            'div',
            { class: 'button-row' },
            el('button', {
              class: 'button ghost',
              type: 'button',
              text: '测试连接',
              onclick: () => testConnection('api-base'),
            })
          )
        ),
        el('p', {
          class: 'auth-note',
          text: '密码不会写入网页存储；本机服务只在内存中保留它，用于会话自动续期。退出或重启服务即清除。',
        })
      )
    );
  }

  function showAuthError(message) {
    const node = $('#auth-error');
    if (!node) {
      toast(message);
      return;
    }
    node.textContent = message;
    node.hidden = !message;
  }

  async function doLogin() {
    const apiInput = $('#api-base');
    const userInput = $('#username');
    const passInput = $('#password');
    const button = $('#login-btn');
    if (!userInput || !passInput || !button) return;

    const rawBase = apiInput ? normalizeBase(apiInput.value) : '';
    const username = (userInput.value || '').trim();
    const password = passInput.value || '';

    showAuthError('');
    if (!username || !password) {
      showAuthError('请输入学号和密码');
      return;
    }
    if (needsApiBase() && !rawBase) {
      showAuthError('请填写本机服务地址（Tailscale 的 https 地址）');
      return;
    }

    const previousBase = state.apiBase;
    state.apiBase = rawBase;
    button.disabled = true;
    button.textContent = '登录中…';

    try {
      const payload = await api('/api/login', {
        method: 'POST',
        body: { username, password },
        skipAuthHandling: true,
      });
      if (!payload || !payload.token) {
        throw new Error('登录响应异常，请检查服务地址');
      }
      passInput.value = '';
      state.token = payload.token;
      state.username = payload.username || username;
      state.authMessage = '';
      write(KEYS.token, state.token);
      write(KEYS.username, state.username);
      if (rawBase) write(KEYS.api, rawBase);
      else remove(KEYS.api);
      // A cache written while talking to a different server may belong to
      // another account; never show it after switching.
      if (rawBase !== previousBase) remove(KEYS.lastQr);
      state.tab = 'qr';
      state.qr = null;
      state.qrShown = {};
      hydrateQrCache();
      render();
      loadQr();
    } catch (err) {
      state.apiBase = previousBase;
      showAuthError(err && err.message ? err.message : '登录失败');
      button.disabled = false;
      button.textContent = '登录';
    }
  }

  async function testConnection(inputId) {
    const input = document.getElementById(inputId);
    const raw = normalizeBase(input && input.value);
    if (!raw && needsApiBase()) {
      toast('请先填写服务地址');
      return;
    }
    const base = raw || location.origin;
    toast('正在测试连接…');
    try {
      const response = await fetch(`${base}/api/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || payload.ok !== true) throw new Error('返回内容异常');
      toast('连接成功，本机服务正常');
    } catch (err) {
      toast(
        '连接失败：' +
          (err && err.message ? err.message : '网络错误') +
          '（检查 Tailscale 与本机服务）'
      );
    }
  }

  async function doLogout() {
    if (!window.confirm('退出登录？')) return;
    try {
      await api('/api/logout', { method: 'POST', skipAuthHandling: true });
    } catch (err) {
      /* the token may already be gone */
    }
    closeFullscreen();
    clearAuth();
    state.authMessage = '';
    state.qr = null;
    state.qrShown = {};
    state.buses = [];
    state.reservations = [];
    state.history = null;
    remove(KEYS.lastQr);
    render();
    toast('已退出登录');
  }

  // -------------------------------------------------------------------- QR tab
  function readQrCache() {
    const raw = read(KEYS.lastQr);
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items)) return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function hydrateQrCache() {
    if (state.qr) return;
    const cache = readQrCache();
    if (!cache || !cache.items.length) return;
    if (cache.date !== ymd(new Date())) return;
    // Only reuse a cache that belongs to the signed-in account.  A missing
    // username is not enough evidence, so treat it as a different account.
    if (state.username && cache.username !== state.username) return;
    setQrData(cache, { cached: true, cachedAt: cache.savedAt || 0 });
  }

  function setQrData(payload, options = {}) {
    const cached = Boolean(options.cached);
    state.qr = {
      items: Array.isArray(payload.items) ? payload.items : [],
      updated: payload.updated || '',
      date: payload.date || ymd(new Date()),
      scope: payload.scope || 'today',
      cached,
      cachedAt: options.cachedAt || 0,
      fetchedAt: cached ? 0 : Date.now(),
    };
  }

  function writeQrCache(payload) {
    write(
      KEYS.lastQr,
      JSON.stringify({
        savedAt: Date.now(),
        username: state.username,
        date: payload.date || ymd(new Date()),
        scope: payload.scope || 'today',
        updated: payload.updated || '',
        items: payload.items || [],
      })
    );
  }

  async function loadQr(options = {}) {
    const force = Boolean(options.force);
    if (state.qrLoading && !force) return;

    state.qrLoading = true;
    state.req.qr += 1;
    const reqId = state.req.qr;
    if (state.tab === 'qr') renderMain();

    try {
      const payload = await api('/api/qr?scope=all');
      if (reqId !== state.req.qr) return;
      setQrData(payload);
      writeQrCache(payload);
      state.qrError = '';
    } catch (err) {
      if (reqId !== state.req.qr) return;
      state.qrError = err && err.message ? err.message : '获取乘车码失败';
    } finally {
      if (reqId === state.req.qr) {
        state.qrLoading = false;
        if (state.tab === 'qr') renderMain();
      }
    }
  }

  function renderQr() {
    const nodes = [];
    const todayText = ymd(new Date());

    if (state.qrError && state.qr) {
      nodes.push(
        el('div', {
          class: 'notice warn',
          text: `刷新失败：${state.qrError}。下面是上次获取的数据。`,
        })
      );
    }

    if (state.qrLoading && !state.qr) {
      nodes.push(el('div', { class: 'spinner' }));
      return nodes;
    }

    const data = state.qr;
    if (!data) {
      nodes.push(
        emptyState(
          '📡',
          '暂时无法获取乘车码',
          state.qrError || '检查手机是否已连接 Tailscale，以及本机服务是否在运行。',
          '重试',
          () => loadQr({ force: true })
        )
      );
      return nodes;
    }

    if (data.cached) {
      nodes.push(
        el('div', {
          class: 'notice warn',
          text: `当前显示本机缓存（${clockFromMs(data.cachedAt) || '—'} 更新），可能不是最新。点右上角刷新。`,
        })
      );
    }
    if (data.date && data.date !== todayText) {
      nodes.push(
        el('div', {
          class: 'notice warn',
          text: `这是 ${data.date} 的二维码，不是今天的，可能已失效。`,
        })
      );
    }

    if (!data.items.length) {
      nodes.push(
        emptyState(
          '🚌',
          '还没有可显示的乘车码',
          '预约班车后，乘车二维码会显示在这里。',
          '去预约班车',
          () => switchTab('buses')
        )
      );
      return nodes;
    }

    let nextId = '';
    const now = nowText();
    const upcoming = data.items.find(
      (item) => String(item.time || '').slice(0, 16) >= now
    );
    if (upcoming) nextId = upcoming.id;

    const ordered = [...data.items].sort((a, b) => {
      if (a.id === nextId) return -1;
      if (b.id === nextId) return 1;
      return String(a.time || '').localeCompare(String(b.time || ''));
    });
    ordered.forEach((item) => {
      // The nearest ride is open by default; every other reservation can be
      // revealed or hidden independently, and the choice survives re-renders.
      const visible =
        state.qrShown[item.id] === undefined
          ? item.id === nextId
          : Boolean(state.qrShown[item.id]);
      nodes.push(
        renderQrCard(item, item.id === nextId, visible, () => {
          state.qrShown[item.id] = !visible;
          renderMain();
        })
      );
    });

    if (data.updated) {
      nodes.push(
        el('p', {
          class: 'footnote',
          text: `数据更新于 ${clock(data.updated) || '刚刚'}`,
        })
      );
    }
    return nodes;
  }

  function renderQrCard(item, isNext, visible, onToggle) {
    const card = el('article', {
      class: `qr-card${isNext ? ' is-next' : ''}`,
    });
    const itemDay = String(item.time || '').slice(0, 10);
    const todayText = ymd(new Date());

    card.append(
      el(
        'div',
        { class: 'qr-head' },
        el('span', {
          class: 'pill',
          text: isNext ? '最近一班' : item.code_type || '乘车码',
        }),
        el('span', { class: 'route', text: item.route || '班车' })
      )
    );

    if (itemDay && itemDay !== todayText) {
      card.append(
        el('div', {
          class: 'qr-date',
          text: `${monthDay(item.time)} ${weekdayOf(itemDay)}`.trim(),
        })
      );
    }

    card.append(
      el('div', {
        class: 'qr-time',
        text: timePart(item.time) || '--:--',
      })
    );

    if (visible) {
      if (item.qr) {
        const image = el('img', {
          class: 'qr-img',
          src: item.qr,
          alt: `${timePart(item.time) || ''} 乘车二维码`,
          width: 260,
          height: 260,
        });
        card.append(
          el(
            'button',
            {
              class: 'qr-wrap',
              type: 'button',
              'aria-label': '全屏显示二维码',
              onclick: () => openFullscreen(item),
            },
            image
          )
        );
      } else {
        card.append(
          el('div', {
            class: 'qr-wrap qr-error',
            text: item.error || '二维码加载失败，请稍后刷新',
          })
        );
      }
    }

    const actions = el('div', { class: 'card-actions' });
    if (visible && item.qr) {
      actions.append(
        el('button', {
          class: 'button primary',
          type: 'button',
          text: '全屏出示',
          onclick: () => openFullscreen(item),
        })
      );
    }
    actions.append(
      el('button', {
        class: `button ${visible ? 'ghost' : 'primary'}`,
        type: 'button',
        text: visible ? '隐藏二维码' : '显示二维码',
        'aria-expanded': visible ? 'true' : 'false',
        onclick: onToggle,
      })
    );
    if (item.data_id) {
      actions.append(
        el('button', {
          class: 'button ghost',
          type: 'button',
          text: '取消预约',
          onclick: () => cancelReservation(item),
        })
      );
    }
    if (actions.childElementCount) card.append(actions);

    return card;
  }

  // --------------------------------------------------------------- buses tab
  function nextDays(count) {
    const result = [];
    for (let index = 0; index < count; index += 1) {
      result.push(ymd(shiftDays(index)));
    }
    return result;
  }

  function findReservation(slot) {
    const key = `${slot.date} ${slot.time}`.slice(0, 16);
    return state.reservations.find(
      (item) =>
        String(item.route || '').trim() === String(slot.route || '').trim() &&
        String(item.time || '').slice(0, 16) === key
    );
  }

  // 新燕园 ↔ 燕园 are the routes used most often, so their groups go first:
  // 新燕园→燕园, then 燕园→新燕园, then other cross-campus routes (e.g. via
  // 200号校区), then everything else.
  function busRouteRank(route) {
    const name = String(route || '').trim();
    if (!name.includes('新燕园')) return 3;
    // "燕园" is a substring of "新燕园"; strip the longer name first so the
    // check really means "also mentions the main campus".
    const rest = name.split('新燕园').join('');
    if (!rest.includes('燕园')) return 3;
    if (name.startsWith('新燕园')) return 0;
    if (name.startsWith('燕园')) return 1;
    return 2;
  }

  function renderBuses() {
    const nodes = [];
    const todayString = ymd(new Date());

    nodes.push(
      el(
        'div',
        { class: 'date-strip' },
        nextDays(7).map((date) => {
          const parts = date.split('-').map(Number);
          const active = date === state.busesDate;
          return el(
            'button',
            {
              class: `date-pill${active ? ' active' : ''}`,
              type: 'button',
              'aria-pressed': active ? 'true' : 'false',
              onclick: () => selectDate(date),
            },
            el('span', {
              class: 'date-week',
              text: date === todayString ? '今天' : weekdayOf(date),
            }),
            el('span', {
              class: 'date-md',
              text: `${parts[1]}/${parts[2]}`,
            })
          );
        })
      )
    );

    if (state.busesError) {
      nodes.push(el('div', { class: 'notice warn', text: state.busesError }));
    }

    const hasData = state.busesLoadedDate === state.busesDate;
    if (state.busesLoading && !hasData) {
      nodes.push(el('div', { class: 'spinner' }));
      return nodes;
    }

    const slots = hasData ? state.buses : [];
    if (!slots.length) {
      if (state.busesError) {
        nodes.push(
          emptyState(
            '📡',
            '无法获取班次',
            state.busesError,
            '重试',
            () => loadBuses()
          )
        );
      } else {
        nodes.push(
          emptyState(
            '🕐',
            '这天没有可预约的班次',
            '换一天看看，或稍后刷新。',
            '刷新',
            () => loadBuses()
          )
        );
      }
      return nodes;
    }

    const groups = new Map();
    slots.forEach((slot) => {
      if (!groups.has(slot.route)) groups.set(slot.route, []);
      groups.get(slot.route).push(slot);
    });

    const ranked = [...groups.entries()].map(([route, routeSlots], index) => ({
      route,
      routeSlots,
      index,
      rank: busRouteRank(route),
    }));
    ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);

    ranked.forEach(({ route, routeSlots }) => {
      const group = el(
        'section',
        { class: 'bus-group' },
        el('h2', { class: 'group-title', text: route || '班车' })
      );
      routeSlots.forEach((slot) => group.append(renderBusRow(slot)));
      nodes.push(group);
    });

    return nodes;
  }

  function renderBusRow(slot) {
    const reservation = findReservation(slot);
    const departure = `${slot.date} ${slot.time}`.slice(0, 16);
    const past = departure < nowText();

    const meta = el(
      'div',
      { class: 'bus-meta' },
      el('span', { text: `余位 ${slot.margin}` })
    );
    if (reservation) {
      meta.append(el('span', { class: 'bus-status', text: '已预约' }));
    } else if (past) {
      meta.append(
        el('span', { class: 'bus-status reserved', text: '已发车' })
      );
    }

    const row = el(
      'div',
      { class: 'bus-row' },
      el('div', { class: 'bus-time', text: slot.time }),
      meta
    );

    if (reservation) {
      if (reservation.data_id) {
        row.append(
          el('button', {
            class: 'button ghost small',
            type: 'button',
            text: '取消',
            onclick: () => cancelReservation(reservation),
          })
        );
      }
    } else if (!past) {
      row.append(
        el('button', {
          class: 'button primary small',
          type: 'button',
          text: '预约',
          onclick: () => reserveSlot(slot),
        })
      );
    }

    return row;
  }

  async function loadBuses() {
    const date = state.busesDate;
    state.req.buses += 1;
    const reqId = state.req.buses;
    state.busesLoading = true;
    state.busesError = '';
    if (state.tab === 'buses') renderMain();

    try {
      const [busPayload, reservationPayload] = await Promise.all([
        api(`/api/buses?date=${encodeURIComponent(date)}`),
        api('/api/reservations'),
      ]);
      if (reqId !== state.req.buses) return;
      const items = Array.isArray(busPayload.items) ? busPayload.items : [];
      // Defence in depth: only keep slots that belong to the selected date,
      // even if a server build still returns the whole multi-day timetable.
      state.buses = items.filter((slot) => slot.date === date);
      state.busesLoadedDate = date;
      state.reservations = Array.isArray(reservationPayload.items)
        ? reservationPayload.items
        : [];
    } catch (err) {
      if (reqId !== state.req.buses) return;
      state.busesError = err && err.message ? err.message : '获取班次失败';
    } finally {
      if (reqId === state.req.buses) {
        state.busesLoading = false;
        if (state.tab === 'buses') renderMain();
      }
    }
  }

  function selectDate(date) {
    if (state.busesDate === date) return;
    state.busesDate = date;
    state.buses = [];
    state.busesLoadedDate = '';
    state.busesError = '';
    renderMain();
    loadBuses();
  }

  function ensureTodayOrLater() {
    if (state.busesDate < ymd(new Date())) {
      state.busesDate = ymd(new Date());
      state.busesLoadedDate = '';
      state.buses = [];
    }
  }

  async function reserveSlot(slot) {
    if (state.busyAction) {
      toast('正在处理上一项操作…');
      return;
    }
    const label = `${monthDay(slot.date)} ${slot.time} 的${slot.route || '班车'}`;
    if (!window.confirm(`预约 ${label}？`)) return;

    state.busyAction = true;
    toast('正在预约…');
    try {
      await api('/api/reserve', {
        method: 'POST',
        body: {
          resource_id: slot.bus_id,
          date: slot.date,
          period: slot.time_id,
        },
      });
      toast('预约成功');
      // Refresh both: the list shows the new "已预约" mark, and the QR tab
      // must not keep serving a pre-reservation result from its 60s cache.
      await Promise.all([loadBuses(), loadQr({ force: true })]);
    } catch (err) {
      toast(err && err.message ? err.message : '预约失败');
    } finally {
      state.busyAction = false;
    }
  }

  async function cancelReservation(item) {
    if (state.busyAction) {
      toast('正在处理上一项操作…');
      return;
    }
    const label = item.time
      ? `${monthDay(item.time)} ${timePart(item.time)} 的${item.route || '班车'}`
      : item.route || '班车';
    if (!window.confirm(`取消 ${label} 预约？`)) return;

    state.busyAction = true;
    toast('正在取消…');
    try {
      await api('/api/cancel', {
        method: 'POST',
        body: { appointment_id: item.id, data_id: item.data_id },
      });
      closeFullscreen();
      toast('已取消预约');
      state.qrError = '';
      await Promise.all([loadQr({ force: true }), loadBuses()]);
    } catch (err) {
      toast(err && err.message ? err.message : '取消失败');
    } finally {
      state.busyAction = false;
    }
  }

  // -------------------------------------------------------------- history tab
  function historyInRange() {
    if (!state.history || !Array.isArray(state.history.items)) return [];
    const startKey = ymd(shiftDays(-(state.historyDays - 1)));
    const endKey = ymd(new Date());
    return state.history.items.filter((item) => {
      const day = String(item.time || '').slice(0, 10);
      return day >= startKey && day <= endKey;
    });
  }

  function topRoute(items) {
    const counts = new Map();
    items.forEach((item) => {
      const route = String(item.route || '').trim();
      if (!route) return;
      counts.set(route, (counts.get(route) || 0) + 1);
    });
    let best = '';
    let bestCount = 0;
    counts.forEach((count, route) => {
      if (count > bestCount) {
        best = route;
        bestCount = count;
      }
    });
    return best ? `${best} ×${bestCount}` : '—';
  }

  function monthlyCounts(items, months) {
    const now = new Date();
    const counts = new Map();
    items.forEach((item) => {
      const key = String(item.time || '').slice(0, 7);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    const list = [];
    for (let index = months - 1; index >= 0; index -= 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - index, 1);
      const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
      list.push({
        key,
        label: `${date.getMonth() + 1}月`,
        count: counts.get(key) || 0,
      });
    }
    return list;
  }

  function renderHistory() {
    const nodes = [];

    nodes.push(
      el(
        'div',
        { class: 'range-strip' },
        [
          { days: 30, label: '30 天' },
          { days: 90, label: '90 天' },
          { days: 365, label: '一年' },
        ].map((range) =>
          el('button', {
            class: `range-pill${
              state.historyDays === range.days ? ' active' : ''
            }`,
            type: 'button',
            text: range.label,
            onclick: () => setHistoryDays(range.days),
          })
        )
      )
    );

    if (state.historyError) {
      nodes.push(el('div', { class: 'notice warn', text: state.historyError }));
    }

    if (state.historyLoading && !state.history) {
      nodes.push(el('div', { class: 'spinner' }));
      return nodes;
    }

    if (!state.history) {
      nodes.push(
        emptyState(
          '📡',
          '无法获取乘车记录',
          state.historyError || '检查网络与本机服务后重试。',
          '重试',
          () => loadHistory({ force: true })
        )
      );
      return nodes;
    }

    const items = historyInRange();
    if (!items.length) {
      nodes.push(
        emptyState(
          '🚏',
          '还没有乘车记录',
          `近 ${state.historyDays} 天没有查到已完成的乘车记录。`
        )
      );
      return nodes;
    }

    const thisMonthKey = `${new Date().getFullYear()}-${pad(
      new Date().getMonth() + 1
    )}`;
    const thisMonth = items.filter(
      (item) => String(item.time || '').slice(0, 7) === thisMonthKey
    ).length;
    const latest = items[0];

    nodes.push(
      el(
        'div',
        { class: 'stats-grid' },
        statCard(String(items.length), `近 ${state.historyDays} 天乘车`),
        statCard(String(thisMonth), '本月乘车'),
        statCard(topRoute(items), '最常乘坐'),
        statCard(monthDay(latest.time), '最近一次')
      )
    );

    const months = monthlyCounts(state.history.items, 12);
    const maxCount = Math.max(1, ...months.map((month) => month.count));
    nodes.push(
      el(
        'section',
        { class: 'panel' },
        el('h3', { text: '近 12 个月乘车次数' }),
        el(
          'div',
          { class: 'bar-chart' },
          months.map((month) =>
            el(
              'div',
              {
                class: 'bar-col',
                title: `${month.label}：${month.count} 次`,
              },
              el('div', {
                class: 'bar',
                style: `height:${Math.max(
                  3,
                  Math.round((month.count / maxCount) * 110)
                )}px`,
              }),
              el('span', { class: 'bar-label', text: month.label })
            )
          )
        )
      )
    );

    const panel = el(
      'section',
      { class: 'panel' },
      el('h3', { text: '最近乘车' })
    );
    const list = el('div', { class: 'ride-list' });
    items.slice(0, 50).forEach((item) => {
      list.append(
        el(
          'div',
          { class: 'ride-row' },
          el(
            'div',
            { class: 'ride-main' },
            el('div', { class: 'ride-route', text: item.route || '班车' }),
            el('div', {
              class: 'ride-time',
              text: `${monthDay(item.time)} ${timePart(item.time)}${
                item.sign_time ? ` · 签到 ${timePart(item.sign_time)}` : ''
              }`,
            })
          ),
          el('div', { class: 'ride-status', text: item.status || '' })
        )
      );
    });
    panel.append(list);
    if (items.length > 50) {
      panel.append(
        el('p', { class: 'panel-hint', text: `仅显示最近 50 条，共 ${items.length} 条。` })
      );
    }
    nodes.push(panel);

    return nodes;
  }

  function statCard(value, label) {
    return el(
      'div',
      { class: 'stat-card' },
      el('div', { class: 'stat-value', text: value }),
      el('div', { class: 'stat-label', text: label })
    );
  }

  async function loadHistory(options = {}) {
    const force = Boolean(options.force);
    if (state.historyLoading && !force) return;

    state.historyLoading = true;
    state.historyError = '';
    state.req.history += 1;
    const reqId = state.req.history;
    if (state.tab === 'history') renderMain();

    const start = shiftDays(-365);
    const end = new Date();

    try {
      const payload = await api(
        `/api/history?start=${ymd(start)}&end=${ymd(end)}`
      );
      if (reqId !== state.req.history) return;
      state.history = {
        start: payload.start,
        end: payload.end,
        items: Array.isArray(payload.items) ? payload.items : [],
      };
    } catch (err) {
      if (reqId !== state.req.history) return;
      state.historyError =
        err && err.message ? err.message : '获取乘车记录失败';
    } finally {
      if (reqId === state.req.history) {
        state.historyLoading = false;
        if (state.tab === 'history') renderMain();
      }
    }
  }

  function setHistoryDays(days) {
    if (![30, 90, 365].includes(days) || state.historyDays === days) return;
    state.historyDays = days;
    write(KEYS.historyDays, String(days));
    renderMain();
  }

  // ------------------------------------------------------------- settings tab
  function renderSegmented(options, current, onPick) {
    return el(
      'div',
      { class: 'segmented', role: 'group' },
      options.map((option) =>
        el('button', {
          class: `segment${option.value === current ? ' active' : ''}`,
          type: 'button',
          'aria-pressed': option.value === current ? 'true' : 'false',
          dataset: { value: option.value },
          text: option.label,
          onclick: () => onPick(option.value),
        })
      )
    );
  }

  function renderSettings() {
    const nodes = [];

    nodes.push(
      el(
        'section',
        { class: 'panel' },
        el('h3', { text: '本机服务' }),
        el(
          'label',
          { class: 'field' },
          el('span', { text: '服务地址' }),
          el('input', {
            id: 'settings-api',
            type: 'url',
            inputmode: 'url',
            placeholder: 'https://xxx.ts.net',
            autocomplete: 'off',
            autocapitalize: 'off',
            spellcheck: 'false',
            value: state.apiBase || '',
          })
        ),
        el('p', {
          class: 'panel-hint',
          text:
            `当前页面来源：${location.origin}。` +
            (needsApiBase()
              ? '填写 Tailscale Serve 的 https 地址。'
              : '页面由本机服务提供，可以留空。'),
        }),
        el(
          'div',
          { class: 'button-row' },
          el('button', {
            class: 'button primary small',
            type: 'button',
            text: '保存地址',
            onclick: saveApiBase,
          }),
          el('button', {
            class: 'button ghost small',
            type: 'button',
            text: '测试连接',
            onclick: () => testConnection('settings-api'),
          })
        )
      )
    );

    nodes.push(
      el(
        'section',
        { class: 'panel' },
        el('h3', { text: '账号' }),
        el('p', {
          class: 'panel-hint',
          text: state.username ? `当前登录：${state.username}` : '当前登录：—',
        }),
        el(
          'div',
          { class: 'button-row' },
          el('button', {
            class: 'button ghost small',
            type: 'button',
            text: '退出登录',
            onclick: doLogout,
          })
        )
      )
    );

    nodes.push(
      el(
        'section',
        { class: 'panel' },
        el('h3', { text: '外观' }),
        renderSegmented(
          [
            { value: 'auto', label: '跟随系统' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' },
          ],
          state.theme,
          setTheme
        )
      )
    );

    nodes.push(
      el(
        'section',
        { class: 'panel' },
        el('h3', { text: '本机数据' }),
        el('p', {
          class: 'panel-hint',
          text:
            '本页会在本机保存登录令牌和最近一次乘车码，方便离线打开。账号密码不会保存在网页里。',
        }),
        el(
          'div',
          { class: 'button-row' },
          el('button', {
            class: 'button ghost small',
            type: 'button',
            text: '清除缓存二维码',
            onclick: clearLocalCache,
          })
        )
      )
    );

    nodes.push(
      el(
        'section',
        { class: 'panel' },
        el('h3', { text: '关于' }),
        el('p', {
          class: 'panel-hint',
          text:
            '个人自用的班车乘车码页面。登录请求只发往你自己运行的本机服务，GitHub 上只有静态页面。',
        })
      )
    );

    return nodes;
  }

  function saveApiBase() {
    const input = $('#settings-api');
    if (!input) return;
    const value = normalizeBase(input.value);
    const previous = apiBase();

    state.apiBase = value;
    if (value) write(KEYS.api, value);
    else remove(KEYS.api);

    if (apiBase() !== previous) {
      clearAuth();
      remove(KEYS.lastQr);
      state.authMessage = '服务地址已更改，请重新登录';
      state.qr = null;
      state.qrShown = {};
      state.buses = [];
      state.history = null;
      render();
      toast('服务地址已保存，请重新登录');
      return;
    }
    toast('服务地址已保存');
  }

  function clearLocalCache() {
    remove(KEYS.lastQr);
    state.qr = null;
    toast('已清除本机缓存的二维码');
  }

  // -------------------------------------------------------------- full screen
  let wakeLock = null;

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (err) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      wakeLock.release();
    } catch (err) {
      /* ignore */
    }
    wakeLock = null;
  }

  function openFullscreen(item) {
    if (!item || !item.qr) return;
    closeFullscreen();
    const overlay = el(
      'div',
      {
        class: 'fullscreen',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '乘车码全屏',
      },
      el('button', {
        class: 'fullscreen-close',
        type: 'button',
        text: '关闭',
        onclick: closeFullscreen,
      }),
      el('div', {
        class: 'fullscreen-meta',
        text: `${item.route || '班车'} ${qrWhenText(item.time)}`.trim(),
      }),
      el('img', {
        class: 'fullscreen-qr',
        src: item.qr,
        alt: '乘车二维码',
      }),
      el('div', {
        class: 'fullscreen-hint',
        text: '把屏幕亮度调高，二维码对准扫码器',
      })
    );
    state.fullscreenNode = overlay;
    document.body.append(overlay);
    document.body.classList.add('locked');
    requestWakeLock();
  }

  function closeFullscreen() {
    if (state.fullscreenNode) {
      state.fullscreenNode.remove();
      state.fullscreenNode = null;
    }
    document.body.classList.remove('locked');
    releaseWakeLock();
  }

  // ------------------------------------------------------------------ actions
  function switchTab(tabId) {
    if (!TABS.some((tab) => tab.id === tabId)) return;
    closeFullscreen();
    state.tab = tabId;
    if (tabId === 'qr') hydrateQrCache();
    render();

    if (tabId === 'qr') {
      const fresh =
        state.qr &&
        state.qr.fetchedAt &&
        Date.now() - state.qr.fetchedAt < 60000;
      if (!fresh) loadQr();
    } else if (tabId === 'buses') {
      // If the page stayed open past midnight, do not keep showing yesterday.
      ensureTodayOrLater();
      loadBuses();
    } else if (tabId === 'history') {
      loadHistory();
    }
  }

  function refreshCurrent() {
    if (state.tab === 'qr') loadQr({ force: true });
    else if (state.tab === 'buses') {
      ensureTodayOrLater();
      loadBuses();
    } else if (state.tab === 'history') loadHistory({ force: true });
  }

  // ------------------------------------------------------------- serviceworker
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        /* served over http without localhost? PWA features just stay off. */
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  // --------------------------------------------------------------------- init
  function init() {
    state.theme = read(KEYS.theme) || 'auto';
    // Always land on the QR tab: this page is launched from the home screen
    // primarily to show the boarding code as fast as possible.
    state.tab = 'qr';
    state.apiBase = normalizeBase(read(KEYS.api) || '');
    state.token = read(KEYS.token) || '';
    state.username = read(KEYS.username) || '';
    state.busesDate = ymd(new Date());

    const savedDays = Number(read(KEYS.historyDays));
    state.historyDays = [30, 90, 365].includes(savedDays) ? savedDays : 30;

    applyTheme();
    registerServiceWorker();

    if (!state.token) {
      render();
      return;
    }

    if (state.tab === 'qr') hydrateQrCache();
    render();

    if (state.tab === 'qr') loadQr();
    else if (state.tab === 'buses') loadBuses();
    else if (state.tab === 'history') loadHistory();
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.fullscreenNode) closeFullscreen();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.token) return;
    if (state.fullscreenNode) {
      requestWakeLock();
      return;
    }
    if (state.tab === 'qr') {
      const fresh =
        state.qr &&
        state.qr.fetchedAt &&
        Date.now() - state.qr.fetchedAt < 60000;
      if (!fresh) loadQr();
    }
  });

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', () => {
      if (state.theme === 'auto') applyTheme();
    });
  }

  init();
})();
