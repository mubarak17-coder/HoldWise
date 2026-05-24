// ── State ──
let bankConnected = false;
let lockboxState = { balance: 0, goal: 5000 };

// ── Helper: get auth headers for API calls ──
async function getAuthHeaders() {
  if (typeof supabaseClient === 'undefined' || !supabaseClient) return {};
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return {};
  return {
    'Authorization': `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
}

// ── Helper: authenticated fetch (redirects to login on 401) ──
async function authFetch(url, options = {}) {
  const headers = await getAuthHeaders();
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (res.status === 401) {
    if (typeof supabaseClient !== 'undefined' && supabaseClient) {
      await supabaseClient.auth.signOut();
    }
    window.location.href = '/login.html';
    throw new Error('Session expired');
  }
  return res;
}

// ── XSS-safe text escaping ──
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Savings Lockbox (persisted in Supabase) ──
function updateLockboxUI() {
  const { balance, goal } = lockboxState;
  const pct = goal > 0 ? Math.min((balance / goal) * 100, 100) : 0;

  document.getElementById('lockbox-current').textContent = formatCurrency(balance);
  document.getElementById('lockbox-goal').textContent = `of ${formatCurrency(goal)} goal`;
  document.getElementById('lockbox-progress').style.width = pct.toFixed(1) + '%';
  document.getElementById('lockbox-percent').textContent = pct.toFixed(1) + '% reached';
}

async function fetchLockbox() {
  try {
    const res = await authFetch('/api/lockbox');
    if (res.ok) {
      lockboxState = await res.json();
      updateLockboxUI();
    }
  } catch { /* non-critical on dashboard */ }
}

async function addToLockbox() {
  const input = document.getElementById('lockbox-amount');
  const amount = parseFloat(input.value);
  if (!amount || amount <= 0) return;

  const prev = lockboxState.balance;
  lockboxState.balance = prev + amount;
  input.value = '';
  updateLockboxUI();

  try {
    const res = await authFetch('/api/lockbox', {
      method: 'POST',
      body: JSON.stringify({ balance: lockboxState.balance }),
    });
    if (res.ok) {
      lockboxState = await res.json();
      updateLockboxUI();
      showToast(`Added ${formatCurrency(amount)} to lockbox!`, 'success');
    } else {
      lockboxState.balance = prev;
      updateLockboxUI();
      showToast('Failed to save. Please try again.', 'error');
    }
  } catch {
    lockboxState.balance = prev;
    updateLockboxUI();
    showToast('Failed to save. Please try again.', 'error');
  }
}

function editGoal() {
  const goalEl = document.getElementById('lockbox-goal');
  const current = lockboxState.goal;

  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<input type="number" id="goal-edit-input" value="${current}" min="1" step="0.01"
    style="width:120px;padding:4px 8px;background:rgba(255,255,255,0.05);border:1px solid var(--accent);
    border-radius:6px;color:var(--text);font-size:14px;font-family:inherit;outline:none;" />
    <button onclick="saveGoalEdit()" style="margin-left:6px;padding:4px 10px;background:var(--accent);
    color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;">Save</button>`;
  goalEl.replaceWith(wrapper);

  const input = document.getElementById('goal-edit-input');
  input.focus();
  input.select();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') saveGoalEdit(); });
}

async function saveGoalEdit() {
  const input = document.getElementById('goal-edit-input');
  const val = parseFloat(input.value);

  const wrapper = input.parentElement;
  const goalEl = document.createElement('span');
  goalEl.className = 'lockbox-goal';
  goalEl.id = 'lockbox-goal';
  wrapper.replaceWith(goalEl);

  if (!isNaN(val) && val > 0) {
    lockboxState.goal = val;
    updateLockboxUI();
    try {
      const res = await authFetch('/api/lockbox', {
        method: 'POST',
        body: JSON.stringify({ goal: val }),
      });
      if (res.ok) {
        lockboxState = await res.json();
        updateLockboxUI();
        showToast('Savings goal updated!', 'success');
      }
    } catch {
      showToast('Failed to save goal.', 'error');
    }
  } else {
    updateLockboxUI();
  }
}

// ── Count-up animation (ease-out cubic) ──
function countUp(el, endVal, duration, formatter) {
  const startTime = performance.now();
  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatter(eased * endVal);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── Formatting helpers ──
function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Category colors ──
const catColors = [
  '#1A56DB', '#00D4FF', '#28C840', '#FFB800',
  '#FF5555', '#A855F7', '#EC4899', '#F97316',
];

// ── Connect Bank via Plaid Link ──
async function connectBank() {
  const btn = document.getElementById('connect-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Connecting...';

  try {
    const res = await authFetch('/api/create-link-token', { method: 'POST' });
    const data = await res.json();

    if (!data.link_token) {
      showToast('Could not initialize bank connection. Check your Plaid credentials.', 'error');
      btn.disabled = false;
      btn.textContent = 'Connect Bank';
      return;
    }

    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async (publicToken) => {
        await authFetch('/api/exchange-token', {
          method: 'POST',
          body: JSON.stringify({ public_token: publicToken }),
        });
        bankConnected = true;
        showToast('Bank connected successfully!', 'success');
        loadDashboardData();
      },
      onExit: () => {
        btn.disabled = false;
        btn.textContent = 'Connect Bank';
      },
    });
    handler.open();
  } catch (err) {
    showToast('Failed to connect. Please try again.', 'error');
    btn.disabled = false;
    btn.textContent = 'Connect Bank';
  }
}

// ── Load dashboard data ──
async function loadDashboardData() {
  try {
    const [balRes, txRes] = await Promise.all([
      authFetch('/api/balances'),
      authFetch('/api/transactions'),
    ]);
    const balData = await balRes.json();
    const txData = await txRes.json();

    renderBalances(balData);
    renderTransactions(txData.transactions || []);
    renderCategories(txData.transactions || []);
  } catch (err) {
    showToast('Failed to load dashboard data.', 'error');
  }
}

// ── Animate SVG ring ──
function animateRing() {
  const ring = document.getElementById('ring-progress');
  if (!ring) return;
  const circumference = 659.73; // 2 * PI * 105
  setTimeout(() => { ring.style.strokeDashoffset = 0; }, 100);
}

// ── Render balances ──
function renderBalances(data) {
  const total = data.total_balance || 0;
  const count = (data.accounts || []).length;

  countUp(document.getElementById('total-balance'), total, 1200, v => formatCurrency(v));
  animateRing();

  const subText = count > 0 ? `${count} account${count > 1 ? 's' : ''} connected` : 'No accounts connected';
  document.getElementById('accounts-count').textContent = subText;

  // Update asset list row
  const assetSub = document.getElementById('asset-sub');
  const assetBalance = document.getElementById('asset-balance');
  if (assetSub) assetSub.textContent = count > 0 ? `${count} account${count > 1 ? 's' : ''}` : 'No accounts';
  if (assetBalance) assetBalance.textContent = formatCurrency(total);

  // Update savings asset row
  const assetSavings = document.getElementById('asset-savings');
  if (assetSavings) assetSavings.textContent = formatCurrency(lockboxState.balance);

  if (count > 0) {
    bankConnected = true;
    document.getElementById('connect-title').textContent = 'Add another bank';
    document.getElementById('connect-desc').textContent = `${count} account${count > 1 ? 's' : ''} connected. Link more banks to see all your finances in one place.`;
  }
}

// ── Render transactions (paginated, 10 at a time) ──
let allTransactions = [];
let txPage = 0;
const TX_PER_PAGE = 10;

function getTxIcon(name, category) {
  const n = (name || '').toLowerCase();
  if (n.includes('uber') || n.includes('lyft') || n.includes('taxi')) return '🚗';
  if (n.includes('mcdonald') || n.includes('burger') || n.includes('kfc') || n.includes('wendy')) return '🍔';
  if (n.includes('starbucks') || n.includes('coffee') || n.includes('cafe')) return '☕';
  if (n.includes('amazon') || n.includes('ebay') || n.includes('shop')) return '🛍️';
  if (n.includes('netflix') || n.includes('spotify') || n.includes('apple') || n.includes('google play')) return '📱';
  if (n.includes('airline') || n.includes('flight') || n.includes('united') || n.includes('delta')) return '✈️';
  if (n.includes('hotel') || n.includes('airbnb') || n.includes('marriott')) return '🏨';
  if (n.includes('gym') || n.includes('fitness') || n.includes('sport')) return '💪';
  if (n.includes('pharmacy') || n.includes('cvs') || n.includes('walgreen')) return '💊';
  if (n.includes('pizza') || n.includes('restaurant') || n.includes('sushi')) return '🍽️';
  const cat = ((category && category[0]) || '').toLowerCase();
  if (cat.includes('food') || cat.includes('dining')) return '🍽️';
  if (cat.includes('travel') || cat.includes('transport')) return '✈️';
  if (cat.includes('shopping')) return '🛍️';
  if (cat.includes('health') || cat.includes('medical')) return '💊';
  if (cat.includes('entertainment')) return '🎬';
  if (cat.includes('bill') || cat.includes('util')) return '📄';
  return '💳';
}

function renderTxItem(tx) {
  const isNeg = tx.amount > 0;
  const merchant = escapeHtml(tx.merchant_name || tx.name || 'Unknown');
  const categories = escapeHtml((tx.category || []).join(', ') || 'Uncategorized');
  const icon = getTxIcon(tx.merchant_name || tx.name || '', tx.category);
  return `
    <div class="tx-item">
      <div class="tx-icon">${icon}</div>
      <div class="tx-info">
        <div class="tx-merchant">${merchant}</div>
        <div class="tx-meta">${escapeHtml(formatDate(tx.date))} · ${categories}</div>
      </div>
      <span class="tx-amount ${isNeg ? 'negative' : 'positive'}">${isNeg ? '-' : '+'}${formatCurrency(Math.abs(tx.amount))}</span>
    </div>
  `;
}

function renderTransactions(transactions) {
  const container = document.getElementById('tx-list');
  const countEl = document.getElementById('tx-count');
  const spendingEl = document.getElementById('monthly-spending');
  const showingEl = document.getElementById('tx-showing');

  allTransactions = transactions;
  txPage = 0;
  countUp(countEl, transactions.length, 800, v => String(Math.round(v)));

  if (transactions.length === 0) {
    container.innerHTML = '<div class="empty-state">Connect a bank account to see transactions</div>';
    if (showingEl) showingEl.textContent = '';
    return;
  }

  let totalSpending = 0;
  transactions.forEach(tx => {
    if (tx.amount > 0) totalSpending += tx.amount;
  });
  countUp(spendingEl, totalSpending, 1200, v => formatCurrency(v));

  const visible = transactions.slice(0, TX_PER_PAGE);
  const hasMore = transactions.length > TX_PER_PAGE;

  if (showingEl) showingEl.textContent = `Showing ${visible.length} of ${transactions.length}`;

  container.innerHTML = `
    <div class="tx-scroll">
      <div class="tx-list" id="tx-items">${visible.map(renderTxItem).join('')}</div>
    </div>
    ${hasMore ? '<button class="btn-show-more" onclick="showMoreTx()">Show more</button>' : ''}
  `;
  txPage = 1;
}

function showMoreTx() {
  const start = txPage * TX_PER_PAGE;
  const next = allTransactions.slice(start, start + TX_PER_PAGE);
  if (next.length === 0) return;

  const itemsContainer = document.getElementById('tx-items');
  itemsContainer.insertAdjacentHTML('beforeend', next.map(renderTxItem).join(''));
  txPage++;

  const showingEl = document.getElementById('tx-showing');
  const shown = Math.min(txPage * TX_PER_PAGE, allTransactions.length);
  if (showingEl) showingEl.textContent = `Showing ${shown} of ${allTransactions.length}`;

  if (txPage * TX_PER_PAGE >= allTransactions.length) {
    const btn = document.querySelector('.btn-show-more');
    if (btn) btn.remove();
  }
}

// ── Render spending by category (bar chart) ──
function renderCategories(transactions) {
  const container = document.getElementById('cat-chart');

  if (transactions.length === 0) {
    container.innerHTML = '<div class="empty-state">No data yet</div>';
    return;
  }

  const catMap = {};
  transactions.forEach(tx => {
    if (tx.amount <= 0) return;
    const cat = (tx.category && tx.category[0]) || 'Other';
    catMap[cat] = (catMap[cat] || 0) + tx.amount;
  });

  const sorted = Object.entries(catMap).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = sorted.length > 0 ? sorted[0][1] : 1;

  const bars = sorted.map(([cat, amount], i) => {
    const pct = (amount / max) * 100;
    const color = catColors[i % catColors.length];
    return `
      <div class="cat-bar-group">
        <div class="cat-bar-label">
          <span>${escapeHtml(cat)}</span>
          <span>${formatCurrency(amount)}</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = bars.join('');
}

// ── Toast notifications ──
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Logout ──
async function handleLogout() {
  if (typeof supabaseClient !== 'undefined' && supabaseClient) {
    await supabaseClient.auth.signOut();
  }
  navigateTo('/login.html');
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  fetchLockbox();
  loadDashboardData();
});
