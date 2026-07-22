/* =============================================================================
 * Multiplayer draw.io Whiteboard — client
 *
 * Two integrations power this page:
 *   1. draw.io embed protocol (postMessage) — we host the editor in an <iframe>
 *      pointing at embed.diagrams.net and talk to it over JSON messages.
 *   2. A WebSocket to our own server that fans diagram changes, presence, chat
 *      and pointer positions out to everyone in the same room.
 *
 * Sync strategy: when the local user edits, draw.io fires an "autosave" event
 * with the full XML. We send it to the server, which relays it to peers. When a
 * peer's XML arrives we push it back into draw.io with a "load" action, guarding
 * against feedback loops with a short suppression window.
 * ========================================================================== */

(() => {
  'use strict';

  const DRAWIO_ORIGIN = 'https://embed.diagrams.net';
  // ui=min keeps a clean toolbar; proto=json enables the message protocol.
  const DRAWIO_URL =
    DRAWIO_ORIGIN +
    '/?embed=1&proto=json&spin=1&libraries=1&ui=min&noExitBtn=1&noSaveBtn=1&saveAndExit=0&modified=unsavedChanges';

  const EMPTY_DIAGRAM =
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" ' +
    'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ' +
    'pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

  // ---- DOM refs -----------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const joinOverlay = el('join-overlay');
  const app = el('app');
  const nameInput = el('name-input');
  const roomInput = el('room-input');
  const joinBtn = el('join-btn');
  const editor = el('editor');
  const roomLabel = el('room-label');
  const statusEl = el('status');
  const avatarsEl = el('avatars');
  const peopleList = el('people-list');
  const peopleCount = el('people-count');
  const panelCount = el('panel-count');
  const sidePanel = el('side-panel');
  const cursorLayer = el('cursor-layer');
  const chatLog = el('chat-log');
  const chatForm = el('chat-form');
  const chatInput = el('chat-input');
  const toast = el('toast');

  // ---- State --------------------------------------------------------------
  let ws = null;
  let myId = null;
  let myName = '';
  let myColor = '#5b8cff';
  let roomId = '';
  let editorReady = false;
  let pendingXml = null; // remote XML that arrived before the editor was ready
  let currentXml = EMPTY_DIAGRAM;

  // Feedback-loop guard: while we are applying a remote change, ignore the
  // autosave the "load" action triggers.
  let suppressAutosaveUntil = 0;
  const remoteCursors = new Map(); // id -> element

  // ---- Helpers ------------------------------------------------------------
  function showToast(text, ms = 2200) {
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function setStatus(state, text) {
    statusEl.className = 'status ' + state;
    statusEl.textContent = text;
  }

  // ---- draw.io embed protocol --------------------------------------------
  function postToEditor(payload) {
    editor.contentWindow.postMessage(JSON.stringify(payload), DRAWIO_ORIGIN);
  }

  function loadIntoEditor(xml) {
    // Guard against the echo autosave that "load" produces.
    suppressAutosaveUntil = Date.now() + 800;
    postToEditor({ action: 'load', autosave: 1, xml: xml || EMPTY_DIAGRAM });
  }

  window.addEventListener('message', (evt) => {
    if (evt.origin !== DRAWIO_ORIGIN) return;
    if (typeof evt.data !== 'string' || evt.data.length === 0) return;

    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }

    switch (msg.event) {
      case 'init': {
        editorReady = true;
        // Load whatever we have (either remote state received during join, or
        // an empty diagram) and turn on autosave.
        loadIntoEditor(pendingXml != null ? pendingXml : currentXml);
        pendingXml = null;
        break;
      }
      case 'autosave':
      case 'save': {
        if (Date.now() < suppressAutosaveUntil) return; // ignore our own load echo
        if (typeof msg.xml === 'string') {
          currentXml = msg.xml;
          sendWs({ type: 'diagram', xml: msg.xml });
        }
        break;
      }
      default:
        break;
    }
  });

  // ---- WebSocket ----------------------------------------------------------
  function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.addEventListener('open', () => {
      setStatus('online', 'connected');
      sendWs({ type: 'join', room: roomId, name: myName });
    });

    ws.addEventListener('close', () => {
      setStatus('offline', 'reconnecting…');
      setTimeout(connect, 1500); // simple auto-reconnect
    });

    ws.addEventListener('error', () => setStatus('offline', 'connection error'));

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    });
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        myId = msg.id;
        myColor = msg.color || myColor;
        if (msg.xml) {
          currentXml = msg.xml;
          if (editorReady) loadIntoEditor(msg.xml);
          else pendingXml = msg.xml;
        }
        renderPeople(msg.users || []);
        break;
      }
      case 'presence': {
        renderPeople(msg.users || []);
        break;
      }
      case 'diagram': {
        if (typeof msg.xml === 'string') {
          currentXml = msg.xml;
          if (editorReady) loadIntoEditor(msg.xml);
          else pendingXml = msg.xml;
        }
        break;
      }
      case 'cursor': {
        renderRemoteCursor(msg);
        break;
      }
      case 'left': {
        removeRemoteCursor(msg.id);
        break;
      }
      case 'chat': {
        addChatMessage(msg);
        break;
      }
      case 'system': {
        addSystemMessage(msg.text);
        break;
      }
      default:
        break;
    }
  }

  // ---- Presence rendering -------------------------------------------------
  function renderPeople(users) {
    peopleList.innerHTML = '';
    avatarsEl.innerHTML = '';
    peopleCount.textContent = users.length;
    panelCount.textContent = users.length;

    users.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'person';
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = u.color;
      const name = document.createElement('span');
      name.textContent = u.name;
      li.append(dot, name);
      if (u.id === myId) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = '(you)';
        li.append(you);
      }
      peopleList.append(li);
    });

    // Avatar stack (cap at 5 + overflow badge)
    users.slice(0, 5).forEach((u) => {
      const a = document.createElement('div');
      a.className = 'avatar';
      a.style.background = u.color;
      a.textContent = initials(u.name);
      a.title = u.name;
      avatarsEl.append(a);
    });
    if (users.length > 5) {
      const more = document.createElement('div');
      more.className = 'avatar';
      more.style.background = '#3a4459';
      more.style.color = '#fff';
      more.textContent = '+' + (users.length - 5);
      avatarsEl.append(more);
    }
  }

  // ---- Remote cursors -----------------------------------------------------
  const CURSOR_SVG =
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none">' +
    '<path d="M2 2 L2 16 L6 12 L9 18 L11 17 L8 11 L14 11 Z" fill="COLOR" ' +
    'stroke="#fff" stroke-width="1" stroke-linejoin="round"/></svg>';

  function renderRemoteCursor(msg) {
    let node = remoteCursors.get(msg.id);
    if (!node) {
      node = document.createElement('div');
      node.className = 'remote-cursor';
      node.innerHTML =
        CURSOR_SVG.replace('COLOR', msg.color) +
        `<span class="tag" style="background:${msg.color}">${escapeHtml(
          msg.name,
        )}</span>`;
      cursorLayer.append(node);
      remoteCursors.set(msg.id, node);
    }
    const rect = cursorLayer.getBoundingClientRect();
    node.style.left = msg.x * rect.width + 'px';
    node.style.top = msg.y * rect.height + 'px';
    // Auto-expire stale cursors.
    clearTimeout(node._t);
    node._t = setTimeout(() => removeRemoteCursor(msg.id), 5000);
  }

  function removeRemoteCursor(id) {
    const node = remoteCursors.get(id);
    if (node) {
      node.remove();
      remoteCursors.delete(id);
    }
  }

  // Broadcast our own pointer position (fractional) when it moves over the
  // editor area. Note: we cannot read pointer events *inside* the cross-origin
  // draw.io iframe, so this tracks movement across the whole editor wrapper —
  // giving a lightweight sense of presence.
  let lastCursorSend = 0;
  document.querySelector('.editor-wrap').addEventListener(
    'pointermove',
    (e) => {
      const now = Date.now();
      if (now - lastCursorSend < 50) return; // throttle ~20/s
      lastCursorSend = now;
      const rect = cursorLayer.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      sendWs({ type: 'cursor', x, y });
    },
    { passive: true },
  );

  // ---- Chat ---------------------------------------------------------------
  function addChatMessage(msg) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML =
      `<span class="who" style="color:${msg.color}">${escapeHtml(
        msg.name,
      )}</span>` + escapeHtml(msg.text);
    chatLog.append(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    chatLog.append(div);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    sendWs({ type: 'chat', text });
    chatInput.value = '';
  });

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- Top bar actions ----------------------------------------------------
  el('share-btn').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast('Board link copied to clipboard');
    } catch {
      showToast(url.toString());
    }
  });

  el('panel-toggle').addEventListener('click', () => {
    sidePanel.classList.toggle('collapsed');
  });

  // ---- Join flow ----------------------------------------------------------
  function randomRoom() {
    const words = ['blue', 'nova', 'echo', 'jade', 'flux', 'orbit', 'sage', 'zen'];
    const w = words[Math.floor(Math.random() * words.length)];
    return `${w}-${Math.floor(1000 + Math.random() * 9000)}`;
  }

  function prefill() {
    const params = new URLSearchParams(location.search);
    roomInput.value = params.get('room') || randomRoom();
    const savedName = localStorage.getItem('wb-name');
    if (savedName) nameInput.value = savedName;
  }

  function startSession() {
    myName = (nameInput.value || 'Guest').trim().slice(0, 40) || 'Guest';
    roomId = (roomInput.value || randomRoom()).trim().slice(0, 80) || randomRoom();
    localStorage.setItem('wb-name', myName);

    // Reflect the room in the URL so refresh/share keeps you in place.
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    history.replaceState(null, '', url.toString());

    roomLabel.textContent = roomId;
    joinOverlay.classList.add('hidden');
    app.classList.remove('hidden');

    setStatus('connecting', 'connecting…');
    editor.src = DRAWIO_URL;
    connect();
  }

  joinBtn.addEventListener('click', startSession);
  [nameInput, roomInput].forEach((input) =>
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startSession();
    }),
  );

  prefill();
  nameInput.focus();
})();
