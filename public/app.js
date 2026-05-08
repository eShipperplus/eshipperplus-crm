// eShipper Plus CRM — client app
// Uses Firebase Auth (Google SSO) and talks to the Cloud Run backend.
// The mockup's inline <script> handles navigation/sorting/filtering.
// This module layers live data + API calls on top of that.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// Firebase web config — safe to expose; security is enforced server-side via Admin SDK
const firebaseConfig = {
  apiKey: window.__FIREBASE_API_KEY__ || 'AIzaSyCrRazbb_1q1Gq--2-nbguRQ0Sl2ziOm9Q',
  authDomain: window.__FIREBASE_AUTH_DOMAIN__ || 'eshipper-f56c3.firebaseapp.com',
  projectId: window.__FIREBASE_PROJECT_ID__ || 'eshipper-f56c3',
};

const fbApp = initializeApp(firebaseConfig);
const fbAuth = getAuth(fbApp);

// ─── Auth flow ───────────────────────────────────────────────────────────────
let currentUser = null; // { uid, email, displayName, role }
let idTokenCache = null;

async function getIdToken(forceRefresh = false) {
  if (!fbAuth.currentUser) return null;
  if (!forceRefresh && idTokenCache?.exp > Date.now() + 60_000) return idTokenCache.token;
  const token = await fbAuth.currentUser.getIdToken(forceRefresh);
  idTokenCache = { token, exp: Date.now() + 55 * 60_000 };
  return token;
}

async function api(path, opts = {}) {
  const token = await getIdToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? ' — ' + detail : ''}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Expose on window so the mockup's inline handlers can call these if needed
window.crmApi = api;

function showAuthGate(show) {
  const gate = document.getElementById('auth-gate');
  if (gate) gate.style.display = show ? 'flex' : 'none';
  // Hide the app shell when the auth gate is up (prevents the mockup
  // dashboard flashing behind the gate on every refresh).
  const appShell = document.getElementById('app');
  if (appShell) appShell.style.visibility = show ? 'hidden' : 'visible';
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg || '';
}

onAuthStateChanged(fbAuth, async (user) => {
  console.log('[auth] state changed, user:', user?.email || '(none)');
  if (!user) {
    currentUser = null;
    showAuthGate(true);
    return;
  }
  try {
    console.log('[auth] calling /api/me with token...');
    const me = await api('/api/me');
    console.log('[auth] /api/me ok:', me);
    currentUser = me;
    applyRoleToUI(me);
    showAuthGate(false);
    await bootAppData();
  } catch (err) {
    console.error('[auth] /api/me failed:', err);
    setAuthError('Sign-in succeeded but backend rejected your token: ' + err.message);
  }
});

function attachSignInHandler() {
  const btn = document.getElementById('auth-signin-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    setAuthError('');
    const provider = new GoogleAuthProvider();
    // NOTE: hd restriction removed for now — was silently filtering valid sign-ins
    try {
      console.log('[auth] starting popup sign-in');
      const result = await signInWithPopup(fbAuth, provider);
      console.log('[auth] popup resolved with user:', result?.user?.email);
    } catch (err) {
      console.error('[auth] popup error:', err);
      setAuthError(`${err.code || 'error'}: ${err.message}`);
    }
  });

  // Also handle the redirect-flow return trip in case any future call uses redirect
  getRedirectResult(fbAuth).then(r => {
    if (r) console.log('[auth] redirect resolved with user:', r.user?.email);
  }).catch(err => {
    console.error('[auth] redirect error:', err);
    setAuthError(`${err.code || 'error'}: ${err.message}`);
  });
}

// ─── UI adaptation by role ───────────────────────────────────────────────────
function applyRoleToUI(me) {
  // Update sidebar user card
  const av = document.querySelector('#sb-user .av');
  const un = document.querySelector('#sb-user .un');
  const ur = document.querySelector('#sb-user .ur');
  if (av) av.textContent = (me.displayName || me.email).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
  if (un) un.textContent = me.displayName;
  if (ur) ur.textContent = capitalize(me.role);

  // Hide admin-only nav for non-admins
  const isAdmin = me.role === 'admin';
  document.querySelectorAll('[onclick*="notif-settings"], [onclick*="users"], [onclick*="settings"]').forEach(el => {
    if (!isAdmin) el.style.display = 'none';
  });

  // Internal dev/scope banner — admin-only (1.A, 1.B)
  const devBanner = document.getElementById('dev-scope-banner');
  if (devBanner) devBanner.style.display = isAdmin ? 'flex' : 'none';
}

const capitalize = s => (s || '').charAt(0).toUpperCase() + (s || '').slice(1);

// ─── Boot data load ──────────────────────────────────────────────────────────
async function bootAppData() {
  try {
    const [deals, dash, notifs, users] = await Promise.all([
      api('/api/deals'),
      api('/api/dashboard'),
      api('/api/notifications'),
      api('/api/users'),
    ]);
    window.__crmState = { deals, dash, notifs, users };
    renderDashboard(dash);
    renderPipeline(deals);
    renderLeadsTable(deals);
    renderNotifications(notifs);
    renderUsers(users);
    renderDuplicateQueue();
    updateSidebarBadges(deals, notifs);
    wireDealDetailHandlers();
    wireManualLeadForm();
    wirePartnerRepUpload();
    wireNotificationRulesForm();
    wireUserManagement();
    wireExportCsv();
    wireOnboardingChecklist();
    wireTopBarButtons();
    wireDealEditButton();
    wirePhoneInputs();
    wirePartnerPortalScreen();
    wireRefListAddButtons();
    await loadReferenceLists();
    wireSettingsSaveButtons();
    setupAutoRefresh();
  } catch (err) {
    toast('Failed to load data: ' + err.message, 'error');
  }
}

// ─── Dashboard render ────────────────────────────────────────────────────────
function renderDashboard(dash) {
  if (!dash) return;
  const screen = document.getElementById('s-dashboard');
  if (!screen) return;

  // Top metric cards (1.1a/b/c/d/1.D/1.F). Tooltips clarify formulas (1.1d).
  const metrics = screen.querySelectorAll('.mrow .met .mv');
  const tiles = screen.querySelectorAll('.mrow .met');
  const tooltips = [
    'Deals not in Closed Won / Closed Lost / Onboarding.',
    'Sum of ARR across all active deals.',
    'Sum of (deal ARR × stage probability) across active deals. Stage probabilities are configurable in Settings.',
    'Closed Won ÷ (Closed Won + Closed Lost), all-time.',
    'Pipeline Value ÷ Active Deals. Different from "average Closed Won deal size" — confirm with finance which definition matters most.',
  ];
  tiles.forEach((tile, i) => { if (tooltips[i]) tile.title = tooltips[i]; });
  if (metrics.length >= 5) {
    metrics[0].textContent = dash.activeDeals || 0;
    metrics[1].textContent = fmtCompact(dash.pipelineValue || 0);
    metrics[2].textContent = fmtCompact(dash.weightedForecast || 0);
    metrics[3].textContent = Math.round((dash.winRate || 0) * 100) + '%';
    metrics[4].textContent = fmtCompact(dash.avgDealSize || 0);
  }
  // Hide the "↑3 vs last month" sublabels — we don't compute deltas yet
  screen.querySelectorAll('.mrow .met .ms').forEach(el => el.style.display = 'none');

  // Pipeline Funnel — first card. Bar width = $ value (1.2c).
  // Tooltips per stage explain what each means (1.G).
  const stages = ['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Contract', 'Onboarding'];
  const stageTooltips = {
    'New':           'Just submitted — first contact, not yet qualified.',
    'Qualified':     'Discovery done, fits our service — ready to pitch.',
    'Proposal Sent': 'Quote/proposal delivered — awaiting client response.',
    'Negotiation':   'Discussing terms / pricing.',
    'Closed Won':    'Verbal/written agreement — contract auto-generated and sent for signature.',
    'Contract':      'Contract sent to client, awaiting eSignature.',
    'Onboarding':    'Contract signed — Kim is onboarding the client (T+1 SLA).',
  };
  const funnelCard = screen.querySelectorAll('.card')[0];
  if (funnelCard && dash.funnel) {
    const max = Math.max(1, ...stages.map(s => dash.funnel[s]?.value || 0));
    const colors = { 'New': '#34368a', 'Qualified': '#5258b0', 'Proposal Sent': '#6868bb', 'Negotiation': '#e0832a', 'Closed Won': '#2ba877', 'Contract': '#2588d0', 'Onboarding': '#62c0ae' };
    funnelCard.querySelector('.cb').innerHTML = stages.map(stage => {
      const count = dash.funnel[stage]?.count || 0;
      const value = dash.funnel[stage]?.value || 0;
      const w = max ? Math.max(2, (value / max) * 100) : 2;
      return `<div class="frow" title="${esc(stageTooltips[stage])}">
        <div class="fl" style="cursor:help">${stage} <span style="color:var(--text3);font-size:9px">ⓘ</span></div>
        <div class="fbw"><div class="fb" style="width:${w}%;background:${colors[stage]}">${count} deal${count === 1 ? '' : 's'}</div></div>
        <div class="fc">${fmtCompact(value)}</div>
      </div>`;
    }).join('');
    // Sub-header note about bar width
    const ch = funnelCard.querySelector('.ch .cs');
    if (ch) ch.textContent = 'Bar width = $ value';
  }

  // Weighted Forecast card (second .card on dashboard)
  const forecastCard = screen.querySelectorAll('.card')[1];
  if (forecastCard && dash.funnel) {
    const stageWeight = { 'New': 0.10, 'Qualified': 0.25, 'Proposal Sent': 0.40, 'Negotiation': 0.65, 'Closed Won': 0.90, 'Contract': 0.95, 'Onboarding': 1.00 };
    const rows = stages.map(s => ({ s, weighted: (dash.funnel[s]?.value || 0) * (stageWeight[s] || 0) }));
    const maxW = Math.max(1, ...rows.map(r => r.weighted));
    forecastCard.querySelector('.cb').innerHTML = rows.map(r => {
      const w = maxW ? Math.max(2, (r.weighted / maxW) * 100) : 2;
      const pct = Math.round((stageWeight[r.s] || 0) * 100);
      return `<div class="fcast-row">
        <div class="fcast-s">${r.s} (${pct}%)</div>
        <div class="fcast-bw"><div class="fcast-b" style="width:${w}%">${fmtCompact(r.weighted)}</div></div>
        <div class="fcast-v">${fmtCompact(r.weighted)}</div>
      </div>`;
    }).join('');
  }

  // Deals by Owner — third .card. Highlight the logged-in user's own row (1.5a).
  const ownerCard = screen.querySelectorAll('.card')[2];
  if (ownerCard && dash.byOwner) {
    const sorted = [...dash.byOwner].sort((a, b) => b.pipeline - a.pipeline);
    const myUid = currentUser?.uid;
    ownerCard.querySelector('.cb').innerHTML = `<table class="dt">
      <tr><th>Rep</th><th>Deals</th><th>Pipeline</th></tr>
      ${sorted.length ? sorted.map(o => {
        const isMe = o.uid === myUid;
        return `<tr style="${isMe ? 'background:#fef9f0' : ''}">
          <td><strong>${esc(o.name)}</strong>${isMe ? ' <span style="color:var(--warn);font-size:9.5px;font-weight:600">YOU</span>' : ''}</td>
          <td>${o.deals}</td>
          <td>${fmtCompact(o.pipeline)}</td>
        </tr>`;
      }).join('') : '<tr><td colspan="3" style="text-align:center;color:var(--text3);padding:18px">No deals yet</td></tr>'}
    </table>`;
  }

  // Lead Sources — fourth .card
  const sourcesCard = screen.querySelectorAll('.card')[3];
  if (sourcesCard && dash.bySource) {
    const total = Object.values(dash.bySource).reduce((s, n) => s + n, 0);
    const colors = ['var(--purple)', 'var(--purple-lt)', 'var(--teal)', 'var(--teal-lt)', 'var(--grey-dk)'];
    const entries = Object.entries(dash.bySource).sort((a, b) => b[1] - a[1]);
    sourcesCard.querySelector('.cb').innerHTML = entries.length
      ? entries.map(([name, count], i) => {
          const pct = total ? Math.round((count / total) * 100) : 0;
          return `<div class="srow">
            <div class="sn">${esc(name)}</div>
            <div class="sbw"><div class="sb" style="width:${pct}%;background:${colors[i % colors.length]}"></div></div>
            <div class="sp">${pct}%</div>
          </div>`;
        }).join('')
      : '<div style="text-align:center;color:var(--text3);padding:18px;font-size:12px">No leads yet</div>';
  }

  // Recent Activity — fifth .card (1.7) — loaded async via /api/activity/recent
  loadRecentActivity();
}

async function loadRecentActivity() {
  const screen = document.getElementById('s-dashboard');
  const activityCard = screen?.querySelectorAll('.card')[4];
  if (!activityCard) return;
  const list = activityCard.querySelector('.cb .alist') || activityCard.querySelector('.cb');
  if (!list) return;
  try {
    const items = await api('/api/activity/recent?limit=10');
    if (!items.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--text3);padding:18px;font-size:12px">No activity yet — submit a lead or move a deal to see entries here.</div>';
      return;
    }
    const dealsById = Object.fromEntries((window.__crmState.deals || []).map(d => [d.id, d]));
    list.innerHTML = items.map(a => {
      const dealName = dealsById[a.dealId]?.companyName || a.dealId?.slice(0, 8) || '—';
      return `
        <div class="ai">
          <div class="at">${relativeTime(a.timestamp)}</div>
          <div class="ax"><strong>${esc(dealName)}</strong> — ${esc(activityTitle(a))}${a.detail ? ` <span style="color:var(--text3)">· ${esc(a.detail)}</span>` : ''}${a.actorName ? ` <span style="color:var(--text3)">by ${esc(a.actorName)}</span>` : ''}</div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="text-align:center;color:var(--danger);padding:18px;font-size:12px">Couldn't load activity: ${esc(err.message)}</div>`;
  }
}

function fmtCompact(n) {
  if (!n || n === 0) return '—';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

function fmtMonthly(n) {
  if (!n || n === 0) return '—';
  return '$' + Math.round(n).toLocaleString() + '/mo';
}

// (416) 818-1981 from any digit-only input; preserves +1 prefix if present
function fmtPhone(s) {
  if (!s) return '—';
  const digits = String(s).replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return s;
}

// ─── Pipeline Kanban render ──────────────────────────────────────────────────
function renderPipeline(deals) {
  const kanban = document.querySelector('#s-pipeline .kanban');
  if (!kanban) return;

  // Apply pipeline filters (owner + source)
  const ownerFilter = document.getElementById('pipeline-filter-owner')?.value || '';
  const sourceFilter = document.getElementById('pipeline-filter-source')?.value || '';
  const visible = deals
    .filter(d => !d.discarded && !d.mergedInto)
    .filter(d => !ownerFilter || d.ownerUid === ownerFilter)
    .filter(d => !sourceFilter || d.source === sourceFilter);

  const stages = ['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Contract', 'Onboarding'];
  kanban.innerHTML = stages.map(stage => {
    const stageDeals = visible.filter(d => d.stage === stage);
    const empty = stageDeals.length === 0
      ? `<div style="padding:12px;text-align:center;font-size:10.5px;color:var(--text3);font-style:italic">No deals</div>`
      : '';
    return `
      <div class="kc" data-stage="${esc(stage)}" data-dropzone>
        <div class="kh">${esc(stage)}<span class="kbadge">${stageDeals.length}</span></div>
        ${stageDeals.map(d => dealCardHtml(d)).join('')}
        ${empty}
      </div>`;
  }).join('');
  wireKanbanDragDrop();

  // Pipeline header stats — replaces hardcoded "24 active deals · $1.84M"
  const activeDeals = visible.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
  const pipelineValue = activeDeals.reduce((s, d) => s + (d.arr || 0), 0);
  const headerStats = document.getElementById('pipeline-header-stats');
  if (headerStats) {
    headerStats.textContent = `${visible.length} deal${visible.length === 1 ? '' : 's'} · ${fmtCompact(pipelineValue)} pipeline`;
  }

  // Populate the owner filter dropdown from real users (G.1)
  populateOwnerDropdowns();
}

// Re-render pipeline when filters change
window.applyPipelineFilters = () => {
  renderPipeline(window.__crmState.deals || []);
};

// ─── Owner dropdown population (G.1) ─────────────────────────────────────────
// Single source of truth: pull from /api/users → populate every owner dropdown
// in the app (Leads filter, Pipeline filter, Deal Detail Change Rep modal,
// Manual Lead Entry "owner" select).
function populateOwnerDropdowns() {
  const users = window.__crmState.users || [];
  const repsAndAdmins = users.filter(u => u.role === 'rep' || u.role === 'admin');

  // Leads filter — keep "All Owners" + clear list, then add real users
  const leadsFilter = document.getElementById('lead-filter-owner');
  if (leadsFilter) {
    const current = leadsFilter.value;
    leadsFilter.innerHTML = '<option value="">All Owners</option>' +
      repsAndAdmins.map(u => `<option value="${esc(u.displayName)}">${esc(u.displayName)}</option>`).join('');
    leadsFilter.value = current;
  }

  // Pipeline filter — uses uid to match deal.ownerUid
  const pipelineFilter = document.getElementById('pipeline-filter-owner');
  if (pipelineFilter) {
    const current = pipelineFilter.value;
    pipelineFilter.innerHTML = '<option value="">All Owners</option>' +
      repsAndAdmins.map(u => `<option value="${esc(u.uid)}">${esc(u.displayName)}</option>`).join('');
    pipelineFilter.value = current;
  }

  // Rep reassignment modal in Deal Detail — uses uid. Mark current owner
  // visually + leave the dropdown unselected to force an explicit pick (so
  // we never accidentally reassign Ali → Ali).
  const repModal = document.querySelector('#rep-modal select.fsel');
  if (repModal) {
    const currentOwnerUid = window.__crmState.currentDeal?.ownerUid;
    repModal.innerHTML = `<option value="">— Select a different rep —</option>` +
      repsAndAdmins.map(u => {
        const isCurrent = u.uid === currentOwnerUid;
        return `<option value="${esc(u.uid)}" ${isCurrent ? 'disabled' : ''}>${esc(u.displayName)}${u.role === 'admin' ? ' (Admin)' : ''}${isCurrent ? ' — current owner' : ''}</option>`;
      }).join('');
  }

  // Deal Detail "Owner" inline select
  const dealOwner = document.getElementById('deal-owner-select');
  if (dealOwner) {
    const current = dealOwner.value;
    dealOwner.innerHTML = repsAndAdmins.map(u =>
      `<option value="${esc(u.uid)}">${esc(u.displayName)}</option>`
    ).join('');
    if (current) dealOwner.value = current;
  }
}
document.addEventListener('change', e => {
  if (e.target?.id === 'pipeline-filter-owner' || e.target?.id === 'pipeline-filter-source') {
    window.applyPipelineFilters();
  }
});

function dealCardHtml(d) {
  const ownerColor = pickOwnerColor(d.ownerUid || d.ownerName || '');
  const wonClass = d.stage === 'Closed Won' ? ' won' : '';
  const monthly = d.monthlyRevenue || 0;
  // 2.B — days in stage + stale flag (red dot if 7+ days since last activity)
  const lastActivityTs = d.lastActivityAt?._seconds || d.lastActivityAt?.seconds;
  const daysIdle = lastActivityTs ? Math.floor((Date.now() / 1000 - lastActivityTs) / 86400) : null;
  const stale = daysIdle !== null && daysIdle >= 7 && !['Closed Won', 'Closed Lost', 'Onboarding'].includes(d.stage);
  const idleBadge = daysIdle !== null
    ? `<span style="font-size:9.5px;color:${stale ? 'var(--danger)' : 'var(--text3)'};margin-left:4px" title="${esc(stale ? 'Stale — no activity in 7+ days' : 'Days since last activity')}">${stale ? '🔴 ' : ''}${daysIdle}d</span>`
    : '';
  // Approval pill on card if approval is pending
  const approvalPill = d.approvalStatus === 'pending'
    ? '<span style="font-size:9px;background:#fff4e6;color:#7a4a00;border:1px solid #e0832a;border-radius:3px;padding:1px 5px;margin-left:4px">🔐 Pending</span>'
    : '';
  return `
    <div class="kcard${wonClass}" draggable="true" data-deal-id="${esc(d.id)}" onclick="window.openDeal('${esc(d.id)}')">
      <div class="kcard-n">${esc(d.companyName)}${d.duplicateFlag ? ' <span style="color:#cc3d3d" title="Possible duplicate">⚠</span>' : ''}${approvalPill}</div>
      <div class="kcard-m">${esc((d.services && d.services[0]?.name) || 'Services TBD')} · ${esc(d.source || '')}${idleBadge}</div>
      <div class="kcard-v" style="${monthly === 0 ? 'color:var(--text3)' : ''}">${fmtMonthly(monthly)}</div>
      <div class="kcard-o"><div class="odot" style="background:${ownerColor}"></div>${esc(d.ownerName || 'Unassigned')}</div>
    </div>`;
}

function pickOwnerColor(key) {
  const palette = ['#34368a', '#e0832a', '#2ba877', '#cc3d3d', '#62c0ae', '#5258b0'];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

function wireKanbanDragDrop() {
  // Only admins and deal owners can drag. We defer the permission check to the
  // API; on failure, we roll back the DOM move.
  document.querySelectorAll('.kcard[draggable="true"]').forEach(card => {
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/deal-id', card.dataset.dealId);
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  document.querySelectorAll('[data-dropzone]').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
    col.addEventListener('drop', async e => {
      e.preventDefault();
      const dealId = e.dataTransfer.getData('text/deal-id');
      if (!dealId) return;
      const toStage = col.dataset.stage;
      const card = document.querySelector(`.kcard[data-deal-id="${dealId}"]`);
      if (!card) return;
      const originalParent = card.parentElement;
      col.appendChild(card);

      try {
        if (toStage === 'Closed Lost') {
          // R-24 prompt — handled through the Deal Detail modal; rollback
          originalParent.appendChild(card);
          toast('Use the Mark Lost button on the deal to record loss reason.', 'warn');
          return;
        }
        const r = await api(`/api/deals/${dealId}/stage`, {
          method: 'POST',
          body: JSON.stringify({ toStage }),
        });
        if (r?.status === 'pending_approval') {
          toast('Proposal approval requested — deal will move to Proposal Sent after admin approval.', 'info');
          originalParent.appendChild(card); // revert; deal will move on approval
        } else {
          toast(`Moved to ${toStage}`, 'ok');
          await refreshPipeline();
        }
      } catch (err) {
        originalParent.appendChild(card);
        toast('Move failed: ' + err.message, 'error');
      }
    });
  });
}

// Single source of truth for "something changed, re-render everything".
// Called after every mutation (lead created, stage moved, etc.) plus on a
// 30s interval and when the tab regains focus, so data never goes stale.
async function refreshAll({ silent = false } = {}) {
  try {
    const [deals, dash, notifs, users] = await Promise.all([
      api('/api/deals'),
      api('/api/dashboard'),
      api('/api/notifications'),
      api('/api/users'),
    ]);
    window.__crmState.deals = deals;
    window.__crmState.dash = dash;
    window.__crmState.notifs = notifs;
    window.__crmState.users = users;
    renderDashboard(dash);
    renderPipeline(deals);
    renderLeadsTable(deals);
    renderNotifications(notifs);
    renderUsers(users);
    renderDuplicateQueue();
    updateSidebarBadges(deals, notifs);
  } catch (err) {
    if (!silent) toast('Refresh failed: ' + err.message, 'error');
  }
}
// Backward-compat alias for the old name used in many handlers
const refreshPipeline = refreshAll;

// ─── Leads table render ──────────────────────────────────────────────────────
function renderLeadsTable(deals) {
  const tbody = document.getElementById('leads-tbody');
  if (!tbody) return;
  const stagePill = {
    'New': 'p-new', 'Qualified': 'p-qual', 'Proposal Sent': 'p-prop',
    'Negotiation': 'p-neg', 'Closed Won': 'p-won', 'Contract': 'p-con',
    'Onboarding': 'p-ob', 'Closed Lost': 'p-lost',
  };
  const visible = deals.filter(d => !d.discarded && !d.mergedInto);
  tbody.innerHTML = visible.map(d => {
    const monthly = d.monthlyRevenue || 0;
    // 3.E — pack hidden searchable fields (email, phone) into the row for the search filter
    const hidden = [d.contactEmail, d.contactPhone].filter(Boolean).map(esc).join(' ');
    return `
    <tr onclick="window.openDeal('${esc(d.id)}')" data-search="${hidden}">
      <td><strong>${esc(d.companyName)}</strong>${d.duplicateFlag ? ' <span class="dup-badge">⚠ Dup</span>' : ''}</td>
      <td>${esc(d.contactName) || '<span style="color:var(--text3)">—</span>'}</td>
      <td>${esc(d.industry) || '<span style="color:var(--text3)">—</span>'}</td>
      <td>${esc(d.source) || '<span style="color:var(--text3)">—</span>'}</td>
      <td data-val="${monthly}" ${monthly === 0 ? 'style="color:var(--text3)"' : ''}>${fmtMonthly(monthly)}</td>
      <td><span class="pill ${stagePill[d.stage] || 'p-new'}">${esc(d.stage)}</span></td>
      <td>${esc(d.ownerName || 'Unassigned')}</td>
      <td data-val="${-(d.updatedAt?._seconds || 0)}">${relativeTime(d.updatedAt)}</td>
      <td><button class="btn btn-sm" style="padding:2px 8px;font-size:10px" onclick="event.stopPropagation();window.openDeal('${esc(d.id)}')">View</button></td>
    </tr>`;
  }).join('');
  const count = document.getElementById('lead-count');
  if (count) count.textContent = `${visible.length} lead${visible.length === 1 ? '' : 's'}`;
}

function relativeTime(ts) {
  if (!ts) return '—';
  const s = ts._seconds || ts.seconds || (ts.toDate ? ts.toDate().getTime() / 1000 : 0);
  if (!s) return '—';
  const diff = Date.now() / 1000 - s;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 86400 * 7) return Math.floor(diff / 86400) + 'd ago';
  return new Date(s * 1000).toLocaleDateString();
}

function formatDate(ts) {
  if (!ts) return '—';
  const s = ts._seconds || ts.seconds || (ts.toDate ? ts.toDate().getTime() / 1000 : 0);
  if (!s) return '—';
  return new Date(s * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function tierLabel(tier) {
  return { 1: ' — < $5K/mo', 2: ' — $5K–10K/mo', 3: ' — $10K–25K/mo', 4: ' — $25K+/mo' }[tier] || '';
}

// ─── Notifications render ────────────────────────────────────────────────────
function renderNotifications(notifs) {
  const list = document.getElementById('notif-list');
  if (!list) return;
  if (!notifs.length) {
    list.innerHTML = `<div style="padding:24px;text-align:center;color:#9496b4;font-size:12px">No notifications yet.</div>`;
  } else {
    list.innerHTML = notifs.map(n => notifItemHtml(n)).join('');
  }
  const unread = notifs.filter(n => !n.read).length;
  const el = document.getElementById('notif-unread-count');
  if (el) el.textContent = `${unread} unread`;
}

function notifItemHtml(n) {
  const typeIcon = { lead: '🔔', duplicate: '⚠️', approval: '🔐', inactivity: '⏰', onboarding: '📋', reassign: '🔄', reengagement: '📬' }[n.type] || '📌';
  const ts = relativeTime(n.createdAt);
  return `
    <div class="notif-item ${n.read ? 'read' : 'unread'}" data-id="${esc(n.id)}" style="display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);${n.read ? 'opacity:.6' : 'background:#fafbff'}">
      <div style="width:8px;height:8px;border-radius:50%;background:${n.read ? 'var(--border)' : 'var(--purple)'};flex-shrink:0;margin-top:5px"></div>
      <div style="flex:1;cursor:${n.dealId ? 'pointer' : 'default'}" onclick="${n.dealId ? `window.openDeal('${esc(n.dealId)}')` : ''}">
        <div style="font-size:12px;font-weight:${n.read ? 500 : 600}">${typeIcon} ${esc(n.title)}</div>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">${esc(n.body || '')}</div>
        <div style="font-size:10px;color:var(--text3);margin-top:3px">${ts}</div>
      </div>
      ${!n.read ? `<button class="btn btn-sm" style="padding:2px 10px;font-size:10px;flex-shrink:0" onclick="window.markNotifRead('${esc(n.id)}')">Mark read</button>` : ''}
    </div>`;
}

window.markNotifRead = async (id) => {
  try {
    await api(`/api/notifications/${id}/read`, { method: 'POST' });
    const n = (window.__crmState.notifs || []).find(x => x.id === id);
    if (n) n.read = true;
    renderNotifications(window.__crmState.notifs);
    updateSidebarBadges(window.__crmState.deals, window.__crmState.notifs);
  } catch (err) { toast(err.message, 'error'); }
};

// Override the mockup's markAllRead for live wiring
window.markAllRead = async () => {
  try {
    await api('/api/notifications/mark-all-read', { method: 'POST' });
    window.__crmState.notifs.forEach(n => { n.read = true; });
    renderNotifications(window.__crmState.notifs);
    updateSidebarBadges(window.__crmState.deals, window.__crmState.notifs);
  } catch (err) { toast(err.message, 'error'); }
};

function updateSidebarBadges(deals, notifs) {
  const visibleDeals = (deals || []).filter(d => !d.discarded && !d.mergedInto);
  const activeDeals = visibleDeals.filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage));
  const unread = (notifs || []).filter(n => !n.read).length;
  // Sidebar nav order from index.html:
  //   [0] Pipeline (active deals)
  //   [1] Leads (all visible deals — same count as the leads table)
  //   [2] Notifications (unread)
  const badges = document.querySelectorAll('#sb .nbadge');
  if (badges[0]) badges[0].textContent = activeDeals.length;
  if (badges[1]) badges[1].textContent = visibleDeals.length;
  if (badges[2]) badges[2].textContent = unread;
}

// ─── Deal detail ─────────────────────────────────────────────────────────────
window.openDeal = async (id) => {
  try {
    const [deal, activity] = await Promise.all([
      api(`/api/deals/${id}`),
      api(`/api/deals/${id}/activity`),
    ]);
    window.__crmState.currentDeal = deal;
    // Hide the empty state, show real content
    const emptyState = document.getElementById('deal-empty-state');
    const dealContent = document.getElementById('deal-content');
    if (emptyState) emptyState.style.display = 'none';
    if (dealContent) dealContent.style.display = 'block';
    renderDealDetail(deal, activity);
    if (typeof window.show === 'function') {
      const navEl = document.querySelector('.ni[onclick*="deal"]');
      window.show('deal', navEl);
    }
  } catch (err) { toast('Failed to open deal: ' + err.message, 'error'); }
};

function renderDealDetail(d, activity) {
  const screen = document.getElementById('s-deal');
  if (!screen) return;
  // Title row
  const titleSpan = screen.querySelector('span[style*="font-size:16px"]');
  if (titleSpan) titleSpan.textContent = d.companyName;
  const titlePill = titleSpan?.parentElement?.querySelector('.pill');
  if (titlePill) {
    titlePill.className = 'pill ' + stagePillClass(d.stage);
    titlePill.textContent = d.stage;
  }
  const dupBadge = titleSpan?.parentElement?.querySelector('.dup-badge');
  if (dupBadge) dupBadge.style.display = d.duplicateFlag ? '' : 'none';

  // Info rows — every .drow's .dv must reflect live data
  const rows = screen.querySelectorAll('.drow');
  // Map by label text (.dk) so reordering the HTML doesn't break this
  rows.forEach(row => {
    const key = row.querySelector('.dk')?.textContent.trim().toLowerCase();
    const dv = row.querySelector('.dv');
    if (!dv) return;
    switch (key) {
      case 'company':       dv.textContent = d.companyName || '—'; break;
      case 'contact':       dv.textContent = d.contactName || '—'; break;
      case 'email': {
        // 4.E — clickable mailto link
        if (d.contactEmail) {
          dv.innerHTML = `<a href="mailto:${esc(d.contactEmail)}" style="color:var(--purple);text-decoration:none">${esc(d.contactEmail)}</a>`;
        } else {
          dv.textContent = '—';
        }
        break;
      }
      case 'phone': {
        // 4.E — clickable tel link
        const formatted = fmtPhone(d.contactPhone);
        if (d.contactPhone && formatted !== '—') {
          const digits = String(d.contactPhone).replace(/\D/g, '');
          dv.innerHTML = `<a href="tel:+1${esc(digits)}" style="color:var(--purple);text-decoration:none">${esc(formatted)}</a>`;
        } else {
          dv.textContent = '—';
        }
        break;
      }
      case 'industry': {
        const sel = dv.querySelector('select');
        if (sel) sel.value = d.industry || '';
        break;
      }
      case 'lead source': {
        const sel = dv.querySelector('select');
        if (sel) sel.value = d.source || '';
        break;
      }
      case 'owner': {
        const sel = dv.querySelector('select');
        if (sel) sel.value = d.ownerUid || '';
        break;
      }
      case 'deal tier': {
        const pill = dv.querySelector('.pill');
        if (pill) pill.textContent = d.tier ? `Tier ${d.tier}${tierLabel(d.tier)}` : '—';
        break;
      }
      case 'created':       dv.textContent = formatDate(d.createdAt); break;
      case 'last activity': dv.textContent = relativeTime(d.lastActivityAt); break;
    }
  });

  // Top breadcrumb / title bar reflects this deal (4.1)
  const tbTitle = document.getElementById('tb-title');
  if (tbTitle && screen.classList.contains('on')) {
    tbTitle.textContent = `Deal Detail — ${d.companyName}`;
  }
  // Industry/source/owner are selects; leave them for quick-edit

  // Activity log
  const activityCard = screen.querySelectorAll('.card')[1];
  if (activityCard) {
    const log = activityCard.querySelector('.cb > div');
    if (log) {
      log.innerHTML = activity.map(a => `
        <div style="display:flex;gap:10px;font-size:11px">
          <div class="av" style="width:22px;height:22px;font-size:9px;background:${pickOwnerColor(a.actorUid || a.kind)};flex-shrink:0">${(a.actorName || '⚙').split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase()}</div>
          <div>
            <div style="font-weight:500">${esc(activityTitle(a))}</div>
            ${a.detail ? `<div style="color:var(--text3);font-size:10px">${esc(a.detail)}</div>` : ''}
            <div style="font-size:10px;color:var(--text3)">${relativeTime(a.timestamp)}</div>
          </div>
        </div>`).join('');
    }
  }
  document.getElementById('deal-detail-id')?.remove();
  const idMarker = document.createElement('input');
  idMarker.type = 'hidden'; idMarker.id = 'deal-detail-id'; idMarker.value = d.id;
  screen.prepend(idMarker);

  // Service Breakdown: dynamic rows + auto-recalc (4.3, 4.4a, 4.4b)
  renderServiceBreakdown(d);
  wireServiceBreakdownButtons();

  // Duplicate review controls for admins with a flag set
  renderDuplicateBanner(d);

  // Approval workflow banner (4.M)
  renderApprovalBanner(d);
}

// ─── Approval banner (4.M) ───────────────────────────────────────────────────
// Surfaces approval state. Admins see Approve/Reject when status='pending'.
// Reps see "Pending approval" or "Rejected — rework needed" with reason.
function renderApprovalBanner(d) {
  const screen = document.getElementById('s-deal');
  const existing = document.getElementById('approval-banner');
  if (existing) existing.remove();

  const status = d.approvalStatus;
  if (!status || status === 'approved') return; // nothing to show

  const banner = document.createElement('div');
  banner.id = 'approval-banner';
  banner.style.cssText = 'border-radius:6px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px';

  if (status === 'pending') {
    const isAdmin = currentUser?.role === 'admin';
    banner.style.background = '#fff4e6';
    banner.style.border = '1px solid #e0832a';
    banner.style.color = '#7a4a00';
    banner.innerHTML = `
      <div>🔐 <strong>Approval pending</strong> — proposal needs admin approval before sending to client.
      ${d.approvalRequestedAt ? `<span style="color:#9a6300">Requested ${esc(relativeTime(d.approvalRequestedAt))}</span>` : ''}</div>
      ${isAdmin ? `
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" id="approval-reject-btn" style="background:var(--danger-bg);color:var(--danger);border-color:var(--danger)">Reject</button>
          <button class="btn btn-p btn-sm" id="approval-approve-btn">Approve</button>
        </div>` : '<span style="color:#9a6300;font-style:italic">Awaiting admin</span>'}`;
  } else if (status === 'rejected') {
    banner.style.background = '#fdeaea';
    banner.style.border = '1px solid #cc3d3d';
    banner.style.color = '#992020';
    banner.innerHTML = `
      <div>❌ <strong>Proposal rejected</strong> — rework needed.
      ${d.rejectionReason ? `<div style="font-style:italic;margin-top:3px">"${esc(d.rejectionReason)}"</div>` : ''}</div>`;
  }

  // Inject just below the rep-bar (the bar above Deal Information card)
  const dealContent = document.getElementById('deal-content');
  const insertBefore = dealContent?.querySelector('div[style*="grid-template-columns:1fr 1fr"]');
  if (insertBefore && insertBefore.parentElement) {
    insertBefore.parentElement.insertBefore(banner, insertBefore);
  }

  // Wire admin Approve/Reject buttons
  document.getElementById('approval-approve-btn')?.addEventListener('click', async () => {
    const id = document.getElementById('deal-detail-id')?.value;
    if (!id) return;
    try {
      await api(`/api/deals/${id}/approval`, { method: 'POST', body: JSON.stringify({ approved: true }) });
      toast('Proposal approved · deal advanced to Proposal Sent', 'ok');
      await refreshAll();
      openDeal(id);
    } catch (err) { toast('Approve failed: ' + err.message, 'error'); }
  });
  document.getElementById('approval-reject-btn')?.addEventListener('click', async () => {
    const id = document.getElementById('deal-detail-id')?.value;
    if (!id) return;
    const reason = prompt('Rework notes for the rep (will be emailed and shown on the deal):');
    if (reason === null) return;
    try {
      await api(`/api/deals/${id}/approval`, {
        method: 'POST',
        body: JSON.stringify({ approved: false, reason: reason.trim() }),
      });
      toast('Proposal rejected · rep notified', 'ok');
      await refreshAll();
      openDeal(id);
    } catch (err) { toast('Reject failed: ' + err.message, 'error'); }
  });
}

function activityTitle(a) {
  const titles = {
    stage_change: 'Stage changed',
    edit: 'Deal edited',
    note: 'Note added',
    rep_reassigned: 'Rep reassigned',
    proposal_approved: 'Proposal approved',
    proposal_rejected: 'Proposal rejected',
    contract_generated: 'Contract generated',
    signed: 'Contract signed',
    duplicate_flagged: 'Possible duplicate flagged',
    duplicate_cleared: 'Duplicate cleared',
    inactivity_rep: 'Inactivity — rep notified',
    inactivity_admin: 'Inactivity — admin escalated',
    reengagement_due: 'Re-engagement date reached',
    discarded: 'Discarded',
    merged: 'Merged into another deal',
    onboarding_update: 'Onboarding checklist updated',
    welcome_sent: 'Welcome email sent',
    partner_attribution: 'Partner attribution logged',
  };
  return titles[a.kind] || a.kind;
}

function stagePillClass(stage) {
  return {
    'New': 'p-new', 'Qualified': 'p-qual', 'Proposal Sent': 'p-prop',
    'Negotiation': 'p-neg', 'Closed Won': 'p-won', 'Contract': 'p-con',
    'Onboarding': 'p-ob', 'Closed Lost': 'p-lost',
  }[stage] || 'p-new';
}

// ─── Service Breakdown (4.3, 4.4a, 4.4b) ────────────────────────────────────
const SERVICE_CATALOG = [
  'Freight',
  'Small Parcel Shipping',
  'Warehousing & Fulfillment',
  'Cross-Docking',
  'Value Added Services (VAS)',
];

function renderServiceBreakdown(deal) {
  const tbody = document.getElementById('service-breakdown-tbody');
  if (!tbody) return;
  // Map existing services on the deal by name → { rev, model }
  const existing = {};
  (deal.services || []).forEach(s => {
    existing[s.name] = {
      rev: Number(s.monthlyRevenue) || 0,
      model: s.revenueModel || 'monthly',
    };
  });

  // Default revenue model per service. Freight is one-time per shipment.
  const defaultModel = {
    'Freight': 'one_time',
    'Small Parcel Shipping': 'volume_based',
    'Warehousing & Fulfillment': 'monthly',
    'Cross-Docking': 'volume_based',
    'Value Added Services (VAS)': 'monthly',
  };

  tbody.innerHTML = SERVICE_CATALOG.map(name => {
    const ex = existing[name];
    const rev = ex?.rev || 0;
    const model = ex?.model || defaultModel[name] || 'monthly';
    const active = !!ex && rev > 0;
    return `
      <tr data-svc="${esc(name)}">
        <td>${esc(name)}</td>
        <td>
          <select class="fsel service-model-select" ${active ? '' : 'disabled'}
                  style="width:100%;padding:3px 6px;font-size:11px">
            <option value="monthly" ${model === 'monthly' ? 'selected' : ''}>Monthly Recurring</option>
            <option value="one_time" ${model === 'one_time' ? 'selected' : ''}>One-Time</option>
            <option value="volume_based" ${model === 'volume_based' ? 'selected' : ''}>Volume-Based</option>
          </select>
        </td>
        <td>
          <input class="fi service-rev-input" type="number" min="0" step="100"
                 value="${active ? rev : ''}" placeholder="—"
                 ${active ? '' : 'disabled style="background:var(--surface);color:var(--text3)"'}
                 style="width:100%;padding:4px 8px;font-size:11.5px">
        </td>
        <td>
          <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
            <input type="checkbox" class="service-active-cb" ${active ? 'checked' : ''}>
            <span>${active ? 'Active' : 'Off'}</span>
          </label>
        </td>
      </tr>`;
  }).join('');

  // Wire toggle + input recalc + model change
  tbody.querySelectorAll('.service-active-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const row = cb.closest('tr');
      const input = row.querySelector('.service-rev-input');
      const sel = row.querySelector('.service-model-select');
      const label = cb.parentElement.querySelector('span');
      if (cb.checked) {
        input.disabled = false;
        sel.disabled = false;
        input.style.background = '';
        input.style.color = '';
        label.textContent = 'Active';
        if (!input.value) input.focus();
      } else {
        input.disabled = true;
        sel.disabled = true;
        input.value = '';
        input.style.background = 'var(--surface)';
        input.style.color = 'var(--text3)';
        label.textContent = 'Off';
      }
      recalcServiceTotals();
    });
  });
  tbody.querySelectorAll('.service-rev-input').forEach(input => {
    input.addEventListener('input', recalcServiceTotals);
  });
  tbody.querySelectorAll('.service-model-select').forEach(sel => {
    sel.addEventListener('change', recalcServiceTotals);
  });

  recalcServiceTotals();
}

function recalcServiceTotals() {
  const tbody = document.getElementById('service-breakdown-tbody');
  if (!tbody) return;
  let recurring = 0;
  let oneTime = 0;
  tbody.querySelectorAll('tr').forEach(row => {
    const cb = row.querySelector('.service-active-cb');
    const input = row.querySelector('.service-rev-input');
    const model = row.querySelector('.service-model-select')?.value || 'monthly';
    const v = Number(input?.value) || 0;
    if (cb?.checked && v > 0) {
      if (model === 'one_time') oneTime += v;
      else recurring += v;
    }
  });
  const monthlyEl = document.getElementById('service-total-monthly');
  const arrEl = document.getElementById('service-total-arr');
  const onetimeLine = document.getElementById('service-onetime-line');
  const onetimeEl = document.getElementById('service-total-onetime');
  if (monthlyEl) {
    monthlyEl.textContent = recurring === 0 ? '—' : '$' + recurring.toLocaleString() + ' / mo';
    monthlyEl.style.color = recurring === 0 ? 'var(--text3)' : 'var(--success)';
  }
  if (arrEl) {
    arrEl.textContent = recurring === 0 ? '—' : '$' + (recurring * 12).toLocaleString();
  }
  if (onetimeLine && onetimeEl) {
    if (oneTime > 0) {
      onetimeLine.style.display = 'inline';
      onetimeEl.textContent = '$' + oneTime.toLocaleString();
    } else {
      onetimeLine.style.display = 'none';
    }
  }
}

function gatherCurrentServices() {
  const tbody = document.getElementById('service-breakdown-tbody');
  if (!tbody) return [];
  const services = [];
  tbody.querySelectorAll('tr').forEach(row => {
    const cb = row.querySelector('.service-active-cb');
    const input = row.querySelector('.service-rev-input');
    const model = row.querySelector('.service-model-select')?.value || 'monthly';
    const name = row.dataset.svc;
    if (cb?.checked && Number(input?.value) > 0) {
      services.push({
        name,
        monthlyRevenue: Number(input.value),
        revenueModel: model,
      });
    }
  });
  return services;
}

function wireServiceBreakdownButtons() {
  const saveBtn = document.getElementById('service-save-btn');
  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.onclick = async () => {
      const id = document.getElementById('deal-detail-id')?.value;
      if (!id) return;
      const services = gatherCurrentServices();
      try {
        await api(`/api/deals/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ services }),
        });
        toast('Services saved · tier and ARR recalculated', 'ok');
        await refreshAll();
        openDeal(id);
      } catch (err) { toast(err.message, 'error'); }
    };
  }
  const revertBtn = document.getElementById('service-revert-btn');
  if (revertBtn && !revertBtn.dataset.wired) {
    revertBtn.dataset.wired = '1';
    revertBtn.onclick = () => {
      if (window.__crmState.currentDeal) renderServiceBreakdown(window.__crmState.currentDeal);
    };
  }
}

function renderDuplicateBanner(d) {
  const screen = document.getElementById('s-deal');
  let banner = document.getElementById('dup-banner');
  if (banner) banner.remove();
  if (!d.duplicateFlag || currentUser.role !== 'admin') return;
  banner = document.createElement('div');
  banner.id = 'dup-banner';
  banner.style.cssText = 'background:#fdeaea;border:1px solid #cc3d3d;border-radius:6px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap';
  banner.innerHTML = `
    <div style="font-size:12px;color:#992020"><strong>⚠️ Possible duplicate</strong> — ${(d.duplicateMatches || []).map(m => esc(m.reasons.join(', '))).join('; ')}</div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-sm" onclick="window.decideDuplicate('not_duplicate')">Not a duplicate</button>
      <button class="btn btn-sm" style="background:#cc3d3d;color:#fff;border-color:#cc3d3d" onclick="window.decideDuplicate('discard')">Discard</button>
    </div>`;
  screen.prepend(banner);
}

window.decideDuplicate = async (action) => {
  const id = document.getElementById('deal-detail-id')?.value;
  if (!id) return;
  try {
    await api(`/api/deals/${id}/duplicate-decision`, {
      method: 'POST', body: JSON.stringify({ action }),
    });
    toast('Decision recorded', 'ok');
    await refreshPipeline();
    openDeal(id);
  } catch (err) { toast(err.message, 'error'); }
};

function wireDealDetailHandlers() {
  // Helper: bind a click handler ONCE (idempotent across refreshAll calls).
  function bindOnce(id, handler) {
    const el = document.getElementById(id);
    if (!el) { console.warn(`[wire] missing element #${id}`); return; }
    if (el.dataset.wired === '1') return;
    el.dataset.wired = '1';
    el.addEventListener('click', handler);
  }

  // ── Move Stage modal ─────────────────────────────────────────────────────
  bindOnce('advance-confirm-btn', async () => {
    const id = document.getElementById('deal-detail-id')?.value;
    const select = document.querySelector('#advance-modal select');
    const reason = document.querySelector('#advance-modal textarea')?.value;
    if (!id || !select) return toast('No deal selected', 'warn');
    try {
      const r = await api(`/api/deals/${id}/stage`, {
        method: 'POST', body: JSON.stringify({ toStage: select.value, reason }),
      });
      document.getElementById('advance-modal').style.display = 'none';
      if (r?.status === 'pending_approval') {
        toast('Approval requested — deal will move once admin approves.', 'info');
      } else {
        toast(`Moved to ${select.value}`, 'ok');
      }
      await refreshAll();
      openDeal(id);
    } catch (err) { toast(err.message, 'error'); }
  });

  // ── Mark Lost — auto-fill re-engagement date on reason change ────────────
  const lostReason = document.getElementById('lost-reason');
  const lostDateInput = document.getElementById('lost-reengagement-date');
  if (lostReason && lostDateInput && lostReason.dataset.wired !== '1') {
    lostReason.dataset.wired = '1';
    lostReason.addEventListener('change', () => {
      const opt = lostReason.options[lostReason.selectedIndex];
      const months = Number(opt?.dataset.months) || 6;
      const d = new Date();
      d.setMonth(d.getMonth() + months);
      lostDateInput.value = d.toISOString().slice(0, 10);
    });
  }

  // ── Mark Lost — Confirm button ───────────────────────────────────────────
  bindOnce('lost-confirm-btn', async (event) => {
    console.log('[mark-lost] confirm clicked');
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const id = document.getElementById('deal-detail-id')?.value;
    const reasonSel = document.getElementById('lost-reason');
    const dateInput = document.getElementById('lost-reengagement-date');
    console.log('[mark-lost] state:', { id, reason: reasonSel?.value, date: dateInput?.value });
    if (!id) return toast('No deal selected', 'warn');
    if (!reasonSel?.value) return toast('Pick a loss reason', 'warn');
    if (!dateInput?.value) return toast('Set a re-engagement date', 'warn');
    try {
      const res = await api(`/api/deals/${id}/stage`, {
        method: 'POST',
        body: JSON.stringify({
          toStage: 'Closed Lost',
          lossReason: reasonSel.value,
          reengagementDate: dateInput.value,
        }),
      });
      console.log('[mark-lost] API response:', res);
      document.getElementById('lost-modal').style.display = 'none';
      reasonSel.value = ''; dateInput.value = '';
      toast('Marked as Closed Lost', 'ok');
      await refreshAll();
      openDeal(id);
    } catch (err) {
      console.error('[mark-lost] failed:', err);
      toast('Mark Lost failed: ' + err.message, 'error');
    }
  });

  // ── Rep reassignment modal ───────────────────────────────────────────────
  bindOnce('rep-confirm-btn', async () => {
    const id = document.getElementById('deal-detail-id')?.value;
    const sel = document.querySelector('#rep-modal select');
    const reason = document.querySelector('#rep-modal input')?.value;
    if (!id) return toast('No deal selected', 'warn');
    if (!sel?.value) return toast('Pick a different rep', 'warn');
    try {
      await api(`/api/deals/${id}/reassign`, {
        method: 'POST', body: JSON.stringify({ newOwnerUid: sel.value, reason }),
      });
      document.getElementById('rep-modal').style.display = 'none';
      toast('Rep reassigned', 'ok');
      await refreshAll();
      openDeal(id);
    } catch (err) { toast(err.message, 'error'); }
  });

  // Always re-populate owner dropdowns from current users list
  populateOwnerDropdowns();

  // Log note
  const logBtn = document.querySelector('#s-deal .card:nth-of-type(2) .btn-p');
  if (logBtn && !logBtn.dataset.wired) {
    logBtn.dataset.wired = '1';
    logBtn.onclick = async () => {
      const id = document.getElementById('deal-detail-id')?.value;
      const input = logBtn.parentElement.querySelector('input');
      const text = input?.value?.trim();
      if (!id || !text) return;
      try {
        await api(`/api/deals/${id}/notes`, { method: 'POST', body: JSON.stringify({ text }) });
        input.value = '';
        openDeal(id);
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

// ─── Manual lead entry form ─────────────────────────────────────────────────
// Default reference lists used until admin overrides come back from
// /api/settings/reference_lists. These match the canonical Service Catalog.
const DEFAULT_INDUSTRIES = ['Retail', 'Food & Beverage', 'E-Commerce', 'Auto Parts', 'Distribution', 'Apparel', 'Pharmaceutical', 'CPG', 'B2B', 'Manufacturing', 'Other'];
const DEFAULT_SOURCES = ['Website', 'Partner Portal', 'Manual Entry', 'Referral', 'Trade Show', 'Cold Outreach', 'LinkedIn', 'Other'];

function wireManualLeadForm() {
  const screen = document.getElementById('s-manual-lead');
  if (!screen) return;

  // Populate Industry, Source, and Assigned Rep from real data
  const industries = window.__crmState.referenceLists?.industries || DEFAULT_INDUSTRIES;
  const sources = window.__crmState.referenceLists?.sources || DEFAULT_SOURCES;

  const indSel = document.getElementById('ml-industry');
  if (indSel && !indSel.dataset.wired) {
    indSel.dataset.wired = '1';
    indSel.innerHTML = '<option value="">— Select —</option>' +
      industries.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  }

  const sourceSel = document.getElementById('ml-source');
  if (sourceSel) {
    const cur = sourceSel.value;
    sourceSel.innerHTML = sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    sourceSel.value = cur || 'Manual Entry';
  }

  const ownerSel = document.getElementById('ml-owner');
  if (ownerSel) {
    const repsAndAdmins = (window.__crmState.users || []).filter(u => u.role === 'rep' || u.role === 'admin');
    const cur = ownerSel.value;
    ownerSel.innerHTML = '<option value="">— Select rep —</option>' +
      repsAndAdmins.map(u => `<option value="${esc(u.uid)}">${esc(u.displayName)}${u.role === 'admin' ? ' (Admin)' : ''}</option>`).join('');
    if (cur) ownerSel.value = cur;
    else if (currentUser?.role === 'rep') ownerSel.value = currentUser.uid; // default to self if rep
  }

  // Render service rows from canonical catalog (4.J revenue model + active checkbox + $ format)
  const tbody = document.getElementById('ml-services-tbody');
  if (tbody && !tbody.dataset.wired) {
    tbody.dataset.wired = '1';
    tbody.innerHTML = SERVICE_CATALOG.map(name => `
      <tr data-svc="${esc(name)}">
        <td>${esc(name)}</td>
        <td><input type="checkbox" class="ml-svc-cb"></td>
        <td>
          <input class="fi ml-svc-rev money-input" type="text" placeholder="$0" disabled
                 style="width:120px;padding:4px 8px;font-size:11.5px;background:var(--surface);color:var(--text3)">
        </td>
      </tr>`).join('');

    const recalc = () => {
      let total = 0;
      tbody.querySelectorAll('tr').forEach(row => {
        const cb = row.querySelector('.ml-svc-cb');
        const rev = row.querySelector('.ml-svc-rev');
        if (cb.checked) total += parseMoney(rev.value);
      });
      const totalEl = document.getElementById('ml-total-monthly');
      const tierEl = document.getElementById('ml-total-tier');
      if (totalEl) {
        totalEl.textContent = total === 0 ? '—' : '$' + total.toLocaleString();
        totalEl.style.color = total === 0 ? 'var(--text3)' : 'var(--success)';
      }
      if (tierEl) {
        const tier = total >= 25000 ? 4 : total >= 10000 ? 3 : total >= 5000 ? 2 : total > 0 ? 1 : 0;
        tierEl.textContent = tier ? `→ Tier ${tier}` : '';
      }
    };

    tbody.querySelectorAll('.ml-svc-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const row = cb.closest('tr');
        const rev = row.querySelector('.ml-svc-rev');
        if (cb.checked) {
          rev.disabled = false;
          rev.style.background = '';
          rev.style.color = '';
          rev.focus();
        } else {
          rev.disabled = true;
          rev.value = ''; // uncheck → zero (per user request)
          rev.style.background = 'var(--surface)';
          rev.style.color = 'var(--text3)';
        }
        recalc();
      });
    });
    tbody.querySelectorAll('.ml-svc-rev').forEach(input => {
      input.addEventListener('input', recalc);
    });
    wireMoneyInputs(tbody); // $-prefix auto-format
  }

  // Submit
  const submitBtn = screen.querySelector('.btn-p');
  if (submitBtn && !submitBtn.dataset.wired) {
    submitBtn.dataset.wired = '1';
    submitBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const data = {
        companyName: document.getElementById('ml-company').value.trim(),
        contactName: document.getElementById('ml-contact-name').value.trim(),
        contactEmail: document.getElementById('ml-contact-email').value.trim(),
        contactPhone: document.getElementById('ml-contact-phone').value.trim(),
        industry: document.getElementById('ml-industry').value,
        source: document.getElementById('ml-source').value || 'Manual Entry',
        ownerUid: document.getElementById('ml-owner').value || null,
        notes: document.getElementById('ml-notes').value.trim(),
        services: [],
      };
      const tbodyEl = document.getElementById('ml-services-tbody');
      tbodyEl?.querySelectorAll('tr').forEach(row => {
        const cb = row.querySelector('.ml-svc-cb');
        const rev = row.querySelector('.ml-svc-rev');
        const v = parseMoney(rev?.value);
        if (cb?.checked && v > 0) {
          data.services.push({ name: row.dataset.svc, monthlyRevenue: v });
        }
      });
      if (!data.companyName) return toast('Company name is required', 'warn');
      if (!data.contactEmail) return toast('Email is required', 'warn');
      try {
        const result = await api('/api/deals', { method: 'POST', body: JSON.stringify(data) });
        toast(`Lead created · Tier ${result.tier || '—'}`, 'ok');
        // Clear form
        ['ml-company', 'ml-contact-name', 'ml-contact-title', 'ml-contact-email', 'ml-contact-phone', 'ml-notes']
          .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('ml-industry').value = '';
        tbodyEl?.querySelectorAll('.ml-svc-cb').forEach(cb => {
          if (cb.checked) cb.click(); // toggle off (also disables + clears revenue)
        });
        await refreshAll();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  // Clear Form button
  const clearBtn = Array.from(screen.querySelectorAll('button.btn-sm')).find(b => b.textContent.trim() === 'Clear Form');
  if (clearBtn && !clearBtn.dataset.wired) {
    clearBtn.dataset.wired = '1';
    clearBtn.addEventListener('click', (e) => {
      e.preventDefault();
      ['ml-company', 'ml-contact-name', 'ml-contact-title', 'ml-contact-email', 'ml-contact-phone', 'ml-notes']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      const ind = document.getElementById('ml-industry'); if (ind) ind.value = '';
      const tbodyEl = document.getElementById('ml-services-tbody');
      tbodyEl?.querySelectorAll('.ml-svc-cb').forEach(cb => { if (cb.checked) cb.click(); });
    });
  }
}

// ─── Money input ($-prefix auto-format) ─────────────────────────────────────
// Any input with class .money-input shows "$X,XXX" as the user types,
// strips non-digits, and exposes the raw number via parseMoney().
function parseMoney(s) {
  if (!s) return 0;
  return Number(String(s).replace(/[^\d.]/g, '')) || 0;
}
function wireMoneyInputs(scope = document) {
  scope.querySelectorAll('.money-input').forEach(input => {
    if (input.dataset.moneyWired) return;
    input.dataset.moneyWired = '1';
    input.addEventListener('input', () => {
      const n = parseMoney(input.value);
      input.value = n === 0 && input.value === '' ? '' : '$' + n.toLocaleString();
    });
    input.addEventListener('blur', () => {
      const n = parseMoney(input.value);
      input.value = n === 0 ? '' : '$' + n.toLocaleString();
    });
  });
}

// ─── Partner rep directory upload ───────────────────────────────────────────
function wirePartnerRepUpload() {
  const screen = document.getElementById('s-settings');
  if (!screen || currentUser?.role !== 'admin') return;
  // Look for a file input in the partner rep directory card
  const fileInputs = screen.querySelectorAll('input[type="file"]');
  fileInputs.forEach(fi => {
    if (fi.dataset.wired) return;
    fi.dataset.wired = '1';
    fi.addEventListener('change', async () => {
      if (!fi.files?.length) return;
      const fd = new FormData();
      fd.append('file', fi.files[0]);
      try {
        const token = await getIdToken();
        const res = await fetch('/api/settings/partner-rep-directory/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        toast(`Directory uploaded — ${j.count} rows`, 'ok');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ─── User Management ─────────────────────────────────────────────────────────
function renderUsers(users) {
  const tbody = document.getElementById('users-tbody');
  if (!tbody) return;
  if (!users || !users.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text3)">No users yet</td></tr>';
  } else {
    const roleColor = { admin: 'var(--purple)', rep: '#e0832a', onboarding: 'var(--teal)', finance: '#5258b0' };
    const roleLabel = { admin: 'Admin', rep: 'Sales Rep', onboarding: 'Onboarding Mgr', finance: 'Finance / Mgmt' };
    tbody.innerHTML = users.map(u => {
      const isMe = u.uid === currentUser.uid;
      const initials = (u.displayName || u.email).split(/\s+/).map(p => p[0]).join('').slice(0, 2).toUpperCase();
      const color = pickOwnerColor(u.uid || u.email);
      return `
        <tr data-uid="${esc(u.uid)}">
          <td><div style="display:flex;align-items:center;gap:8px">
            <div class="av" style="width:26px;height:26px;font-size:10px;background:${color}">${esc(initials)}</div>
            <strong>${esc(u.displayName || u.email)}</strong>${isMe ? ' <span style="color:var(--text3);font-size:10px">(you)</span>' : ''}
          </div></td>
          <td>${esc(u.email)}</td>
          <td><span class="pill" style="background:#f0f0fa;color:${roleColor[u.role] || 'var(--text3)'}">${esc(roleLabel[u.role] || u.role)}</span></td>
          <td style="font-size:11px;color:var(--text3)">${u.lastSeen ? relativeTime(u.lastSeen) : '—'}</td>
          <td style="display:flex;gap:5px">
            <button class="btn btn-sm" style="padding:3px 9px;font-size:10px" onclick="window.editUser('${esc(u.uid)}')">Edit</button>
            ${isMe ? '' : `<button class="btn btn-sm" style="padding:3px 9px;font-size:10px;background:var(--danger-bg);color:var(--danger);border-color:var(--danger)" onclick="window.deleteUser('${esc(u.uid)}','${esc(u.displayName || u.email)}')">Delete</button>`}
          </td>
        </tr>`;
    }).join('');
  }
  const count = document.getElementById('users-count');
  if (count) count.textContent = `${users.length} user${users.length === 1 ? '' : 's'} · Admin access only`;
}

window.editUser = (uid) => {
  const u = (window.__crmState.users || []).find(x => x.uid === uid);
  if (!u) return;
  document.getElementById('edit-user-uid').value = uid;
  document.getElementById('edit-user-name').value = u.displayName || '';
  document.getElementById('edit-user-email').value = u.email;
  document.getElementById('edit-user-role').value = u.role;
  document.getElementById('edit-user-modal').style.display = 'flex';
};

window.deleteUser = async (uid, name) => {
  if (!confirm(`Delete user "${name}"? This removes them from the CRM and revokes their sign-in. This cannot be undone.`)) return;
  try {
    await api(`/api/users/${uid}`, { method: 'DELETE' });
    toast(`Deleted ${name}`, 'ok');
    const users = await api('/api/users');
    window.__crmState.users = users;
    renderUsers(users);
  } catch (err) { toast(err.message, 'error'); }
};

function wireUserManagement() {
  // Invite User submit
  const inviteBtn = document.getElementById('invite-submit-btn');
  if (inviteBtn && !inviteBtn.dataset.wired) {
    inviteBtn.dataset.wired = '1';
    inviteBtn.onclick = async () => {
      const name = document.getElementById('invite-name').value.trim();
      const email = document.getElementById('invite-email').value.trim().toLowerCase();
      const role = document.getElementById('invite-role').value;
      if (!email) return toast('Email is required', 'warn');
      try {
        const result = await api('/api/users/invite', {
          method: 'POST',
          body: JSON.stringify({ email, displayName: name, role }),
        });
        document.getElementById('user-modal').style.display = 'none';
        document.getElementById('invite-name').value = '';
        document.getElementById('invite-email').value = '';
        if (result.emailSent && !result.dryRun) {
          toast(`Invitation email sent to ${email}`, 'ok');
        } else if (result.dryRun) {
          toast(`${email} invited (email skipped — SMTP not configured)`, 'warn');
        } else {
          toast(`${email} invited (email failed to send — check server logs)`, 'warn');
        }
        const users = await api('/api/users');
        window.__crmState.users = users;
        renderUsers(users);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Edit User submit
  const editBtn = document.getElementById('edit-user-submit-btn');
  if (editBtn && !editBtn.dataset.wired) {
    editBtn.dataset.wired = '1';
    editBtn.onclick = async () => {
      const uid = document.getElementById('edit-user-uid').value;
      const displayName = document.getElementById('edit-user-name').value.trim();
      const role = document.getElementById('edit-user-role').value;
      try {
        await api(`/api/users/${uid}`, {
          method: 'PATCH',
          body: JSON.stringify({ displayName, role }),
        });
        document.getElementById('edit-user-modal').style.display = 'none';
        toast('User updated', 'ok');
        const users = await api('/api/users');
        window.__crmState.users = users;
        renderUsers(users);
      } catch (err) { toast(err.message, 'error'); }
    };
  }
}

// ─── Duplicate Review Queue (Notification Rules screen, admin-only) ────────
// Renders every deal where duplicateFlag === true alongside its match(es),
// with admin actions: Merge, Not a duplicate, View both.
function renderDuplicateQueue() {
  if (currentUser?.role !== 'admin') return;
  const card = document.getElementById('dup-queue-card');
  const list = document.getElementById('dup-queue-list');
  const counter = document.getElementById('dup-queue-count');
  if (!card || !list) return;

  const allDeals = window.__crmState.deals || [];
  const flagged = allDeals.filter(d => d.duplicateFlag && !d.discarded && !d.mergedInto);
  if (!flagged.length) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  if (counter) counter.textContent = `Admin only — ${flagged.length} pending`;

  const dealsById = Object.fromEntries(allDeals.map(d => [d.id, d]));

  list.innerHTML = flagged.map(d => {
    const matches = (d.duplicateMatches || []);
    const matchCards = matches.map(m => {
      const ex = dealsById[m.matchDealId];
      if (!ex) return `<div style="padding:12px 14px;color:var(--text3);font-size:11.5px">Match ID ${esc(m.matchDealId)} (no longer exists)</div>`;
      return `
        <div style="padding:12px 14px">
          <div style="font-size:10px;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Existing Deal</div>
          <div style="font-size:12px;font-weight:600">${esc(ex.companyName)}</div>
          <div style="font-size:11px;color:var(--text3)">${esc(ex.contactEmail || '—')} · ${esc(ex.source || '—')}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:4px">${fmtMonthly(ex.monthlyRevenue || 0)}</div>
          <div style="margin-top:6px;font-size:10.5px;color:var(--text3)">${esc(ex.stage)} · ${esc(ex.ownerName || 'Unassigned')}</div>
          <div style="margin-top:6px;font-size:10px;color:var(--danger)">Match: ${esc(m.reasons.join(', '))}</div>
        </div>`;
    }).join('');

    return `
      <div style="background:var(--white);border:1px solid var(--border);border-radius:6px;overflow:hidden">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
          <div style="padding:12px 14px;border-right:1px solid var(--border);background:#fffbfb">
            <div style="font-size:10px;font-weight:600;color:var(--danger);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">New Submission</div>
            <div style="font-size:12px;font-weight:600">${esc(d.companyName)}</div>
            <div style="font-size:11px;color:var(--text3)">${esc(d.contactEmail || '—')} · ${esc(d.source || '—')}</div>
            <div style="font-size:11px;color:var(--text2);margin-top:4px">${fmtMonthly(d.monthlyRevenue || 0)}</div>
            <div style="margin-top:6px;font-size:10.5px;color:var(--text3)">${esc(d.stage)} · ${esc(d.ownerName || 'Unassigned')}</div>
          </div>
          ${matchCards}
        </div>
        <div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-sm" style="color:var(--success);border-color:var(--success)" onclick="window.dupDecision('${esc(d.id)}','not_duplicate')">✓ Not a duplicate — proceed separately</button>
          ${matches.length === 1 ? `<button class="btn btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="window.dupDecision('${esc(d.id)}','merge','${esc(matches[0].matchDealId)}')">Merge — discard the new submission</button>` : ''}
          <button class="btn btn-sm" onclick="window.openDeal('${esc(d.id)}')">View new submission</button>
          ${matches[0]?.matchDealId ? `<button class="btn btn-sm" onclick="window.openDeal('${esc(matches[0].matchDealId)}')">View existing deal</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

window.dupDecision = async (dealId, action, mergeTargetId) => {
  const verb = action === 'merge' ? 'merge into the existing deal (this will hide the new submission)' :
               action === 'not_duplicate' ? 'mark as NOT a duplicate' : 'discard';
  if (!confirm(`Confirm: ${verb}?`)) return;
  try {
    await api(`/api/deals/${dealId}/duplicate-decision`, {
      method: 'POST',
      body: JSON.stringify({ action, mergeTargetId }),
    });
    toast(action === 'merge' ? 'Merged' : action === 'not_duplicate' ? 'Marked not a duplicate' : 'Discarded', 'ok');
    await refreshAll();
    renderDuplicateQueue();
  } catch (err) { toast(err.message, 'error'); }
};

// ─── Settings page — all the save buttons ──────────────────────────────────
function wireSettingsSaveButtons() {
  if (currentUser?.role !== 'admin') return;

  // Save Stage Weights
  const stageBtn = document.getElementById('save-stage-weights-btn');
  if (stageBtn && !stageBtn.dataset.wired) {
    stageBtn.dataset.wired = '1';
    stageBtn.addEventListener('click', async () => {
      const payload = {};
      document.querySelectorAll('#stage-weights-table .pct-input').forEach(inp => {
        const stage = inp.dataset.stage;
        const pct = Number(inp.value);
        if (!isFinite(pct) || pct < 0 || pct > 100) return;
        payload[stage] = pct / 100; // store as 0.00–1.00
      });
      try {
        await api('/api/settings/stage_weights', { method: 'PUT', body: JSON.stringify(payload) });
        toast('Stage weights saved · weighted forecast will use them', 'ok');
        await refreshAll();
      } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    });
    // Load saved values on first wire
    api('/api/settings/stage_weights').then(cfg => {
      document.querySelectorAll('#stage-weights-table .pct-input').forEach(inp => {
        const stage = inp.dataset.stage;
        if (cfg[stage] != null) inp.value = Math.round(cfg[stage] * 100);
      });
    }).catch(() => {});
  }

  // Save Cost Inputs
  const costBtn = document.getElementById('save-cost-inputs-btn');
  if (costBtn && !costBtn.dataset.wired) {
    costBtn.dataset.wired = '1';
    costBtn.addEventListener('click', async () => {
      const rates = {};
      document.querySelectorAll('.cost-rate-input').forEach(inp => {
        const v = Number(inp.value);
        if (isFinite(v)) rates[inp.dataset.svc] = v / 100;
      });
      const payload = {
        rates,
        overheadPool: parseMoney(document.getElementById('cost-overhead-pool')?.value),
        variablePct: Number(document.getElementById('cost-variable-pct')?.value) / 100 || 0,
      };
      try {
        await api('/api/settings/cost_inputs', { method: 'PUT', body: JSON.stringify(payload) });
        toast('Cost inputs saved (Phase 2 — will drive Profitability panel)', 'ok');
        // Update timestamps
        const now = new Date().toLocaleDateString();
        document.querySelectorAll('#cost-rates-table .cost-updated').forEach(td => td.textContent = now);
      } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    });
    // Load saved values
    api('/api/settings/cost_inputs').then(cfg => {
      const rates = cfg.rates || {};
      document.querySelectorAll('.cost-rate-input').forEach(inp => {
        const v = rates[inp.dataset.svc];
        if (v != null) inp.value = Math.round(v * 100);
      });
      const pool = document.getElementById('cost-overhead-pool');
      const variable = document.getElementById('cost-variable-pct');
      if (pool && cfg.overheadPool) pool.value = '$' + Number(cfg.overheadPool).toLocaleString();
      if (variable && cfg.variablePct != null) variable.value = (cfg.variablePct * 100).toFixed(1);
    }).catch(() => {});
  }

  // Save Duplicate Detection
  const detectionBtn = document.getElementById('save-detection-btn');
  if (detectionBtn && !detectionBtn.dataset.wired) {
    detectionBtn.dataset.wired = '1';
    detectionBtn.addEventListener('click', async () => {
      const payload = {
        matchCompany: document.getElementById('dup-match-company')?.checked ?? true,
        matchEmail:   document.getElementById('dup-match-email')?.checked ?? true,
        matchPhone:   document.getElementById('dup-match-phone')?.checked ?? true,
        fuzzyThreshold: Number(document.getElementById('dup-fuzzy-threshold')?.value) || 0.8,
      };
      // Stored under notification_rules.duplicateDetection so the engine sees it
      // alongside the other settings (single doc fetch).
      try {
        const current = await api('/api/settings/notification_rules').catch(() => ({}));
        await api('/api/settings/notification_rules', {
          method: 'PUT',
          body: JSON.stringify({ ...current, duplicateDetection: payload }),
        });
        toast('Duplicate detection settings saved', 'ok');
      } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    });
    // Load saved values
    api('/api/settings/notification_rules').then(cfg => {
      const dup = cfg.duplicateDetection || {};
      const cb1 = document.getElementById('dup-match-company');
      const cb2 = document.getElementById('dup-match-email');
      const cb3 = document.getElementById('dup-match-phone');
      const ft = document.getElementById('dup-fuzzy-threshold');
      if (cb1) cb1.checked = dup.matchCompany !== false;
      if (cb2) cb2.checked = dup.matchEmail !== false;
      if (cb3) cb3.checked = dup.matchPhone !== false;
      if (ft && dup.fuzzyThreshold) ft.value = dup.fuzzyThreshold;
    }).catch(() => {});
  }

  // Partner Rep Directory — live data + upload + download
  wirePartnerRepDirectory();
}

// ─── Partner Rep Directory live editor ─────────────────────────────────────
function wirePartnerRepDirectory() {
  const tbody = document.getElementById('partner-reps-tbody');
  const meta = document.getElementById('partner-reps-meta');
  const fileInput = document.getElementById('partner-reps-file');
  const uploadBtn = document.getElementById('partner-reps-upload-btn');
  const downloadBtn = document.getElementById('partner-reps-download-btn');
  if (!tbody) return;

  const renderTable = (entries) => {
    if (!entries || !entries.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:14px;color:var(--text3);font-size:11px">No reps yet — upload a CSV/Excel below.</td></tr>';
      if (meta) meta.textContent = 'No directory loaded';
      return;
    }
    tbody.innerHTML = entries.map((e, i) => `
      <tr>
        <td>${esc(e.company)}</td>
        <td>${esc(e.repName)}</td>
        <td><button class="btn btn-sm" style="padding:2px 8px;font-size:10px;color:var(--danger)" onclick="window.removePartnerRep(${i})">Remove</button></td>
      </tr>`).join('');
    if (meta) meta.textContent = `${entries.length} rep${entries.length === 1 ? '' : 's'}`;
  };

  // Load
  api('/api/settings/partner_rep_directory').then(cfg => {
    window.__crmState.partnerReps = cfg.entries || [];
    renderTable(window.__crmState.partnerReps);
  }).catch(() => renderTable([]));

  // Remove
  window.removePartnerRep = async (idx) => {
    const entries = (window.__crmState.partnerReps || []).filter((_, i) => i !== idx);
    window.__crmState.partnerReps = entries;
    renderTable(entries);
    try {
      await api('/api/settings/partner_rep_directory', {
        method: 'PUT', body: JSON.stringify({ entries, rowCount: entries.length }),
      });
      toast('Removed', 'ok');
    } catch (err) { toast('Save failed: ' + err.message, 'error'); }
  };

  // Upload
  if (uploadBtn && !uploadBtn.dataset.wired) {
    uploadBtn.dataset.wired = '1';
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      if (!fileInput.files?.length) return;
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        const token = await getIdToken();
        const res = await fetch('/api/settings/partner-rep-directory/upload', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error);
        toast(`Uploaded — ${j.count} rows`, 'ok');
        const cfg = await api('/api/settings/partner_rep_directory');
        window.__crmState.partnerReps = cfg.entries || [];
        renderTable(window.__crmState.partnerReps);
      } catch (err) { toast(err.message, 'error'); }
      fileInput.value = '';
    });
  }

  // Download
  if (downloadBtn && !downloadBtn.dataset.wired) {
    downloadBtn.dataset.wired = '1';
    downloadBtn.addEventListener('click', () => {
      const entries = window.__crmState.partnerReps || [];
      if (!entries.length) return toast('Directory is empty', 'warn');
      const csv = 'Company Name,Rep Name\n' +
        entries.map(e => `"${(e.company || '').replace(/"/g, '""')}","${(e.repName || '').replace(/"/g, '""')}"`).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `partner-rep-directory-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      toast(`Downloaded ${entries.length} reps`, 'ok');
    });
  }
}

// ─── Reference Lists (Industry / Lead Source) editor ────────────────────────
// Loaded from /api/settings/reference_lists, persisted on every Add / Delete.
// Drives the dropdowns on Manual Lead Entry, Pipeline filter, Leads filter.
async function loadReferenceLists() {
  try {
    const cfg = await api('/api/settings/reference_lists');
    window.__crmState.referenceLists = {
      industries: Array.isArray(cfg.industries) && cfg.industries.length ? cfg.industries : DEFAULT_INDUSTRIES,
      sources: Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : DEFAULT_SOURCES,
    };
    renderRefListEditor();
    populateAllSourceDropdowns();
    populateAllIndustryDropdowns();
  } catch (err) {
    // Fall back to defaults
    window.__crmState.referenceLists = { industries: DEFAULT_INDUSTRIES, sources: DEFAULT_SOURCES };
    renderRefListEditor();
    populateAllSourceDropdowns();
    populateAllIndustryDropdowns();
  }
}

function renderRefListEditor() {
  const lists = window.__crmState.referenceLists || {};
  document.querySelectorAll('[data-ref-list]').forEach(container => {
    const key = container.dataset.refList; // 'industries' or 'sources'
    const items = lists[key] || [];
    container.innerHTML = items.map(item => `
      <div class="ref-item" data-value="${esc(item)}" style="display:flex;align-items:center;justify-content:space-between;font-size:11.5px;background:var(--surface);padding:4px 8px;border-radius:5px">
        ${esc(item)}
        <button class="btn btn-sm" style="padding:1px 6px;font-size:9.5px;color:var(--danger)" onclick="window.removeRefItem('${esc(key)}','${esc(item)}')">✕</button>
      </div>`).join('') || '<div style="font-size:11px;color:var(--text3);padding:6px 8px">No entries — add some below</div>';
  });
}

window.removeRefItem = async (key, value) => {
  const lists = window.__crmState.referenceLists || {};
  lists[key] = (lists[key] || []).filter(v => v !== value);
  window.__crmState.referenceLists = lists;
  renderRefListEditor();
  populateAllSourceDropdowns();
  populateAllIndustryDropdowns();
  try {
    await api('/api/settings/reference_lists', { method: 'PUT', body: JSON.stringify(lists) });
    toast(`Removed "${value}"`, 'ok');
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
};

function wireRefListAddButtons() {
  const wires = [
    { btn: 'add-industry-btn', input: 'add-industry', key: 'industries' },
    { btn: 'add-source-btn', input: 'add-source', key: 'sources' },
  ];
  wires.forEach(({ btn, input, key }) => {
    const b = document.getElementById(btn);
    if (!b || b.dataset.wired) return;
    b.dataset.wired = '1';
    b.addEventListener('click', async () => {
      const inp = document.getElementById(input);
      const v = (inp?.value || '').trim();
      if (!v) return;
      const lists = window.__crmState.referenceLists || {};
      lists[key] = lists[key] || [];
      if (lists[key].some(x => x.toLowerCase() === v.toLowerCase())) {
        return toast('Already in the list', 'warn');
      }
      lists[key].push(v);
      window.__crmState.referenceLists = lists;
      inp.value = '';
      renderRefListEditor();
      populateAllSourceDropdowns();
      populateAllIndustryDropdowns();
      try {
        await api('/api/settings/reference_lists', { method: 'PUT', body: JSON.stringify(lists) });
        toast(`Added "${v}"`, 'ok');
      } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    });
  });
}

// Sources dropdown consistency — feed Pipeline filter, Leads filter from saved list
function populateAllSourceDropdowns() {
  const sources = window.__crmState.referenceLists?.sources || DEFAULT_SOURCES;
  const targets = [
    document.getElementById('pipeline-filter-source'),
    document.getElementById('lead-filter-source'),
    document.getElementById('ml-source'),
  ];
  targets.forEach(sel => {
    if (!sel) return;
    const cur = sel.value;
    const placeholder = sel.id.includes('filter') ? '<option value="">All Sources</option>' : '';
    sel.innerHTML = placeholder + sources.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    if (cur && (placeholder || sources.includes(cur))) sel.value = cur;
  });
}

function populateAllIndustryDropdowns() {
  const industries = window.__crmState.referenceLists?.industries || DEFAULT_INDUSTRIES;
  const targets = [document.getElementById('ml-industry')];
  targets.forEach(sel => {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Select —</option>' +
      industries.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
    if (cur) sel.value = cur;
  });
  // Also refresh the Industry select inside the Deal Information card
  document.querySelectorAll('#s-deal .drow .dv select').forEach(sel => {
    const label = sel.closest('.drow')?.querySelector('.dk')?.textContent.trim().toLowerCase();
    if (label === 'industry') {
      const cur = sel.value;
      sel.innerHTML = '<option value="">—</option>' +
        industries.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
      if (cur) sel.value = cur;
    }
  });
}

function wireNotificationRulesForm() {
  if (currentUser?.role !== 'admin') return;

  // Helper — read the rule ID ("R-03", "R-07", ...) from the row a checkbox lives in
  const ruleIdFromCheckbox = (cb) => {
    const row = cb.closest('tr');
    const strong = row?.querySelector('td:first-child strong');
    return strong?.textContent.trim() || null;
  };

  const loadSettings = async () => {
    try {
      const cfg = await api('/api/settings/notification_rules');
      const repField = document.getElementById('cfg-inactivity-rep-days');
      const adminField = document.getElementById('cfg-inactivity-admin-days');
      const stallField = document.getElementById('cfg-inactivity-stall-days');
      if (repField && cfg.inactivityRepDays) repField.value = cfg.inactivityRepDays;
      if (adminField && cfg.inactivityAdminDays) adminField.value = cfg.inactivityAdminDays;
      if (stallField && cfg.inactivityStallDays) stallField.value = cfg.inactivityStallDays;

      // Tier thresholds (4.2b)
      const t2 = document.getElementById('cfg-tier2');
      const t3 = document.getElementById('cfg-tier3');
      const t4 = document.getElementById('cfg-tier4');
      if (t2 && cfg.tierThresholds?.tier2) t2.value = cfg.tierThresholds.tier2;
      if (t3 && cfg.tierThresholds?.tier3) t3.value = cfg.tierThresholds.tier3;
      if (t4 && cfg.tierThresholds?.tier4) t4.value = cfg.tierThresholds.tier4;

      // Recipient overrides
      const adminRcpt = document.getElementById('cfg-admin-recipients');
      const obRcpt = document.getElementById('cfg-onboarding-recipient');
      if (adminRcpt) adminRcpt.value = (cfg.adminRecipientsOverride || []).join(', ');
      if (obRcpt) obRcpt.value = cfg.onboardingRecipientOverride || '';

      // Toggle each rule checkbox from saved enabledRules map
      const enabledRules = cfg.enabledRules || {};
      document.querySelectorAll('[data-rule-toggle]').forEach(cb => {
        if (cb.disabled) return; // Phase 2 rules stay disabled
        const ruleId = ruleIdFromCheckbox(cb);
        if (ruleId && enabledRules[ruleId] === false) cb.checked = false;
      });
    } catch (err) { /* silent on first load */ }
  };
  loadSettings();

  // Save Changes — collect everything and PUT
  const saveBtn = document.querySelector('#s-notif-settings .btn-p');
  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.onclick = async () => {
      const repField = document.getElementById('cfg-inactivity-rep-days');
      const adminField = document.getElementById('cfg-inactivity-admin-days');

      const enabledRules = {};
      document.querySelectorAll('[data-rule-toggle]').forEach(cb => {
        if (cb.disabled) return;
        const ruleId = ruleIdFromCheckbox(cb);
        if (ruleId) enabledRules[ruleId] = cb.checked;
      });

      const t2 = Number(document.getElementById('cfg-tier2')?.value) || 5000;
      const t3 = Number(document.getElementById('cfg-tier3')?.value) || 10000;
      const t4 = Number(document.getElementById('cfg-tier4')?.value) || 25000;
      if (!(t2 < t3 && t3 < t4)) {
        return toast('Tier thresholds must be ascending (Tier 2 < Tier 3 < Tier 4)', 'warn');
      }
      // Notification recipient overrides
      const adminRcpt = (document.getElementById('cfg-admin-recipients')?.value || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      const obRcpt = (document.getElementById('cfg-onboarding-recipient')?.value || '').trim();
      const payload = {
        inactivityRepDays: Number(repField?.value) || 3,
        inactivityAdminDays: Number(adminField?.value) || 7,
        tierThresholds: { tier2: t2, tier3: t3, tier4: t4 },
        enabledRules,
        adminRecipientsOverride: adminRcpt,
        onboardingRecipientOverride: obRcpt,
      };
      try {
        await api('/api/settings/notification_rules', {
          method: 'PUT', body: JSON.stringify(payload),
        });
        toast('Notification rules saved', 'ok');
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Refresh from server when the screen is opened (in case other admins changed it)
  document.querySelector('.ni[onclick*="notif-settings"]')?.addEventListener('click', loadSettings);
}

// ─── Export CSV (Leads) ──────────────────────────────────────────────────────
// 3.H — exports the FILTERED view (current search + stage + source + owner
// filters applied), not the entire deal set. Walks the DOM to find rows
// currently visible after filterLeads() runs.
function wireExportCsv() {
  const btn = document.getElementById('leads-export-csv-btn');
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.onclick = () => {
    // Find currently-visible rows (filterLeads adds 'hidden-row' class for non-matches)
    const tbody = document.getElementById('leads-tbody');
    const allRows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
    const visibleRows = allRows.filter(r => !r.classList.contains('hidden-row') && r.style.display !== 'none');

    // Map back to deal objects
    const allDeals = (window.__crmState.deals || []).filter(d => !d.discarded && !d.mergedInto);
    const visibleIds = new Set();
    visibleRows.forEach(row => {
      const m = row.getAttribute('onclick')?.match(/openDeal\('([^']+)'\)/);
      if (m) visibleIds.add(m[1]);
    });
    const deals = allDeals.filter(d => visibleIds.has(d.id));

    if (!deals.length) return toast('No leads matching current filters', 'warn');

    const cols = ['companyName', 'contactName', 'contactEmail', 'contactPhone', 'industry', 'source', 'monthlyRevenue', 'arr', 'tier', 'stage', 'ownerName', 'createdAt', 'lastActivityAt'];
    const header = cols.join(',');
    const csvEsc = v => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object' && v._seconds) v = new Date(v._seconds * 1000).toISOString();
      const s = String(v).replace(/"/g, '""');
      return /[,"\n]/.test(s) ? `"${s}"` : s;
    };
    const rows = deals.map(d => cols.map(c => csvEsc(d[c])).join(','));
    const blob = new Blob([header + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `eshipperplus-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    const totalCount = (window.__crmState.deals || []).length;
    toast(`Exported ${deals.length} of ${totalCount} lead${totalCount === 1 ? '' : 's'} (filtered view)`, 'ok');
  };
}

// ─── Onboarding checklist toggles (admin / onboarding role) ─────────────────
function wireOnboardingChecklist() {
  if (!['admin', 'onboarding'].includes(currentUser?.role)) return;
  const screen = document.getElementById('s-onboarding');
  if (!screen) return;
  // Wire any .ob-item or .chk-item to toggle done-state and save
  // Note: this is a generic wire — a full implementation needs to know
  // which deal's checklist this is. For MVP, we just visually toggle.
  screen.querySelectorAll('.ob-item, .chk-item').forEach(item => {
    if (item.dataset.wired) return;
    item.dataset.wired = '1';
    item.addEventListener('click', () => {
      item.classList.toggle('act');
      const cb = item.querySelector('.chkb');
      if (cb) cb.classList.toggle('ck');
    });
  });
}

// ─── Top-bar + New Lead button (always go to manual lead entry) ─────────────
function wireTopBarButtons() {
  const newLeadBtn = document.querySelector('#tb-r .btn-sm:not(.btn-p)');
  if (newLeadBtn && !newLeadBtn.dataset.wired) {
    newLeadBtn.dataset.wired = '1';
    newLeadBtn.onclick = () => {
      const navEl = document.querySelector('.ni[onclick*=manual-lead]');
      if (typeof window.show === 'function') window.show('manual-lead', navEl);
    };
  }
}

// ─── Deal Detail Edit button ─────────────────────────────────────────────────
function wireDealEditButton() {
  // Each card has its own Edit; the main inline-edit panel is the Deal Information card.
  // Toggle disabled state on inputs to enter "edit mode"; save persists via /api/deals/:id PATCH.
  const screen = document.getElementById('s-deal');
  if (!screen) return;
  const editBtns = screen.querySelectorAll('.ch .btn-sm');
  editBtns.forEach(btn => {
    if (btn.dataset.wired || btn.textContent.trim() !== 'Edit') return;
    btn.dataset.wired = '1';
    btn.onclick = async () => {
      const id = document.getElementById('deal-detail-id')?.value;
      if (!id) return;
      const card = btn.closest('.card');
      const inputs = card.querySelectorAll('input.fi, select.fi, textarea.fi, select.fsel');
      const isEditMode = btn.textContent === 'Save';
      if (!isEditMode) {
        inputs.forEach(i => i.disabled = false);
        btn.textContent = 'Save';
        return;
      }
      // Save mode — gather fields and PATCH
      const payload = {};
      inputs.forEach(i => {
        const label = (i.previousElementSibling?.textContent || '').toLowerCase();
        if (label.includes('industry')) payload.industry = i.value;
        else if (label.includes('source') || label.includes('lead source')) payload.source = i.value;
      });
      try {
        await api(`/api/deals/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        toast('Saved', 'ok');
        btn.textContent = 'Edit';
        inputs.forEach(i => i.disabled = true);
      } catch (err) { toast(err.message, 'error'); }
    };
  });
}

// ─── Auto-refresh ────────────────────────────────────────────────────────────
// Three triggers keep data fresh without per-action wiring:
//   1. After every successful mutation — handlers call refreshAll() directly.
//   2. Every 30s on a background interval (silent — no error toasts).
//   3. When the tab regains focus (visibility change).
let _autoRefreshTimer = null;
function setupAutoRefresh() {
  if (_autoRefreshTimer) return; // already wired
  _autoRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshAll({ silent: true });
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll({ silent: true });
  });
  // Also refresh whenever the user clicks a sidebar nav item (Dashboard,
  // Pipeline, Leads, Notifications, User Management) — they expect the
  // screen they're switching to to be current.
  document.querySelectorAll('#sb .ni').forEach(ni => {
    ni.addEventListener('click', () => {
      refreshAll({ silent: true });
      // Clicking "Deal Detail" in the sidebar = "I want to see the empty
      // state, not the deal I had open before". Clear and show empty.
      // (To go back to a specific deal, click it from Pipeline / Leads.)
      if (ni.getAttribute('onclick')?.includes("'deal'")) {
        window.__crmState.currentDeal = null;
        const emptyState = document.getElementById('deal-empty-state');
        const dealContent = document.getElementById('deal-content');
        if (emptyState) emptyState.style.display = 'flex';
        if (dealContent) dealContent.style.display = 'none';
        // Also reset the top-bar title
        const tbTitle = document.getElementById('tb-title');
        if (tbTitle) tbTitle.textContent = 'Deal Detail';
      }
    });
  });
}

// ─── Phone input validation (max 10 digits, auto-format) ────────────────────
// Apply to every <input class="phone-input"> globally. As user types:
//   - non-digit characters (other than space, paren, dash, plus) are stripped
//   - more than 10 digits is blocked
//   - on blur, formatted to (XXX) XXX-XXXX
function wirePhoneInputs() {
  document.querySelectorAll('.phone-input').forEach(input => {
    if (input.dataset.phoneWired) return;
    input.dataset.phoneWired = '1';
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 10);
      // Live progressive formatting as they type
      let formatted = digits;
      if (digits.length > 6) formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      else if (digits.length > 3) formatted = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
      else if (digits.length > 0) formatted = `(${digits}`;
      input.value = formatted;
    });
    input.addEventListener('blur', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 10);
      if (!digits) { input.value = ''; return; }
      input.setCustomValidity('');
      if (digits.length === 10) {
        input.value = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
      } else {
        input.setCustomValidity('Phone number must be exactly 10 digits.');
      }
    });
  });
}

// ─── Partner Portal mockup screen — wire dynamic services + totals ──────────
function wirePartnerPortalScreen() {
  const table = document.getElementById('partner-services-table');
  if (!table || table.dataset.wired) return;
  table.dataset.wired = '1';

  const recalc = () => {
    let total = 0;
    table.querySelectorAll('tr[data-svc]').forEach(row => {
      const cb = row.querySelector('.partner-svc-cb');
      const rev = row.querySelector('.partner-svc-rev');
      if (cb.checked) total += Number(rev.value) || 0;
    });
    const totalEl = document.getElementById('partner-total-monthly');
    const tierEl = document.getElementById('partner-total-tier');
    if (totalEl) {
      totalEl.textContent = total === 0 ? '—' : '$' + total.toLocaleString();
      totalEl.style.color = total === 0 ? 'var(--text3)' : 'var(--success)';
    }
    if (tierEl) {
      const tier = total >= 25000 ? 4 : total >= 10000 ? 3 : total >= 5000 ? 2 : total > 0 ? 1 : 0;
      tierEl.textContent = tier ? `→ Tier ${tier}` : '';
    }
  };

  table.querySelectorAll('tr[data-svc]').forEach(row => {
    const cb = row.querySelector('.partner-svc-cb');
    const rev = row.querySelector('.partner-svc-rev');
    cb.addEventListener('change', () => {
      rev.disabled = !cb.checked;
      if (!cb.checked) rev.value = '';
      else rev.focus();
      recalc();
    });
    rev.addEventListener('input', recalc);
  });

  // Populate rep dropdown from the partner directory
  const repSel = document.getElementById('partner-rep-select');
  if (repSel) {
    fetch('/public/partner-reps')
      .then(r => r.json())
      .then(entries => {
        const byCompany = {};
        for (const e of (entries || [])) {
          (byCompany[e.company] = byCompany[e.company] || []).push(e.repName);
        }
        repSel.innerHTML = '<option value="">— Select your rep —</option>';
        Object.keys(byCompany).sort().forEach(company => {
          const og = document.createElement('optgroup');
          og.label = company;
          byCompany[company].forEach(rep => {
            const opt = document.createElement('option');
            opt.value = JSON.stringify({ company, repName: rep });
            opt.textContent = rep;
            og.appendChild(opt);
          });
          repSel.appendChild(og);
        });
      })
      .catch(() => {});
  }

  recalc();

  // Populate Client Industry dropdown from reference lists
  const ind = document.getElementById('pp-industry');
  if (ind && !ind.dataset.wired) {
    ind.dataset.wired = '1';
    const industries = window.__crmState.referenceLists?.industries || DEFAULT_INDUSTRIES;
    ind.innerHTML = '<option value="">— Select —</option>' +
      industries.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
  }

  // Wire the Submit Lead button — POSTs to /public/leads/partner same as the public page
  const submitBtn = document.getElementById('partner-preview-submit');
  if (submitBtn && !submitBtn.dataset.wired) {
    submitBtn.dataset.wired = '1';
    submitBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const repVal = document.getElementById('partner-rep-select')?.value;
      if (!repVal) return toast('Pick your rep from the dropdown first', 'warn');
      let partnerRep;
      try { partnerRep = JSON.parse(repVal); } catch { return toast('Invalid rep selection', 'error'); }

      const services = [];
      table.querySelectorAll('tr[data-svc]').forEach(row => {
        const cb = row.querySelector('.partner-svc-cb');
        const rev = row.querySelector('.partner-svc-rev');
        const v = Number(rev?.value) || 0;
        if (cb?.checked && v > 0) {
          services.push({ name: row.dataset.svc, monthlyRevenue: v });
        }
      });

      const body = {
        companyName: document.getElementById('pp-company')?.value.trim(),
        contactName: document.getElementById('pp-contact-name')?.value.trim(),
        contactEmail: document.getElementById('pp-contact-email')?.value.trim(),
        contactPhone: document.getElementById('pp-contact-phone')?.value.trim(),
        industry: document.getElementById('pp-industry')?.value,
        notes: document.getElementById('pp-notes')?.value.trim(),
        services,
        partnerRep,
      };
      if (!body.companyName) return toast('Client company is required', 'warn');
      if (!body.contactEmail) return toast('Contact email is required', 'warn');
      try {
        // Use direct fetch (not api()) since /public/* doesn't require auth
        const r = await fetch('/public/leads/partner', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || 'Submission failed');
        }
        toast('Lead submitted via partner portal', 'ok');
        // Clear form
        ['pp-company', 'pp-contact-name', 'pp-contact-title', 'pp-contact-email', 'pp-contact-phone', 'pp-notes']
          .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        const indEl = document.getElementById('pp-industry'); if (indEl) indEl.value = '';
        table.querySelectorAll('.partner-svc-cb').forEach(cb => { if (cb.checked) cb.click(); });
        await refreshAll();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
}

// ─── Toast helper ────────────────────────────────────────────────────────────
function toast(msg, kind = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return alert(msg);
  const bg = { ok: '#2ba877', error: '#cc3d3d', warn: '#e0832a', info: '#34368a' }[kind] || '#34368a';
  const t = document.createElement('div');
  t.style.cssText = `background:${bg};color:#fff;padding:10px 14px;border-radius:6px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.15);pointer-events:auto;max-width:320px`;
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => t.style.opacity = '0', 4000);
  setTimeout(() => t.remove(), 4500);
  t.style.transition = 'opacity .3s';
}
window.crmToast = toast;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', attachSignInHandler);
if (document.readyState !== 'loading') attachSignInHandler();

// Show the auth gate by default until sign-in resolves
showAuthGate(true);

// Add a sign-out link to the sidebar user card
document.addEventListener('DOMContentLoaded', () => {
  const user = document.getElementById('sb-user');
  if (!user) return;
  user.style.cursor = 'pointer';
  user.title = 'Click to sign out';
  user.addEventListener('click', async () => {
    if (confirm('Sign out?')) { await signOut(fbAuth); location.reload(); }
  });
});
