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

function formatTimeFr(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('fr-BE', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(d);
}

function formatDateTimeFr(value, opts = {}) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('fr-BE', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        ...opts,
    }).format(d);
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
    minimax:    { icon: '🔮', color: 'var(--neon-violet)'  },
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
            const primary = `<div class="provider-metric">${p.requests_remaining} / ${p.requests_limit || '?'} req (5h)</div>`;
            const weekly = (p.requests_remaining_7d != null)
                ? `<div class="provider-sub">weekly: ${p.requests_remaining_7d} / ${p.requests_limit_7d || '?'} req</div>`
                : '';
            const reset5h = p.reset_at ? `<div class="provider-sub">reset 5h ${formatTimeFr(p.reset_at)}</div>` : '';
            const reset7d = p.reset_at_7d ? `<div class="provider-sub">reset weekly ${formatDateTimeFr(p.reset_at_7d)}</div>` : '';
            const note = p.note ? `<div class="provider-sub">${p.note}</div>` : '';
            return `${primary}${weekly}${reset5h}${reset7d}${note}`;
        }
        if (p.remaining_5h != null && p.limit_5h != null) {
            return `<div class="provider-metric">${p.remaining_5h} / ${p.limit_5h} left</div><div class="provider-sub">${p.used_7d || 0} / ${p.limit_7d || '?'} used (7d)</div>`;
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
    if (p.type === 'rate_limits' && p.requests_limit > 0 && p.requests_remaining != null) {
        return (p.requests_remaining / p.requests_limit) < 0.2;
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

// ── Z.ai Usage Widget ──
function _relativeTime(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    if (isNaN(d)) return null;
    const diff = d - Date.now();
    const absDiff = Math.abs(diff);
    const mins = Math.floor(absDiff / 60000);
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    if (diff > 0) {
        if (hrs > 0) return `resets in ${hrs}h${remainMins > 0 ? remainMins + 'm' : ''}`;
        return `resets in ${mins}m`;
    }
    if (hrs > 0) return `${hrs}h${remainMins}m ago`;
    if (mins > 0) return `${mins}m ago`;
    return 'just now';
}

async function loadZaiUsage() {
    const data = await fetchAPI('zai/usage');
    const section = document.getElementById('zai-usage-section');
    if (!data) {
        if (section) section.style.display = 'none';
        return;
    }
    if (section) section.style.display = '';

    const used5 = data.used_5h ?? 0;
    const limit5 = data.limit_5h ?? 0;
    const used7 = data.used_7d ?? 0;
    const limit7 = data.limit_7d ?? 0;
    const remaining5 = data.remaining_5h ?? (limit5 - used5);
    const pct5 = limit5 > 0 ? Math.min(100, (used5 / limit5) * 100) : 0;
    const pct7 = limit7 > 0 ? Math.min(100, (used7 / limit7) * 100) : 0;

    document.getElementById('zai-5h-counts').textContent = `${used5} / ${limit5}`;
    document.getElementById('zai-7d-counts').textContent = `${used7} / ${limit7}`;
    document.getElementById('zai-5h-bar').style.width = pct5.toFixed(1) + '%';
    document.getElementById('zai-7d-bar').style.width = pct7.toFixed(1) + '%';

    // color bars by usage
    const bar5 = document.getElementById('zai-5h-bar');
    const bar7 = document.getElementById('zai-7d-bar');
    bar5.className = 'zai-bar-fill' + (pct5 >= 100 ? ' zai-bar-danger' : pct5 >= 80 ? ' zai-bar-warning' : '');
    bar7.className = 'zai-bar-fill' + (pct7 >= 100 ? ' zai-bar-danger' : pct7 >= 80 ? ' zai-bar-warning' : '');

    // reset times
    const reset5 = _relativeTime(data.reset_5h_at);
    const reset7 = _relativeTime(data.reset_7d_at);
    document.getElementById('zai-5h-reset').textContent = reset5 || '';
    document.getElementById('zai-7d-reset').textContent = reset7 || '';

    // last call
    const lastEl = document.getElementById('zai-last-call');
    if (data.last_call_ts) {
        const rel = _relativeTime(data.last_call_ts);
        lastEl.textContent = rel ? `last call: ${rel}` : `last call: ${new Date(data.last_call_ts).toLocaleTimeString()}`;
    } else {
        lastEl.textContent = '';
    }

    // status badge
    const badge = document.getElementById('zai-status-badge');
    const pctRemaining = limit5 > 0 ? (remaining5 / limit5) : 1;
    if (remaining5 <= 0) {
        badge.textContent = 'EXHAUSTED';
        badge.className = 'zai-status-badge zai-badge-danger';
    } else if (pctRemaining <= 0.2) {
        badge.textContent = 'LOW';
        badge.className = 'zai-status-badge zai-badge-warning';
    } else {
        badge.textContent = 'OK';
        badge.className = 'zai-status-badge zai-badge-ok';
    }
}

// ── Subscription Usage Widget ──
function _subBar(pct, label, extra) {
    if (pct == null) return '';
    const cls = pct >= 100 ? 'zai-bar-danger' : pct >= 80 ? 'zai-bar-warning' : '';
    const extraHtml = extra ? `<span class="zai-meta" style="margin-left:8px;font-size:0.7rem;">${extra}</span>` : '';
    return `
        <div style="margin-bottom:6px;">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;margin-bottom:2px;">
                <span>${label}</span><span>${pct.toFixed(1)}%${extraHtml}</span>
            </div>
            <div class="zai-bar-track"><div class="zai-bar-fill ${cls}" style="width:${Math.min(100, pct).toFixed(1)}%"></div></div>
        </div>`;
}

async function loadSubscriptionUsage() {
    const data = await fetchAPI('subscriptions/usage');
    const section = document.getElementById('sub-usage-section');
    if (!data) { if (section) section.style.display = 'none'; return; }

    let html = '';
    let hasContent = false;
    let worstPct = 0;

    // Codex Plus (live)
    const codex = data.codex;
    if (codex && codex.available) {
        hasContent = true;
        let inner = '';
        if (codex.primary_remaining_percent != null) {
            worstPct = Math.max(worstPct, 100 - codex.primary_remaining_percent);
            inner += _subBar(codex.primary_remaining_percent, '5h restants', codex.primary_resets_at ? `reset ${formatTimeFr(codex.primary_resets_at)}` : null);
        }
        if (codex.secondary_remaining_percent != null) {
            worstPct = Math.max(worstPct, 100 - codex.secondary_remaining_percent);
            inner += _subBar(codex.secondary_remaining_percent, 'Hebdo restants', codex.secondary_resets_at ? `reset ${formatDateTimeFr(codex.secondary_resets_at)}` : null);
        }
        const reviewLimit = codex.rate_limits_by_limit_id && (codex.rate_limits_by_limit_id.review || codex.rate_limits_by_limit_id.code_review || codex.rate_limits_by_limit_id.codex_review);
        if (reviewLimit && reviewLimit.primary_remaining_percent != null) {
            worstPct = Math.max(worstPct, 100 - reviewLimit.primary_remaining_percent);
            inner += _subBar(reviewLimit.primary_remaining_percent, 'Revue code', reviewLimit.primary_resets_at ? `reset ${formatDateTimeFr(reviewLimit.primary_resets_at)}` : null);
        }
        if (codex.credits) {
            const balance = codex.credits.balance ?? '—';
            inner += `<div style="font-size:0.78rem;opacity:0.78;margin-top:8px;">Crédits restants: <strong>${balance}</strong></div>`;
        }
        if (inner) {
            html += `<div class="zai-window" style="flex:1;min-width:240px;"><div class="zai-window-label">Codex Plus</div>${inner}</div>`;
        }
    }

    // Claude Max (live or cached fallback)
    const live = data.claude_live;
    const cc = data.claude_code;
    if (live && (live.available || cc?.available)) {
        hasContent = true;
        let inner = '';
        if (live?.current_session && live.current_session.used_percent != null) {
            worstPct = Math.max(worstPct, live.current_session.used_percent);
            inner += _subBar(live.current_session.used_percent, 'Session', live.current_session.resets_text || null);
        }
        if (live?.current_week_all_models && live.current_week_all_models.used_percent != null) {
            worstPct = Math.max(worstPct, live.current_week_all_models.used_percent);
            inner += _subBar(live.current_week_all_models.used_percent, 'Week (all)', live.current_week_all_models.resets_text || null);
        }
        if (live?.current_week_sonnet && live.current_week_sonnet.used_percent != null) {
            worstPct = Math.max(worstPct, live.current_week_sonnet.used_percent);
            inner += _subBar(live.current_week_sonnet.used_percent, 'Week (Sonnet)', live.current_week_sonnet.resets_text || null);
        }
        if (live?.extra_usage) {
            const eu = live.extra_usage;
            const spendLine = eu.spent_usd != null && eu.limit_usd != null
                ? `$${eu.spent_usd.toFixed(2)} / $${eu.limit_usd.toFixed(2)}`
                : null;
            if (eu.used_percent != null) {
                inner += _subBar(eu.used_percent, 'Extra usage', spendLine);
            } else if (spendLine) {
                inner += `<div style="font-size:0.75rem;opacity:0.7;margin-top:4px;">Extra: ${spendLine}</div>`;
            }
        }
        if (!inner && cc?.available) {
            const totalTok = (cc.input_tokens_5h || 0) + (cc.output_tokens_5h || 0);
            inner += `<div style="font-size:0.78rem;opacity:0.88;line-height:1.5;">Quota live Claude indispo pour l'instant.</div>`;
            inner += `<div style="font-size:0.76rem;opacity:0.7;margin-top:6px;">Local 5h: ${formatNumber(cc.assistant_messages_5h || 0)} msgs · ${formatNumber(totalTok)} tok</div>`;
        }
        const liveMeta = [];
        if (live?.stale && live.cached_fetched_at) {
            liveMeta.push(`cache ${formatDateTimeFr(live.cached_fetched_at, { second: '2-digit' })}`);
        }
        if (live?.reason && !live.live_available) {
            liveMeta.push('live indispo');
        }
        if (liveMeta.length) {
            inner += `<div style="font-size:0.72rem;opacity:0.58;margin-top:8px;">${liveMeta.join(' · ')}</div>`;
        }
        if (inner) {
            html += `<div class="zai-window" style="flex:1;min-width:200px;"><div class="zai-window-label">Claude Max</div>${inner}</div>`;
        }
    }

    // Local telemetry footer
    if (cc && cc.available) {
        hasContent = true;
        const parts = [];
        if (cc.assistant_messages_total) parts.push(`${formatNumber(cc.assistant_messages_total)} msgs`);
        const totalTok = (cc.input_tokens_total || 0) + (cc.output_tokens_total || 0);
        if (totalTok) parts.push(`${formatNumber(totalTok)} tok`);
        if (parts.length) {
            html += `<div class="zai-footer" style="margin-top:8px;font-size:0.72rem;opacity:0.6;">Local telemetry: ${parts.join(' · ')}</div>`;
        }
    }

    if (!hasContent) { if (section) section.style.display = 'none'; return; }
    section.style.display = '';
    document.getElementById('sub-usage-body').innerHTML = `<div class="zai-row" style="flex-wrap:wrap;gap:16px;">${html}</div>`;

    const updatedAtEl = document.getElementById('sub-updated-at');
    const updatedAt = data.claude_live?.fetched_at || data.codex?.last_seen_at || data.claude_code?.last_seen_at;
    if (updatedAtEl) {
        updatedAtEl.textContent = updatedAt ? `(updated ${formatDateTimeFr(updatedAt, { second: '2-digit' })})` : '';
    }

    // Status badge
    const badge = document.getElementById('sub-status-badge');
    if (worstPct >= 100) { badge.textContent = 'EXHAUSTED'; badge.className = 'zai-status-badge zai-badge-danger'; }
    else if (worstPct >= 80) { badge.textContent = 'LOW'; badge.className = 'zai-status-badge zai-badge-warning'; }
    else if (worstPct > 0) { badge.textContent = 'OK'; badge.className = 'zai-status-badge zai-badge-ok'; }
    else { badge.textContent = '—'; badge.className = 'zai-status-badge'; }
}

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
    loadOverview();
    loadProviders();
    loadZaiUsage();
    loadSubscriptionUsage();
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
        loadZaiUsage();
        loadSubscriptionUsage();
    }, 30000);

    // Providers: refresh every 60s + button handler
    setInterval(loadProviders, 60000);
    const rbtn = document.getElementById('providers-refresh-btn');
    if (rbtn) rbtn.addEventListener('click', refreshProviders);
});
