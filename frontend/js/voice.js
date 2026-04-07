/* Valentina Voice Chat — JS Logic */
(function () {
    'use strict';

    // ── State machine ──
    const State = { IDLE: 'idle', RECORDING: 'recording', PROCESSING: 'processing', PLAYING: 'playing' };
    let state = State.IDLE;

    // ── DOM refs ──
    const statusEl    = document.getElementById('status');
    const recordBtn   = document.getElementById('record-btn');
    const chatArea    = document.getElementById('chat-area');
    const canvas      = document.getElementById('eq-canvas');
    const ctx         = canvas.getContext('2d');
    const connDot     = document.getElementById('conn-dot');

    // ── Audio context + analyser ──
    let audioCtx      = null;
    let analyser      = null;
    let dataArray     = null;
    let gainNode      = null;

    // ── WebSocket ──
    let ws = null;
    let reconnectTimer = null;
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${wsProto}//${location.host}/ws/voice-chat`;

    // ── Speech recognition ──
    let recognition = null;
    let finalTranscript = '';

    // ── Audio queue for binary chunks ──
    let audioQueue    = [];
    let isPlaying     = false;
    let currentValMsg = null;  // current Valentina chat bubble element

    // ────────────────────────────────────────────
    // Initialise
    // ────────────────────────────────────────────
    function init() {
        initAudio();
        initRecognition();
        connectWS();
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        recordBtn.addEventListener('click', toggleRecord);
        drawEqualizer();
    }

    // ── Audio context ──
    function initAudio() {
        audioCtx  = new (window.AudioContext || window.webkitAudioContext)();
        analyser  = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        gainNode  = audioCtx.createGain();
        gainNode.connect(analyser);
        analyser.connect(audioCtx.destination);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
    }

    // ── Speech recognition (STT) ──
    function initRecognition() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) { console.warn('SpeechRecognition not supported'); return; }
        recognition = new SpeechRecognition();
        recognition.lang = 'fr-FR';
        recognition.interimResults = false;
        recognition.continuous = false;

        recognition.onresult = (e) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript;
            }
        };
        recognition.onend = () => {
            if (state === State.RECORDING) {
                // user finished speaking
                if (finalTranscript.trim()) {
                    sendUserMessage(finalTranscript.trim());
                }
                finalTranscript = '';
                setState(State.PROCESSING);
            }
        };
        recognition.onerror = (e) => {
            console.error('STT error', e.error);
            if (state === State.RECORDING) setState(State.IDLE);
        };
    }

    // ── WebSocket ──
    function connectWS() {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
        ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            connDot.className = 'connection-dot connected';
            clearTimeout(reconnectTimer);
        };
        ws.onclose = () => {
            connDot.className = 'connection-dot disconnected';
            scheduleReconnect();
        };
        ws.onerror = () => {
            connDot.className = 'connection-dot disconnected';
        };
        ws.onmessage = (evt) => {
            if (evt.data instanceof ArrayBuffer) {
                handleAudioChunk(evt.data);
            } else {
                try {
                    const msg = JSON.parse(evt.data);
                    if (msg.type === 'text_chunk') handleTextChunk(msg.text);
                    else if (msg.type === 'response_complete') handleComplete();
                } catch (e) { console.warn('Bad JSON', e); }
            }
        };
    }

    function scheduleReconnect() {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectWS, 3000);
    }

    function sendUserMessage(text) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'user_message', text }));
        }
        addChatMessage('user', text);
    }

    // ── Incoming handlers ──
    function handleTextChunk(text) {
        if (state !== State.PLAYING && state !== State.PROCESSING) setState(State.PLAYING);
        if (!currentValMsg) {
            currentValMsg = addChatMessage('valentina', '');
        }
        const contentEl = currentValMsg.querySelector('.msg-content');
        contentEl.textContent += text;
        chatArea.scrollTop = chatArea.scrollHeight;
    }

    function handleAudioChunk(buffer) {
        if (state !== State.PLAYING) setState(State.PLAYING);
        audioQueue.push(buffer);
        if (!isPlaying) playNextChunk();
    }

    function handleComplete() {
        currentValMsg = null;
        // let remaining audio finish, then idle
        if (!isPlaying) setState(State.IDLE);
    }

    // ── Audio playback queue ──
    async function playNextChunk() {
        if (audioQueue.length === 0) { isPlaying = false; setState(State.IDLE); return; }
        isPlaying = true;
        const buf = audioQueue.shift();
        try {
            const audioBuf = await audioCtx.decodeAudioData(buf.slice(0));
            const src = audioCtx.createBufferSource();
            src.buffer = audioBuf;
            src.connect(gainNode);
            src.onended = () => playNextChunk();
            src.start();
        } catch (e) {
            console.warn('decode error', e);
            playNextChunk();
        }
    }

    // ── Record toggle ──
    function toggleRecord() {
        // resume audio context on user gesture
        if (audioCtx.state === 'suspended') audioCtx.resume();

        if (state === State.IDLE) {
            if (!recognition) return;
            finalTranscript = '';
            recognition.start();
            setState(State.RECORDING);
        } else if (state === State.RECORDING) {
            recognition.stop();
        }
    }

    // ── State management ──
    function setState(s) {
        state = s;
        recordBtn.classList.toggle('active', s === State.RECORDING);
        const labels = { idle: 'Prête', recording: 'Écoute...', processing: 'Réfléchis...', playing: 'Parle...' };
        statusEl.textContent = labels[s] || '';
        statusEl.className = 'status-indicator ' + s;
    }

    // ── Chat bubbles ──
    function addChatMessage(role, text) {
        const div = document.createElement('div');
        div.className = 'chat-msg ' + role;
        const sender = document.createElement('div');
        sender.className = 'sender';
        sender.textContent = role === 'user' ? 'Vous' : 'Valentina';
        const content = document.createElement('div');
        content.className = 'msg-content';
        content.textContent = text;
        div.appendChild(sender);
        div.appendChild(content);
        chatArea.appendChild(div);
        chatArea.scrollTop = chatArea.scrollHeight;
        return div;
    }

    // ── Canvas resize ──
    function resizeCanvas() {
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width  = rect.width * (window.devicePixelRatio || 1);
        canvas.height = rect.height * (window.devicePixelRatio || 1);
    }

    // ── Equalizer draw loop ──
    function drawEqualizer() {
        requestAnimationFrame(drawEqualizer);
        const W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        const barCount = 48;
        const gap = 3 * (window.devicePixelRatio || 1);
        const barW = (W - gap * (barCount + 1)) / barCount;
        const isActive = state === State.PLAYING;

        if (isActive && analyser) {
            analyser.getByteFrequencyData(dataArray);
        }

        const time = performance.now() / 1000;

        for (let i = 0; i < barCount; i++) {
            let val;
            if (isActive && dataArray) {
                // map bar index to frequency bin
                const idx = Math.floor(i * (dataArray.length / barCount));
                val = dataArray[idx] / 255;
            } else {
                // idle ambient animation
                val = 0.08 + 0.06 * Math.sin(time * 1.5 + i * 0.35) + 0.04 * Math.sin(time * 2.8 + i * 0.2);
            }

            const barH = Math.max(4, val * H * 0.85);
            const x = gap + i * (barW + gap);
            const y = H - barH;

            // gradient per bar
            const grad = ctx.createLinearGradient(x, H, x, y);
            const t = i / barCount;
            if (t < 0.33) {
                grad.addColorStop(0, '#00f0ff');
                grad.addColorStop(1, '#bf5af2');
            } else if (t < 0.66) {
                grad.addColorStop(0, '#bf5af2');
                grad.addColorStop(1, '#ff00ff');
            } else {
                grad.addColorStop(0, '#ff00ff');
                grad.addColorStop(1, '#ff2d78');
            }

            ctx.fillStyle = grad;

            // rounded top bar
            const r = Math.min(barW / 2, 4 * (window.devicePixelRatio || 1));
            ctx.beginPath();
            ctx.moveTo(x, H);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
            ctx.lineTo(x + barW - r, y);
            ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
            ctx.lineTo(x + barW, H);
            ctx.closePath();
            ctx.fill();

            // glow
            ctx.shadowColor = t < 0.33 ? '#00f0ff' : t < 0.66 ? '#bf5af2' : '#ff00ff';
            ctx.shadowBlur = isActive ? 8 : 3;
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    }

    // ── Start ──
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
