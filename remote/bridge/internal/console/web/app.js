'use strict';
/* Salcara Bridge console — plain JS, no build step. Every dynamic string goes through esc(). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14.5 8.5l2 2"/>',
  plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  warn: '<path d="M12 3 2 20h20z"/><path d="M12 10v5M12 17.5v.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  phone: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M11 18.5h2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
  chev: '<path d="m9 6 6 6-6 6"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="m3 7.5 9 4.5 9-4.5M12 12v9"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
  power: '<path d="M12 3v9"/><path d="M6.3 7.5a8 8 0 1 0 11.4 0"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M16 13h2M3 10h18M6 6l9-3 1 3"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] || ''}</svg>`;
const ico = (n) => `<span class="ico">${icon(n)}</span>`;

const STATUS = {
  connected: '已连接',
  connecting: '连接中',
  not_logged_in: '未登录',
  invalid_key: 'Key 无效',
};
const TOOL_LABEL = { codex: 'Codex', claude: 'Claude Code', 'claude-desktop': 'Claude Desktop' };
const SESSION_STATUS = { running: '运行中', idle: '空闲', waiting_approval: '等待审批', failed: '失败' };

const S = {
  state: null,
  route: 'overview',
  sessions: [],
  sessFilter: '',
  sessLoading: false,
  openKey: null,
  openInfo: null,
  tl: [],
  tlIndex: new Map(),
  approvals: [],
  revealed: {},
  editingName: false,
  pairCode: null,
  pairExpires: 0,
};

/* ---------------- utilities ---------------- */

async function api(path, body, method) {
  const opts = { method: method || (body !== undefined ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('连不上 Salcara Bridge，程序可能已经退出');
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
  return data;
}

/* 系统相关的文案：Finder / 资源管理器 / 文件管理器 */
const OSX = () => (S.state && S.state.os) || '';
const fileMgr = () => ({ darwin: '访达', windows: '资源管理器' })[OSX()] || '文件管理器';
const openWord = () => OSX() === 'darwin' ? '在访达中显示' : '打开文件夹';
const launchHint = () => OSX() === 'darwin' ? '在“应用程序”里打开 Salcara Bridge' : '双击程序';

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 5200 : 3000);
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`已复制${what ? ' ' + what : ''}`, 'ok');
}

function relTime(ms) {
  if (!ms) return '';
  const d = Date.now() - ms;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
  if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + ' 天前';
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : null));
function money(v, unit) {
  const n = num(v);
  if (n === null) return '—';
  const u = (unit || 'USD').toUpperCase();
  const s = Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
  return u === 'USD' ? '$' + s : s + ' ' + u;
}
function compact(v) {
  const n = num(v);
  if (n === null) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function pct(used, limit) {
  const u = num(used), l = num(limit);
  if (u === null || !l) return null;
  return Math.max(0, Math.min(100, (u / l) * 100));
}
function bar(p) {
  if (p === null) return '';
  const cls = p >= 90 ? 'bad' : p >= 70 ? 'warn' : '';
  return `<div class="bar ${cls}"><i style="width:${p.toFixed(1)}%"></i></div>`;
}

function statusPill(st) {
  const s = (st && st.state) || 'not_logged_in';
  return `<span class="st-${esc(s)}"><span class="dot"></span></span>`;
}

function toolChip(tool, client) {
  let cls = 't-codex', label = client || TOOL_LABEL[tool] || tool;
  if (tool === 'claude') cls = /desktop/i.test(client || '') ? 't-desktop' : 't-claude';
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

function renderText(t) {
  // minimal markdown: fenced code blocks + inline code
  const parts = String(t || '').split(/```/);
  return parts.map((p, i) => {
    if (i % 2 === 1) return `<pre>${esc(p.replace(/^[\w-]*\n/, ''))}</pre>`;
    return esc(p).replace(/`([^`\n]+)`/g, '<code>$1</code>');
  }).join('');
}

function renderDiff(d) {
  return String(d || '').split('\n').map((l) => {
    const c = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
    return `<span class="${c}">${esc(l)}</span>`;
  }).join('\n');
}

/* ---------------- shell ---------------- */

const PAGES = {
  overview: { title: '概览', sub: '这台电脑的连接状态、中转站余额和编程工具' },
  login: { title: '登录 / 中转站', sub: '填写你的中转站地址和 API Key，手机用同一个 Key 登录就能看到这台电脑' },
  tools: { title: '工具配置', sub: '一键把本机的 Claude Code / Codex 接入中转站' },
  projects: { title: '项目文件夹', sub: '手机只能在这些文件夹里发起任务' },
  sessions: { title: '会话', sub: '这台电脑上所有 Codex / Claude Code 会话，可以在这里实时查看和审批' },
  settings: { title: '设置', sub: '开机自启、审批策略、日志与退出' },
};

function setConn(st) {
  const s = (st && st.state) || 'not_logged_in';
  const pill = $('#connPill');
  pill.className = 'conn st-' + s;
  $('.conn-label', pill).textContent = STATUS[s] || s;
  pill.title = (st && st.error) || '';
  const hero = $('#heroStatus');
  if (hero) {
    hero.className = 'hero-status st-' + s;
    $('.lbl', hero).textContent = STATUS[s] || s;
    const er = $('#heroErr');
    if (er) er.textContent = st && st.error && s !== 'connected' ? st.error : '';
  }
}

function setApprovalBadge() {
  const b = $('#approvalBadge');
  b.hidden = S.approvals.length === 0;
  b.textContent = S.approvals.length;
}

async function loadState() {
  S.state = await api('/api/state');
  setConn(S.state.hub);
  $('#sideVer').textContent = `v${S.state.version} · ${({ windows: 'Windows', darwin: 'macOS', linux: 'Linux' })[S.state.os] || S.state.os}`;
  return S.state;
}

async function route() {
  const r = (location.hash || '#overview').slice(1).split('/')[0];
  S.route = PAGES[r] ? r : 'overview';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === S.route));
  $('#pageTitle').textContent = PAGES[S.route].title;
  $('#pageSub').textContent = PAGES[S.route].sub;
  $('#headActions').innerHTML = '';
  const view = $('#view');
  view.innerHTML = '<div class="card"><div class="skeleton" style="width:40%"></div><div class="skeleton" style="width:70%;margin-top:12px"></div></div>';
  try {
    await RENDER[S.route](view);
  } catch (e) {
    view.innerHTML = `<div class="callout bad">${ico('warn')}<div>${esc(e.message)}</div></div>`;
  }
}

/* ---------------- 概览 ---------------- */

function usageCards(u, err) {
  if (err) return `<div class="callout warn">${ico('warn')}<div>读取中转站用量失败：${esc(err)}</div></div>`;
  if (!u) return '';
  const unit = u.unit || 'USD';
  const cards = [];
  const today = (u.usage && u.usage.today) || {};
  const total = (u.usage && u.usage.total) || {};
  if (num(u.remaining) !== null || num(u.balance) !== null) {
    cards.push(`<div class="card stat"><div class="stat-label">${ico('wallet')}${esc(u.planName || '剩余额度')}</div>
      <div class="stat-value">${money(num(u.remaining) ?? u.balance, unit)}</div>
      <div class="stat-foot">${u.mode === 'quota_limited' ? 'Key 限额模式' : '账户可用'}</div></div>`);
  }
  if (u.quota && typeof u.quota === 'object') {
    const p = pct(u.quota.used, u.quota.limit);
    cards.push(`<div class="card stat"><div class="stat-label">${ico('key')}Key 总额度</div>
      <div class="stat-value">${money(u.quota.used, u.quota.unit || unit)}<span class="muted small"> / ${money(u.quota.limit, u.quota.unit || unit)}</span></div>${bar(p)}</div>`);
  }
  if (today && (today.cost !== undefined || today.requests !== undefined)) {
    cards.push(`<div class="card stat"><div class="stat-label">${ico('bolt')}今日消费</div>
      <div class="stat-value">${money(num(today.actual_cost) ?? today.cost, unit)}</div>
      <div class="stat-foot">${compact(today.requests)} 次请求 · ${compact(today.total_tokens)} tokens</div></div>`);
  }
  if (total && (total.cost !== undefined || total.requests !== undefined)) {
    cards.push(`<div class="card stat"><div class="stat-label">${ico('clock')}累计消费</div>
      <div class="stat-value">${money(num(total.actual_cost) ?? total.cost, unit)}</div>
      <div class="stat-foot">${compact(total.requests)} 次请求 · ${compact(total.total_tokens)} tokens</div></div>`);
  }
  const sub = u.subscription;
  if (sub && typeof sub === 'object') {
    [['daily', '今日'], ['weekly', '本周'], ['monthly', '本月']].forEach(([k, label]) => {
      const lim = num(sub[k + '_limit_usd']);
      if (lim) {
        cards.push(`<div class="card stat"><div class="stat-label">${ico('clock')}订阅 · ${label}</div>
          <div class="stat-value">${money(sub[k + '_usage_usd'], 'USD')}<span class="muted small"> / ${money(lim, 'USD')}</span></div>${bar(pct(sub[k + '_usage_usd'], lim))}</div>`);
      }
    });
  }
  if (Array.isArray(u.rate_limits)) {
    u.rate_limits.forEach((r) => {
      cards.push(`<div class="card stat"><div class="stat-label">${ico('clock')}${esc(r.window)} 限额</div>
        <div class="stat-value">${money(r.used, 'USD')}<span class="muted small"> / ${money(r.limit, 'USD')}</span></div>${bar(pct(r.used, r.limit))}</div>`);
    });
  }
  if (!cards.length) return '';
  let extra = '';
  if (u.days_until_expiry !== undefined && u.days_until_expiry !== null) extra = `<div class="muted small">Key 还有 ${esc(u.days_until_expiry)} 天到期</div>`;
  return `<div class="grid grid-auto">${cards.slice(0, 8).join('')}</div>${extra}`;
}

function toolCard(t, extra) {
  const cls = t.id === 'codex' ? 'codex' : t.id === 'claude' ? 'claude' : 'desktop';
  const letter = t.id === 'codex' ? 'Cx' : t.id === 'claude' ? 'CC' : 'CD';
  return `<div class="card tool-card">
    <div class="tool-head"><span class="tool-logo ${cls}">${letter}</span>
      <div><div class="tool-name">${esc(t.name || TOOL_LABEL[t.id])}</div>
      <div class="muted small">${t.available ? (t.version ? '版本 ' + esc(t.version) : '已安装') : '没有在这台电脑上找到'}</div></div>
      <span class="spacer"></span>${t.available ? '<span class="chip ok">已安装</span>' : '<span class="chip">未安装</span>'}</div>
    ${extra || ''}</div>`;
}

RENDER_overview = async function (view) {
  const st = await loadState();
  const c = st.config;
  const hub = st.hub || {};
  const s = hub.state || 'not_logged_in';
  const tools = (st.tools || []).slice();
  if (!tools.find((t) => t.id === 'codex')) tools.push({ id: 'codex', name: 'Codex', available: false });
  if (!tools.find((t) => t.id === 'claude')) tools.push({ id: 'claude', name: 'Claude Code', available: false });
  tools.push(st.desktop || { id: 'claude-desktop', name: 'Claude Desktop', available: false });
  $('#headActions').innerHTML = `<button class="btn" data-act="refresh">${icon('refresh')}刷新</button>`;

  view.innerHTML = `
  <div class="card hero">
    <div class="hero-top">
      <span id="heroStatus" class="hero-status st-${esc(s)}"><span class="dot"></span><span class="lbl">${esc(STATUS[s] || s)}</span></span>
      <span class="hero-meta">${c.relayRoot ? esc(c.relayRoot.replace(/^https?:\/\//, '')) : '还没有登录中转站'}</span>
      <span class="spacer"></span>
      ${c.loggedIn ? '' : `<a class="btn sm" href="#login" style="background:#fff;color:#3D7BFA;border:none">去登录</a>`}
    </div>
    <div class="hero-device" id="devName">${S.editingName
      ? `<input class="input inline-input" id="devInput" value="${esc(c.deviceName)}" maxlength="40"><button class="btn sm" data-act="saveName" style="background:#fff;color:#3D7BFA;border:none">保存</button><button class="btn sm ghost" data-act="cancelName" style="color:#fff">取消</button>`
      : `${esc(c.deviceName)}<button class="icon-btn" data-act="editName" title="修改设备名称">${icon('edit')}</button>`}</div>
    <div class="hero-meta" id="heroErr">${hub.error && s !== 'connected' ? esc(hub.error) : ''}</div>
    <div class="hero-hint">${ico('phone')}<div>电脑与手机使用同一个中转站 Key，再输入一次性配对码即可连接。</div></div>
  </div>
  <div class="card pair-card"><div class="row"><div class="li-main"><div class="li-title">配对这台电脑</div><div class="li-sub">配对码只在本机显示，5 分钟有效。重新配对会让旧手机失效。</div></div>
  <button class="btn primary" data-act="pairStart" ${s === 'connected' ? '' : 'disabled'}>生成配对码</button></div>
  <div id="pairCode" class="pair-code">${S.pairCode && S.pairExpires > Date.now() ? esc(S.pairCode) : ''}</div></div>
  <div id="approvalsBox"></div>
  <div id="usageBox">${c.loggedIn ? '<div class="grid grid-4">' + '<div class="card stat"><div class="skeleton"></div><div class="skeleton" style="margin-top:12px;height:24px;width:60%"></div></div>'.repeat(4) + '</div>' : ''}</div>
  <div class="grid grid-3">${tools.map((t) => toolCard(t)).join('')}</div>
  <div class="card"><div class="row">
    <div class="folder-ico">${icon('chat')}</div>
    <div class="li-main"><div class="li-title" id="sessCount">正在统计会话…</div><div class="li-sub">包括在终端、VS Code、Claude Desktop 里开的会话，以及手机发起的任务</div></div>
    <a class="btn" href="#sessions">查看会话</a></div></div>`;
  renderApprovalsBox();
  if (c.loggedIn) {
    api('/api/usage').then((r) => { const b = $('#usageBox'); if (b) b.innerHTML = usageCards(r.usage, r.error); }).catch((e) => { const b = $('#usageBox'); if (b) b.innerHTML = usageCards(null, e.message); });
  }
  api('/api/sessions').then((r) => {
    const el = $('#sessCount');
    if (!el) return;
    const list = r.sessions || [];
    const running = list.filter((x) => x.status === 'running' || x.status === 'waiting_approval').length;
    el.textContent = `最近 ${list.length} 个会话` + (running ? ` · ${running} 个正在运行` : '');
  }).catch(() => { const el = $('#sessCount'); if (el) el.textContent = '会话读取失败'; });
};

function renderApprovalsBox() {
  const box = $('#approvalsBox');
  if (!box) return;
  if (!S.approvals.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="card appr-banner"><div class="card-head"><h3 class="card-title">${ico('warn')}有 ${S.approvals.length} 个操作等待批准</h3><a href="#sessions" class="btn sm">打开会话</a></div>
    ${S.approvals.map((a) => `<div class="appr-row"><div class="li-main"><div class="li-title">${esc(a.title || '需要批准')}</div><div class="li-sub">${esc(a.sessionKey)}${a.cwd ? ' · ' + esc(a.cwd) : ''}</div></div>
    <button class="btn sm primary" data-act="approve" data-id="${esc(a.approvalId)}" data-d="allow">允许</button>
    <button class="btn sm danger" data-act="approve" data-id="${esc(a.approvalId)}" data-d="deny">拒绝</button></div>`).join('')}</div>`;
}

/* ---------------- 登录 / 中转站 ---------------- */

RENDER_login = async function (view) {
  const st = await loadState();
  const c = st.config;
  const keyPh = c.accountKey ? `已保存 ${c.accountKey}，留空表示不修改` : 'sk-…';
  view.innerHTML = `
  <div class="card">
    <div class="card-head"><div><h3 class="card-title">${ico('key')}中转站账号</h3>
      <p class="card-sub">Bridge 用这个 Key 登录远程编程服务；只有中转站的有效用户才能使用。</p></div>
      ${c.loggedIn ? `<span class="chip ok">${icon('check')}已登录</span>` : '<span class="chip">未登录</span>'}</div>
    <div class="form-grid">
      <div class="field"><label for="fRoot">中转站地址</label>
        <input class="input" id="fRoot" placeholder="https://api.example.com" value="${esc(c.relayRoot)}">
        <span class="help">填网站根地址即可，不用带 /v1</span></div>
      <div class="field"><label for="fKey">API Key</label>
        <div class="input-wrap"><input class="input" id="fKey" type="password" autocomplete="off" placeholder="${esc(keyPh)}">
        <button class="icon-btn" data-act="toggleVis" data-for="fKey" title="显示/隐藏">${icon('eye')}</button></div>
        <span class="help">在中转站网页「API 密钥」里创建；手机端用同一个 Key</span></div>
    </div>
    <div class="divider"></div>
    <details class="adv"${c.codexKey || c.claudeKey || c.hubUrl ? ' open' : ''}><summary><span class="chev">${icon('chev')}</span>高级：给 Codex / Claude Code 分别指定 Key</summary>
      <div class="callout" style="margin:14px 0">${ico('info')}<div>sub2api 的分组是按平台划分的：<b>Codex 需要 OpenAI 分组的 Key</b>，<b>Claude Code 需要 Anthropic（Claude）分组的 Key</b>。如果你的账号 Key 只属于一个分组，另一个工具就在这里填对应分组的 Key；留空表示使用上面的账号 Key。</div></div>
      <div class="form-grid">
        <div class="field"><label for="fCodex">Codex Key（OpenAI 分组）</label>
          <div class="input-wrap"><input class="input" id="fCodex" type="password" autocomplete="off" placeholder="${esc(c.codexKey ? '已保存 ' + c.codexKey + '，留空不修改' : '留空 = 使用账号 Key')}">
          <button class="icon-btn" data-act="toggleVis" data-for="fCodex">${icon('eye')}</button></div>
          ${c.codexKey ? '<label class="row small muted" style="font-weight:500"><input type="checkbox" id="fCodexClear"> 清除，改用账号 Key</label>' : ''}</div>
        <div class="field"><label for="fClaude">Claude Key（Anthropic 分组）</label>
          <div class="input-wrap"><input class="input" id="fClaude" type="password" autocomplete="off" placeholder="${esc(c.claudeKey ? '已保存 ' + c.claudeKey + '，留空不修改' : '留空 = 使用账号 Key')}">
          <button class="icon-btn" data-act="toggleVis" data-for="fClaude">${icon('eye')}</button></div>
          ${c.claudeKey ? '<label class="row small muted" style="font-weight:500"><input type="checkbox" id="fClaudeClear"> 清除，改用账号 Key</label>' : ''}</div>
        <div class="field"><label for="fHub">远程编程服务地址（可选）</label>
          <input class="input" id="fHub" placeholder="${esc(c.relayRoot ? c.relayRoot + '/salcara-hub' : '默认 = 中转站地址/salcara-hub')}" value="${esc(c.hubUrl)}">
          <span class="help">一般不用填，默认是 中转站地址/salcara-hub</span></div>
      </div>
    </details>
    <div class="form-actions">
      <button class="btn grad" data-act="login">${icon('check')}保存并登录</button>
      <button class="btn" data-act="testKey">测试连接</button>
      <span class="spacer"></span>
      ${c.loggedIn ? `<button class="btn ghost" data-act="logout">退出登录</button>` : ''}
    </div>
    <div id="testResult" style="margin-top:14px"></div>
  </div>
  <div class="card"><h3 class="card-title">${ico('info')}这些信息怎么用</h3>
    <ul class="muted" style="margin:10px 0 0;padding-left:20px;line-height:1.9">
      <li>账号 Key 只用于登录远程编程服务（服务端只保存它的哈希），和手机端互相识别。</li>
      <li>在手机上发起的任务，Bridge 会把中转站地址和对应的 Key 注入 Codex / Claude Code 进程，费用照常记在你的中转站账户。</li>
      <li>Key 保存在本机配置文件 <code>${esc(c.configPath)}</code>（权限 0600，仅当前用户可读）。</li>
    </ul></div>`;
};

function testResultHTML(u) {
  const parts = [];
  if (u.planName) parts.push(esc(u.planName));
  if (num(u.remaining) !== null) parts.push('剩余 ' + money(u.remaining, u.unit));
  if (u.usage && u.usage.today) parts.push('今日 ' + compact(u.usage.today.requests) + ' 次请求');
  return `<div class="callout ok">${ico('check')}<div>Key 有效${parts.length ? '：' + parts.join(' · ') : ''}</div></div>`;
}

/* ---------------- 工具配置 ---------------- */

RENDER_tools = async function (view) {
  const [st, tc] = await Promise.all([loadState(), api('/api/toolcfg')]);
  const c = st.config;
  const loggedIn = c.loggedIn;
  const cl = tc.claude, cx = tc.codex;
  const toolOf = (id) => (st.tools || []).find((t) => t.id === id) || { available: false };
  const stateChip = (x) => x.configured ? `<span class="chip ok">${icon('check')}已接入中转站</span>` : (x.error ? '<span class="chip bad">读取失败</span>' : '<span class="chip warn">未接入</span>');
  const needLogin = loggedIn ? '' : `<div class="callout warn">${ico('warn')}<div>请先在 <a href="#login">登录 / 中转站</a> 填写中转站地址和 Key，再一键配置。</div></div>`;
  const isWin = tc.os === 'windows';
  const mode = tc.codexAuthMode || 'token';
  view.innerHTML = `${needLogin}
  <div class="grid grid-2">
    <div class="card tool-card">
      <div class="tool-head"><span class="tool-logo claude">CC</span><div><div class="tool-name">Claude Code</div>
        <div class="muted small">${toolOf('claude').available ? '已安装 ' + esc(toolOf('claude').version || '') : '未检测到 claude 命令'}</div></div>
        <span class="spacer"></span>${stateChip(cl)}</div>
      <dl class="kv"><dt>配置文件</dt><dd class="mono">${esc(cl.path)} <button class="btn sm" data-act="reveal" data-w="claude">${icon('folder')}${openWord()}</button></dd>
        <dt>当前地址</dt><dd>${cl.baseUrl ? esc(cl.baseUrl) : '<span class="muted">官方（未设置 ANTHROPIC_BASE_URL）</span>'}</dd>
        <dt>Key</dt><dd>${cl.tokenMatches ? '<span class="chip ok">与 Bridge 一致</span>' : '<span class="muted">未设置或不同</span>'}</dd>
        <dt>备份</dt><dd>${cl.hasBackup ? '已备份原配置 <code>settings.json.salcara-bak</code>' : '<span class="muted">无</span>'}</dd></dl>
      ${cl.apiKeySet ? `<div class="callout warn">${ico('warn')}<div>settings.json 里还设置了 <code>ANTHROPIC_API_KEY</code>，它的优先级更高，可能导致不走中转站。建议删掉。</div></div>` : ''}
      ${cl.error ? `<div class="callout bad">${ico('warn')}<div>${esc(cl.error)}</div></div>` : ''}
      <div class="muted small">写入 <code>env</code>：<code>ANTHROPIC_BASE_URL</code> = 中转站地址（不带 /v1）、<code>ANTHROPIC_AUTH_TOKEN</code> = Claude Key、<code>CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC</code> = 1。其他设置保持不变，第一次修改前自动备份。</div>
      <div class="row"><button class="btn primary" data-act="toolcfg" data-tool="claude" data-a="apply" ${loggedIn ? '' : 'disabled'}>一键配置</button>
        <button class="btn" data-act="toolcfg" data-tool="claude" data-a="restore">恢复原配置</button></div>
    </div>

    <div class="card tool-card">
      <div class="tool-head"><span class="tool-logo codex">Cx</span><div><div class="tool-name">Codex</div>
        <div class="muted small">${toolOf('codex').available ? '已安装 ' + esc(toolOf('codex').version || '') : '未检测到 codex 命令'}</div></div>
        <span class="spacer"></span>${stateChip(cx)}</div>
      <dl class="kv"><dt>配置文件</dt><dd class="mono">${esc(cx.path)} <button class="btn sm" data-act="reveal" data-w="codex">${icon('folder')}${openWord()}</button></dd>
        <dt>当前提供方</dt><dd>${cx.provider ? esc(cx.provider) : '<span class="muted">openai（默认）</span>'}</dd>
        <dt>地址</dt><dd>${cx.baseUrl ? esc(cx.baseUrl) : '<span class="muted">—</span>'}</dd>
        <dt>认证方式</dt><dd>${cx.authMode === 'env' ? '环境变量 ' + esc(tc.envKeyName) : cx.authMode === 'token' ? 'Key 写在配置文件里' : '<span class="muted">—</span>'}</dd>
        <dt>备份</dt><dd>${cx.hasBackup ? '已备份原配置 <code>config.toml.salcara-bak</code>' : '<span class="muted">无</span>'}</dd></dl>
      <div class="field"><label>Key 保存方式</label>
        <div class="radio-cards" style="grid-template-columns:1fr 1fr">
          <label class="radio-card ${mode !== 'env' ? 'sel' : ''}"><input type="radio" name="cxmode" value="token" ${mode !== 'env' ? 'checked' : ''}><span class="t">写入配置文件</span><span class="d">experimental_bearer_token，最省事（Key 以明文存在 config.toml）</span></label>
          <label class="radio-card ${mode === 'env' ? 'sel' : ''}"><input type="radio" name="cxmode" value="env" ${mode === 'env' ? 'checked' : ''}><span class="t">环境变量</span><span class="d">env_key = ${esc(tc.envKeyName)}${isWin ? '，自动用 setx 设置' : tc.os === 'darwin' ? '，需要自己在 ~/.zshrc 里 export（从程序坞打开的 App 读不到，Mac 上推荐左边的方式）' : '，需要你自己在 shell 里 export'}</span></label>
        </div></div>
      <div class="muted small">设置 <code>model_provider = "salcara"</code>，并写入 <code>[model_providers.salcara]</code>：base_url = 中转站地址/v1、wire_api = "responses"、requires_openai_auth = false、supports_websockets = false。其他配置和注释保持不变，第一次修改前自动备份。</div>
      <div class="row"><button class="btn primary" data-act="toolcfg" data-tool="codex" data-a="apply" ${loggedIn ? '' : 'disabled'}>一键配置</button>
        <button class="btn" data-act="toolcfg" data-tool="codex" data-a="restore">恢复原配置</button></div>
    </div>
  </div>

  <div class="card tool-card">
    <div class="tool-head"><span class="tool-logo desktop">CD</span><div><div class="tool-name">Claude Desktop</div>
      <div class="muted small">${tc.desktop && tc.desktop.available ? '已安装 ' + esc(tc.desktop.version || '') : '没有检测到 Claude 桌面版'}</div></div>
      <span class="spacer"></span><span class="chip info">在应用内设置</span></div>
    <p class="muted" style="margin:0">Claude 桌面版的第三方模型接入在应用里设置，按下面几步操作即可（只需一次）：</p>
    <ol class="steps">
      <li><div>打开 Claude 桌面版，${tc.os === 'darwin' ? '屏幕顶部菜单栏' : '菜单'} <b>Help → Troubleshooting → Enable Developer Mode</b>。</div></li>
      <li><div>菜单 <b>Developer → Configure Third-Party Inference</b>。</div></li>
      <li><div><b>Connection type</b> 选 <b>Gateway</b>，<b>Credential</b> 选 <b>Static API key</b>，<b>Auth scheme</b> 选 <b>Bearer</b>。</div></li>
      <li><div style="flex:1;min-width:0"><b>Gateway base URL</b> 填：
        <div class="copy-field"><code>${esc(c.relayRoot || '（请先登录中转站）')}</code><button class="btn sm" data-act="copyVal" data-v="${esc(c.relayRoot)}" data-w="地址" ${c.relayRoot ? '' : 'disabled'}>${icon('copy')}复制</button></div></div></li>
      <li><div style="flex:1;min-width:0"><b>API key</b> 填你的 Claude Key：
        <div class="copy-field"><code>${esc(c.claudeKey || c.accountKey || '（请先登录中转站）')}</code><button class="btn sm" data-act="copySecret" data-which="claude" ${loggedIn ? '' : 'disabled'}>${icon('copy')}复制</button></div></div></li>
      <li><div>保存后重启 Claude 桌面版${tc.os === 'darwin' ? '（⌘Q 完全退出再打开）' : ''}。${tc.desktopConfigDir ? `它的设置保存在 <code>${esc(tc.desktopConfigDir)}</code>。` : ''}</div></li>
    </ol>
    <div class="callout">${ico('info')}<div>Claude 桌面版里 <b>Code</b> 标签页的会话本质上就是 Claude Code 会话，会出现在「会话」页面里（标记为 Claude Desktop），手机上也能看到。</div></div>
  </div>`;
};

/* ---------------- 项目文件夹 ---------------- */

RENDER_projects = async function (view) {
  const st = await loadState();
  const ps = st.config.projects || [];
  view.innerHTML = `
  <div class="callout">${ico('info')}<div>为了安全，手机只能在下面这些文件夹（以及它们的子文件夹）里新建任务。会话里的命令也在这些文件夹里执行。</div></div>
  <div class="card">
    <div class="card-head"><h3 class="card-title">${ico('plus')}添加文件夹</h3></div>
    <div class="row" style="flex-wrap:nowrap">
      <input class="input" id="projPath" placeholder="${st.os === 'windows' ? 'C:\\code\\my-app' : esc((st.home || (st.os === 'darwin' ? '/Users/me' : '/home/me')) + '/code/my-app')}">
      <button class="btn" data-act="browse">${icon('folder')}浏览…</button>
      <button class="btn primary" data-act="addProj">添加</button>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><h3 class="card-title">${ico('folder')}允许的文件夹 <span class="chip">${ps.length}</span></h3></div>
    ${ps.length ? `<div class="list">${ps.map((p) => `<div class="list-item"><div class="folder-ico">${icon('folder')}</div>
      <div class="li-main"><div class="li-title">${esc(p.name)}</div><div class="li-sub mono">${esc(p.path)}</div></div>
      <button class="btn sm danger" data-act="rmProj" data-path="${esc(p.path)}">${icon('trash')}移除</button></div>`).join('')}</div>`
      : `<div class="empty"><div class="big">还没有允许任何文件夹</div>添加你平时写代码的项目文件夹，手机上就能选它来发任务</div>`}
  </div>`;
};

async function openBrowser(start) {
  const root = $('#modalRoot');
  let cur = null;
  async function load(p) {
    try {
      cur = await api('/api/fs?path=' + encodeURIComponent(p || ''));
    } catch (e) { toast(e.message, 'bad'); return; }
    root.innerHTML = `<div class="modal-back" data-act="closeModal"><div class="modal" data-stop>
      <div class="modal-head"><h3>选择项目文件夹</h3><button class="icon-btn" data-act="closeModal">✕</button></div>
      <div class="modal-body">
        <div class="roots">${cur.roots.map((r) => `<button class="btn sm" data-act="fsGo" data-p="${esc(r.path)}">${esc(r.name)}</button>`).join('')}</div>
        <div class="crumb">${esc(cur.path)}</div>
        <div style="margin:8px 0 14px">
          ${cur.parent ? `<div class="dir" data-act="fsGo" data-p="${esc(cur.parent)}">${ico('up')}<span>上一级</span></div>` : ''}
          ${cur.dirs.length ? cur.dirs.map((d) => `<div class="dir" data-act="fsGo" data-p="${esc(d.path)}">${ico('folder')}<span>${esc(d.name)}</span></div>`).join('') : '<div class="empty small">没有子文件夹</div>'}
        </div>
      </div>
      <div class="modal-foot"><span class="muted small" style="margin-right:auto">选中的是当前打开的文件夹</span>
        <button class="btn" data-act="closeModal">取消</button><button class="btn primary" data-act="fsPick">选择这个文件夹</button></div>
    </div></div>`;
  }
  S.fsLoad = load;
  S.fsCur = () => cur;
  await load(start);
}

/* ---------------- 会话 ---------------- */

RENDER_sessions = async function (view) {
  $('#headActions').innerHTML = `<button class="btn" data-act="reloadSessions">${icon('refresh')}刷新</button>`;
  view.innerHTML = `
  <div class="row"><div class="filters">
    ${[['', '全部'], ['codex', 'Codex'], ['claude', 'Claude Code / Desktop']].map(([k, l]) => `<button class="filter ${S.sessFilter === k ? 'on' : ''}" data-act="sessFilter" data-k="${k}">${l}</button>`).join('')}
  </div></div>
  <div id="approvalsBox"></div>
  <div class="sess-layout">
    <div class="card sess-list" id="sessList"><div class="skeleton"></div><div class="skeleton" style="margin-top:12px;width:70%"></div></div>
    <div class="card detail" id="sessDetail"><div class="empty" style="margin:auto"><div class="big">选择一个会话</div>查看实时进度、批准操作，或者继续对话</div></div>
  </div>`;
  renderApprovalsBox();
  await loadSessions();
  if (S.openKey) openSession(S.openKey, true);
};

async function loadSessions() {
  try {
    const r = await api('/api/sessions' + (S.sessFilter ? '?tool=' + S.sessFilter : ''));
    S.sessions = r.sessions || [];
  } catch (e) {
    const el = $('#sessList');
    if (el) el.innerHTML = `<div class="callout bad">${ico('warn')}<div>${esc(e.message)}</div></div>`;
    return;
  }
  renderSessionList();
}

function renderSessionList() {
  const el = $('#sessList');
  if (!el) return;
  if (!S.sessions.length) {
    el.innerHTML = '<div class="empty"><div class="big">还没有会话</div>在终端里用 codex / claude，或者在手机上发起任务后，会话会出现在这里</div>';
    return;
  }
  el.innerHTML = S.sessions.map((s) => `<div class="sess ${s.sessionKey === S.openKey ? 'sel' : ''}" data-act="openSess" data-k="${esc(s.sessionKey)}">
    <div class="sess-title">${esc(s.title || '（无标题）')}</div>
    <div class="sess-meta">${toolChip(s.tool, s.client)}<span class="status-dot s-${esc(s.status)}"></span>${esc(SESSION_STATUS[s.status] || s.status)}<span class="spacer"></span>${esc(relTime(s.updatedAt))}</div>
    ${s.cwd ? `<div class="sess-cwd">${esc(s.cwd)}</div>` : ''}</div>`).join('');
}

function tlKey(ev) {
  if (ev.type === 'message' || ev.type === 'reasoning' || ev.type === 'tool') return ev.type + ':' + (ev.id || Math.random());
  if (ev.type === 'approval.request' || ev.type === 'approval.resolved') return 'ap:' + ev.approvalId;
  return 'x:' + Math.random();
}

function tlApply(ev) {
  if (ev.type === 'session.updated') {
    if (ev.session) S.openInfo = ev.session;
    return;
  }
  const k = tlKey(ev);
  if (ev.type === 'approval.resolved') {
    const i = S.tlIndex.get(k);
    if (i !== undefined) { S.tl[i] = Object.assign({}, S.tl[i], { resolved: ev }); return; }
  }
  if (S.tlIndex.has(k)) {
    const i = S.tlIndex.get(k);
    S.tl[i] = Object.assign({}, S.tl[i], ev);
  } else {
    S.tlIndex.set(k, S.tl.length);
    S.tl.push(ev);
  }
}

const KIND_ICON = { command: 'terminal', file_change: 'edit', read: 'file', search: 'search', web: 'globe', mcp: 'box', other: 'box' };

function tlItem(ev) {
  switch (ev.type) {
    case 'message':
      return `<div class="msg ${ev.role === 'user' ? 'user' : 'assistant'}">${renderText(ev.text)}</div>`;
    case 'reasoning':
      return ev.text ? `<div class="reason">${esc(ev.text)}</div>` : '';
    case 'tool': {
      const chip = ev.status === 'running' ? '<span class="chip info"><span class="spin" style="width:10px;height:10px"></span>运行中</span>'
        : ev.status === 'failed' ? `<span class="chip bad">失败${ev.exitCode !== undefined && ev.exitCode !== null ? ' ' + esc(ev.exitCode) : ''}</span>` : '<span class="chip ok">完成</span>';
      const has = ev.detail || ev.output || ev.diff;
      return `<details class="tl-tool"><summary>${ico(KIND_ICON[ev.kind] || 'box')}<span class="tt">${esc(ev.title || ev.kind)}</span>${chip}</summary>
        ${has ? `<div class="body">${ev.detail ? `<pre>${esc(ev.detail)}</pre>` : ''}${ev.diff ? `<pre class="diff">${renderDiff(ev.diff)}</pre>` : ''}${ev.output ? `<pre>${esc(ev.output)}</pre>` : ''}</div>` : ''}</details>`;
    }
    case 'approval.request':
    case 'approval.resolved': {
      const r = ev.resolved || (ev.type === 'approval.resolved' ? ev : null);
      const dec = r ? ({ allow: '已允许', allow_session: '已允许（本会话）', deny: '已拒绝' }[r.decision] || r.decision) : '';
      const by = r ? ({ phone: '手机', desktop: '电脑', timeout: '超时' }[r.by] || r.by || '') : '';
      return `<div class="appr ${r ? 'done' : ''}"><div class="appr-title">${ico(r ? 'check' : 'warn')}${esc(ev.title || '需要批准')}</div>
        ${ev.detail ? `<pre>${esc(ev.detail)}</pre>` : ''}${ev.diff ? `<pre class="diff">${renderDiff(ev.diff)}</pre>` : ''}
        ${r ? `<div class="muted small">${esc(dec)}${by ? ' · 由' + esc(by) + '处理' : ''}</div>`
          : `<div class="row"><button class="btn sm primary" data-act="approve" data-id="${esc(ev.approvalId)}" data-d="allow">允许</button>
             <button class="btn sm" data-act="approve" data-id="${esc(ev.approvalId)}" data-d="allow_session">本会话都允许</button>
             <button class="btn sm danger" data-act="approve" data-id="${esc(ev.approvalId)}" data-d="deny">拒绝</button></div>`}</div>`;
    }
    case 'turn': {
      const label = { started: '开始执行', completed: '本轮完成', failed: '执行失败', interrupted: '已停止' }[ev.status] || ev.status;
      const usage = ev.usage ? ` · ${compact(ev.usage.inputTokens)} 输入 / ${compact(ev.usage.outputTokens)} 输出 tokens` : '';
      return `<div class="turn">${esc(label)}${esc(usage)}${ev.error ? ' · ' + esc(ev.error) : ''}</div>`;
    }
    case 'notice':
      return `<div class="notice ${esc(ev.level)}">${esc(ev.text)}</div>`;
  }
  return '';
}

function renderDetail(scroll) {
  const el = $('#sessDetail');
  if (!el) return;
  const s = S.openInfo || {};
  const running = s.status === 'running' || s.status === 'waiting_approval';
  const tlEl = $('#timeline');
  const atBottom = !tlEl || tlEl.scrollHeight - tlEl.scrollTop - tlEl.clientHeight < 80;
  el.innerHTML = `<div class="detail-head"><div class="row"><div class="li-main"><div class="detail-title">${esc(s.title || S.openKey)}</div>
      <div class="sess-meta" style="margin-top:6px">${toolChip(s.tool, s.client)}<span class="status-dot s-${esc(s.status)}"></span>${esc(SESSION_STATUS[s.status] || s.status || '')}${s.model ? ' · ' + esc(s.model) : ''}${s.cwd ? ` · <span class="mono">${esc(s.cwd)}</span>` : ''}</div></div>
      ${running ? `<button class="btn sm danger" data-act="interrupt">${icon('stop')}停止</button>` : ''}</div></div>
    <div class="timeline" id="timeline">${S.tl.map(tlItem).join('') || '<div class="empty">还没有内容</div>'}</div>
    <div class="composer">${s.controllable === false ? '<div class="muted small" style="flex:1">这个会话目前不能从这里继续</div>'
      : `<textarea class="input" id="sendText" placeholder="继续对话…（${OSX() === 'darwin' ? '⌘' : 'Ctrl+'}Enter 发送）"></textarea><button class="btn primary" data-act="send">${icon('send')}发送</button>`}</div>`;
  const t = $('#timeline');
  if (t && (scroll || atBottom)) t.scrollTop = t.scrollHeight;
}

async function openSession(key, keepScroll) {
  S.openKey = key;
  renderSessionList();
  const el = $('#sessDetail');
  if (el && !keepScroll) el.innerHTML = '<div class="empty" style="margin:auto"><span class="spin"></span></div>';
  try {
    const r = await api('/api/session?key=' + encodeURIComponent(key));
    if (S.openKey !== key) return;
    S.openInfo = r.session;
    S.tl = [];
    S.tlIndex = new Map();
    (r.events || []).forEach(tlApply);
    S.approvals.filter((a) => a.sessionKey === key).forEach(tlApply);
    renderDetail(true);
  } catch (e) {
    if (el) el.innerHTML = `<div class="callout bad" style="margin:20px">${ico('warn')}<div>${esc(e.message)}</div></div>`;
  }
}

/* ---------------- 设置 ---------------- */

RENDER_settings = async function (view) {
  const st = await loadState();
  const c = st.config;
  const pol = [
    ['ask', '每次都询问', '执行命令、修改文件前都要你在手机或电脑上批准（推荐）', ''],
    ['auto_edits', '自动批准改文件', '修改项目内的文件自动通过，运行命令仍然询问', ''],
    ['auto_all', '全部自动', '不再询问，AI 可以直接运行任何命令。只在你完全信任任务时使用', 'danger'],
  ];
  view.innerHTML = `
  <div class="card">
    <h3 class="card-title" style="margin-bottom:14px">${ico('power')}启动</h3>
    <div class="setting-row"><div class="txt"><div class="t">开机自动启动</div><div class="d">登录电脑后在后台运行，手机随时能连上这台电脑</div></div>
      <label class="switch"><input type="checkbox" id="swAuto" ${c.autostart ? 'checked' : ''}><span></span></label></div>
    <div class="setting-row"><div class="txt"><div class="t">开机启动时打开控制台</div><div class="d">关闭后开机只在后台运行，需要时${launchHint()}即可打开这个页面</div></div>
      <label class="switch"><input type="checkbox" id="swOpen" ${c.openConsoleOnStart ? 'checked' : ''}><span></span></label></div>
  </div>
  <div class="card">
    <h3 class="card-title" style="margin-bottom:6px">${ico('check')}审批策略</h3>
    <p class="card-sub" style="margin-bottom:14px">从手机发起的新任务默认使用这个策略（手机上发任务时也可以单独选择）</p>
    <div class="radio-cards">${pol.map(([v, t, d, cls]) => `<label class="radio-card ${cls} ${c.approval === v ? 'sel' : ''}"><input type="radio" name="pol" value="${v}" ${c.approval === v ? 'checked' : ''}>
      <span class="t">${cls ? `<span style="color:var(--danger)">${icon('warn')}</span>` : ''}${t}</span><span class="d">${d}</span></label>`).join('')}</div>
    ${c.approval === 'auto_all' ? `<div class="callout bad" style="margin-top:14px">${ico('warn')}<div><b>风险提示：</b>“全部自动”下 AI 可以不经确认运行任意命令（包括删除文件、访问网络）。请只在允许的项目文件夹里、并且信任任务内容时使用。</div></div>` : ''}
  </div>
  <div class="card">
    <h3 class="card-title" style="margin-bottom:14px">${ico('bolt')}默认模型（可选）</h3>
    <div class="form-grid">
      <div class="field"><label for="mCodex">Codex 模型</label><input class="input" id="mCodex" placeholder="留空 = Codex 默认" value="${esc(c.codexModel)}"></div>
      <div class="field"><label for="mClaude">Claude Code 模型</label><input class="input" id="mClaude" placeholder="留空 = Claude Code 默认" value="${esc(c.claudeModel)}"></div>
    </div>
    <div class="form-actions"><button class="btn primary" data-act="saveModels">保存</button></div>
  </div>
  <div class="card">
    <div class="card-head"><h3 class="card-title">${ico('terminal')}运行日志</h3><button class="btn sm" data-act="loadLogs">${icon('refresh')}刷新</button></div>
    <pre class="logs" id="logs">加载中…</pre>
    <div class="muted small" id="logPath" style="margin-top:8px"></div>
  </div>
  <div class="card">
    <h3 class="card-title" style="margin-bottom:12px">${ico('info')}关于</h3>
    <dl class="kv"><dt>版本</dt><dd>${esc(st.version)}</dd><dt>设备 ID</dt><dd class="mono">${esc(c.deviceId)}</dd>
      <dt>程序位置</dt><dd class="mono">${esc(st.appBundle || st.exe || '—')} <button class="btn sm" data-act="reveal" data-w="exe">${icon('folder')}${openWord()}</button></dd>
      <dt>配置文件</dt><dd class="mono">${esc(c.configPath)} <button class="btn sm" data-act="reveal" data-w="config">${icon('folder')}${openWord()}</button></dd><dt>服务地址</dt><dd class="mono">${esc(c.effectiveHubUrl || '—')}</dd></dl>
    ${st.installedFrom ? `<div class="callout ok" style="margin-top:12px">${ico('check')}<div>已自动安装到 <code>${esc(st.appBundle)}</code>，开机自启也指向这里。原来下载的 <code>${esc(st.installedFrom)}</code> 可以删除。</div></div>` : ''}
    ${st.os === 'darwin' ? `<div class="callout" style="margin-top:12px">${ico('info')}<div>第一次让 Codex / Claude Code 读写“文稿”“桌面”“下载”里的项目时，macOS 会弹窗询问 <b>“Salcara Bridge”想访问…</b>，请点<b>允许</b>；点错了可以到 <b>系统设置 → 隐私与安全性 → 文件和文件夹</b> 里重新打开。</div></div>` : ''}
    <div class="divider"></div>
    <div class="row"><div class="li-main"><div class="li-title">退出程序</div><div class="li-sub">退出后手机将看不到这台电脑，正在运行的任务会停止</div></div>
      <button class="btn danger" data-act="quit">${icon('power')}退出 Salcara Bridge</button></div>
  </div>`;
  loadLogs();
};

async function loadLogs() {
  try {
    const r = await api('/api/logs');
    const el = $('#logs');
    if (!el) return;
    el.textContent = r.lines.length ? r.lines.join('\n') : '（暂无日志）';
    el.scrollTop = el.scrollHeight;
    $('#logPath').textContent = r.path ? '日志文件：' + r.path : '';
  } catch (e) { toast(e.message, 'bad'); }
}

const RENDER = {
  overview: (v) => RENDER_overview(v),
  login: (v) => RENDER_login(v),
  tools: (v) => RENDER_tools(v),
  projects: (v) => RENDER_projects(v),
  sessions: (v) => RENDER_sessions(v),
  settings: (v) => RENDER_settings(v),
};
var RENDER_overview, RENDER_login, RENDER_tools, RENDER_projects, RENDER_sessions, RENDER_settings;

/* ---------------- actions ---------------- */

async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.dataset.html = btn.innerHTML; btn.innerHTML = '<span class="spin"></span>' + btn.textContent; }
  try { return await fn(); } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.html; } }
}

const ACTIONS = {
  refresh: () => route(),
  pairStart: async (button) => {
    await busy(button, async () => {
      try {
        const result = await api('/api/pair/start', {});
        S.pairCode = result.code;
        S.pairExpires = result.expiresAt;
        const output = $('#pairCode');
        if (output) output.textContent = result.code;
        toast('在手机上输入此配对码', 'ok');
      } catch (error) { toast(error.message, 'bad'); }
    });
  },
  reveal: async (b) => { try { await api('/api/reveal', { which: b.dataset.w }); } catch (e) { toast(e.message, 'bad'); } },
  editName: () => { S.editingName = true; route().then(() => { const i = $('#devInput'); if (i) { i.focus(); i.select(); } }); },
  cancelName: () => { S.editingName = false; route(); },
  saveName: async (b) => {
    await busy(b, async () => {
      try { await api('/api/device', { name: $('#devInput').value }); S.editingName = false; toast('设备名称已更新', 'ok'); route(); } catch (e) { toast(e.message, 'bad'); }
    });
  },
  toggleVis: (b) => { const i = document.getElementById(b.dataset.for); i.type = i.type === 'password' ? 'text' : 'password'; },
  testKey: async (b) => {
    await busy(b, async () => {
      const out = $('#testResult');
      try {
        const r = await api('/api/test', { relayRoot: $('#fRoot').value, key: $('#fKey').value });
        out.innerHTML = testResultHTML(r.usage || {});
      } catch (e) { out.innerHTML = `<div class="callout bad">${ico('warn')}<div>${esc(e.message)}</div></div>`; }
    });
  },
  login: async (b) => {
    await busy(b, async () => {
      const body = { relayRoot: $('#fRoot').value, accountKey: $('#fKey').value, hubUrl: $('#fHub').value };
      const cx = $('#fCodex').value.trim(), cl = $('#fClaude').value.trim();
      if (cx) body.codexKey = cx; else if ($('#fCodexClear') && $('#fCodexClear').checked) body.codexKey = '';
      if (cl) body.claudeKey = cl; else if ($('#fClaudeClear') && $('#fClaudeClear').checked) body.claudeKey = '';
      try {
        const r = await api('/api/login', body);
        toast(r.autostartEnabled ? '登录成功，已开启开机自启' : '登录成功', 'ok');
        await route();
        const out = $('#testResult');
        if (out) out.innerHTML = testResultHTML(r.usage || {});
      } catch (e) { const out = $('#testResult'); out.innerHTML = `<div class="callout bad">${ico('warn')}<div>${esc(e.message)}</div></div>`; }
    });
  },
  logout: async () => {
    if (!confirm('退出登录后，手机将看不到这台电脑。确定吗？')) return;
    await api('/api/logout', {});
    toast('已退出登录');
    route();
  },
  toolcfg: async (b) => {
    const tool = b.dataset.tool, a = b.dataset.a;
    if (a === 'restore' && !confirm('恢复到一键配置之前的原配置？')) return;
    const m = $('input[name=cxmode]:checked');
    await busy(b, async () => {
      try {
        const r = await api('/api/toolcfg', { tool, action: a, mode: m ? m.value : 'token' });
        toast(r.note || '完成', 'ok');
        route();
      } catch (e) { toast(e.message, 'bad'); }
    });
  },
  copyVal: (b) => copyText(b.dataset.v, b.dataset.w),
  copySecret: async (b) => { try { const r = await api('/api/secret?which=' + b.dataset.which); copyText(r.value, 'Key'); } catch (e) { toast(e.message, 'bad'); } },
  browse: () => openBrowser($('#projPath').value.trim()),
  fsGo: (b) => S.fsLoad(b.dataset.p),
  fsPick: () => { const c = S.fsCur(); $('#modalRoot').innerHTML = ''; const i = $('#projPath'); if (i && c) { i.value = c.path; ACTIONS.addProj($('[data-act=addProj]')); } },
  closeModal: (b, e) => { if (b.classList.contains('modal-back') && e.target.closest('[data-stop]')) return; $('#modalRoot').innerHTML = ''; },
  addProj: async (b) => {
    const p = $('#projPath').value.trim();
    if (!p) { toast('请填写文件夹路径', 'bad'); return; }
    await busy(b, async () => {
      try { await api('/api/projects', { path: p }); toast('已添加', 'ok'); route(); } catch (e) { toast(e.message, 'bad'); }
    });
  },
  rmProj: async (b) => {
    if (!confirm('移除后手机不能再在这个文件夹里发起任务。确定吗？')) return;
    await api('/api/projects/remove', { path: b.dataset.path });
    route();
  },
  sessFilter: (b) => { S.sessFilter = b.dataset.k; $$('.filter').forEach((x) => x.classList.toggle('on', x === b)); loadSessions(); },
  reloadSessions: () => loadSessions(),
  openSess: (b) => openSession(b.dataset.k),
  approve: async (b) => {
    await busy(b, async () => {
      try { await api('/api/approval', { approvalId: b.dataset.id, decision: b.dataset.d }); toast('已处理', 'ok'); } catch (e) { toast(e.message, 'bad'); }
      S.approvals = S.approvals.filter((a) => a.approvalId !== b.dataset.id);
      setApprovalBadge();
      renderApprovalsBox();
    });
  },
  send: async (b) => {
    const t = $('#sendText');
    const text = t.value.trim();
    if (!text) return;
    await busy(b, async () => {
      try { await api('/api/session/send', { sessionKey: S.openKey, text }); t.value = ''; } catch (e) { toast(e.message, 'bad'); }
    });
  },
  interrupt: async (b) => { await busy(b, async () => { try { await api('/api/session/interrupt', { sessionKey: S.openKey }); toast('已发送停止'); } catch (e) { toast(e.message, 'bad'); } }); },
  saveModels: async (b) => {
    await busy(b, async () => {
      try { await api('/api/settings', { codexModel: $('#mCodex').value, claudeModel: $('#mClaude').value }); toast('已保存', 'ok'); } catch (e) { toast(e.message, 'bad'); }
    });
  },
  loadLogs: () => loadLogs(),
  quit: async () => {
    if (!confirm('退出 Salcara Bridge？手机将看不到这台电脑，直到你再次打开它。')) return;
    try { await api('/api/quit', {}); } catch (_) { /* ignore */ }
    document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:8px;font-family:var(--font)"><h2 style="margin:0">Salcara Bridge 已退出</h2><p style="color:#6D768B">可以关闭这个页面了。需要时' + launchHint() + '即可重新打开。</p></div>';
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.tagName === 'A' && el.getAttribute('href')) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  if (el.dataset.act === 'closeModal' && el.classList.contains('modal-back') && e.target !== el) return;
  e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(err.message, 'bad'));
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  try {
    if (t.id === 'swAuto') { await api('/api/settings', { autostart: t.checked }); toast(t.checked ? '已开启开机自启' : '已关闭开机自启', 'ok'); }
    else if (t.id === 'swOpen') { await api('/api/settings', { openConsoleOnStart: t.checked }); toast('已保存', 'ok'); }
    else if (t.name === 'pol') {
      if (t.value === 'auto_all' && !confirm('“全部自动”会让 AI 不经确认运行任意命令，确定开启吗？')) { route(); return; }
      await api('/api/settings', { approval: t.value }); toast('审批策略已更新', 'ok'); route();
    } else if (t.name === 'cxmode') {
      $$('input[name=cxmode]').forEach((i) => i.closest('.radio-card').classList.toggle('sel', i.checked));
    }
  } catch (err) { toast(err.message, 'bad'); if (t.type === 'checkbox') t.checked = !t.checked; }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'sendText' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ACTIONS.send($('[data-act=send]')); }
  if (e.target.id === 'devInput' && e.key === 'Enter') ACTIONS.saveName($('[data-act=saveName]'));
  if (e.target.id === 'projPath' && e.key === 'Enter') ACTIONS.addProj($('[data-act=addProj]'));
  if (e.key === 'Escape') $('#modalRoot').innerHTML = '';
});

/* ---------------- live stream ---------------- */

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('status', (m) => {
    const st = JSON.parse(m.data);
    if (S.state) S.state.hub = st;
    setConn(st);
  });
  es.addEventListener('event', (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'approval.request') {
      if (!S.approvals.find((a) => a.approvalId === ev.approvalId)) S.approvals.push(ev);
      setApprovalBadge(); renderApprovalsBox();
    } else if (ev.type === 'approval.resolved') {
      S.approvals = S.approvals.filter((a) => a.approvalId !== ev.approvalId);
      setApprovalBadge(); renderApprovalsBox();
    }
    if (ev.type === 'session.updated' && ev.session) {
      const i = S.sessions.findIndex((s) => s.sessionKey === ev.session.sessionKey);
      if (i >= 0) S.sessions[i] = ev.session; else if (!S.sessFilter || S.sessFilter === ev.session.tool) S.sessions.unshift(ev.session);
      S.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      if (S.route === 'sessions') renderSessionList();
    }
    if (S.route === 'sessions' && S.openKey && ev.sessionKey === S.openKey) {
      tlApply(ev);
      renderDetail(false);
    }
  });
  es.onerror = () => {
    setConn({ state: 'connecting', error: '与本机程序的连接断开' });
  };
}

async function boot() {
  window.addEventListener('hashchange', route);
  try {
    const r = await api('/api/approvals');
    S.approvals = r.approvals || [];
    setApprovalBadge();
  } catch (_) { /* ignore */ }
  $$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  connectStream();
  route();
}
boot();
