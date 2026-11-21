'use strict';

const state = {
  me: null,
  view: 'overview',
  page: 1,
  query: '',
  plans: [],
};

const $ = (id) => document.getElementById(id);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (cents, currency = 'USD') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100);
  } catch {
    return `${((cents || 0) / 100).toFixed(2)} ${currency}`;
  }
};
const date = (v) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'autopilot-forex' },
  };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, init);
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

/* ── auth ───────────────────────────────────────────────────────────── */
async function boot() {
  $('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const msg = $('loginMsg');
    const btn = $('loginBtn');
    msg.textContent = '';
    msg.className = 'msg';
    btn.disabled = true;

    try {
      await api('/api/auth/login', {
        method: 'POST',
        body: { email: $('loginEmail').value.trim(), password: $('loginPassword').value },
      });
      await enterApp();
    } catch (error) {
      msg.textContent = error.message;
      msg.className = 'msg err';
    } finally {
      btn.disabled = false;
    }
  });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    window.location.reload();
  });

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
  $('sheetCancel').addEventListener('click', closeSheet);

  try {
    await enterApp();
  } catch {
    showLogin();
  }
}

async function enterApp() {
  const me = await api('/api/me');
  state.me = me.user;

  if (!['OWNER', 'ADMIN', 'SUPPORT', 'ANALYST'].includes(me.user.role)) {
    showLogin('This account does not have team access.');
    return;
  }

  $('loginScreen').hidden = true;
  $('app').hidden = false;
  $('whoami').textContent = `${me.user.email} · ${me.user.role}`;
  navigate('overview');
}

function showLogin(message) {
  $('app').hidden = true;
  $('loginScreen').hidden = false;
  if (message) {
    $('loginMsg').textContent = message;
    $('loginMsg').className = 'msg err';
  }
}

function can(minimum) {
  const rank = { USER: 0, ANALYST: 1, SUPPORT: 2, ADMIN: 3, OWNER: 4 };
  return rank[state.me?.role || 'USER'] >= rank[minimum];
}

/* ── navigation ─────────────────────────────────────────────────────── */
const TITLES = {
  overview: 'Overview',
  users: 'Users',
  signals: 'Signals',
  posts: 'Research',
  plans: 'Plans',
  subscriptions: 'Subscriptions',
  payments: 'Payments',
  messages: 'Messages',
  audit: 'Audit log',
  settings: 'Settings',
};

async function navigate(view) {
  state.view = view;
  state.page = 1;
  $('viewTitle').textContent = TITLES[view] || view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('viewActions').innerHTML = '';
  await render();
}

async function render() {
  const root = $('viewRoot');
  root.innerHTML = '<div class="panel"><p class="empty">Loading…</p></div>';

  try {
    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'users') await renderUsers();
    else if (state.view === 'signals') await renderSignals();
    else if (state.view === 'posts') await renderPosts();
    else if (state.view === 'plans') await renderPlans();
    else if (state.view === 'subscriptions') await renderSubscriptions();
    else if (state.view === 'payments') await renderPayments();
    else if (state.view === 'messages') await renderMessages();
    else if (state.view === 'audit') await renderAudit();
    else if (state.view === 'settings') await renderSettings();
  } catch (error) {
    root.innerHTML = `<div class="panel"><p class="empty">${esc(error.message)}</p></div>`;
  }
}

function pager(total, page, pageSize, onGo) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const wrap = document.createElement('div');
  wrap.className = 'pager';
  wrap.innerHTML = `<span>${total} record${total === 1 ? '' : 's'} · page ${page} of ${pages}</span>
    <button class="btn sm" data-dir="-1" ${page <= 1 ? 'disabled' : ''}>Prev</button>
    <button class="btn sm" data-dir="1" ${page >= pages ? 'disabled' : ''}>Next</button>`;
  wrap.querySelectorAll('button[data-dir]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.page = page + Number(btn.dataset.dir);
      onGo();
    }),
  );
  return wrap;
}

/* ── overview ───────────────────────────────────────────────────────── */
async function renderOverview() {
  const s = await api('/api/admin/stats');

  $('viewRoot').innerHTML = `
    <div class="cards">
      <div class="card"><p>Users</p><h3>${s.users}</h3><span class="chip">+${s.newUsers7d} this week</span></div>
      <div class="card"><p>Active VIP</p><h3>${s.activeSubscriptions}</h3></div>
      <div class="card"><p>Revenue collected</p><h3>${money(s.revenueCents)}</h3></div>
      <div class="card"><p>Open signals</p><h3>${s.openSignals}</h3></div>
      <div class="card"><p>New messages</p><h3>${s.newMessages}</h3></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Newest accounts</h2>
        <button class="btn sm" data-go="users">All users</button></div>
      <table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Joined</th></tr></thead><tbody>
      ${s.recentUsers
        .map(
          (u) => `<tr><td class="mono">${esc(u.email)}</td><td>${esc(u.fullName)}</td>
          <td><span class="chip ${u.role === 'USER' ? '' : 'ok'}">${esc(u.role)}</span></td><td>${day(u.createdAt)}</td></tr>`,
        )
        .join('') || '<tr><td colspan="4" class="empty">No users yet</td></tr>'}
      </tbody></table>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Latest payments</h2>
        <button class="btn sm" data-go="payments">All payments</button></div>
      <table><thead><tr><th>When</th><th>User</th><th>Plan</th><th>Amount</th><th>Status</th></tr></thead><tbody>
      ${s.recentPayments
        .map(
          (p) => `<tr><td>${date(p.createdAt)}</td><td class="mono">${esc(p.user?.email || '—')}</td>
          <td>${esc(p.plan?.name || '—')}</td><td>${money(p.amountCents, p.currency)}</td>
          <td><span class="chip ${p.status === 'PAID' ? 'ok' : 'bad'}">${esc(p.status)}</span></td></tr>`,
        )
        .join('') || '<tr><td colspan="5" class="empty">No payments recorded</td></tr>'}
      </tbody></table>
    </div>`;

  $('viewRoot').querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.go)),
  );
}

/* ── users ──────────────────────────────────────────────────────────── */
async function renderUsers() {
  const data = await api(
    `/api/admin/users?page=${state.page}&pageSize=20${state.query ? `&q=${encodeURIComponent(state.query)}` : ''}`,
  );

  $('viewActions').innerHTML = `<div class="filters">
      <input id="userSearch" placeholder="Search email or name" value="${esc(state.query)}">
    </div>`;

  $('viewRoot').innerHTML = `
    <div class="panel">
      <table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Membership</th><th>Joined</th><th></th></tr></thead><tbody>
      ${data.items
        .map((u) => {
          const sub = u.subscriptions?.[0];
          return `<tr>
            <td><div>${esc(u.fullName)}</div><div class="mono">${esc(u.email)}</div></td>
            <td><span class="chip ${u.role === 'USER' ? '' : 'ok'}">${esc(u.role)}</span></td>
            <td><span class="chip ${u.status === 'ACTIVE' ? 'ok' : 'bad'}">${esc(u.status)}</span></td>
            <td>${sub ? `<span class="chip vip">${esc(sub.plan.name)}</span>` : '—'}</td>
            <td>${day(u.createdAt)}</td>
            <td class="actions"><button class="btn sm" data-user="${u.id}">Manage</button></td>
          </tr>`;
        })
        .join('') || '<tr><td colspan="6" class="empty">No users match</td></tr>'}
      </tbody></table>
      <div id="pagerSlot"></div>
    </div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderUsers));

  const search = $('userSearch');
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = search.value.trim();
      state.page = 1;
      renderUsers();
    }, 350);
  });

  $('viewRoot').querySelectorAll('[data-user]').forEach((btn) =>
    btn.addEventListener('click', () => openUser(btn.dataset.user)),
  );
}

async function openUser(id) {
  const { user } = await api(`/api/admin/users/${id}`);

  openSheet(
    'Manage user',
    `<div class="grid2">
      <div><label>Full name</label><input name="fullName" value="${esc(user.fullName)}"></div>
      <div><label>Role</label>
        <select name="role" ${can('ADMIN') ? '' : 'disabled'}>
          ${['USER', 'ANALYST', 'SUPPORT', 'ADMIN', 'OWNER']
            .map((r) => `<option ${r === user.role ? 'selected' : ''}>${r}</option>`)
            .join('')}
        </select>
      </div>
      <div><label>Status</label>
        <select name="status" ${can('ADMIN') ? '' : 'disabled'}>
          ${['ACTIVE', 'SUSPENDED', 'DELETED']
            .map((s) => `<option ${s === user.status ? 'selected' : ''}>${s}</option>`)
            .join('')}
        </select>
      </div>
      <div><label>Set new password (optional)</label><input name="password" type="password" minlength="10" autocomplete="new-password"></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2>Membership history</h2>
      <table><tbody>
      ${(user.subscriptions || [])
        .map(
          (s) => `<tr><td>${esc(s.plan.name)}</td><td><span class="chip ${s.status === 'ACTIVE' ? 'ok' : ''}">${esc(s.status)}</span></td>
          <td>${esc(s.provider)}</td><td>ends ${day(s.currentPeriodEnd)}</td></tr>`,
        )
        .join('') || '<tr><td class="empty">No subscriptions</td></tr>'}
      </tbody></table>
    </div>
    <div class="grid2" style="margin-top:14px">
      <div><label>Grant plan</label>
        <select name="grantPlan">${state.plans.map((p) => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('')}</select>
      </div>
      <div><label>Months</label><input name="grantMonths" type="number" min="1" max="36" value="1"></div>
    </div>`,
    async (form) => {
      const body = {};
      const name = form.fullName.value.trim();
      if (name && name !== user.fullName) body.fullName = name;
      if (can('ADMIN')) {
        if (form.role.value !== user.role) body.role = form.role.value;
        if (form.status.value !== user.status) body.status = form.status.value;
      }
      if (form.password.value) body.password = form.password.value;

      if (Object.keys(body).length) {
        await api(`/api/admin/users/${id}`, { method: 'PATCH', body });
        toast('User updated.');
      }

      if (Number(form.grantMonths.value) > 0 && form.grantPlan.value) {
        await api(`/api/admin/users/${id}/grant`, {
          method: 'POST',
          body: { planCode: form.grantPlan.value, months: Number(form.grantMonths.value) },
        });
        toast('Membership granted.');
      }

      closeSheet();
      await renderUsers();
    },
  );
}

/* ── signals ────────────────────────────────────────────────────────── */
async function renderSignals() {
  const data = await api(`/api/admin/signals?page=${state.page}&pageSize=20`);

  $('viewActions').innerHTML = `<button class="btn primary" id="newSignal">New signal</button>`;
  $('newSignal').addEventListener('click', () => openSignal());

  $('viewRoot').innerHTML = `
    <div class="panel">
      <table><thead><tr><th>Published</th><th>Pair</th><th>Dir</th><th>Entry</th><th>SL</th><th>TP</th><th>Status</th><th>Visible</th><th></th></tr></thead><tbody>
      ${data.items
        .map(
          (s) => `<tr>
            <td>${date(s.publishedAt)}</td>
            <td><strong>${esc(s.pair)}</strong> <span class="chip">${esc(s.timeframe)}</span></td>
            <td><span class="chip ${s.direction === 'BUY' ? 'ok' : 'bad'}">${esc(s.direction)}</span></td>
            <td>${s.entry}</td><td>${s.stopLoss ?? '—'}</td><td>${s.takeProfit ?? '—'}</td>
            <td><span class="chip">${esc(s.status)}</span></td>
            <td><span class="chip ${s.vipOnly ? 'vip' : ''}">${s.vipOnly ? 'VIP' : 'FREE'}</span></td>
            <td class="actions">
              <button class="btn sm" data-edit="${s.id}">Edit</button>
              <button class="btn sm danger" data-del="${s.id}">Delete</button>
            </td></tr>`,
        )
        .join('') || '<tr><td colspan="9" class="empty">No signals yet — publish the first one</td></tr>'}
      </tbody></table>
      <div id="pagerSlot"></div>
    </div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderSignals));

  $('viewRoot').querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openSignal(data.items.find((s) => s.id === btn.dataset.edit))),
  );
  $('viewRoot').querySelectorAll('[data-del]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this signal permanently?')) return;
      await api(`/api/admin/signals/${btn.dataset.del}`, { method: 'DELETE' });
      toast('Signal deleted.');
      await renderSignals();
    }),
  );
}

function openSignal(signal) {
  const s = signal || {};
  openSheet(
    signal ? 'Edit signal' : 'New signal',
    `<div class="grid3">
      <div><label>Pair</label><input name="pair" value="${esc(s.pair || '')}" placeholder="XAU/USD" required></div>
      <div><label>Direction</label><select name="direction">
        <option ${s.direction === 'SELL' ? '' : 'selected'}>BUY</option>
        <option ${s.direction === 'SELL' ? 'selected' : ''}>SELL</option></select></div>
      <div><label>Timeframe</label><input name="timeframe" value="${esc(s.timeframe || 'H1')}"></div>
      <div><label>Entry</label><input name="entry" type="number" step="any" value="${s.entry ?? ''}" required></div>
      <div><label>Stop loss</label><input name="stopLoss" type="number" step="any" value="${s.stopLoss ?? ''}"></div>
      <div><label>Take profit</label><input name="takeProfit" type="number" step="any" value="${s.takeProfit ?? ''}"></div>
      <div><label>Confidence %</label><input name="confidence" type="number" min="0" max="100" value="${s.confidence ?? 60}"></div>
      <div><label>Status</label><select name="status">
        ${['OPEN', 'CLOSED', 'CANCELLED'].map((v) => `<option ${s.status === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select></div>
      <div><label>Result %</label><input name="resultPct" type="number" step="any" value="${s.resultPct ?? ''}"></div>
    </div>
    <div style="margin-top:12px"><label>Notes</label><textarea name="notes">${esc(s.notes || '')}</textarea></div>
    <div style="margin-top:12px"><label><input type="checkbox" name="vipOnly" style="width:auto" ${s.vipOnly === false ? '' : 'checked'}> VIP only</label></div>`,
    async (form) => {
      const body = {
        pair: form.pair.value.trim().toUpperCase(),
        direction: form.direction.value,
        timeframe: form.timeframe.value.trim().toUpperCase() || 'H1',
        entry: Number(form.entry.value),
        stopLoss: form.stopLoss.value ? Number(form.stopLoss.value) : null,
        takeProfit: form.takeProfit.value ? Number(form.takeProfit.value) : null,
        confidence: Number(form.confidence.value),
        status: form.status.value,
        resultPct: form.resultPct.value ? Number(form.resultPct.value) : null,
        notes: form.notes.value.trim() || null,
        vipOnly: form.vipOnly.checked,
      };
      if (signal) await api(`/api/admin/signals/${signal.id}`, { method: 'PATCH', body });
      else await api('/api/admin/signals', { method: 'POST', body });
      closeSheet();
      toast('Signal saved.');
      await renderSignals();
    },
  );
}

/* ── posts ──────────────────────────────────────────────────────────── */
async function renderPosts() {
  const data = await api(`/api/admin/posts?page=${state.page}&pageSize=20`);

  $('viewActions').innerHTML = `<button class="btn primary" id="newPost">New article</button>`;
  $('newPost').addEventListener('click', () => openPost());

  $('viewRoot').innerHTML = `
    <div class="panel">
      <table><thead><tr><th>Title</th><th>Category</th><th>Access</th><th>State</th><th>Published</th><th></th></tr></thead><tbody>
      ${data.items
        .map(
          (p) => `<tr>
            <td><div>${esc(p.title)}</div><div class="mono">/${esc(p.slug)}</div></td>
            <td><span class="chip">${esc(p.category)}</span></td>
            <td>${p.vipOnly ? '<span class="chip vip">VIP</span>' : '<span class="chip">FREE</span>'}</td>
            <td><span class="chip ${p.published ? 'ok' : ''}">${p.published ? 'LIVE' : 'DRAFT'}</span></td>
            <td>${day(p.publishedAt)}</td>
            <td class="actions">
              <button class="btn sm" data-edit-post="${p.id}">Edit</button>
              <button class="btn sm danger" data-del-post="${p.id}">Delete</button>
            </td></tr>`,
        )
        .join('') || '<tr><td colspan="6" class="empty">No articles yet</td></tr>'}
      </tbody></table>
      <div id="pagerSlot"></div>
    </div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderPosts));

  $('viewRoot').querySelectorAll('[data-edit-post]').forEach((btn) =>
    btn.addEventListener('click', () => openPost(data.items.find((p) => p.id === btn.dataset.editPost))),
  );
  $('viewRoot').querySelectorAll('[data-del-post]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!window.confirm('Delete this article?')) return;
      await api(`/api/admin/posts/${btn.dataset.delPost}`, { method: 'DELETE' });
      toast('Article deleted.');
      await renderPosts();
    }),
  );
}

function openPost(post) {
  const p = post || {};
  openSheet(
    post ? 'Edit article' : 'New article',
    `<div class="grid2">
      <div><label>Title</label><input name="title" value="${esc(p.title || '')}" required></div>
      <div><label>Slug (optional)</label><input name="slug" value="${esc(p.slug || '')}"></div>
      <div><label>Category</label><select name="category">
        ${['ANALYSIS', 'EDUCATION', 'ANNOUNCEMENT']
          .map((c) => `<option ${p.category === c ? 'selected' : ''}>${c}</option>`)
          .join('')}</select></div>
      <div><label>Cover image URL</label><input name="coverUrl" value="${esc(p.coverUrl || '')}"></div>
    </div>
    <div style="margin-top:12px"><label>Excerpt</label><input name="excerpt" value="${esc(p.excerpt || '')}"></div>
    <div style="margin-top:12px"><label>Body (Markdown-lite)</label><textarea name="body" style="min-height:280px">${esc(p.body || '')}</textarea></div>
    <div style="margin-top:12px;display:flex;gap:20px">
      <label style="text-transform:none;letter-spacing:0"><input type="checkbox" name="vipOnly" style="width:auto" ${p.vipOnly ? 'checked' : ''}> VIP only</label>
      <label style="text-transform:none;letter-spacing:0"><input type="checkbox" name="published" style="width:auto" ${p.published ? 'checked' : ''}> Publish now</label>
    </div>`,
    async (form) => {
      const body = {
        title: form.title.value.trim(),
        slug: form.slug.value.trim() || undefined,
        category: form.category.value,
        excerpt: form.excerpt.value.trim() || null,
        body: form.body.value,
        coverUrl: form.coverUrl.value.trim() || null,
        vipOnly: form.vipOnly.checked,
        published: form.published.checked,
      };
      if (post) await api(`/api/admin/posts/${post.id}`, { method: 'PATCH', body });
      else await api('/api/admin/posts', { method: 'POST', body });
      closeSheet();
      toast('Article saved.');
      await renderPosts();
    },
  );
}

/* ── plans ──────────────────────────────────────────────────────────── */
async function renderPlans() {
  const data = await api('/api/admin/plans');
  state.plans = data.items;

  $('viewActions').innerHTML = `<button class="btn primary" id="newPlan">New plan</button>`;
  $('newPlan').addEventListener('click', () => openPlan());

  $('viewRoot').innerHTML = `
    <div class="cards">
      ${data.items
        .map(
          (p) => `<div class="card">
            <p>${esc(p.code)}</p>
            <h3>${money(p.priceCents, p.currency)}</h3>
            <div class="small">${esc(p.name)} · per ${esc(p.interval.toLowerCase())}</div>
            <div style="margin-top:10px"><span class="chip ${p.active ? 'ok' : 'bad'}">${p.active ? 'ACTIVE' : 'OFF'}</span>
            <span class="chip">${p.stripePriceId ? 'stripe' : 'no stripe id'}</span></div>
            <button class="btn sm" style="margin-top:12px" data-plan-edit="${esc(p.code)}">Edit</button>
          </div>`,
        )
        .join('')}
    </div>`;

  $('viewRoot').querySelectorAll('[data-plan-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openPlan(state.plans.find((p) => p.code === btn.dataset.planEdit))),
  );
}

function openPlan(plan) {
  const p = plan || { code: '', name: '', priceCents: 1900, currency: 'USD', interval: 'MONTH', features: [], active: true };

  openSheet(
    plan ? 'Edit plan' : 'New plan',
    `<div class="grid2">
      <div><label>Code</label><input name="code" value="${esc(p.code)}" ${plan ? 'disabled' : ''} placeholder="vip-monthly"></div>
      <div><label>Name</label><input name="name" value="${esc(p.name)}" required></div>
      <div><label>Price (cents)</label><input name="priceCents" type="number" min="0" value="${p.priceCents}" required></div>
      <div><label>Currency</label><input name="currency" value="${esc(p.currency)}" maxlength="3"></div>
      <div><label>Interval</label><select name="interval">
        <option ${p.interval === 'MONTH' ? 'selected' : ''}>MONTH</option>
        <option ${p.interval === 'YEAR' ? 'selected' : ''}>YEAR</option></select></div>
      <div><label>Stripe price ID</label><input name="stripePriceId" value="${esc(p.stripePriceId || '')}"></div>
    </div>
    <div style="margin-top:12px"><label>Features (one per line)</label>
      <textarea name="features">${esc((p.features || []).join('\n'))}</textarea></div>
    <div style="margin-top:12px"><label style="text-transform:none;letter-spacing:0">
      <input type="checkbox" name="active" style="width:auto" ${p.active ? 'checked' : ''}> Active and purchasable</label></div>`,
    async (form) => {
      const body = {
        name: form.name.value.trim(),
        priceCents: Number(form.priceCents.value),
        currency: form.currency.value.trim().toUpperCase(),
        interval: form.interval.value,
        stripePriceId: form.stripePriceId.value.trim() || null,
        features: form.features.value.split('\n').map((f) => f.trim()).filter(Boolean),
        active: form.active.checked,
      };
      await api(`/api/admin/plans/${encodeURIComponent(form.code.value.trim())}`, { method: 'PUT', body });
      closeSheet();
      toast('Plan saved.');
      await renderPlans();
    },
  );
}

/* ── subscriptions & payments ───────────────────────────────────────── */
async function renderSubscriptions() {
  const data = await api(`/api/admin/subscriptions?page=${state.page}&pageSize=20`);

  $('viewRoot').innerHTML = `<div class="panel">
    <table><thead><tr><th>User</th><th>Plan</th><th>Status</th><th>Provider</th><th>Period end</th><th>Created</th></tr></thead><tbody>
    ${data.items
      .map(
        (s) => `<tr><td class="mono">${esc(s.user?.email || '—')}</td><td>${esc(s.plan?.name || '—')}</td>
        <td><span class="chip ${s.status === 'ACTIVE' ? 'ok' : s.status === 'PAST_DUE' ? 'bad' : ''}">${esc(s.status)}</span></td>
        <td>${esc(s.provider)}</td><td>${day(s.currentPeriodEnd)}</td><td>${day(s.createdAt)}</td></tr>`,
      )
      .join('') || '<tr><td colspan="6" class="empty">No subscriptions yet</td></tr>'}
    </tbody></table><div id="pagerSlot"></div></div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderSubscriptions));
}

async function renderPayments() {
  const data = await api(`/api/admin/payments?page=${state.page}&pageSize=20`);

  $('viewRoot').innerHTML = `<div class="panel">
    <table><thead><tr><th>Date</th><th>User</th><th>Provider</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead><tbody>
    ${data.items
      .map(
        (p) => `<tr><td>${date(p.createdAt)}</td><td class="mono">${esc(p.user?.email || '—')}</td>
        <td>${esc(p.provider)}</td><td>${money(p.amountCents, p.currency)}</td>
        <td><span class="chip ${p.status === 'PAID' ? 'ok' : 'bad'}">${esc(p.status)}</span></td>
        <td class="mono">${esc(p.providerRef).slice(0, 28)}</td></tr>`,
      )
      .join('') || '<tr><td colspan="6" class="empty">No payments yet</td></tr>'}
    </tbody></table><div id="pagerSlot"></div></div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderPayments));
}

/* ── messages ───────────────────────────────────────────────────────── */
async function renderMessages() {
  const data = await api(`/api/admin/messages?page=${state.page}&pageSize=20`);

  $('viewRoot').innerHTML = `<div class="panel">
    <table><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>State</th><th></th></tr></thead><tbody>
    ${data.items
      .map(
        (m) => `<tr>
          <td>${date(m.createdAt)}</td>
          <td><div>${esc(m.name)}</div><div class="mono">${esc(m.email)}</div></td>
          <td class="wrap">${esc(m.subject)}<div class="small muted">${esc(m.message).slice(0, 90)}…</div></td>
          <td><span class="chip ${m.status === 'NEW' ? 'ok' : ''}">${esc(m.status)}</span></td>
          <td class="actions">
            <button class="btn sm" data-msg-open="${m.id}">Open</button>
            <button class="btn sm" data-msg-archive="${m.id}">Archive</button>
          </td></tr>`,
      )
      .join('') || '<tr><td colspan="5" class="empty">No messages yet</td></tr>'}
    </tbody></table><div id="pagerSlot"></div></div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderMessages));

  $('viewRoot').querySelectorAll('[data-msg-open]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const m = data.items.find((x) => x.id === btn.dataset.msgOpen);
      api(`/api/admin/messages/${m.id}`, { method: 'PATCH', body: { status: 'READ' } }).catch(() => {});
      openSheet(
        m.subject,
        `<p class="small muted">From ${esc(m.name)} &lt;${esc(m.email)}&gt; · ${date(m.createdAt)}</p>
         <p style="white-space:pre-wrap;margin-top:12px">${esc(m.message)}</p>
         <p style="margin-top:16px"><a class="btn" href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: ' + m.subject)}">Reply by email</a></p>`,
        async () => closeSheet(),
      );
    }),
  );

  $('viewRoot').querySelectorAll('[data-msg-archive]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/admin/messages/${btn.dataset.msgArchive}`, { method: 'PATCH', body: { status: 'ARCHIVED' } });
      toast('Archived.');
      await renderMessages();
    }),
  );
}

/* ── audit ──────────────────────────────────────────────────────────── */
async function renderAudit() {
  if (!can('ADMIN')) {
    $('viewRoot').innerHTML = '<div class="panel"><p class="empty">Admins only.</p></div>';
    return;
  }
  const data = await api(`/api/admin/audit?page=${state.page}&pageSize=30`);

  $('viewRoot').innerHTML = `<div class="panel">
    <table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>IP</th></tr></thead><tbody>
    ${data.items
      .map(
        (a) => `<tr><td>${date(a.createdAt)}</td><td class="mono">${esc(a.actor?.email || 'system')}</td>
        <td>${esc(a.action)}</td><td class="mono">${esc(a.entity || '')} ${esc((a.entityId || '').slice(0, 8))}</td>
        <td class="mono">${esc(a.ip || '—')}</td></tr>`,
      )
      .join('') || '<tr><td colspan="5" class="empty">Nothing logged yet</td></tr>'}
    </tbody></table><div id="pagerSlot"></div></div>`;

  $('pagerSlot').appendChild(pager(data.total, data.page, data.pageSize, renderAudit));
}

/* ── settings ───────────────────────────────────────────────────────── */
async function renderSettings() {
  if (!can('ADMIN')) {
    $('viewRoot').innerHTML = '<div class="panel"><p class="empty">Admins only.</p></div>';
    return;
  }
  const data = await api('/api/admin/settings');
  const site = data.items.site || {};

  $('viewRoot').innerHTML = `<div class="panel">
    <h2>Site settings</h2>
    <div class="grid2">
      <div><label>Support email</label><input id="setSupport" value="${esc(site.supportEmail || '')}"></div>
      <div><label>M-Pesa paybill / till</label><input id="setMpesa" value="${esc(site.mpesaNumber || '')}"></div>
      <div><label>Trading hours</label><input id="setHours" value="${esc(site.tradingHours || '')}"></div>
    </div>
    <button class="btn primary" id="saveSite" style="margin-top:16px">Save settings</button>
    <div class="panel" style="margin-top:20px">
      <h2>Operational checklist</h2>
      <ul style="margin-left:18px;color:var(--muted);font-size:13px;line-height:1.9">
        <li>STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET set in Railway</li>
        <li>Stripe price ID attached to each paid plan</li>
        <li>INTASEND keys + webhook challenge for M-Pesa</li>
        <li>RESEND_API_KEY so verification and reset emails send</li>
        <li>TWELVE_DATA_API_KEY for live quotes</li>
      </ul>
    </div>
  </div>`;

  $('saveSite').addEventListener('click', async () => {
    await api('/api/admin/settings/site', {
      method: 'PUT',
      body: {
        value: {
          supportEmail: $('setSupport').value.trim(),
          mpesaNumber: $('setMpesa').value.trim(),
          tradingHours: $('setHours').value.trim(),
        },
      },
    });
    toast('Settings saved.');
  });
}

/* ── sheet ──────────────────────────────────────────────────────────── */
let sheetSubmit = null;

function openSheet(title, html, onSubmit) {
  $('sheetTitle').textContent = title;
  $('sheetFields').innerHTML = html;
  sheetSubmit = onSubmit;
  $('overlay').classList.add('show');
}

function closeSheet() {
  $('overlay').classList.remove('show');
  $('sheetFields').innerHTML = '';
  sheetSubmit = null;
}

document.addEventListener('DOMContentLoaded', () => {
  $('sheetForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sheetSubmit) return;
    const form = event.currentTarget;
    const btn = $('sheetSave');
    btn.disabled = true;
    try {
      await sheetSubmit(form);
    } catch (error) {
      toast(error.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('overlay').addEventListener('click', (event) => {
    if (event.target.id === 'overlay') closeSheet();
  });

  boot().catch((error) => {
    showLogin(error.message);
  });
});
