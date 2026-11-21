/* Autopilot Forex — member app. Talks to the platform API on the same origin. */
'use strict';

const state = {
  user: null,
  membership: null,
  plans: [],
  capabilities: {},
  signals: [],
  modalMode: 'login',
};

/* ── tiny helpers ───────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(cents, currency = 'USD') {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function shortDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

function banner(message, kind = 'warn') {
  const el = $('banner');
  if (!message) {
    el.className = 'banner';
    el.textContent = '';
    return;
  }
  el.textContent = message;
  el.className = `banner show ${kind}`;
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
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    const error = new Error(payload?.error?.message || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

/* ── data loads ─────────────────────────────────────────────────────── */
async function loadSite() {
  try {
    const site = await api('/api/public/site');
    state.plans = site.plans || [];
    state.capabilities = site.capabilities || {};
    renderPlans();
  } catch (error) {
    console.error(error);
  }
}

async function loadMarkets() {
  const badge = $('marketBadge');
  const rows = $('terminalRows');
  const cards = $('marketCards');
  try {
    const data = await api('/api/public/markets');
    const quotes = data.quotes || [];

    if (!quotes.length) {
      badge.className = 'badge warn';
      badge.textContent = 'not configured';
      $('marketNote').textContent = 'Live pricing is not connected yet. Nothing here is simulated.';
      rows.innerHTML = '<div class="skeleton">Add TWELVE_DATA_API_KEY in Railway to publish live quotes.</div>';
      cards.innerHTML = '<div class="card"><h3>Market data</h3><p class="muted">Quotes appear here once the provider key is set.</p></div>';
      return;
    }

    badge.className = 'badge live';
    badge.textContent = quotes.some((q) => q.stale) ? 'cached' : 'live';
    $('marketNote').textContent = `Updated ${new Date(quotes[0].updatedAt).toLocaleTimeString()}`;

    rows.innerHTML = quotes
      .slice(0, 4)
      .map((q) => {
        const cls = q.changePercent >= 0 ? 'positive' : 'negative';
        const sign = q.changePercent >= 0 ? '+' : '';
        return `<div class="terminal-row"><span>${esc(q.symbol)}</span>
          <span><strong>${q.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</strong>
          <span class="${cls}"> ${sign}${q.changePercent.toFixed(2)}%</span></span></div>`;
      })
      .join('');

    cards.innerHTML = quotes
      .map((q) => {
        const cls = q.changePercent >= 0 ? 'positive' : 'negative';
        const sign = q.changePercent >= 0 ? '+' : '';
        return `<div class="card"><h3>${esc(q.symbol)}</h3>
          <div class="price">${q.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
          <p class="${cls}">${sign}${q.changePercent.toFixed(2)}%</p></div>`;
      })
      .join('');
  } catch (error) {
    badge.className = 'badge warn';
    badge.textContent = 'unavailable';
    rows.innerHTML = `<div class="skeleton">${esc(error.message)}</div>`;
  }
}

async function loadPosts() {
  const container = $('postCards');
  try {
    const data = await api('/api/public/posts?pageSize=3');
    if (!data.items?.length) {
      container.innerHTML = '<div class="card"><h3>Research</h3><p class="muted">The first pieces publish soon.</p></div>';
      return;
    }
    container.innerHTML = data.items
      .map(
        (p) => `<a class="card" href="/post.html?slug=${encodeURIComponent(p.slug)}">
          <span class="badge ${p.vipOnly ? 'vip' : ''}">${p.vipOnly ? 'VIP' : esc(p.category)}</span>
          <h3>${esc(p.title)}</h3>
          <p>${esc(p.excerpt || '')}</p>
          <p class="small muted">${shortDate(p.publishedAt)}</p></a>`,
      )
      .join('');
  } catch {
    container.innerHTML = '<div class="card"><h3>Research</h3><p class="muted">Could not load posts.</p></div>';
  }
}

async function loadSignals() {
  try {
    const [pub, mine] = await Promise.all([
      api('/api/public/signals'),
      state.user ? api('/api/me/signals').catch(() => null) : Promise.resolve(null),
    ]);
    state.signals = pub.items || [];
    renderSignals();
    if (mine) renderMySignals(mine.items || []);
  } catch (error) {
    $('signalsTable').querySelector('tbody').innerHTML =
      `<tr><td colspan="8" class="empty">${esc(error.message)}</td></tr>`;
  }
}

/* ── rendering ──────────────────────────────────────────────────────── */
function renderSignals() {
  const body = $('signalsTable').querySelector('tbody');
  const items = state.signals;
  $('statSignals').textContent = String(items.length);

  if (!items.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No signals published yet.</td></tr>';
    $('signalsNote').textContent = '';
    return;
  }

  body.innerHTML = items
    .map((s) => {
      const dir = s.direction === 'BUY' ? 'buy' : 'sell';
      if (s.locked) {
        return `<tr class="locked">
          <td>${esc(s.pair)}</td><td><span class="badge ${dir}">${esc(s.direction)}</span></td>
          <td>${esc(s.timeframe)}</td><td>VIP</td><td>VIP</td><td>VIP</td><td>—</td>
          <td><span class="badge vip">upgrade</span></td></tr>`;
      }
      return `<tr>
        <td>${esc(s.pair)}</td>
        <td><span class="badge ${dir}">${esc(s.direction)}</span></td>
        <td>${esc(s.timeframe)}</td>
        <td>${s.entry}</td>
        <td>${s.stopLoss ?? '—'}</td>
        <td>${s.takeProfit ?? '—'}</td>
        <td>${s.confidence}%</td>
        <td><span class="badge">${esc(s.status)}</span></td>
      </tr>`;
    })
    .join('');

  $('signalsNote').textContent = state.membership?.vip
    ? 'Full detail is visible on your VIP membership.'
    : 'Locked rows are VIP-only. Free accounts see direction only.';
}

function renderMySignals(items) {
  const body = $('mySignals').querySelector('tbody');
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">No signals yet.</td></tr>';
    return;
  }
  body.innerHTML = items
    .slice(0, 12)
    .map(
      (s) => `<tr class="${s.locked ? 'locked' : ''}">
        <td>${esc(s.pair)}</td>
        <td>${esc(s.direction)}</td>
        <td>${esc(s.timeframe)}</td>
        <td>${s.locked ? 'VIP' : s.entry}</td>
        <td>${esc(s.status)}</td>
        <td>${shortDate(s.publishedAt)}</td></tr>`,
    )
    .join('');
}

function renderPlans() {
  const container = $('planBox');
  if (!state.plans.length) {
    $('planNote').textContent = 'Plans are being configured.';
    return;
  }

  const primary = state.plans.find((p) => p.currency === 'USD') || state.plans[0];
  $('planPrice').textContent = `${money(primary.priceCents, primary.currency)} / ${primary.interval.toLowerCase()}`;
  $('planNote').textContent = primary.description || 'Cancel anytime.';

  const buttons = state.plans
    .map((plan) => {
      const isKes = plan.currency === 'KES';
      const label = isKes ? 'Pay with M-Pesa' : 'Join with card';
      const available = isKes ? state.capabilities.mpesa : state.capabilities.cardPayments;
      return `<button class="btn ${isKes ? '' : 'primary'}" style="margin:8px 8px 0 0"
        data-plan="${esc(plan.code)}" data-provider="${isKes ? 'mpesa' : 'stripe'}"
        ${available ? '' : 'disabled title="Not enabled yet"'}>${label} · ${money(plan.priceCents, plan.currency)}</button>`;
    })
    .join('');

  container.innerHTML = `
    <div class="eyebrow">Membership</div>
    <h3>${money(primary.priceCents, primary.currency)} / ${esc(primary.interval.toLowerCase())}</h3>
    <p class="muted">${esc(primary.description || 'Cancel anytime.')}</p>
    <div>${buttons}</div>
    <p class="demo">Card or M-Pesa. Cancel anytime.</p>`;

  container.querySelectorAll('button[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => buyPlan(btn.dataset.plan, btn.dataset.provider));
  });
}

function renderSession() {
  const guest = $('guestView');
  const member = $('memberView');

  if (!state.user) {
    guest.hidden = false;
    member.hidden = true;
    $('loginBtn').hidden = false;
    $('registerBtn').hidden = false;
    return;
  }

  guest.hidden = true;
  member.hidden = false;
  $('loginBtn').hidden = true;
  $('registerBtn').hidden = true;

  $('welcomeMessage').textContent = `Welcome, ${state.user.fullName.split(' ')[0]}`;
  $('userEmail').textContent = state.user.email;

  const vip = state.membership?.vip;
  $('userPlan').textContent = vip ? state.membership.plan.name : 'Free';
  $('memberBadge').textContent = vip ? 'VIP' : 'FREE';
  $('memberBadge').className = `badge ${vip ? 'vip' : ''}`;
  $('userRenewal').textContent = vip ? shortDate(state.membership.currentPeriodEnd) : '—';
  $('cancelBtn').hidden = !(vip && !state.membership.cancelAtPeriodEnd);
  $('verifyNote').textContent = state.user.emailVerified
    ? ''
    : 'Your email is not verified yet — check your inbox for the link.';
}

/* ── auth ───────────────────────────────────────────────────────────── */
function openModal(mode) {
  state.modalMode = mode;
  $('modalTitle').textContent = mode === 'register' ? 'Create your account' : 'Member login';
  $('modalDescription').textContent =
    mode === 'register' ? 'Free account. Upgrade whenever you want.' : 'Welcome back to Autopilot Forex.';
  $('authMessage').textContent = '';
  $('submitButton').textContent = mode === 'register' ? 'Create Account' : 'Log In';
  $('submitButton').disabled = false;

  $('modalFields').innerHTML =
    mode === 'register'
      ? `<div class="field"><label for="mName">Full name</label><input id="mName" autocomplete="name" required></div>
         <div class="field"><label for="mEmail">Email</label><input id="mEmail" type="email" autocomplete="email" required></div>
         <div class="field"><label for="mPassword">Password</label><input id="mPassword" type="password" autocomplete="new-password" minlength="10" required>
         <span class="small muted">At least 10 characters, mixing letters with numbers or symbols.</span></div>`
      : `<div class="field"><label for="mEmail">Email</label><input id="mEmail" type="email" autocomplete="email" required></div>
         <div class="field"><label for="mPassword">Password</label><input id="mPassword" type="password" autocomplete="current-password" required></div>`;

  $('modal').classList.add('show');
  $('modalFields').querySelector('input')?.focus({ preventScroll: true });
}

function closeModal() {
  $('modal').classList.remove('show');
}

async function submitModal() {
  const email = $('mEmail')?.value.trim();
  const password = $('mPassword')?.value;
  const name = $('mName')?.value.trim();
  const message = $('authMessage');
  const button = $('submitButton');

  message.textContent = '';

  if (!email || !email.includes('@')) {
    message.textContent = 'Enter a valid email address.';
    return;
  }
  if (state.modalMode === 'register' && (!name || name.length < 2)) {
    message.textContent = 'Enter your full name.';
    return;
  }
  if (!password || (state.modalMode === 'register' && password.length < 10)) {
    message.textContent = 'Password must be at least 10 characters.';
    return;
  }

  button.disabled = true;
  button.textContent = 'Please wait…';

  try {
    const data =
      state.modalMode === 'register'
        ? await api('/api/auth/register', { method: 'POST', body: { fullName: name, email, password } })
        : await api('/api/auth/login', { method: 'POST', body: { email, password } });

    state.user = data.user;
    closeModal();
    await refreshSession();
    toast(state.modalMode === 'register' ? 'Account created. Check your email to verify.' : 'Welcome back.');
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = state.modalMode === 'register' ? 'Create Account' : 'Log In';
  }
}

async function refreshSession() {
  try {
    const session = await api('/api/auth/session');
    if (session.user) {
      const data = await api('/api/me');
      state.user = data.user;
      state.membership = data.membership;
    } else {
      state.user = null;
      state.membership = null;
    }
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      state.membership = null;
    }
  }
  renderSession();
  await loadSignals();
}

async function logoutUser() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } catch (error) {
    console.warn(error);
  }
  state.user = null;
  state.membership = null;
  renderSession();
  await loadSignals();
  toast('Signed out.');
}

/* ── billing ────────────────────────────────────────────────────────── */
async function buyPlan(planCode, provider) {
  if (!state.user) {
    openModal('login');
    toast('Sign in first, then choose your plan.');
    return;
  }

  let phone;
  if (provider === 'mpesa') {
    phone = window.prompt('M-Pesa phone number (e.g. 254712345678)');
    if (!phone) return;
  }

  try {
    const data = await api('/api/billing/checkout', {
      method: 'POST',
      body: { planCode, provider, ...(phone ? { phone } : {}) },
    });
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    toast('Checkout started. Follow the prompt on your phone.');
  } catch (error) {
    if (error.code === 'not_configured') {
      toast('Payments are still being switched on. Contact support and we will set you up manually.', true);
    } else {
      toast(error.message, true);
    }
  }
}

function buySelectedPlan() {
  const button = document.querySelector('#planBox button[data-plan]');
  if (button) button.click();
  else openModal('register');
}

async function cancelMembership() {
  if (!window.confirm('Cancel renewal at the end of this period?')) return;
  try {
    const data = await api('/api/billing/cancel', { method: 'POST', body: {} });
    toast(data.message || 'Cancellation recorded.');
    await refreshSession();
  } catch (error) {
    toast(error.message, true);
  }
}

/* ── misc ───────────────────────────────────────────────────────────── */
function toggleMenu() {
  $('navLinks').classList.toggle('show');
}

function initContact() {
  $('contactForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await api('/api/contact', {
        method: 'POST',
        body: {
          name: $('cName').value.trim(),
          email: $('cEmail').value.trim(),
          subject: $('cSubject').value.trim(),
          message: $('cMessage').value.trim(),
        },
      });
      form.reset();
      toast('Message sent. The team will reply by email.');
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

function initBanner() {
  const params = new URLSearchParams(window.location.search);

  // GitHub Pages is a static preview: say so instead of failing silently.
  if (window.location.hostname.endsWith('github.io')) {
    banner(
      'Preview build. Accounts, payments and live prices run on the application server, not on GitHub Pages.',
      'warn',
    );
    return;
  }
  if (params.get('verified') === '1') banner('Email verified. Welcome aboard.', 'ok');
  if (params.get('verified') === 'invalid') banner('That verification link is invalid or expired.', 'err');
  if (params.get('checkout') === 'success') banner('Payment received. Your VIP access activates as soon as the provider confirms.', 'ok');
  if (params.get('checkout') === 'cancelled') banner('Checkout cancelled. Nothing was charged.', 'warn');
}

document.addEventListener('DOMContentLoaded', async () => {
  initBanner();
  initContact();

  const bind = (id, fn) => {
    const el = $(id);
    if (el) el.addEventListener('click', fn);
  };
  bind('loginBtn', () => openModal('login'));
  bind('registerBtn', () => openModal('register'));
  bind('heroRegister', () => openModal('register'));
  bind('guestLogin', () => openModal('login'));
  bind('menuBtn', toggleMenu);
  bind('logoutBtn', logoutUser);
  bind('cancelBtn', cancelMembership);
  bind('planCta', buySelectedPlan);
  bind('submitButton', submitModal);
  bind('modalCancel', closeModal);
  bind('upgradeBtn', () => document.getElementById('vip').scrollIntoView({ behavior: 'smooth' }));

  $('modal').addEventListener('click', (event) => {
    if (event.target.id === 'modal') closeModal();
  });
  document.querySelectorAll('.nav-links a').forEach((link) => {
    link.addEventListener('click', () => $('navLinks').classList.remove('show'));
  });

  await loadSite();
  await Promise.all([loadMarkets(), loadPosts()]);
  await refreshSession();
});
