// ============================================================
// KRANE AI — JS Core Engine (monolite)
// File sorgente: JS_Core, JS_Auth, JS_Dashboard, JS_Feed,
//   JS_Clienti, JS_PED, JS_Settings, JS_Init
// ============================================================

// ── URL Backend GAS (API endpoint) ──
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzJpKUtSCtOewTsRkOa9j-0QNhvN38BFM2I8kjYimysCsedIEPFM4ZO4YRz9OkVYN1H_Q/exec';

// ── Service Worker (ora funziona perché siamo su GitHub Pages) ──
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js')
    .then(() => console.log('[SW] Registrato'))
    .catch(e => console.warn('[SW] Errore registrazione:', e.message));
}

const KR = (() => {
// ============================================================
// KRANE AI — JS Core Engine (State, Helpers, Particles, Nav)
// ============================================================

  // ── State ──
  let currentUser = null;
  let sessionToken = null;
  let loginAttempts = 0;
  let lockoutUntil = 0;
  let lastFeedTimestamp = '';
  let feedPollInterval = null;
  let pedMonth = new Date().getMonth() + 1;
  let pedYear = new Date().getFullYear();
  let pedSelectedClient = '';
  let allClienti = [];
  let clientFilter = 'tutti';
  let isAdmin = false;
  const settings = {
    sound: localStorage.getItem('kr_sound') !== 'off',
    vibrate: localStorage.getItem('kr_vibrate') !== 'off'
  };

  // ── Helpers ──
  const $ = id => document.getElementById(id);
  const haptic = (ms = 8) => { if (settings.vibrate && navigator.vibrate) navigator.vibrate(ms); };

  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2800);
  }

  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ── API wrapper — fetch verso GAS (sostituisce google.script.run) ──
  async function gas(fn, ...args) {
    const params = new URLSearchParams({ action: fn });
    if (sessionToken) params.set('token', sessionToken);
    args.forEach((a, i) => params.set(`a${i}`, a === null || a === undefined ? '' : typeof a === 'object' ? JSON.stringify(a) : String(a)));
    const res = await fetch(`${GAS_API_URL}?${params}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── PARTICLES ──
  function initParticles() {
    const cv = $('particles');
    if (!cv) return;
    const cx = cv.getContext('2d');
    let pts = [];
    function rC() { cv.width = innerWidth; cv.height = innerHeight; }
    rC();
    addEventListener('resize', rC);
    function cP() {
      return {
        x: Math.random() * cv.width, y: Math.random() * cv.height,
        vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.8 + 0.3, a: Math.random() * 0.25 + 0.03,
        c: ['52,211,153', '167,139,250', '244,114,182', '245,158,11'][Math.floor(Math.random() * 4)]
      };
    }
    for (let i = 0; i < 15; i++) pts.push(cP());
    let _pFrame = 0;
    function dP() {
      _pFrame++;
      // Disegna ogni 2 frame per risparmiare CPU su mobile
      if (_pFrame % 2 === 0) {
        cx.clearRect(0, 0, cv.width, cv.height);
        pts.forEach(p => {
          p.x += p.vx; p.y += p.vy;
          if (p.x < 0 || p.x > cv.width) p.vx *= -1;
          if (p.y < 0 || p.y > cv.height) p.vy *= -1;
          cx.beginPath(); cx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          cx.fillStyle = `rgba(${p.c},${p.a})`; cx.fill();
        });
      }
      requestAnimationFrame(dP);
    }
    dP();
  }

  // ── NAVIGATION ──
  const pages = ['pageDashboard', 'pageClienti', 'pagePED', 'pageStats', 'pageAltro'];
  let _navItems = null;
  let _pageDoms = null;
  let _currentPage = 0;
  function nav(n) {
    if (n === _currentPage && _pageDoms) return; // gi\u00E0 sulla pagina
    _currentPage = n;
    // Cache DOM refs al primo uso
    if (!_pageDoms) _pageDoms = pages.map(id => $(id));
    if (!_navItems) _navItems = Array.from(document.querySelectorAll('.nav-item'));
    _pageDoms.forEach((el, i) => el.classList.toggle('active', i === n));
    _navItems.forEach((el, i) => el.classList.toggle('active', i === n));
    // FAB visibile solo su pagina Clienti E solo per Admin
    const fabEl = $('fab');
    fabEl.style.display = (n === 1 && !fabEl.getAttribute('data-hidden-role')) ? 'flex' : 'none';
    haptic();
    // Lazy load data per pagina
    if (n === 1 && allClienti.length === 0) loadClienti();
    if (n === 2) loadPED();
    if (n === 3) loadStats();
    if (n === 4) loadTeam();
  }

  function switchSub(chip, showId) {
    ['subTeam', 'subAgenti', 'subWorkflow', 'subSettings'].forEach(id => {
      $(id).style.display = (id === showId) ? 'block' : 'none';
    });
    chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    haptic();
    if (showId === 'subWorkflow') loadWorkflowJobs();
  }

  // ── AUTH ──

  // Salva credenziali nel portachiavi di sistema (attiva Face ID / impronta)
  async function _storeCredential(username, password) {
    try {
      if (!window.PasswordCredential) return;
      const cred = new PasswordCredential({ id: username, password: password, name: 'Krane AI' });
      await navigator.credentials.store(cred);
    } catch (e) { /* silenzioso — non tutti i browser supportano */ }
  }

  // Recupera credenziali dal portachiavi (il sistema chiede Face ID / impronta)
  async function _getStoredCredential() {
    try {
      if (!window.PasswordCredential) return null;
      const cred = await navigator.credentials.get({ password: true, mediation: 'optional' });
      if (cred && cred.type === 'password') return { username: cred.id, password: cred.password };
    } catch (e) { /* silenzioso */ }
    return null;
  }

  async function initAuth() {
    // 1. Prova sessione salvata (token in localStorage — dura 6 mesi)
    const savedToken = localStorage.getItem('kr_token');
    if (savedToken) {
      try {
        const res = await gas('authVerifySession', savedToken);
        if (res && res.ok) {
          sessionToken = savedToken;
          currentUser = { username: res.username, nome: res.nome, role: res.role };
          enterApp();
          return;
        }
      } catch (e) {
        console.warn('Session verify failed:', e);
      }
      localStorage.removeItem('kr_token');
    }

    // 2. Prova login biometrico (Face ID / impronta) dal portachiavi
    const stored = await _getStoredCredential();
    if (stored && stored.username && stored.password) {
      try {
        const hash = await sha256(stored.password);
        const res = await gas('authLogin', stored.username, hash);
        if (res && res.ok && !res.firstLogin) {
          sessionToken = res.token;
          localStorage.setItem('kr_token', res.token);
          currentUser = { username: res.username, nome: res.nome, role: res.role };
          enterApp();
          return;
        }
      } catch (e) {
        console.warn('Biometric login failed:', e);
      }
    }

    // 3. Nessuna sessione — mostra login manuale
    $('loginOverlay').classList.remove('hidden');
  }

  async function doLogin() {
    const now = Date.now();
    if (now < lockoutUntil) {
      const secs = Math.ceil((lockoutUntil - now) / 1000);
      $('loginLockout').textContent = `Account bloccato. Riprova tra ${secs}s`;
      return;
    }
    const u = $('loginUser').value.trim().toLowerCase();
    const p = $('loginPass').value;
    if (!u || !p) { $('loginError').textContent = 'Inserisci username e password'; return; }

    $('loginBtn').disabled = true;
    $('loginBtn').textContent = 'Verifica...';

    try {
      const hash = await sha256(p);
      const res = await gas('authLogin', u, hash);
      if (!res || !res.ok) {
        loginAttempts++;
        $('loginError').textContent = (res && res.errore) || 'Credenziali non valide';
        if (loginAttempts >= 5) {
          lockoutUntil = Date.now() + 60000;
          $('loginLockout').textContent = 'Troppi tentativi. Bloccato per 60 secondi.';
          setTimeout(() => { $('loginBtn').disabled = false; $('loginLockout').textContent = ''; loginAttempts = 0; }, 60000);
        } else {
          $('loginLockout').textContent = `Tentativo ${loginAttempts}/5`;
          $('loginBtn').disabled = false;
        }
        haptic(100);
        $('loginBtn').textContent = 'Accedi';
        return;
      }
      loginAttempts = 0;
      sessionToken = res.token;
      localStorage.setItem('kr_token', res.token);
      currentUser = { username: res.username, nome: res.nome, role: res.role };

      // Salva nel portachiavi per Face ID / impronta al prossimo accesso
      await _storeCredential(u, p);

      if (res.firstLogin) {
        $('loginForm').style.display = 'none';
        $('changePwForm').style.display = 'flex';
        $('loginTitleEl').textContent = 'Benvenuto!';
        $('loginClaimEl').textContent = res.nome + ', scegli la tua password personale';
        $('loginStudioEl').style.display = 'none';
        $('loginBtn').textContent = 'Accedi';
        $('loginBtn').disabled = false;
        return;
      }
      enterApp();
    } catch (err) {
      $('loginError').textContent = 'Errore di connessione. Riprova.';
      $('loginBtn').textContent = 'Accedi';
      $('loginBtn').disabled = false;
    }
  }

  async function doChangePassword() {
    const p1 = $('newPass1').value;
    const p2 = $('newPass2').value;
    const err = $('changePwError');
    if (p1.length < 6) { err.textContent = 'Minimo 6 caratteri'; return; }
    if (p1 !== p2) { err.textContent = 'Le password non coincidono'; return; }
    if (p1 === 'krane2026') { err.textContent = 'Scegli una password diversa da quella iniziale'; return; }
    try {
      const hash = await sha256(p1);
      const res = await gas('authChangePassword', currentUser.username, hash);
      if (res && res.ok) {
        enterApp();
      } else {
        err.textContent = 'Errore nel salvataggio';
      }
    } catch (e) {
      err.textContent = 'Errore di connessione';
    }
  }

  function enterApp() {
    $('greetName').textContent = currentUser.nome;
    $('wbAvatar').textContent = currentUser.nome[0];
    $('wbName').textContent = currentUser.nome;
    $('wbRole').textContent = currentUser.role;
    $('loginOverlay').classList.add('hidden');

    // ── Permessi per ruolo ──
    isAdmin = currentUser.role === 'Admin';

    // Admin: mostra gestione utenti, nascondi cambio password (solo da GAS)
    if (isAdmin) {
      $('adminSection').style.display = 'block';
      $('changePwRow').style.display = 'none';
    }

    // Nascondi elementi admin-only per non-Admin
    document.querySelectorAll('.admin-only').forEach(el => {
      el.style.display = isAdmin ? '' : 'none';
    });

    // FAB (bottone + nella pagina Clienti) — solo Admin
    if (!isAdmin) {
      const fab = $('fab');
      if (fab) fab.setAttribute('data-hidden-role', '1');
    }

    // Saluto personalizzato per utente
    const _saluti = {
      'jared': 'Salve, Jared',
      'alessandro': 'Ave Sandrus',
      'roberto': "Fa na' ca Bobby!",
      'francesco': 'Buonasera, CEO!'
    };
    const saluto = _saluti[currentUser.username] || ('Ciao ' + currentUser.nome + '!');
    $('greetName').textContent = saluto;
    showToast(saluto);

    loadDashboard();
    startFeedPolling();
    // Avvia polling notifiche
    pollNotifiche();
    setInterval(pollNotifiche, 10000);

    // Mostra banner notifiche se il permesso non è ancora stato dato (iOS richiede gesto utente)
    setTimeout(_showNotifPrompt, 1500);
  }

  function doLogout() {
    localStorage.removeItem('kr_token');
    sessionToken = null;
    currentUser = null;
    if (feedPollInterval) clearInterval(feedPollInterval);
    location.reload();
  }

  // ── NOTIFICHE POLLING + PUSH NATIVE ──
  let _lastUnread = 0;

  async function pollNotifiche() {
    if (!currentUser) return;
    try {
      const res = await gas('getNotificheCount', currentUser.username);
      if (res && res.ok) {
        const badge = $('notifBadge');
        const bell = $('notifBell');
        if (res.unread > 0) {
          badge.textContent = res.unread > 99 ? '99+' : res.unread;
          badge.style.display = 'flex';
          bell.classList.add('has-unread');
          // Push nativa se ci sono nuove notifiche
          if (res.unread > _lastUnread && _lastUnread >= 0 && 'Notification' in window && Notification.permission === 'granted') {
            const diff = res.unread - _lastUnread;
            new Notification('Krane AI', {
              body: diff === 1 ? 'Hai una nuova notifica' : `Hai ${diff} nuove notifiche`,
              icon: 'https://i.imgur.com/8Km9tLL.png',
              tag: 'krane-notif',
              renotify: true
            });
          }
        } else {
          badge.style.display = 'none';
          bell.classList.remove('has-unread');
        }
        _lastUnread = res.unread || 0;
      }
    } catch (e) { /* silenzioso */ }
  }

  // Mostra banner notifiche — non blocca mai, mostra sempre se il permesso è "default"
  function _showNotifPrompt() {
    console.log('[NOTIF] Check: Notification in window =', 'Notification' in window,
      '| permission =', ('Notification' in window) ? Notification.permission : 'N/A',
      '| dismissed =', localStorage.getItem('kr_notif_dismissed'),
      '| standalone =', window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches);

    // Se il browser non supporta le notifiche, mostra comunque il banner
    // con un messaggio diverso (diagnostico per noi)
    const dismissed = localStorage.getItem('kr_notif_dismissed');
    if (dismissed) return;

    const hasNotifAPI = 'Notification' in window;
    if (hasNotifAPI && Notification.permission !== 'default') return;

    const el = $('notifPrompt');
    if (el) el.style.display = 'flex';
  }

  // L'utente tocca "Attiva" — gesto dell'utente (richiesto da iOS)
  async function acceptNotif() {
    const el = $('notifPrompt');
    if (el) el.style.display = 'none';

    // Caso 1: Notification API disponibile
    if ('Notification' in window) {
      try {
        const result = await Notification.requestPermission();
        console.log('[NOTIF] Permission result:', result);
        if (result === 'granted') {
          showToast('Notifiche attivate! 🔔');
          // Test: mostra una notifica di prova
          try { new Notification('Krane AI', { body: 'Le notifiche funzionano!' }); } catch (e) {}
        } else if (result === 'denied') {
          showToast('Permesso negato — vai in Impostazioni > Notifiche per riattivarlo');
        } else {
          showToast('Permesso non concesso');
        }
      } catch (e) {
        console.warn('[NOTIF] Error:', e);
        showToast('Errore nella richiesta permesso');
      }
    } else {
      // Caso 2: API non disponibile (versione iOS vecchia o non è una PWA)
      showToast('Notifiche non disponibili — assicurati di aprire da icona Home');
    }
  }

  // L'utente tocca "No grazie" — nascondi e ricorda la scelta
  function dismissNotif() {
    const el = $('notifPrompt');
    if (el) el.style.display = 'none';
    localStorage.setItem('kr_notif_dismissed', '1');
  }

  // Fallback: richiedi permesso al tap sulla campanella (utile se ha chiuso il banner)
  function _requestNotifPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  // ── DASHBOARD ──
  async function loadDashboard() {
    try {
      const stats = await gas('getStats');
      if (stats) {
        $('statClienti').textContent = stats.clienti || 0;
        $('statAssets').textContent = stats.assets || 0;
        $('statPED').textContent = stats.pedAttivi || 0;
      }
    } catch (e) {
      console.warn('loadDashboard error:', e);
    }
    loadFeedInitial();
    loadProduzione();
  }

  // ── PRODUZIONE DASHBOARD (Fase 1E) ──
  async function loadProduzione() {
    try {
      const res = await gas('getTasksProduzione');
      if (!res || !res.ok) return;

      const summary = $('prodSummary');
      const list    = $('prodTaskList');

      if (res.totale === 0) {
        summary.style.display = 'none';
        list.innerHTML = '<div class="empty-state" style="padding:16px 0"><div class="empty-state-icon">✅</div><div class="empty-state-text">Tutto prodotto! Nessun task in coda.</div></div>';
        return;
      }

      // Summary
      summary.style.display = 'flex';
      $('prodTotale').textContent = res.totale;
      $('prodOverdue').textContent = res.overdue;

      // Task list (max 8 sulla dashboard)
      const oggi = new Date().toISOString().slice(0, 10);
      const tra3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      let html = '';

      res.tasks.slice(0, 8).forEach(t => {
        const isOverdue = t.dataPub && t.dataPub < oggi;
        const isUrgent  = !isOverdue && t.dataPub && t.dataPub <= tra3;
        const cls       = isOverdue ? 'overdue' : (isUrgent ? 'urgent' : '');
        const dateCls   = isOverdue ? 'overdue' : (isUrgent ? 'urgent' : 'normal');
        const tipoLower = (t.tipo || '').toLowerCase();
        const iconCls   = tipoLower.includes('reel') ? 'reel' : (tipoLower.includes('carosello') ? 'carosello' : 'post');
        const icon      = tipoLower.includes('reel') ? '🎬' : (tipoLower.includes('carosello') ? '📱' : '🖼');
        const dataLabel = t.dataPub ? _formatDataBreve(t.dataPub) : '—';

        html += `<div class="prod-task ${cls}" onclick="KR.openSheet('previewAsset',{clienteId:'${t.clienteId}',rowIndex:${t.rowIndex}})">
          <div class="prod-task-icon ${iconCls}">${icon}</div>
          <div class="prod-task-body">
            <div class="prod-task-title">${t.titolo || 'Senza titolo'}</div>
            <div class="prod-task-meta">${t.nomeCliente} · ${t.tipo}</div>
          </div>
          <div class="prod-task-date ${dateCls}">${dataLabel}</div>
        </div>`;
      });

      if (res.tasks.length > 8) {
        html += `<div style="text-align:center;padding:8px;color:var(--text-dim);font-size:12px">...e altri ${res.tasks.length - 8} task</div>`;
      }

      list.innerHTML = html;
    } catch (e) {
      console.warn('loadProduzione error:', e);
    }
  }

  function _formatDataBreve(dateStr) {
    if (!dateStr) return '—';
    try {
      const parts = dateStr.split('-');
      if (parts.length < 3) return dateStr;
      const mesi = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
      return parseInt(parts[2]) + ' ' + mesi[parseInt(parts[1]) - 1];
    } catch (_) { return dateStr; }
  }

  // ── FEED ──
  async function loadFeedInitial() {
    try {
      const items = await gas('getFeedRecent', 15);
      renderFeed(items || []);
    } catch (e) {
      $('feedList').innerHTML = '<div class="empty-state"><div class="empty-state-icon">📡</div><div class="empty-state-text">Feed non disponibile</div></div>';
    }
  }

  function renderFeed(items) {
    const container = $('feedList');
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📡</div><div class="empty-state-text">Nessun evento recente.<br>Le attivit\u00E0 appariranno qui in tempo reale.</div></div>';
      return;
    }
    const colors = ['green', 'purple', 'orange', 'pink'];
    container.innerHTML = items.slice(0, 15).map((item, i) => {
      const color = colors[i % 4];
      const time = timeAgo(item.timestamp);
      return `<div class="feed-item glass"><div class="feed-dot ${color}">${item.icona || '📌'}</div><div class="feed-content"><div class="feed-text"><strong>${item.tipo || 'Evento'}</strong> ${item.messaggio || ''}</div><div class="feed-time">${time}</div></div></div>`;
    }).join('');
    if (items[0]) lastFeedTimestamp = items[0].timestamp;
    // Aggiorna ticker con l'ultimo evento
    if (items[0]) {
      $('tickerText').innerHTML = `<strong>${items[0].tipo || 'Sistema'}</strong> ${items[0].messaggio || ''}`;
    }
  }

  function startFeedPolling() {
    if (feedPollInterval) clearInterval(feedPollInterval);
    feedPollInterval = setInterval(async () => {
      try {
        const items = await gas('getFeed', lastFeedTimestamp);
        if (items && items.length > 0) {
          // Prepend nuovi items
          const container = $('feedList');
          const colors = ['green', 'purple', 'orange', 'pink'];
          const newHtml = items.map((item, i) => {
            const color = colors[i % 4];
            return `<div class="feed-item glass" style="animation:fIn 0.4s both"><div class="feed-dot ${color}">${item.icona || '📌'}</div><div class="feed-content"><div class="feed-text"><strong>${item.tipo || 'Evento'}</strong> ${item.messaggio || ''}</div><div class="feed-time">Adesso</div></div></div>`;
          }).join('');
          container.innerHTML = newHtml + container.innerHTML;
          lastFeedTimestamp = items[0].timestamp;
          $('tickerText').innerHTML = `<strong>${items[0].tipo || 'Sistema'}</strong> ${items[0].messaggio || ''}`;
          if (settings.vibrate) haptic(15);
          showToast('Nuovo evento nel feed');
        }
      } catch (e) { /* silenzio su errori polling */ }
    }, 8000);
  }

  function loadMoreFeed() {
    loadFeedInitial();
    showToast('Feed aggiornato');
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Adesso';
    if (mins < 60) return mins + ' min fa';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' ore fa';
    return Math.floor(hours / 24) + ' giorni fa';
  }

  // ── CLIENTI ──
  async function loadClienti() {
    try {
      const list = await gas('getClientiAttivi');
      allClienti = list || [];
      renderClienti(allClienti);
    } catch (e) {
      $('clientList').innerHTML = '<div class="empty-state"><div class="empty-state-icon">❌</div><div class="empty-state-text">Errore nel caricamento clienti</div></div>';
    }
  }

  function renderClienti(list) {
    const container = $('clientList');
    if (!list || list.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">Nessun cliente trovato.<br>Usa il + per aggiungerne uno.</div></div>';
      return;
    }
    const colors = [
      { bg: 'rgba(52,211,153,0.12)', color: 'var(--accent)' },
      { bg: 'rgba(167,139,250,0.12)', color: 'var(--a2)' },
      { bg: 'rgba(245,158,11,0.12)', color: 'var(--a3)' },
      { bg: 'rgba(244,114,182,0.12)', color: 'var(--a4)' }
    ];
    container.innerHTML = list.map((c, i) => {
      const col = colors[i % 4];
      const initials = (c.nome || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
      return `<div class="client-card glass" onclick="KR.openClientDetail('${c.id}')"><div class="client-avatar" style="background:${col.bg};color:${col.color}">${initials}</div><div class="client-info"><div class="client-name">${c.nome}</div><div class="client-sector">${c.settore || ''}</div></div><div class="client-status-dot"></div><div class="client-arrow">›</div></div>`;
    }).join('');
  }

  function filterClienti() {
    const q = $('clientSearch').value.toLowerCase();
    const filtered = allClienti.filter(c => (c.nome || '').toLowerCase().includes(q) || (c.settore || '').toLowerCase().includes(q));
    renderClienti(filtered);
  }

  function filterClientiByStatus(chip, status) {
    clientFilter = status;
    chip.parentElement.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    // Per ora tutti sono "attivi" dal backend — quando si supporterà archivio, filtrare qui
    renderClienti(allClienti);
    haptic();
  }

  function openClientDetail(clienteId) {
    openSheet('clientDetail', clienteId);
  }

  // ── PED ──
  function populatePEDDropdown() {
    const menu = $('pedDdMenu');
    if (!allClienti || allClienti.length === 0) {
      gas('getClientiAttivi').then(list => {
        allClienti = list || [];
        _buildPEDMenu();
      }).catch(() => {});
    } else {
      _buildPEDMenu();
    }
  }

  function _buildPEDMenu() {
    const menu = $('pedDdMenu');
    const colors = ['var(--accent)', 'var(--a2)', 'var(--a3)', 'var(--a4)'];
    menu.innerHTML = allClienti.map((c, i) =>
      `<div class="dd-option" onclick="KR.selectPEDClient(this,'${c.id}','${c.nome}')"><div class="dd-dot" style="background:${colors[i % 4]}"></div>${c.nome}</div>`
    ).join('');
  }

  function togglePEDDropdown() {
    $('pedDdMenu').classList.toggle('open');
    $('pedDdArrow').classList.toggle('open');
    if ($('pedDdMenu').classList.contains('open')) populatePEDDropdown();
  }

  function selectPEDClient(el, id, nome) {
    pedSelectedClient = id;
    $('pedDdLabel').textContent = nome;
    $('pedDdMenu').querySelectorAll('.dd-option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    $('pedDdMenu').classList.remove('open');
    $('pedDdArrow').classList.remove('open');
    loadPED();
    haptic();
  }

  function pedChangeMonth(delta) {
    pedMonth += delta;
    if (pedMonth > 12) { pedMonth = 1; pedYear++; }
    if (pedMonth < 1) { pedMonth = 12; pedYear--; }
    loadPED();
    haptic();
  }

  async function loadPED() {
    const mesi = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
    $('pedMonthName').textContent = mesi[pedMonth - 1] + ' ' + pedYear;

    if (!pedSelectedClient) {
      renderCalendar([], pedYear, pedMonth);
      return;
    }

    try {
      const res = await gas('getPEDCalendario', pedSelectedClient, pedYear, pedMonth);
      if (res && res.ok) {
        renderCalendar(res.assets || [], pedYear, pedMonth);
        renderPEDAssets(res.assets || []);
      }
    } catch (e) {
      console.warn('loadPED error:', e);
    }
  }

  function renderCalendar(assets, year, month) {
    const grid = $('pedCalGrid');
    // Days header
    let html = '<div class="cal-day-name">L</div><div class="cal-day-name">M</div><div class="cal-day-name">M</div><div class="cal-day-name">G</div><div class="cal-day-name">V</div><div class="cal-day-name">S</div><div class="cal-day-name">D</div>';

    const firstDay = new Date(year, month - 1, 1).getDay();
    const daysInMonth = new Date(year, month, 0).getDate();
    const today = new Date();
    const startOffset = firstDay === 0 ? 6 : firstDay - 1; // Lun = 0

    // Map assets per giorno
    const dayMap = {};
    (assets || []).forEach(a => {
      const d = new Date(a.data).getDate();
      if (!dayMap[d]) dayMap[d] = [];
      dayMap[d].push(a);
    });

    const typeColors = { 'Reel': 'var(--accent)', 'Post': 'var(--a2)', 'Carosello': 'var(--a3)' };

    for (let i = 0; i < startOffset; i++) html += '<div class="cal-day"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = (d === today.getDate() && month === today.getMonth() + 1 && year === today.getFullYear());
      const hasContent = dayMap[d] && dayMap[d].length > 0;
      let cls = 'cal-day';
      if (isToday) cls += ' today';
      else if (hasContent) cls += ' has-content';
      let dots = '';
      if (hasContent && !isToday) {
        dots = '<div class="cal-dot-row">' + dayMap[d].slice(0, 3).map(a => `<div class="cal-tiny-dot" style="background:${typeColors[a.tipo] || 'var(--accent)'}"></div>`).join('') + '</div>';
      }
      html += `<div class="${cls}">${d}${dots}</div>`;
    }
    grid.innerHTML = html;
  }

  // ── Parser design lato client (mirror di _parseDesign in GAS) ──
  function parseDesignClient(txt) {
    if (!txt) return null;
    const gf = (campo) => { const m = txt.match(new RegExp(campo + ':\\s*(.+?)(?=\\n|$)', 'i')); return m ? m[1].trim() : ''; };
    const parseFont = (raw) => {
      if (!raw) return null;
      const m = raw.match(/^(.+?)\s*—\s*(https?:\/\/.+?)$/i);
      return m ? { nome: m[1].trim(), url: m[2].trim() } : { nome: raw, url: '' };
    };
    const parsePal = (raw) => {
      if (!raw) return null;
      const moodM = raw.match(/—\s*([^\[\]]+?)$/);
      const cols = [...raw.matchAll(/\[?\s*#([0-9a-fA-F]{6})\s*\|\s*([^|]+?)\s*\|\s*(\d+\s*,\s*\d+\s*,\s*\d+)\s*\|\s*(\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+)\s*\]?/g)];
      return cols.length > 0 ? { mood: moodM ? moodM[1].trim() : '', colors: cols.map(m => ({ hex: '#'+m[1], pantone: m[2].trim(), rgb: m[3].replace(/\s/g,''), cmyk: m[4].replace(/\s/g,'') })) } : null;
    };
    const p1 = parsePal(gf('PALETTE_1')), p2 = parsePal(gf('PALETTE_2')), p3 = parsePal(gf('PALETTE_3'));
    return { fp: parseFont(gf('FONT_PRIMARIO')), fs: parseFont(gf('FONT_SECONDARIO')), fm: gf('FONT_MOTIVAZIONE'), palettes: [p1,p2,p3].filter(Boolean) };
  }

  function renderDesignPreview(design) {
    const d = parseDesignClient(design);
    if (!d || (d.palettes.length === 0 && !d.fp)) return '';
    const palHtml = d.palettes.map((p, i) => `
      <div class="pal-row">
        <div class="pal-label">${p.mood ? p.mood.split('.')[0].substring(0, 50) : 'Proposta ' + (i+1)}</div>
        <div class="pal-colors">${p.colors.map(c => `
          <div class="pal-color-wrap">
            <div class="pal-circle" style="background:${c.hex}"></div>
            <div class="pal-hex">${c.hex}</div>
            <div class="pal-spec">${c.pantone}</div>
            <div class="pal-spec">RGB ${c.rgb}</div>
            <div class="pal-spec">CMYK ${c.cmyk}</div>
          </div>`).join('')}
        </div>
        ${p.mood ? '<div class="pal-mood">💡 ' + p.mood + '</div>' : ''}
      </div>`).join('');
    const fontHtml = (d.fp || d.fs) ? `<div class="design-fonts">
      ${d.fp ? '<div class="design-font">🔤 <strong>' + d.fp.nome + '</strong>' + (d.fp.url ? ' <a href="' + d.fp.url + '" target="_blank" class="font-link">↗</a>' : '') + '</div>' : ''}
      ${d.fs ? '<div class="design-font">🔤 ' + d.fs.nome + (d.fs.url ? ' <a href="' + d.fs.url + '" target="_blank" class="font-link">↗</a>' : '') + '</div>' : ''}
      ${d.fm ? '<div class="design-font-note">💡 ' + d.fm + '</div>' : ''}
    </div>` : '';
    return `<div class="design-preview">${fontHtml}<div class="pal-container">${palHtml}</div></div>`;
  }

  // ── STATUS SYSTEM ──
  const statusMap = {
    'Proposto': { cls: 'status-proposto', label: 'Proposto', icon: '📋' },
    'Approvato': { cls: 'status-approvato', label: 'Approvato', icon: '✅' },
    'In Revisione': { cls: 'status-revisione', label: 'In Revisione', icon: '🔄' },
    'Prodotto': { cls: 'status-prodotto', label: 'Prodotto', icon: '🎬' },
    'Pubblicato': { cls: 'status-pubblicato', label: 'Pubblicato', icon: '🚀' },
    'Rifiutato': { cls: 'status-rifiutato', label: 'Rifiutato', icon: '❌' },
    'Bozza': { cls: 'status-bozza', label: 'Bozza', icon: '📝' }
  };

  function getStatusBadge(stato) {
    const s = statusMap[stato] || statusMap['Bozza'];
    return `<span class="status-badge ${s.cls}">${s.label}</span>`;
  }

  function renderPEDAssets(assets) {
    const container = $('pedAssetList');
    if (!assets || assets.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">Nessun contenuto per questo mese</div></div>';
      return;
    }
    const badgeClass = { 'Reel': 'badge-reel', 'Post': 'badge-post', 'Carosello': 'badge-carosello' };
    container.innerHTML = assets.map(a => {
      const bc = badgeClass[a.tipo] || 'badge-post';
      const designHtml = a.design ? renderDesignPreview(a.design) : '';
      const statusHtml = getStatusBadge(a.stato);
      return `<div class="asset-card glass">
        <div class="asset-header">
          <div class="asset-type-badge ${bc}">${a.tipo || '?'}</div>
          <div class="asset-info">
            <div class="asset-title">${a.titolo || 'Senza titolo'}</div>
            <div class="asset-status">${statusHtml} · ${new Date(a.data).toLocaleDateString('it-IT')}${a.driveLink ? ' · 📁' : ''}</div>
          </div>
          <button class="preview-asset-btn" onclick="KR.openSheet('previewAsset',{clienteId:'${a.clienteId}',rowIndex:${a.rowIndex}})" title="Anteprima">👁️</button>
          <button class="edit-asset-btn" onclick="KR.openSheet('editAsset',{clienteId:'${a.clienteId}',rowIndex:${a.rowIndex}})" title="Modifica">✏️</button>
        </div>
        ${designHtml ? '<div class="asset-design-toggle" onclick="this.nextElementSibling.classList.toggle(\'open\')">🎨 Palette & Font ▾</div><div class="asset-design-body">' + designHtml + '</div>' : ''}
      </div>`;
    }).join('');
  }

  // ── CLIENT DETAIL + PED GENERATION ──
  async function loadClientDetail(clienteId) {
    try {
      const res = await gas('getClienteDetail', clienteId);
      const sc = $('sheetContent');
      if (res && res.ok) {
        const c = res.cliente;
        let assetsHtml = (res.assets || []).map(a => `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:13px"><strong>${a.titolo || ''}</strong> <span style="color:var(--text-s)">${a.tipo || ''} · ${a.stato || ''}</span></div>`).join('');
        const briefHtml = c.brief ? `<div style="margin:12px 0;padding:10px 12px;background:rgba(255,255,255,0.03);border-radius:10px;font-size:13px;color:var(--text-s);line-height:1.5"><strong style="color:var(--text-p)">Brief:</strong> ${c.brief}</div>` : '';
        const metaHtml = [c.target && `🎯 ${c.target}`, c.competitor && `⚔️ ${c.competitor}`, c.tono && `🎨 ${c.tono}`].filter(Boolean).join('<br>');
        // Bottone Genera PED — solo Admin, solo cliente Attivo
        const pedBtn = isAdmin && c.stato === 'Attivo'
          ? `<button class="sheet-btn" id="btnGeneraPED" style="width:100%;margin:16px 0;background:linear-gradient(135deg,#7f5af0,#2cb67d);color:#fff;font-weight:700" onclick="KR.avviaPED('${c.id}','${c.nome.replace(/'/g,'\\&#39;')}')">📋 Genera Piano Editoriale</button>`
          : '';
        sc.innerHTML = `<div class="sheet-title">${c.nome}</div>
        <div class="sheet-subtitle">${c.settore || ''} ${c.sito ? '· ' + c.sito : ''}</div>
        ${briefHtml}
        ${metaHtml ? '<div style="margin-bottom:16px;font-size:12px;color:var(--text-s);line-height:1.8">' + metaHtml + '</div>' : ''}
        ${pedBtn}
        <div class="section-title" style="font-size:14px">Asset recenti</div>
        ${assetsHtml || '<div style="color:var(--text-t);font-size:13px">Nessun asset</div>'}`;
      } else {
        sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Cliente non trovato</div>';
      }
    } catch (e) {
      $('sheetContent').innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Impossibile caricare i dati</div>';
    }
  }

  async function avviaPED(clienteId, nomeCliente) {
    if (!isAdmin) { showToast('Solo Admin'); return; }
    const btn = $('btnGeneraPED');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Avvio generazione...'; }
    try {
      const res = await gas('avviaPEDDaApp', clienteId);
      if (res && res.ok) {
        showToast('🚀 PED in generazione per ' + (nomeCliente || res.cliente) + '! Riceverai una notifica quando sarà pronto.');
        closeSheet();
      } else {
        showToast('❌ ' + (res ? res.errore : 'Errore sconosciuto'));
        if (btn) { btn.disabled = false; btn.textContent = '📋 Genera Piano Editoriale'; }
      }
    } catch (e) {
      showToast('❌ Errore di connessione');
      if (btn) { btn.disabled = false; btn.textContent = '📋 Genera Piano Editoriale'; }
    }
  }

  async function loadPEDClientList() {
    try {
      const list = await gas('getClientiAttivi');
      const container = $('pedClientList');
      if (!list || list.length === 0) {
        container.innerHTML = '<div style="color:var(--text-t);font-size:13px;text-align:center;padding:20px">Nessun cliente attivo. Registrane uno prima.</div>';
        return;
      }
      const colors = ['var(--accent)', 'var(--a2)', 'var(--a3)', 'var(--a4)'];
      container.innerHTML = list.map((c, i) => {
        const col = colors[i % 4];
        const initials = (c.nome || '??').substring(0, 2).toUpperCase();
        return `<div class="ped-client-btn glass" onclick="KR.avviaPED('${c.id}','${(c.nome || '').replace(/'/g,'')}')" style="display:flex;align-items:center;gap:14px;padding:14px 16px;border-radius:14px;margin-bottom:8px;cursor:pointer;border:1px solid var(--glass-border);transition:all 0.2s">
          <div style="width:40px;height:40px;border-radius:12px;background:${col};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;flex-shrink:0">${initials}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:14px;color:var(--text)">${c.nome}</div>
            <div style="font-size:12px;color:var(--text-dim)">${c.settore || 'Settore non specificato'}</div>
          </div>
          <div style="font-size:18px;color:var(--accent)">📋</div>
        </div>`;
      }).join('');
    } catch (e) {
      $('pedClientList').innerHTML = '<div style="color:var(--red);font-size:13px">Errore di caricamento</div>';
    }
  }

  async function loadResetPwList() {
    try {
      const res = await gas('authGetUsers', sessionToken);
      if (res && res.ok) {
        const users = (res.users || []).filter(u => u.username !== currentUser.username);
        $('resetPwList').innerHTML = users.map(u =>
          `<div class="admin-btn" onclick="KR.submitResetPw('${u.username}','${u.nome}')"><div class="ab-icon" style="background:rgba(245,158,11,0.12)">🔑</div>${u.nome} (${u.username})</div>`
        ).join('') || '<div style="color:var(--text-s);font-size:13px">Nessun altro utente</div>';
      }
    } catch (e) {
      $('resetPwList').innerHTML = '<div style="color:var(--red);font-size:13px">Errore di caricamento</div>';
    }
  }

  // ── NOTIFICHE ──
  async function loadNotifiche() {
    if (!currentUser) return;
    _requestNotifPermission();
    try {
      const res = await gas('getNotifiche', currentUser.username);
      const container = $('notifList');
      if (!res || !res.ok || !res.notifiche || res.notifiche.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔔</div><div class="empty-state-text">Nessuna notifica</div></div>';
        return;
      }
      container.innerHTML = res.notifiche.map((n, i) => {
        const iconMap = {
          'PED_PROPOSTO': { icon: '📋', cls: 'ped' },
          'VOTO_RICEVUTO': { icon: '🗳️', cls: 'voto' },
          'PED_APPROVATO': { icon: '🎉', cls: 'approvato' },
          'PED_RIFIUTATO': { icon: '❌', cls: 'rifiutato' },
          'PED_AUTO_APPROVATO': { icon: '⏰', cls: 'auto' },
          'REMINDER_VOTO': { icon: '🔔', cls: 'ped' }
        };
        const ic = iconMap[n.tipo] || { icon: 'ℹ️', cls: 'info' };
        const unread = !n.letta ? ' unread' : '';
        const ago = timeAgo(n.timestamp);
        let actionBadge = '';
        if (n.azioneRichiesta === 'Voto') {
          actionBadge = n.azioneCompletata
            ? '<div class="notif-action-badge done">✅ Votato</div>'
            : '<div class="notif-action-badge pending">⏳ Voto richiesto</div>';
        }
        const isVotable = (n.tipo === 'PED_PROPOSTO' || n.tipo === 'REMINDER_VOTO') && n.pedId;
        const clickAction = isVotable
          ? `onclick="KR.openNotifPed('${n.id}','${n.pedId}','${n.clienteId}')"`
          : `onclick="KR.markNotifRead('${n.id}')"`;
        return `<div class="notif-item${unread}" ${clickAction} style="animation-delay:${i * 0.06}s">
          <div class="notif-icon ${ic.cls}">${ic.icon}</div>
          <div class="notif-body">
            <div class="notif-title">${n.titolo}</div>
            <div class="notif-msg">${n.messaggio}</div>
            ${actionBadge}
            <div class="notif-time">${ago}</div>
          </div>
        </div>`;
      }).join('');
    } catch (e) {
      $('notifList').innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-text">Errore caricamento</div></div>';
    }
  }

  async function markNotifRead(notificaId) {
    try {
      await gas('markNotificaLetta', notificaId);
      pollNotifiche();
      // Aggiorna visivamente
      const items = document.querySelectorAll('.notif-item.unread');
      items.forEach(el => {
        if (el.getAttribute('onclick') && el.getAttribute('onclick').includes(notificaId)) {
          el.classList.remove('unread');
        }
      });
    } catch (e) { /* silenzioso */ }
  }

  async function markAllNotifRead() {
    if (!currentUser) return;
    try {
      showToast('Segno tutte come lette...');
      await gas('markTutteNotificheLette', currentUser.username);
      pollNotifiche();
      document.querySelectorAll('.notif-item.unread').forEach(el => el.classList.remove('unread'));
      showToast('✅ Tutte le notifiche lette');
    } catch (e) { showToast('Errore'); }
  }

  async function openNotifPed(notificaId, pedId, clienteId) {
    // Segna come letta
    markNotifRead(notificaId);
    // Apri il pannello voto PED
    closeSheet();
    setTimeout(() => openSheet('votaPed', { pedId, clienteId }), 400);
  }

  // ── VOTA PED (pannello dedicato per votazione) ──
  async function loadVotaPed(data) {
    const sc = $('sheetContent');
    try {
      // Carica voti correnti e info PED_Meta
      const votiRes = await gas('getVotiPed', data.pedId);
      if (!votiRes || !votiRes.ok) {
        sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Impossibile caricare i voti</div>';
        return;
      }

      const { voti, approvals, rejections, soglia, totalTeam } = votiRes;
      const pctApprove = Math.round((approvals / soglia) * 100);
      const pctReject = rejections > 0 ? Math.round((rejections / soglia) * 100) : 0;
      const myVote = voti.find(v => v.username.toLowerCase() === currentUser.username.toLowerCase());
      const hasVoted = !!myVote;

      const voteListHtml = voti.length > 0
        ? `<div class="vote-list">${voti.map(v =>
            `<div class="vote-chip ${v.voto === 'approva' ? 'si' : 'no'}">${v.voto === 'approva' ? '✅' : '❌'} ${v.nome} <span style="font-size:10px;color:var(--text-t);margin-left:4px">${timeAgo(v.timestamp)}</span></div>`
          ).join('')}</div>`
        : '<div style="font-size:12px;color:var(--text-t);margin-top:8px">Nessun voto ancora</div>';

      const voteButtons = hasVoted
        ? `<div style="padding:14px;background:rgba(52,211,153,0.06);border-radius:12px;text-align:center;margin-top:12px">
            <div style="font-size:14px;font-weight:700;color:var(--accent)">Hai già votato: ${myVote.voto === 'approva' ? '✅ Approvato' : '❌ Rifiutato'}</div>
          </div>`
        : `<div class="vote-buttons">
            <button class="vote-btn approve" onclick="KR.submitVoto('${data.pedId}','approva',this)">✅ Approva</button>
            <button class="vote-btn reject" onclick="KR.submitVoto('${data.pedId}','rifiuta',this)">❌ Rifiuta</button>
          </div>`;

      sc.innerHTML = `
        <div class="sheet-title">🗳️ Vota PED</div>
        <div class="sheet-subtitle">Servono ${soglia} approvazioni su ${totalTeam} membri (team − 1)</div>

        <div class="vote-section">
          <div class="vote-progress-wrap">
            <div class="vote-progress-label">
              <span class="vote-progress-title">Approvazioni</span>
              <span class="vote-progress-count">${approvals} / ${soglia}</span>
            </div>
            <div class="vote-progress-bar">
              <div class="vote-progress-fill green" style="width:${Math.min(100, pctApprove)}%"></div>
            </div>
          </div>
          ${rejections > 0 ? `<div class="vote-progress-wrap">
            <div class="vote-progress-label">
              <span class="vote-progress-title" style="color:var(--red)">Rifiuti</span>
              <span class="vote-progress-count" style="color:var(--red)">${rejections}</span>
            </div>
            <div class="vote-progress-bar">
              <div class="vote-progress-fill red" style="width:${Math.min(100, pctReject)}%"></div>
            </div>
          </div>` : ''}

          <div class="vote-timer">
            <span class="vote-timer-icon">⏰</span> Scadenza: 24 ore dalla proposta
          </div>

          ${voteListHtml}
          ${voteButtons}
        </div>

        <div style="margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.04)">
          <div style="font-size:11px;color:var(--text-t);line-height:1.6">
            📌 Regola: servono <strong>${soglia}</strong> approvazioni (team − 1) entro 24 ore. Se nessuno rifiuta entro la scadenza, il PED viene approvato automaticamente.
          </div>
        </div>
      `;
    } catch (e) {
      sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Impossibile caricare</div>';
    }
  }

  async function submitVoto(pedId, voto, btnEl) {
    if (!currentUser) return;
    btnEl.disabled = true;
    btnEl.textContent = '⏳';
    try {
      const res = await gas('votaAssetApp', pedId, currentUser.username, voto);
      if (res && res.ok) {
        showToast(voto === 'approva' ? '✅ Voto registrato — Approvato!' : '❌ Voto registrato — Rifiutato');
        haptic(15);
        // Ricarica il pannello voto per aggiornare il conteggio
        loadVotaPed({ pedId });
        pollNotifiche();
      } else {
        showToast(votiRes.errore || 'Errore nel voto');
        btnEl.disabled = false;
        btnEl.textContent = voto === 'approva' ? '✅ Approva' : '❌ Rifiuta';
      }
    } catch (e) {
      showToast('Errore di connessione');
      btnEl.disabled = false;
      btnEl.textContent = voto === 'approva' ? '✅ Approva' : '❌ Rifiuta';
    }
  }

  // ── ASSET PREVIEW (visualizzazione PED proposto/approvato) ──
  async function loadAssetPreview(data) {
    const sc = $('sheetContent');
    try {
      const res = await gas('getAssetDetail', data.clienteId, data.rowIndex);
      if (!res || !res.ok) {
        sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Asset non trovato</div>';
        return;
      }
      const a = res.asset;
      const ri = res.rowIndex;
      const cid = data.clienteId;
      const bc = { 'Reel': 'badge-reel', 'Post': 'badge-post', 'Carosello': 'badge-carosello' }[a.tipo] || 'badge-post';
      const statusBadge = getStatusBadge(a.stato);

      // Status action buttons — what can you do from this state?
      const statusButtons = buildStatusActions(a.stato, cid, ri);

      // Captions
      const captions = [
        { label: 'Engaging', text: a.caption1 },
        { label: 'Storytelling', text: a.caption2 },
        { label: 'Educativa', text: a.caption3 }
      ].filter(c => c.text);
      const captionsHtml = captions.length > 0 ? `
        <div class="preview-section">
          <div class="preview-section-label">✍️ Caption</div>
          ${captions.map(c => `<div class="preview-caption-card"><div class="preview-caption-label">${c.label}</div><div class="preview-caption-text">${c.text}</div></div>`).join('')}
        </div>` : '';

      // Storyboard
      const storyHtml = a.storyboard ? `
        <div class="preview-section">
          <div class="preview-section-label">🎬 Storyboard</div>
          <div class="preview-story-block">${a.storyboard}</div>
        </div>` : '';

      // Shotlist
      const shotHtml = a.shotlist ? `
        <div class="preview-section">
          <div class="preview-section-label">📸 Shotlist</div>
          <div class="preview-story-block">${a.shotlist}</div>
        </div>` : '';

      // Motivazione
      const motivHtml = a.motivazione ? `
        <div class="preview-section">
          <div class="preview-section-label">💡 Motivazione strategica</div>
          <div class="preview-motiv-block">${a.motivazione}</div>
        </div>` : '';

      // Design (palette + font preview)
      let designSection = '';
      if (a.design) {
        const d = parseDesignClient(a.design);
        if (d) {
          let fontPreviewHtml = '';
          if (d.fp || d.fs) {
            // Load Google Fonts dynamically
            const fontsToLoad = [d.fp, d.fs].filter(f => f && f.url);
            if (fontsToLoad.length > 0) {
              const familyParams = fontsToLoad.map(f => 'family=' + encodeURIComponent(f.nome)).join('&');
              const linkTag = `<link href="https://fonts.googleapis.com/css2?${familyParams}&display=swap" rel="stylesheet">`;
              // Inject font link
              if (!document.querySelector('link[data-krane-fonts]')) {
                const el = document.createElement('div');
                el.innerHTML = linkTag;
                const link = el.firstChild;
                link.setAttribute('data-krane-fonts', '1');
                document.head.appendChild(link);
              } else {
                document.querySelector('link[data-krane-fonts]').href = `https://fonts.googleapis.com/css2?${familyParams}&display=swap`;
              }
            }
            fontPreviewHtml = `<div class="preview-font-preview">
              ${d.fp ? `<div class="preview-font-sample"><div class="preview-font-sample-label">Font Primario — ${d.fp.nome}</div><div style="font-family:'${d.fp.nome}',sans-serif;font-size:22px;font-weight:700;margin-bottom:4px">Il contenuto perfetto</div><div style="font-family:'${d.fp.nome}',sans-serif;font-size:14px;color:var(--text-s)">Aa Bb Cc Dd 1234567890</div></div>` : ''}
              ${d.fs ? `<div class="preview-font-sample" style="margin-top:12px"><div class="preview-font-sample-label">Font Secondario — ${d.fs.nome}</div><div style="font-family:'${d.fs.nome}',sans-serif;font-size:16px;color:var(--text-s);line-height:1.5">Testo di esempio per il body copy del contenuto social.</div><div style="font-family:'${d.fs.nome}',sans-serif;font-size:14px;color:var(--text-t)">Aa Bb Cc Dd 1234567890</div></div>` : ''}
              ${d.fm ? `<div style="margin-top:10px;font-size:11px;color:var(--text-t);line-height:1.5">💡 ${d.fm}</div>` : ''}
            </div>`;
          }
          designSection = `<div class="preview-section">
            <div class="preview-section-label">🎨 Design — Palette & Font</div>
            ${renderDesignPreview(a.design)}
            ${fontPreviewHtml}
          </div>`;
        }
      }

      // Audio — Suno v4.5 con MOTIVAZIONE + STYLE + LYRICS
      const audioHtml = (a.suno1 || a.suno2) ? `
        <div class="preview-section">
          <div class="preview-section-label">🎵 Audio — Suno v4.5</div>
          ${a.suno1 ? renderSunoPreview(a.suno1, 'Proposta A') : ''}
          ${a.suno2 ? renderSunoPreview(a.suno2, 'Proposta B') : ''}
        </div>` : '';

      // Reference / Drive
      const refHtml = (a.reference || a.driveLink) ? `
        <div class="preview-section">
          <div class="preview-section-label">📎 Riferimenti</div>
          ${a.driveLink ? `<a href="${a.driveLink}" target="_blank" class="preview-ref-link">📁 File su Drive</a>` : ''}
          ${a.reference ? `<div style="margin-top:8px;font-size:12px;color:var(--text-s)">${a.reference}</div>` : ''}
        </div>` : '';

      sc.innerHTML = `
        <div class="preview-header-row">
          <div class="asset-type-badge ${bc}">${a.tipo || '?'}</div>
          <div class="preview-header-title">${a.titolo || 'Senza titolo'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
          ${statusBadge}
          <span class="preview-date">📅 ${new Date(a.data).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </div>
        <div id="previewStatusActions">${statusButtons}</div>
        <div id="previewVoteSection"></div>
        ${motivHtml}
        ${captionsHtml}
        ${storyHtml}
        ${shotHtml}
        ${designSection}
        ${audioHtml}
        ${refHtml}
        <div style="display:flex;gap:8px;margin-top:20px">
          <button class="sheet-btn" style="flex:1;background:var(--glass);color:var(--text);box-shadow:none;border:1px solid var(--glass-border)" onclick="KR.openSheet('editAsset',{clienteId:'${cid}',rowIndex:${ri}})">✏️ Modifica</button>
          <button class="sheet-btn" style="flex:1;background:linear-gradient(135deg,#7f5af0,#2cb67d);color:#fff" onclick="KR.openRegenSheet('${cid}',${ri},'${a.tipo}')">🔄 Rigenera</button>
        </div>
        ${(a.stato === 'Approvato' || a.stato === 'Da Produrre') && isAdmin ? `<button class="sheet-btn" style="width:100%;margin-top:8px;background:rgba(139,108,240,0.12);color:var(--accent);border:1px solid rgba(139,108,240,0.3)" onclick="KR.generaLinkCliente('${cid}',${ri})">🔗 Genera link per il cliente</button>` : ''}
      `;

      // Se l'asset è in stato Proposto, carica la sezione voti inline
      if (a.stato === 'Proposto' && cid) {
        loadInlineVoteSection(cid);
      }
    } catch (e) {
      sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Impossibile caricare il contenuto</div>';
    }
  }

  // ── SUNO v4.5 PREVIEW — renderizza MOTIVAZIONE + STYLE + LYRICS separati ──
  function renderSunoPreview(sunoText, label) {
    if (!sunoText || sunoText === 'N/A') return '';
    // Prova a parsare il formato v4.5: MOTIVAZIONE: ... | STYLE: ... | LYRICS: ...
    const motivMatch = sunoText.match(/MOTIVAZIONE:\s*([\s\S]*?)(?=\s*\|?\s*STYLE:|$)/i);
    const styleMatch = sunoText.match(/STYLE:\s*([\s\S]*?)(?=\s*\|?\s*LYRICS:|$)/i);
    const lyricsMatch = sunoText.match(/LYRICS:\s*([\s\S]*?)$/i);

    if (motivMatch || styleMatch) {
      const motiv = motivMatch ? motivMatch[1].trim() : '';
      const style = styleMatch ? styleMatch[1].trim() : '';
      const lyrics = lyricsMatch ? lyricsMatch[1].trim() : 'instrumental';
      return `<div class="suno-card glass">
        <div class="suno-label">${label}</div>
        ${motiv ? `<div class="suno-motiv">💭 ${motiv}</div>` : ''}
        ${style ? `<div class="preview-audio-pill">🎵 STYLE: ${style}</div>` : ''}
        ${lyrics !== 'instrumental' ? `<div class="preview-audio-pill">📝 LYRICS: ${lyrics}</div>` : '<div class="suno-instrumental">🎹 Instrumental</div>'}
      </div>`;
    }
    // Fallback: formato legacy
    return `<div class="suno-card glass"><div class="suno-label">${label}</div><div class="preview-audio-pill">🎵 ${sunoText}</div></div>`;
  }

  // ── RIGENERAZIONE UI — bottom sheet con 3 opzioni ──
  function openRegenSheet(clienteId, rowIndex, tipo) {
    const sc = $('sheetContent');
    sc.innerHTML = `
      <div class="sheet-title">🔄 Rigenera contenuto</div>
      <div class="sheet-subtitle">Scegli cosa rigenerare</div>
      <div id="regenOptions">
        <div class="regen-tile glass" onclick="KR.selectRegen('full')">
          <div class="regen-icon">🔄</div>
          <div class="regen-label">Rigenera tutto</div>
          <div class="regen-desc">Riscrive l'intero contenuto da zero con angolazione diversa</div>
        </div>
        <div class="regen-tile glass" onclick="KR.selectRegen('section')">
          <div class="regen-icon">🎯</div>
          <div class="regen-label">Rigenera sezione</div>
          <div class="regen-desc">Scegli quale parte rigenerare</div>
        </div>
        <div class="regen-tile glass" onclick="KR.selectRegen('prompt')">
          <div class="regen-icon">✍️</div>
          <div class="regen-label">Modifica con istruzioni</div>
          <div class="regen-desc">Dai indicazioni specifiche alla Volpe</div>
        </div>
      </div>
      <div id="regenForm" style="display:none">
        <div id="regenSectionBtns" style="display:none;margin-bottom:12px">
          <div class="sheet-subtitle" style="margin-bottom:8px">Quale sezione?</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="chip regen-sec-btn" data-sec="caption" onclick="KR.pickRegenSection(this,'caption')">✍️ Caption</button>
            <button class="chip regen-sec-btn" data-sec="storyboard" onclick="KR.pickRegenSection(this,'storyboard')">🎬 Storyboard</button>
            <button class="chip regen-sec-btn" data-sec="design" onclick="KR.pickRegenSection(this,'design')">🎨 Design</button>
            ${tipo === 'Reel' ? '<button class="chip regen-sec-btn" data-sec="suno" onclick="KR.pickRegenSection(this,\'suno\')">🎵 Audio</button>' : ''}
          </div>
        </div>
        <textarea class="sheet-textarea" id="regenPrompt" placeholder="Istruzioni per la Volpe (opzionale per rigenera tutto/sezione, obbligatorio per modifica con istruzioni)..." rows="4"></textarea>
        <button class="sheet-btn" id="regenSubmitBtn" onclick="KR.submitRegen('${clienteId}',${rowIndex})" style="background:linear-gradient(135deg,#7f5af0,#2cb67d);color:#fff;margin-top:8px;width:100%">🚀 Genera</button>
      </div>
    `;
    $('sheetOverlay').classList.add('open');
    haptic(12);
  }

  let _regenMode = 'full';
  let _regenSection = '';

  function selectRegen(mode) {
    _regenMode = mode;
    _regenSection = '';
    $('regenOptions').style.display = 'none';
    $('regenForm').style.display = 'block';
    if (mode === 'section') {
      $('regenSectionBtns').style.display = 'block';
    } else {
      $('regenSectionBtns').style.display = 'none';
    }
    if (mode === 'prompt') {
      $('regenPrompt').placeholder = 'Descrivi le modifiche che vuoi (obbligatorio)...';
      $('regenPrompt').focus();
    }
  }

  function pickRegenSection(btn, sec) {
    _regenSection = sec;
    document.querySelectorAll('.regen-sec-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  async function submitRegen(clienteId, rowIndex) {
    const prompt = $('regenPrompt').value.trim();
    if (_regenMode === 'prompt' && !prompt) {
      showToast('Scrivi le istruzioni per la Volpe');
      return;
    }
    if (_regenMode === 'section' && !_regenSection) {
      showToast('Seleziona una sezione');
      return;
    }

    $('regenSubmitBtn').disabled = true;
    $('regenSubmitBtn').textContent = '⏳ Generando...';

    try {
      let res;
      if (_regenMode === 'full') {
        res = await gas('rigeneraAssetApp', clienteId, rowIndex, prompt || '');
      } else if (_regenMode === 'section') {
        res = await gas('rigeneraSezioneApp', clienteId, rowIndex, _regenSection, prompt || '');
      } else if (_regenMode === 'prompt') {
        res = await gas('rigeneraAssetApp', clienteId, rowIndex, prompt);
      }

      if (res && res.ok) {
        showToast('Contenuto rigenerato!');
        closeSheet();
        // Riapri la preview aggiornata
        openSheet('previewAsset', { clienteId, rowIndex });
      } else {
        showToast('Errore: ' + (res ? res.errore : 'sconosciuto'));
      }
    } catch (e) {
      showToast('Errore di connessione');
    }

    const btn = $('regenSubmitBtn');
    if (btn) { btn.disabled = false; btn.textContent = '🚀 Genera'; }
  }

  async function generaLinkCliente(clienteId, rowIndex) {
    if (!isAdmin) { showToast('Solo Admin'); return; }
    showToast('⏳ Generazione link...');
    try {
      const res = await gas('generaLinkPreviewApp', clienteId, rowIndex);
      if (res && res.ok && res.url) {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(res.url);
          showToast('✅ Link copiato! Invialo al cliente');
        } else {
          prompt('Link per il cliente (copia manualmente):', res.url);
        }
      } else {
        showToast('❌ ' + (res ? res.errore : 'Errore'));
      }
    } catch (e) {
      showToast('❌ Errore: ' + e.message);
    }
  }

  function buildStatusActions(stato, clienteId, rowIndex) {
    const actions = [];
    switch (stato) {
      case 'Proposto':
        actions.push({ label: '✅ Approva', cls: 'approve', newStato: 'Approvato' });
        actions.push({ label: '🔄 Revisione', cls: 'revision', newStato: 'In Revisione' });
        actions.push({ label: '❌ Rifiuta', cls: 'reject', newStato: 'Rifiutato' });
        break;
      case 'In Revisione':
        actions.push({ label: '✅ Approva', cls: 'approve', newStato: 'Approvato' });
        actions.push({ label: '❌ Rifiuta', cls: 'reject', newStato: 'Rifiutato' });
        break;
      case 'Approvato':
        actions.push({ label: '🎬 Prodotto', cls: 'approve', newStato: 'Prodotto' });
        actions.push({ label: '🔄 Revisione', cls: 'revision', newStato: 'In Revisione' });
        break;
      case 'Prodotto':
        actions.push({ label: '🚀 Pubblica', cls: 'publish', newStato: 'Pubblicato' });
        break;
      case 'Rifiutato':
        actions.push({ label: '📋 Riproponi', cls: 'revision', newStato: 'Proposto' });
        break;
      case 'Bozza':
        actions.push({ label: '📋 Proponi', cls: 'approve', newStato: 'Proposto' });
        break;
      default:
        actions.push({ label: '📋 Proponi', cls: 'approve', newStato: 'Proposto' });
        break;
    }
    if (actions.length === 0) return '';
    return `<div class="status-actions">${actions.map(a =>
      `<button class="status-action-btn ${a.cls}" onclick="KR.changeAssetStatus('${clienteId}',${rowIndex},'${a.newStato}',this)">${a.label}</button>`
    ).join('')}</div>`;
  }

  async function changeAssetStatus(clienteId, rowIndex, newStato, btnEl) {
    const origText = btnEl.textContent;
    btnEl.textContent = '⏳';
    btnEl.disabled = true;
    try {
      const res = await gas('updateAssetManual', clienteId, rowIndex, 'stato', newStato);
      if (res && res.ok) {
        showToast(`Stato → ${newStato}`);
        haptic(15);
        // Ricarica la preview con il nuovo stato
        loadAssetPreview({ clienteId, rowIndex });
        // Ricarica anche la lista PED in background
        loadPED();
      } else {
        btnEl.textContent = origText;
        btnEl.disabled = false;
        showToast('Errore: ' + (res.errore || 'sconosciuto'));
      }
    } catch (e) {
      btnEl.textContent = origText;
      btnEl.disabled = false;
      showToast('Errore di connessione');
    }
  }

  // ── INLINE VOTE SECTION (dentro la preview asset) ──
  async function loadInlineVoteSection(clienteId) {
    const container = $('previewVoteSection');
    if (!container) return;
    container.innerHTML = '<div style="padding:10px 0"><div class="spinner"></div></div>';
    try {
      // Trova il PedID attivo per questo cliente
      const pedRes = await gas('getPedIdAttivo', clienteId);
      if (!pedRes || !pedRes.ok || !pedRes.pedId) {
        container.innerHTML = '';
        return;
      }
      if (pedRes.stato !== 'Proposto') {
        container.innerHTML = '';
        return;
      }
      const pedId = pedRes.pedId;
      // Carica voti
      const votiRes = await gas('getVotiPed', pedId);
      if (!votiRes || !votiRes.ok) { container.innerHTML = ''; return; }

      const { voti, approvals, rejections, soglia, totalTeam } = votiRes;
      const pctApprove = Math.round((approvals / soglia) * 100);
      const myVote = currentUser ? voti.find(v => v.username.toLowerCase() === currentUser.username.toLowerCase()) : null;
      const hasVoted = !!myVote;

      const voteChips = voti.length > 0
        ? `<div class="vote-list">${voti.map(v =>
            `<div class="vote-chip ${v.voto === 'approva' ? 'si' : 'no'}">${v.voto === 'approva' ? '✅' : '❌'} ${v.nome}</div>`
          ).join('')}</div>` : '';

      const buttons = hasVoted
        ? `<div style="padding:10px;background:rgba(52,211,153,0.06);border-radius:10px;text-align:center;font-size:13px;color:var(--accent);font-weight:600">
            Hai votato: ${myVote.voto === 'approva' ? '✅ Approvato' : '❌ Rifiutato'}
          </div>`
        : `<div class="vote-buttons">
            <button class="vote-btn approve" onclick="KR.submitVoto('${pedId}','approva',this)">✅ Approva</button>
            <button class="vote-btn reject" onclick="KR.submitVoto('${pedId}','rifiuta',this)">❌ Rifiuta</button>
          </div>`;

      container.innerHTML = `
        <div class="preview-section" style="background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.12);border-radius:14px;padding:16px;margin:12px 0">
          <div class="preview-section-label" style="margin-bottom:10px">🗳️ Votazione Team</div>
          <div class="vote-progress-wrap">
            <div class="vote-progress-label">
              <span class="vote-progress-title">Approvazioni</span>
              <span class="vote-progress-count">${approvals} / ${soglia}</span>
            </div>
            <div class="vote-progress-bar">
              <div class="vote-progress-fill green" style="width:${Math.min(100, pctApprove)}%"></div>
            </div>
          </div>
          <div class="vote-timer"><span class="vote-timer-icon">⏰</span> Servono ${soglia} su ${totalTeam} entro 24h</div>
          ${voteChips}
          ${buttons}
        </div>`;
    } catch (e) {
      container.innerHTML = '';
    }
  }

  // ── ASSET EDITOR (pannello modifica manuale) ──
  async function loadAssetEditor(data) {
    const sc = $('sheetContent');
    try {
      const res = await gas('getAssetDetail', data.clienteId, data.rowIndex);
      if (!res || !res.ok) {
        sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Asset non trovato</div>';
        return;
      }
      const a = res.asset;
      const ri = res.rowIndex;
      const cid = data.clienteId;

      const field = (id, label, val, rows) => {
        if (rows) return `<div class="edit-field"><label class="edit-label">${label}</label><textarea class="sheet-textarea edit-ta" id="${id}" style="height:${rows * 22}px">${val || ''}</textarea><button class="edit-save" onclick="KR.saveAssetField('${cid}',${ri},'${id}',this)">💾</button></div>`;
        return `<div class="edit-field"><label class="edit-label">${label}</label><input class="sheet-input edit-in" id="${id}" value="${(val || '').replace(/"/g, '&quot;')}"><button class="edit-save" onclick="KR.saveAssetField('${cid}',${ri},'${id}',this)">💾</button></div>`;
      };

      sc.innerHTML = `
        <div class="sheet-title">${a.titolo || 'Contenuto'}</div>
        <div class="sheet-subtitle">${a.tipo} · ${new Date(a.data).toLocaleDateString('it-IT')} · ${a.stato}</div>
        <div class="edit-section-label">📋 Generale</div>
        ${field('titolo', 'Titolo', a.titolo)}
        ${field('stato', 'Stato (Bozza / Prodotto / Pubblicato)', a.stato)}
        ${field('driveLink', '📁 Link Drive (incolla link file)', a.driveLink)}
        <div class="edit-section-label">✍️ Caption (3 versioni)</div>
        ${field('caption1', 'Caption 1 — Engaging', a.caption1, 4)}
        ${field('caption2', 'Caption 2 — Storytelling', a.caption2, 4)}
        ${field('caption3', 'Caption 3 — Educativa', a.caption3, 4)}
        <div class="edit-section-label">🎬 Produzione</div>
        ${field('storyboard', 'Storyboard', a.storyboard, 5)}
        ${field('shotlist', 'Shotlist', a.shotlist, 3)}
        ${field('motivazione', 'Motivazione', a.motivazione, 3)}
        <div class="edit-section-label">🎨 Design</div>
        ${field('design', 'Palette & Font (formato completo)', a.design, 6)}
        <div class="edit-section-label">🎵 Audio</div>
        ${field('suno1', 'Suno 1', a.suno1, 2)}
        ${field('suno2', 'Suno 2', a.suno2, 2)}
        <div style="padding:12px 0;font-size:11px;color:var(--text-t)">Ogni campo si salva singolarmente. Le automazioni non vengono interrotte.</div>
      `;
    } catch (e) {
      sc.innerHTML = '<div class="sheet-title">Errore</div><div class="sheet-subtitle">Impossibile caricare i dati</div>';
    }
  }

  async function saveAssetField(clienteId, rowIndex, campo, btnEl) {
    const el = $(campo);
    if (!el) return;
    const valore = el.value;
    btnEl.textContent = '⏳';
    try {
      const res = await gas('updateAssetManual', clienteId, rowIndex, campo, valore);
      if (res && res.ok) {
        btnEl.textContent = '✅';
        setTimeout(() => { btnEl.textContent = '💾'; }, 1500);
        showToast(`${campo} salvato`);
      } else {
        btnEl.textContent = '❌';
        showToast('Errore: ' + (res.errore || 'sconosciuto'));
        setTimeout(() => { btnEl.textContent = '💾'; }, 2000);
      }
    } catch (e) {
      btnEl.textContent = '❌';
      showToast('Errore di connessione');
      setTimeout(() => { btnEl.textContent = '💾'; }, 2000);
    }
  }

  // ── STATS ──
  async function loadStats() {
    try {
      const res = await gas('getStatisticheGlobali');
      if (res && res.ok !== false) {
        $('statsCost').textContent = '$' + (res.costoMese || '0.00');
        $('statsApproval').textContent = (res.tassoApprovazione || 0) + '%';
        renderBarChart(res.assetPerMese || {});
        renderDonut(res.tipi || {});
      }
    } catch (e) {
      console.warn('loadStats error:', e);
    }
    // Popola dropdown con clienti
    populateStatsDropdown();
  }

  function populateStatsDropdown() {
    const menu = $('statsDdMenu');
    const colors = ['var(--accent)', 'var(--a2)', 'var(--a3)', 'var(--a4)'];
    let html = '<div class="dd-option selected" onclick="KR.selectStatsClient(this,\'\')"><div class="dd-dot" style="background:var(--accent)"></div>Vista Globale</div>';
    allClienti.forEach((c, i) => {
      html += `<div class="dd-option" onclick="KR.selectStatsClient(this,'${c.id}')"><div class="dd-dot" style="background:${colors[(i + 1) % 4]}"></div>${c.nome}</div>`;
    });
    menu.innerHTML = html;
  }

  function toggleStatsDropdown() {
    $('statsDdMenu').classList.toggle('open');
    $('statsDdArrow').classList.toggle('open');
  }

  async function selectStatsClient(el, clienteId) {
    el.parentElement.querySelectorAll('.dd-option').forEach(o => o.classList.remove('selected'));
    el.classList.add('selected');
    $('statsDdLabel').textContent = el.textContent.trim();
    $('statsDdMenu').classList.remove('open');
    $('statsDdArrow').classList.remove('open');
    haptic();
    if (clienteId) {
      try {
        const res = await gas('getStatisticheCliente', clienteId);
        if (res && res.ok) {
          $('statsApproval').textContent = (res.tassoApprovazione || 0) + '%';
          renderDonut(res.tipi || {});
        }
      } catch (e) {}
    } else {
      loadStats();
    }
  }

  function renderBarChart(data) {
    const container = $('statsBarChart');
    const months = Object.keys(data);
    if (months.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:10px"><div class="empty-state-text">Dati non disponibili</div></div>';
      return;
    }
    const max = Math.max(...Object.values(data), 1);
    const gradients = [
      'linear-gradient(180deg,var(--accent),rgba(52,211,153,0.3))',
      'linear-gradient(180deg,var(--a2),rgba(167,139,250,0.3))',
      'linear-gradient(180deg,var(--a4),rgba(244,114,182,0.3))'
    ];
    container.innerHTML = months.map((m, i) => {
      const pct = Math.round((data[m] / max) * 100);
      const grad = gradients[i % 3];
      const glow = i === months.length - 1 ? ' glow' : '';
      return `<div class="chart-bar-wrapper"><div class="chart-bar${glow}" style="height:${pct}%;background:${grad}"></div><div class="chart-bar-label">${m}</div></div>`;
    }).join('');
  }

  function renderDonut(tipi) {
    const container = $('statsDonut');
    const entries = Object.entries(tipi);
    if (entries.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:10px"><div class="empty-state-text">Dati non disponibili</div></div>';
      return;
    }
    const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
    const colors = ['var(--accent)', 'var(--a2)', 'var(--a3)', 'var(--a4)'];
    let offset = 25;
    let circles = '';
    let legend = '';
    entries.forEach(([tipo, val], i) => {
      const pct = Math.round((val / total) * 100);
      const dash = pct;
      circles += `<circle cx="21" cy="21" r="15.9" fill="transparent" stroke="${colors[i % 4]}" stroke-width="4.5" stroke-dasharray="${dash} ${100 - dash}" stroke-dashoffset="${offset}" stroke-linecap="round"></circle>`;
      offset -= dash;
      legend += `<div class="legend-item"><div class="legend-dot" style="background:${colors[i % 4]}"></div>${tipo} — ${pct}%</div>`;
    });
    container.innerHTML = `<svg class="donut-svg" viewBox="0 0 42 42">${circles}</svg><div class="donut-legend">${legend}</div>`;
  }

  // ── TEAM ──
  async function loadTeam() {
    try {
      const list = await gas('getTeamMembers');
      renderTeam(list || []);
    } catch (e) {}
  }

  function renderTeam(members) {
    const container = $('teamList');
    if (!members || members.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-text">Nessun membro del team</div></div>';
      return;
    }
    const colors = [
      { bg: 'rgba(52,211,153,0.12)', color: 'var(--accent)' },
      { bg: 'rgba(167,139,250,0.12)', color: 'var(--a2)' },
      { bg: 'rgba(245,158,11,0.12)', color: 'var(--a3)' },
      { bg: 'rgba(244,114,182,0.12)', color: 'var(--a4)' }
    ];
    container.innerHTML = members.map((m, i) => {
      const col = colors[i % 4];
      return `<div class="team-card glass"><div class="team-avatar" style="background:${col.bg};color:${col.color}">${(m.nome || '?')[0]}</div><div class="team-info"><div class="team-name">${m.nome}</div><div class="team-role">${m.role}</div></div><div class="team-status offline">—</div></div>`;
    }).join('');
  }

  // ── WORKFLOW ──
  async function loadWorkflowJobs() {
    try {
      const jobs = await gas('getJobQueuePending');
      renderWorkflowJobs(jobs || []);
    } catch (e) {
      $('workflowJobList').innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚙️</div><div class="empty-state-text">Impossibile caricare la coda</div></div>';
    }
  }

  function renderWorkflowJobs(jobs) {
    const container = $('workflowJobList');
    if (!jobs || jobs.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-text">Nessun job in coda o fallito.<br>Tutto funziona correttamente!</div></div>';
      return;
    }
    container.innerHTML = jobs.map(j => {
      const isError = j.stato === 'Errore';
      const badgeStyle = isError ? 'background:rgba(239,68,68,0.12);color:var(--red)' : 'background:rgba(245,158,11,0.12);color:var(--a3)';
      const retryBtn = isError ? `<button style="background:linear-gradient(135deg,var(--accent),#2dd4bf);border:none;color:#000;padding:8px 16px;border-radius:10px;font-weight:700;font-size:12px;font-family:var(--font);cursor:pointer" onclick="KR.retryJob('${j.jobId}')">Riprova</button>` : '';
      return `<div class="asset-card glass"><div class="asset-type-badge" style="${badgeStyle}">${j.stato}</div><div class="asset-info"><div class="asset-title">${j.tipo || 'Job'} — ${j.clienteId || ''}</div><div class="asset-status">${timeAgo(j.timestamp)}</div></div>${retryBtn}</div>`;
    }).join('');
  }

  async function retryJob(jobId) {
    try {
      const res = await gas('retryJob', jobId);
      if (res && res.ok) {
        showToast('Job rimesso in coda');
        loadWorkflowJobs();
      } else {
        showToast('Errore: ' + ((res && res.errore) || 'sconosciuto'));
      }
    } catch (e) {
      showToast('Errore di connessione');
    }
  }

  // ── SUBMIT ACTIONS ──
  async function submitNewClient() {
    if (currentUser.role !== 'Admin') { showToast('Solo Admin può aggiungere clienti'); return; }
    const nome = $('ncNome').value.trim();
    const settore = $('ncSettore').value.trim();
    const sito = $('ncSito').value.trim();
    const brief = $('ncBrief').value.trim();
    const target = $('ncTarget').value.trim();
    const competitor = $('ncCompetitor').value.trim();
    const tono = $('ncTono').value.trim();
    if (!nome) { showToast('Inserisci il nome del brand'); return; }
    try {
      showToast('Registrazione in corso...');
      const res = await gas('aggiungiCliente', nome, settore, sito, brief, target, competitor, tono);
      if (res && res.ok) {
        closeSheet();
        const dnaMsg = res.dnaGenerato ? ' + DNA generato' : '';
        showToast(nome + ' registrato!' + dnaMsg);
        loadClienti();
      } else {
        showToast('Errore: ' + ((res && res.error) || 'sconosciuto'));
      }
    } catch (e) {
      showToast('Errore di connessione');
    }
  }

  async function submitChangePw() {
    const p1 = $('sheetNewPw1').value;
    const p2 = $('sheetNewPw2').value;
    const err = $('sheetPwError');
    if (p1.length < 6) { err.textContent = 'Minimo 6 caratteri'; return; }
    if (p1 !== p2) { err.textContent = 'Le password non coincidono'; return; }
    try {
      const hash = await sha256(p1);
      const res = await gas('authChangePassword', currentUser.username, hash);
      if (res && res.ok) {
        closeSheet();
        showToast('Password aggiornata!');
      } else {
        err.textContent = 'Errore nel salvataggio';
      }
    } catch (e) {
      err.textContent = 'Errore di connessione';
    }
  }

  async function submitResetPw(username, nome) {
    if (currentUser.role !== 'Admin') { showToast('Solo Admin può resettare password'); return; }
    try {
      const res = await gas('authResetPassword', sessionToken, username);
      if (res && res.ok) {
        closeSheet();
        showToast('Password di ' + nome + ' resettata');
      } else {
        showToast('Errore: ' + ((res && res.errore) || 'sconosciuto'));
      }
    } catch (e) {
      showToast('Errore di connessione');
    }
  }

  async function submitAddUser() {
    if (currentUser.role !== 'Admin') { showToast('Solo Admin può gestire utenti'); return; }
    const nome = $('auNome').value.trim();
    const username = $('auUsername').value.trim().toLowerCase();
    const ruolo = $('auRuolo').value.trim();
    if (!nome || !username || !ruolo) { showToast('Compila tutti i campi'); return; }
    try {
      const res = await gas('authAddUser', sessionToken, username, nome, ruolo);
      if (res && res.ok) {
        closeSheet();
        showToast(nome + ' aggiunto al team!');
        loadTeam();
      } else {
        showToast('Errore: ' + ((res && res.errore) || 'sconosciuto'));
      }
    } catch (e) {
      showToast('Errore di connessione');
    }
  }

  async function submitCaption() {
    const clienteId = $('wcClienteId').value.trim();
    const rowIndex = parseInt($('wcRowIndex').value.trim());
    const caption = $('wcCaption').value.trim();
    if (!clienteId || !rowIndex || !caption) { showToast('Compila tutti i campi'); return; }
    try {
      const res = await gas('updateAssetManual', clienteId, rowIndex, 'caption', caption);
      if (res && res.ok) {
        closeSheet();
        showToast('Caption salvata!');
      } else {
        showToast('Errore: ' + ((res && res.errore) || 'sconosciuto'));
      }
    } catch (e) {
      showToast('Errore di connessione');
    }
  }

  // ── SETTINGS ──
  function toggleSetting(el, key) {
    el.classList.toggle('on');
    settings[key] = el.classList.contains('on');
    localStorage.setItem('kr_' + key, settings[key] ? 'on' : 'off');
    haptic();
  }

  // ── BOTTOM SHEETS ──
  function openSheet(type, data) {
    const sc = $('sheetContent');
    let html = '';

    switch (type) {
      case 'notifiche':
        html = `<div class="notif-header-row">
          <div class="sheet-title" style="margin:0">Notifiche</div>
          <button class="notif-mark-all" onclick="KR.markAllNotifRead()">Segna tutte lette</button>
        </div>
        <div id="notifList"><div class="page-loading"><div class="spinner"></div></div></div>`;
        setTimeout(loadNotifiche, 100);
        break;

      case 'newClient':
        html = `<div class="sheet-title">Nuovo Cliente</div>
        <div class="sheet-subtitle">Registra un nuovo brand nel sistema</div>
        <input class="sheet-input" id="ncNome" placeholder="Nome brand *">
        <input class="sheet-input" id="ncSettore" placeholder="Settore (es. Food & Beverage, Fashion...)">
        <input class="sheet-input" id="ncSito" placeholder="Sito web (opzionale)">
        <textarea class="sheet-textarea" id="ncBrief" placeholder="Descrivi il cliente: chi \u00E8, cosa fa, cosa gli serve, i suoi punti di forza... Pi\u00F9 scrivi, meglio lavorano gli agenti." style="height:120px"></textarea>
        <input class="sheet-input" id="ncTarget" placeholder="Target (es. 25-40 anni, coppie, foodies)">
        <input class="sheet-input" id="ncCompetitor" placeholder="Competitor diretti (es. Zen Sushi, Sakura)">
        <input class="sheet-input" id="ncTono" placeholder="Tono (es. elegante, minimal, giocoso, urban)">
        <div style="font-size:11px;color:var(--text-t);margin:8px 0 12px">Il Brief \u00E8 il campo pi\u00F9 importante: guida tutti gli agenti. Gli altri campi sono opzionali ma migliorano i risultati.</div>
        <button class="sheet-btn" onclick="KR.submitNewClient()">Registra Cliente</button>`;
        break;

      case 'clientDetail':
        html = `<div class="sheet-title">Dettaglio Cliente</div>
        <div class="sheet-subtitle">Caricamento...</div>
        <div class="page-loading"><div class="spinner"></div></div>`;
        setTimeout(() => loadClientDetail(data), 100);
        break;

      case 'changePw':
        html = `<div class="sheet-title">Cambia Password</div>
        <div class="sheet-subtitle">Scegli una nuova password sicura</div>
        <input class="sheet-input" type="password" id="sheetNewPw1" placeholder="Nuova password (min. 6 caratteri)">
        <input class="sheet-input" type="password" id="sheetNewPw2" placeholder="Conferma password">
        <button class="sheet-btn" onclick="KR.submitChangePw()">Salva Password</button>
        <div class="login-error" id="sheetPwError" style="margin-top:8px"></div>`;
        break;

      case 'resetPw':
        html = `<div class="sheet-title">Resetta Password</div>
        <div class="sheet-subtitle">L'utente dovr\u00E0 sceglierne una nuova al prossimo login</div>
        <div id="resetPwList"><div class="page-loading"><div class="spinner"></div></div></div>`;
        setTimeout(loadResetPwList, 100);
        break;

      case 'addUser':
        html = `<div class="sheet-title">Nuovo Utente</div>
        <div class="sheet-subtitle">Verr\u00E0 creato con password iniziale krane2026</div>
        <input class="sheet-input" id="auNome" placeholder="Nome">
        <input class="sheet-input" id="auUsername" placeholder="Username">
        <input class="sheet-input" id="auRuolo" placeholder="Ruolo (es. Designer, Marketing)">
        <button class="sheet-btn" onclick="KR.submitAddUser()">Crea Utente</button>`;
        break;

      case 'writeCaption':
        html = `<div class="sheet-title">Scrivi Caption</div>
        <div class="sheet-subtitle">Sostituisci manualmente la Volpe Tibetana</div>
        <input class="sheet-input" id="wcClienteId" placeholder="ID Cliente">
        <input class="sheet-input" id="wcRowIndex" placeholder="Riga asset (numero)">
        <textarea class="sheet-textarea" id="wcCaption" placeholder="Scrivi la caption..." style="height:140px"></textarea>
        <button class="sheet-btn" onclick="KR.submitCaption()">Salva Caption</button>`;
        break;

      case 'insertTrend':
        html = `<div class="sheet-title">Inserisci Trend</div>
        <div class="sheet-subtitle">Sostituisci manualmente Pika</div>
        <input class="sheet-input" id="itClienteId" placeholder="ID Cliente">
        <textarea class="sheet-textarea" id="itTrend" placeholder="Descrivi il trend..." style="height:140px"></textarea>
        <button class="sheet-btn" onclick="KR.showToast('Trend salvato');KR.closeSheet()">Salva Trend</button>`;
        break;

      case 'votaPed':
        html = `<div class="sheet-title">\uD83D\uDDF3\uFE0F Vota PED</div>
        <div class="sheet-subtitle">Caricamento voti...</div>
        <div class="page-loading"><div class="spinner"></div></div>`;
        setTimeout(() => loadVotaPed(data), 100);
        break;

      case 'previewAsset':
        html = `<div class="sheet-title">Anteprima PED</div>
        <div class="sheet-subtitle">Caricamento...</div>
        <div class="page-loading"><div class="spinner"></div></div>`;
        setTimeout(() => loadAssetPreview(data), 100);
        break;

      case 'editAsset':
        html = `<div class="sheet-title">Modifica Contenuto</div>
        <div class="sheet-subtitle">Caricamento...</div>
        <div class="page-loading"><div class="spinner"></div></div>`;
        setTimeout(() => loadAssetEditor(data), 100);
        break;

      case 'selectClientePED':
        html = `<div class="sheet-title">\uD83D\uDCCB Genera PED</div>
        <div class="sheet-subtitle">Seleziona il cliente per cui generare il piano editoriale</div>
        <div id="pedClientList"><div class="page-loading"><div class="spinner"></div></div></div>`;
        setTimeout(loadPEDClientList, 100);
        break;

      case 'regen':
        // Contenuto gi\u00E0 impostato da openRegenSheet — apri solo l'overlay
        $('sheetOverlay').classList.add('open');
        haptic(12);
        return;
    }

    sc.innerHTML = html;
    $('sheetOverlay').classList.add('open');
    haptic(12);
  }

  function closeSheet() {
    $('sheetOverlay').classList.remove('open');
  }

  // ── INIT ──
  function init() {
    initParticles();
    initAuth();
    // Restore settings toggles
    if (!settings.sound) { const t = $('toggleSound'); if (t) t.classList.remove('on'); }
    if (!settings.vibrate) { const t = $('toggleVibrate'); if (t) t.classList.remove('on'); }
  }

  // Avvia
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ── Public API ──
  return {
    nav, switchSub, showToast, doLogin, doChangePassword, doLogout,
    filterClienti, filterClientiByStatus, openClientDetail,
    togglePEDDropdown, selectPEDClient, pedChangeMonth, loadPED,
    toggleStatsDropdown, selectStatsClient,
    openSheet, closeSheet,
    submitNewClient, submitChangePw, submitResetPw, submitAddUser, submitCaption,
    saveAssetField, changeAssetStatus, retryJob, loadMoreFeed, toggleSetting,
    markNotifRead, markAllNotifRead, openNotifPed, submitVoto,
    openRegenSheet, selectRegen, pickRegenSection, submitRegen,
    generaLinkCliente, loadProduzione, avviaPED,
    acceptNotif, dismissNotif
  };

})();
