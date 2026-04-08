/**
 * VALENTINA DASHBOARD — Cyberpunk JS Controller
 */

const NEON = {
    cyan: '#00f0ff',
    magenta: '#ff00ff',
    green: '#00ff88',
    purple: '#bf5af2',
    orange: '#ff6b35',
    pink: '#ff2d78',
    yellow: '#ffd700',
};

const NEON_PALETTE = [
    NEON.cyan, NEON.magenta, NEON.green, NEON.purple, 
    NEON.orange, NEON.pink, NEON.yellow
];

// ── Chart.js Global Config ──
Chart.defaults.color = '#8b8fa3';
Chart.defaults.borderColor = 'rgba(255,255,255,0.04)';
Chart.defaults.font.family = "'Rajdhani', sans-serif";

// ── Utilities ──
function formatNumber(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
}

async function fetchAPI(endpoint) {
    try {
        const res = await fetch(`/api/${endpoint}`);
        return await res.json();
    } catch (e) {
        console.error(`API error: ${endpoint}`, e);
        return null;
    }
}

// ── Overview Stats ──
async function loadOverview() {
    const data = await fetchAPI('overview');
    if (!data) return;

    document.getElementById('total-sessions').textContent = data.total_sessions;
    document.getElementById('today-sessions').textContent = `aujourd'hui: ${data.today_sessions}`;
    document.getElementById('total-messages').textContent = formatNumber(data.total_messages);
    document.getElementById('today-messages').textContent = `aujourd'hui: ${data.today_messages}`;
    
    const totalTokens = data.total_input_tokens + data.total_output_tokens;
    document.getElementById('total-tokens').textContent = formatNumber(totalTokens);
    document.getElementById('tokens-breakdown').textContent = 
        `in: ${formatNumber(data.total_input_tokens)} / out: ${formatNumber(data.total_output_tokens)}`;
    
    document.getElementById('total-tools').textContent = formatNumber(data.total_tool_calls);
    document.getElementById('cost-estimate').textContent = 
        `coût estimé: $${data.total_estimated_cost.toFixed(2)}`;

    // Models chart
    if (data.model_usage && data.model_usage.length > 0) {
        createModelsChart(data.model_usage);
    }
}

// ── Providers Arsenal (live) ──
const PROVIDER_META = {
    deepseek:   { icon: '🐳', color: 'var(--neon-cyan)'    },
    openrouter: { icon: '🧭', color: 'var(--neon-magenta)' },
    elevenlabs: { icon: '🎙️', color: 'var(--neon-violet)'  },
    fal:        { icon: '🎨', color: 'var(--neon-magenta)' },
    runpod:     { icon: '🖥️', color: 'var(--neon-cyan)'    },
    tavily:     { icon: '🔎', color: 'var(--neon-violet)'  },
    zai:        { icon: '🧠', color: 'var(--neon-cyan)'    },
};

function _fmtNum(n) {
    if (n == null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

function _statusIcon(s) {
    if (s === 'ok') return '🟢';
    if (s === 'degraded') return '🟠';
    return '🔴';
}

function _providerBody(p) {
    if (p.status === 'error') {
        return `<div class="provider-error">${(p.error || 'error').slice(0,120)}</div>`;
    }
    if (p.type === 'balance_usd') {
        const bal = Number(p.balance || 0);
        const total = Number(p.total || 0);
        let pct = null;
        let line = `$${bal.toFixed(2)}`;
        if (total > 0) {
            pct = Math.max(0, Math.min(100, (bal / total) * 100));
            line = `$${bal.toFixed(2)} / $${total.toFixed(2)}`;
        }
        const bar = pct != null
            ? `<div class="provider-bar"><div class="provider-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`
            : '';
        const spend = (p.spend_per_hour != null && p.spend_per_hour > 0)
            ? `<div class="provider-sub">spend: $${Number(p.spend_per_hour).toFixed(3)}/h</div>` : '';
        return `<div class="provider-metric">${line}</div>${bar}${spend}`;
    }
    if (p.type === 'quota_chars') {
        const used = Number(p.used || 0);
        const limit = Number(p.limit || 0);
        const pct = limit > 0 ? (used / limit) * 100 : 0;
        const bar = `<div class="provider-bar"><div class="provider-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
        const note = p.error ? `<div class="provider-sub" style="color:#fbbf24">${p.error}</div>` : '';
        return `<div class="provider-metric">${_fmtNum(used)} / ${_fmtNum(limit)} chars</div>${bar}${note}`;
    }
    if (p.type === 'quota_credits') {
        const used = Number(p.used || 0);
        const limit = p.limit;
        if (limit != null) {
            const pct = limit > 0 ? (used / limit) * 100 : 0;
            const bar = `<div class="provider-bar"><div class="provider-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
            return `<div class="provider-metric">${_fmtNum(used)} / ${_fmtNum(limit)}</div>${bar}`;
        }
        return `<div class="provider-metric">${_fmtNum(used)} used</div>`;
    }
    if (p.type === 'rate_limits') {
        if (p.requests_remaining != null) {
            return `<div class="provider-metric">${p.requests_remaining} / ${p.requests_limit || '?'} req</div>`;
        }
        return `<div class="provider-sub">${p.note || 'no data'}</div>`;
    }
    return `<div class="provider-sub">—</div>`;
}

function _isLow(p) {
    if (p.type === 'balance_usd' && p.total > 0) {
        return (p.balance / p.total) < 0.2;
    }
    if (p.type === 'quota_chars' && p.limit > 0) {
        return ((p.limit - p.used) / p.limit) < 0.2;
    }
    return false;
}

async function loadProviders() {
    const resp = await fetchAPI('providers/live');
    if (!resp || !resp.providers) return;
    _renderProviders(resp);
}

function _renderProviders(resp) {
    const grid = document.getElementById('providers-grid');
    const updatedEl = document.getElementById('providers-updated-at');
    if (updatedEl && resp.updated_at) {
        const d = new Date(resp.updated_at);
        updatedEl.textContent = `(${resp.source || ''} · ${d.toLocaleTimeString()})`;
    }
    grid.innerHTML = resp.providers.map(p => {
        const meta = PROVIDER_META[p.id] || { icon: '⚡', color: 'var(--neon-cyan)' };
        const lowClass = _isLow(p) ? 'provider-low' : '';
        const statusClass = `provider-${p.status || 'ok'}`;
        return `
            <div class="provider-card ${statusClass} ${lowClass}" style="--provider-color: ${meta.color}">
                <div class="provider-head">
                    <span class="provider-icon">${meta.icon}</span>
                    <span class="provider-name">${p.name || p.id}</span>
                    <span class="provider-status-icon">${_statusIcon(p.status)}</span>
                </div>
                ${_providerBody(p)}
            </div>
        `;
    }).join('');
}

async function refreshProviders() {
    const btn = document.getElementById('providers-refresh-btn');
    const icon = document.getElementById('providers-refresh-icon');
    if (btn) btn.disabled = true;
    if (icon) icon.classList.add('spin');
    try {
        const resp = await fetch(`/api/providers/refresh`, { method: 'POST' });
        if (resp.ok) {
            const data = await resp.json();
            _renderProviders(data);
        }
    } catch (e) {
        console.error('provider refresh failed', e);
    } finally {
        if (btn) btn.disabled = false;
        if (icon) icon.classList.remove('spin');
    }
}

// ── Activity Timeline Chart ──
async function loadActivity() {
    const data = await fetchAPI('activity?days=7');
    if (!data || data.length === 0) return;

    const ctx = document.getElementById('activityChart').getContext('2d');
    
    const gradient = ctx.createLinearGradient(0, 0, 0, 280);
    gradient.addColorStop(0, 'rgba(0, 240, 255, 0.3)');
    gradient.addColorStop(1, 'rgba(0, 240, 255, 0.0)');

    new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => {
                const parts = d.hour.split(' ');
                return parts[1] || parts[0];
            }),
            datasets: [{
                label: 'Messages',
                data: data.map(d => d.messages),
                borderColor: NEON.cyan,
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: NEON.cyan,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10, 11, 26, 0.9)',
                    borderColor: NEON.cyan,
                    borderWidth: 1,
                    titleFont: { family: "'Orbitron', sans-serif", size: 11 },
                    bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
                    padding: 12,
                    cornerRadius: 8,
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { maxTicksLimit: 12, font: { size: 10 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.03)' },
                    ticks: { font: { size: 10 } }
                }
            }
        }
    });
}

// ── Models Doughnut Chart ──
function createModelsChart(modelData) {
    const ctx = document.getElementById('modelsChart').getContext('2d');
    
    new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: modelData.map(m => m.model.split('/').pop()),
            datasets: [{
                data: modelData.map(m => m.sessions),
                backgroundColor: NEON_PALETTE.slice(0, modelData.length),
                borderColor: 'rgba(5, 6, 15, 0.8)',
                borderWidth: 3,
                hoverOffset: 8,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 16,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        font: { size: 11, family: "'Rajdhani', sans-serif" }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(10, 11, 26, 0.9)',
                    borderColor: NEON.magenta,
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                }
            }
        }
    });
}

// ── Provider Tokens Chart ──
async function loadProviderTokens() {
    const data = await fetchAPI('tokens-by-provider');
    if (!data || data.length === 0) return;

    const ctx = document.getElementById('providerTokensChart').getContext('2d');

    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => d.provider || 'unknown'),
            datasets: [
                {
                    label: 'Input',
                    data: data.map(d => d.input_tokens),
                    backgroundColor: 'rgba(0, 240, 255, 0.6)',
                    borderColor: NEON.cyan,
                    borderWidth: 1,
                    borderRadius: 4,
                },
                {
                    label: 'Output',
                    data: data.map(d => d.output_tokens),
                    backgroundColor: 'rgba(255, 0, 255, 0.6)',
                    borderColor: NEON.magenta,
                    borderWidth: 1,
                    borderRadius: 4,
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'rect',
                        font: { size: 10 }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(10, 11, 26, 0.9)',
                    borderColor: NEON.purple,
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${formatNumber(ctx.raw)} tokens`
                    }
                }
            },
            scales: {
                x: { 
                    grid: { display: false },
                    ticks: { font: { size: 10 } }
                },
                y: { 
                    grid: { color: 'rgba(255,255,255,0.03)' },
                    ticks: { 
                        font: { size: 10 },
                        callback: v => formatNumber(v)
                    }
                }
            }
        }
    });
}

// ── Tool Usage Bars ──
async function loadTools() {
    const data = await fetchAPI('tools');
    if (!data || data.length === 0) return;

    const container = document.getElementById('tools-container');
    const maxCount = Math.max(...data.map(d => d.count));

    container.innerHTML = data.slice(0, 10).map(t => {
        const pct = (t.count / maxCount * 100).toFixed(1);
        const name = t.tool.replace('mcp_', '').replace('_tool', '');
        return `
            <div class="tool-bar">
                <div class="tool-name">${name}</div>
                <div class="tool-bar-track">
                    <div class="tool-bar-fill" style="width: ${pct}%"></div>
                </div>
                <div class="tool-count">${t.count}</div>
            </div>
        `;
    }).join('');
}

// ── Sessions Table ──
async function loadSessions() {
    const data = await fetchAPI('sessions?limit=10');
    if (!data || data.length === 0) return;

    const tbody = document.getElementById('sessions-tbody');
    tbody.innerHTML = data.map(s => {
        const sourceClass = s.source === 'telegram' ? 'badge-telegram' : 'badge-cli';
        const model = (s.model || '?').split('/').pop().substring(0, 20);
        const totalTokens = (s.input_tokens || 0) + (s.output_tokens || 0);
        return `
            <tr>
                <td><span class="badge ${sourceClass}">${s.source}</span></td>
                <td style="font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;">${model}</td>
                <td>${s.messages || 0}</td>
                <td>${s.tool_calls || 0}</td>
                <td>${formatNumber(totalTokens)}</td>
                <td style="font-size: 0.8rem; color: var(--text-secondary);">${s.started || '—'}</td>
            </tr>
        `;
    }).join('');
}

// ── Voice Stats ──
async function loadVoiceStats() {
    const data = await fetchAPI('voice-stats');
    if (!data) return;

    document.getElementById('voice-total').textContent = formatNumber(data.total_interactions);

    if (data.model_breakdown && data.model_breakdown.length > 0) {
        const parts = data.model_breakdown.map(m => {
            const name = (m.model || 'unknown').split('-')[0];
            return `${name}: ${m.count}`;
        });
        document.getElementById('voice-breakdown').textContent = parts.join(' / ');
    } else {
        document.getElementById('voice-breakdown').textContent = `aujourd'hui: ${data.today_interactions || 0}`;
    }
}

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
    loadOverview();
    loadProviders();
    loadActivity();
    loadProviderTokens();
    loadTools();
    loadSessions();
    loadVoiceStats();

    // Auto-refresh every 30s
    setInterval(() => {
        loadOverview();
        loadSessions();
        loadVoiceStats();
    }, 30000);

    // Providers: refresh every 60s + button handler
    setInterval(loadProviders, 60000);
    const rbtn = document.getElementById('providers-refresh-btn');
    if (rbtn) rbtn.addEventListener('click', refreshProviders);
});
