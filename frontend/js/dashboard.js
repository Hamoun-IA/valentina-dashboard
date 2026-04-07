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

// ── Providers ──
async function loadProviders() {
    const data = await fetchAPI('providers');
    if (!data) return;

    const grid = document.getElementById('providers-grid');
    grid.innerHTML = data.map(p => `
        <div class="provider-card" style="--provider-color: ${p.color}">
            <div class="provider-icon">${p.icon}</div>
            <div class="provider-name">${p.name}</div>
            <span class="provider-tier tier-${p.tier}">${p.tier}</span>
            <div class="provider-status">
                <div class="provider-status-dot"></div>
                <span>active</span>
            </div>
        </div>
    `).join('');
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

// ── Initialize ──
document.addEventListener('DOMContentLoaded', () => {
    loadOverview();
    loadProviders();
    loadActivity();
    loadProviderTokens();
    loadTools();
    loadSessions();

    // Auto-refresh every 30s
    setInterval(() => {
        loadOverview();
        loadSessions();
    }, 30000);
});
