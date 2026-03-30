// ── State ──
let bankConnected = false;

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

// ── Savings Lockbox (persisted in localStorage) ──
const LOCKBOX_KEY = 'holdwise_lockbox';
const LOCKBOX_GOAL_KEY = 'holdwise_lockbox_goal';

function getLockbox() {
  return parseFloat(localStorage.getItem(LOCKBOX_KEY) || '0');
}
function getLockboxGoal() {
  return parseFloat(localStorage.getItem(LOCKBOX_GOAL_KEY) || '5000');
}
function saveLockbox(val) {
  localStorage.setItem(LOCKBOX_KEY, val.toString());
}
function saveLockboxGoal(val) {
  localStorage.setItem(LOCKBOX_GOAL_KEY, val.toString());
}

function updateLockboxUI() {
  const current = getLockbox();
  const goal = getLockboxGoal();
  const pct = goal > 0 ? Math.min((current / goal) * 100, 100) : 0;

  document.getElementById('lockbox-current').textContent = formatCurrency(current);
  document.getElementById('lockbox-goal').textContent = `of ${formatCurrency(goal)} goal`;
  document.getElementById('lockbox-progress').style.width = pct.toFixed(1) + '%';
  document.getElementById('lockbox-percent').textContent = pct.toFixed(1) + '% reached';
}

function addToLockbox() {
  const input = document.getElementById('lockbox-amount');
  const amount = parseFloat(input.value);
  if (!amount || amount <= 0) return;
  saveLockbox(getLockbox() + amount);
  input.value = '';
  updateLockboxUI();
}

function editGoal() {
  const goalEl = document.getElementById('lockbox-goal');
  const current = getLockboxGoal();

  // Replace goal text with inline input
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

function saveGoalEdit() {
  const input = document.getElementById('goal-edit-input');
  const val = parseFloat(input.value);
  if (!isNaN(val) && val > 0) {
    saveLockboxGoal(val);
    showToast('Savings goal updated!', 'success');
  }
  // Restore the goal element
  const wrapper = input.parentElement;
  const goalEl = document.createElement('span');
  goalEl.className = 'lockbox-goal';
  goalEl.id = 'lockbox-goal';
  wrapper.replaceWith(goalEl);
  updateLockboxUI();
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
        document.getElementById('connect-banner').style.display = 'none';
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

// ── Render balances ──
function renderBalances(data) {
  const total = data.total_balance || 0;
  const count = (data.accounts || []).length;
  document.getElementById('total-balance').textContent = formatCurrency(total);
  document.getElementById('accounts-count').textContent =
    count > 0 ? `${count} account${count > 1 ? 's' : ''} connected` : 'No accounts connected';

  if (count > 0) {
    document.getElementById('connect-banner').style.display = 'none';
    bankConnected = true;
  }
}

// ── Render transactions (paginated, 10 at a time) ──
let allTransactions = [];
let txPage = 0;
const TX_PER_PAGE = 10;

function renderTxItem(tx) {
  const isNeg = tx.amount > 0;
  const merchant = escapeHtml(tx.merchant_name || tx.name || 'Unknown');
  const categories = escapeHtml((tx.category || []).join(', ') || 'Uncategorized');
  return `
    <div class="tx-item">
      <div class="tx-left">
        <span class="tx-merchant">${merchant}</span>
        <span class="tx-meta">${escapeHtml(formatDate(tx.date))} · ${categories}</span>
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
  countEl.textContent = transactions.length;

  if (transactions.length === 0) {
    container.innerHTML = '<div class="empty-state">Connect a bank account to see transactions</div>';
    if (showingEl) showingEl.textContent = '';
    return;
  }

  let totalSpending = 0;
  transactions.forEach(tx => {
    if (tx.amount > 0) totalSpending += tx.amount;
  });
  spendingEl.textContent = formatCurrency(totalSpending);

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
  // Clear sensitive local data on logout
  localStorage.removeItem(LOCKBOX_KEY);
  localStorage.removeItem(LOCKBOX_GOAL_KEY);
  navigateTo('/login.html');
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  updateLockboxUI();
  loadDashboardData();
});
