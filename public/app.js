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
}

function setAuthError(msg) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = msg || '';
}

onAuthStateChanged(fbAuth, async (user) => {
  if (!user) {
    currentUser = null;
    showAuthGate(true);
    return;
  }
  try {
    const me = await api('/api/me');
    currentUser = me;
    applyRoleToUI(me);
    showAuthGate(false);
    await bootAppData();
  } catch (err) {
    setAuthError('Sign-in succeeded but backend rejected your token: ' + err.message);
  }
});

function attachSignInHandler() {
  const btn = document.getElementById('auth-signin-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    setAuthError('');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ hd: 'eshipperplus.com' }); // restrict to workspace domain
    try {
      await signInWithPopup(fbAuth, provider);
    } catch (err) {
      // Popup blocked / closed / extension interference → fall back to full-page redirect
      if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request']
            .includes(err.code)) {
        await signInWithRedirect(fbAuth, provider);
      } else {
        setAuthError(err.message);
      }
    }
  });

  // Handle the redirect-flow return trip (page reloads with the auth result)
  getRedirectResult(fbAuth).catch(err => setAuthError(err.message));
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
    updateSidebarBadges(deals, notifs);
    wireDealDetailHandlers();
    wireManualLeadForm();
    wirePartnerRepUpload();
    wireNotificationRulesForm();
  } catch (err) {
    toast('Failed to load data: ' + err.message, 'error');
  }
}

// ─── Dashboard render ────────────────────────────────────────────────────────
function renderDashboard(dash) {
  if (!dash) return;
  const metrics = document.querySelectorAll('#s-dashboard .mrow .met .mv');
  if (metrics.length >= 5) {
    metrics[0].textContent = dash.activeDeals;
    metrics[1].textContent = fmtCompact(dash.pipelineValue);
    metrics[2].textContent = fmtCompact(dash.weightedForecast);
    metrics[3].textContent = Math.round(dash.winRate * 100) + '%';
    metrics[4].textContent = fmtCompact(dash.avgDealSize);
  }
}

function fmtCompact(n) {
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return '$' + (n / 1_000).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

// ─── Pipeline Kanban render ──────────────────────────────────────────────────
function renderPipeline(deals) {
  const kanban = document.querySelector('#s-pipeline .kanban');
  if (!kanban) return;
  const stages = ['New', 'Qualified', 'Proposal Sent', 'Negotiation', 'Closed Won', 'Contract', 'Onboarding'];
  kanban.innerHTML = stages.map(stage => {
    const stageDeals = deals.filter(d => d.stage === stage && !d.discarded && !d.mergedInto);
    return `
      <div class="kc" data-stage="${esc(stage)}" data-dropzone>
        <div class="kh">${esc(stage)}<span class="kbadge">${stageDeals.length}</span></div>
        ${stageDeals.map(d => dealCardHtml(d)).join('')}
      </div>`;
  }).join('');
  wireKanbanDragDrop();
}

function dealCardHtml(d) {
  const ownerColor = pickOwnerColor(d.ownerUid || d.ownerName || '');
  const wonClass = d.stage === 'Closed Won' ? ' won' : '';
  return `
    <div class="kcard${wonClass}" draggable="true" data-deal-id="${esc(d.id)}" onclick="window.openDeal('${esc(d.id)}')">
      <div class="kcard-n">${esc(d.companyName)}${d.duplicateFlag ? ' <span style="color:#cc3d3d" title="Possible duplicate">⚠</span>' : ''}</div>
      <div class="kcard-m">${esc((d.services && d.services[0]?.name) || 'Services TBD')} · ${esc(d.source || '')}</div>
      <div class="kcard-v">$${(d.monthlyRevenue || 0).toLocaleString()}/mo</div>
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

async function refreshPipeline() {
  const deals = await api('/api/deals');
  window.__crmState.deals = deals;
  renderPipeline(deals);
  renderLeadsTable(deals);
}

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
  tbody.innerHTML = visible.map(d => `
    <tr onclick="window.openDeal('${esc(d.id)}')">
      <td><strong>${esc(d.companyName)}</strong>${d.duplicateFlag ? ' <span class="dup-badge">⚠ Dup</span>' : ''}</td>
      <td>${esc(d.contactName || '')}</td>
      <td>${esc(d.industry || '')}</td>
      <td>${esc(d.source || '')}</td>
      <td data-val="${d.monthlyRevenue || 0}">$${((d.monthlyRevenue || 0) / 1000).toFixed(1)}K/mo</td>
      <td><span class="pill ${stagePill[d.stage] || 'p-new'}">${esc(d.stage)}</span></td>
      <td>${esc(d.ownerName || 'Unassigned')}</td>
      <td data-val="${-(d.updatedAt?._seconds || 0)}">${relativeTime(d.updatedAt)}</td>
      <td><button class="btn btn-sm" style="padding:2px 8px;font-size:10px" onclick="event.stopPropagation();window.openDeal('${esc(d.id)}')">View</button></td>
    </tr>
  `).join('');
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
  const activeDeals = (deals || []).filter(d => !['Closed Won', 'Closed Lost'].includes(d.stage) && !d.discarded && !d.mergedInto);
  const newLeads = (deals || []).filter(d => d.stage === 'New' && !d.discarded).length;
  const unread = (notifs || []).filter(n => !n.read).length;
  const badges = document.querySelectorAll('#sb .nbadge');
  // mockup order: Pipeline=[0], Leads=[1], Notifications=[2]
  if (badges[0]) badges[0].textContent = activeDeals.length;
  if (badges[1]) badges[1].textContent = newLeads;
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

  // Info rows
  const info = screen.querySelectorAll('.drow .dv');
  if (info[0]) info[0].textContent = d.companyName || '—';
  if (info[1]) info[1].textContent = d.contactName || '—';
  if (info[2]) info[2].textContent = d.contactEmail || '—';
  if (info[3]) info[3].textContent = d.contactPhone || '—';
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

  // Duplicate review controls for admins with a flag set
  renderDuplicateBanner(d);
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
  // Override the modal confirm buttons so they call the API
  const advanceBtn = document.querySelector('#advance-modal .btn-p');
  if (advanceBtn && !advanceBtn.dataset.wired) {
    advanceBtn.dataset.wired = '1';
    advanceBtn.onclick = async () => {
      const id = document.getElementById('deal-detail-id')?.value;
      const select = document.querySelector('#advance-modal select');
      const reason = document.querySelector('#advance-modal textarea')?.value;
      if (!id || !select) return;
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
        await refreshPipeline();
        openDeal(id);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Lost modal
  const lostBtn = document.querySelector('#lost-modal [style*="danger"]');
  if (lostBtn && !lostBtn.dataset.wired) {
    lostBtn.dataset.wired = '1';
    lostBtn.onclick = async () => {
      const id = document.getElementById('deal-detail-id')?.value;
      const reasonSel = document.querySelector('#lost-modal select');
      const dateInput = document.querySelector('#lost-modal input[type="date"]');
      if (!id || !reasonSel || !dateInput.value) return toast('Fill all required fields', 'warn');
      try {
        await api(`/api/deals/${id}/stage`, {
          method: 'POST',
          body: JSON.stringify({
            toStage: 'Closed Lost',
            lossReason: reasonSel.value,
            reengagementDate: dateInput.value,
          }),
        });
        document.getElementById('lost-modal').style.display = 'none';
        toast('Marked as Closed Lost', 'ok');
        await refreshPipeline();
        openDeal(id);
      } catch (err) { toast(err.message, 'error'); }
    };
  }

  // Rep reassignment modal
  const repBtn = document.querySelector('#rep-modal .btn-p');
  if (repBtn && !repBtn.dataset.wired) {
    repBtn.dataset.wired = '1';
    repBtn.onclick = async () => {
      const id = document.getElementById('deal-detail-id')?.value;
      const sel = document.querySelector('#rep-modal select');
      const reason = document.querySelector('#rep-modal input')?.value;
      if (!id || !sel) return;
      const newOwner = (window.__crmState.users || []).find(u => u.displayName === sel.value.replace(/\s*\(current\)\s*$/, ''));
      if (!newOwner) return toast('Unknown rep', 'warn');
      try {
        await api(`/api/deals/${id}/reassign`, {
          method: 'POST', body: JSON.stringify({ newOwnerUid: newOwner.uid, reason }),
        });
        document.getElementById('rep-modal').style.display = 'none';
        toast('Rep reassigned', 'ok');
        await refreshPipeline();
        openDeal(id);
      } catch (err) { toast(err.message, 'error'); }
    };

    // Populate rep dropdown from real users
    const repSel = document.querySelector('#rep-modal select');
    if (repSel) {
      repSel.innerHTML = (window.__crmState.users || [])
        .filter(u => u.role === 'rep' || u.role === 'admin')
        .map(u => `<option value="${esc(u.uid)}">${esc(u.displayName)}</option>`).join('');
    }
  }

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
function wireManualLeadForm() {
  const screen = document.getElementById('s-manual-lead');
  if (!screen) return;
  let submitBtn = screen.querySelector('.btn-p');
  if (!submitBtn || submitBtn.dataset.wired) return;
  submitBtn.dataset.wired = '1';
  submitBtn.onclick = async (e) => {
    e.preventDefault();
    const inputs = screen.querySelectorAll('input, select, textarea');
    const data = {};
    let companyField, contactName, contactEmail, contactPhone, industry, sourceField, ownerField, notes;
    inputs.forEach(inp => {
      const label = (inp.previousElementSibling?.textContent || inp.placeholder || '').toLowerCase();
      if (label.includes('company')) data.companyName = inp.value;
      else if (label.includes('contact name')) data.contactName = inp.value;
      else if (label.includes('email')) data.contactEmail = inp.value;
      else if (label.includes('phone')) data.contactPhone = inp.value;
      else if (label.includes('industry')) data.industry = inp.value;
      else if (label.includes('source')) data.source = inp.value;
      else if (label.includes('owner') || label.includes('assign')) {
        const u = (window.__crmState.users || []).find(x => x.displayName === inp.value);
        if (u) data.ownerUid = u.uid;
      } else if (label.includes('note')) data.notes = inp.value;
    });
    if (!data.companyName) return toast('Company name is required', 'warn');
    data.source = data.source || 'Manual Entry';
    try {
      const result = await api('/api/deals', { method: 'POST', body: JSON.stringify(data) });
      toast(`Lead created: Tier ${result.tier || '—'}`, 'ok');
      inputs.forEach(i => { if (i.tagName !== 'SELECT') i.value = ''; });
      await refreshPipeline();
    } catch (err) { toast(err.message, 'error'); }
  };
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

function wireNotificationRulesForm() {
  // Load current notification_rules settings and populate any matching inputs
  if (currentUser?.role !== 'admin') return;
  api('/api/settings/notification_rules').then(cfg => {
    const repField = document.getElementById('cfg-inactivity-rep-days');
    const adminField = document.getElementById('cfg-inactivity-admin-days');
    if (repField && cfg.inactivityRepDays) repField.value = cfg.inactivityRepDays;
    if (adminField && cfg.inactivityAdminDays) adminField.value = cfg.inactivityAdminDays;
  }).catch(() => {});
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
