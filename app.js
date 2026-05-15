/* ============================================================
   hayaosi - 早押しボタン
   方式: PeerJS (WebRTC データチャネル) によるP2P通信
   - ホスト(出題者)の端末がサーバー役
   - 全クライアントがホストに直接接続
   - ホスト側の受信時刻で順位を確定（公平な単一基準）
   ============================================================ */

(() => {
  'use strict';

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const entryScreen   = $('entry-screen');
  const playerScreen  = $('player-screen');
  const hostScreen    = $('host-screen');

  const nameInput     = $('name-input');
  const roomInput     = $('room-input');
  const hostBtn       = $('host-btn');
  const joinBtn       = $('join-btn');
  const entryStatus   = $('entry-status');

  const buzzBtn       = $('buzz-btn');
  const myNameDisplay = $('my-name-display');
  const playerRoomName= $('player-room-name');
  const playerConnDot = $('player-conn-dot');
  const playerConnTxt = $('player-conn-text');
  const resultBanner  = $('player-result-banner');
  const resultName    = $('player-result-name');
  const resultSub     = $('player-result-sub');

  const hostRoomName  = $('host-room-name');
  const hostPlayerCount = $('host-player-count');
  const resetBtn      = $('reset-btn');
  const rankingList   = $('ranking-list');
  const playersList   = $('players-list');

  const buzzerAudio   = $('buzzer-audio');

  // ---- 状態 ----
  let myName = '';
  let roomCode = '';
  let role = null;           // 'host' or 'player'
  let peer = null;           // PeerJS Peer
  let myPeerId = null;

  // ホスト側
  /** @type {Map<string, {conn:any, name:string, connected:boolean}>} */
  const connections = new Map();
  /** @type {Array<{id:string, name:string, time:number}>} */
  let ranking = [];
  let hostStartTime = 0;

  // プレイヤー側
  let hostConn = null;
  let hasBuzzed = false;
  let locked = false;

  // ---- ユーティリティ ----

  // 合言葉から PeerJS ID を生成
  function roomToPeerId(code) {
    // PeerJSのID制限: 英数字とハイフン/アンダースコア、特殊文字NG
    // 日本語などを含めるためハッシュ化
    let hash = 5381;
    const s = code.trim().toLowerCase();
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) + hash) + s.charCodeAt(i);
      hash |= 0;
    }
    return 'hayaosi-room-' + Math.abs(hash).toString(36);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    })[c]);
  }

  function showScreen(name) {
    entryScreen.classList.add('hidden');
    playerScreen.classList.add('hidden');
    hostScreen.classList.add('hidden');
    if (name === 'entry')  entryScreen.classList.remove('hidden');
    if (name === 'player') playerScreen.classList.remove('hidden');
    if (name === 'host')   hostScreen.classList.remove('hidden');
  }

  function setStatus(msg, isError = false) {
    entryStatus.textContent = msg;
    entryStatus.style.color = isError ? '#d62828' : '#2ecc71';
  }

  function setPlayerConn(state, text) {
    playerConnDot.className = 'dot ' + (state || '');
    playerConnTxt.textContent = text;
  }

  // ---- 音 (低遅延化) ----
  // WebAudioで事前デコードして即時再生
  let audioCtx = null;
  let buzzerBuffer = null;

  async function initAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (!buzzerBuffer) {
        const res = await fetch('sounds/buzzer.mp3');
        const arr = await res.arrayBuffer();
        buzzerBuffer = await audioCtx.decodeAudioData(arr);
      }
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
    } catch (e) {
      console.warn('Audio init failed, fallback to <audio>', e);
    }
  }

  function playBuzzer() {
    // WebAudio優先
    if (audioCtx && buzzerBuffer) {
      try {
        const src = audioCtx.createBufferSource();
        src.buffer = buzzerBuffer;
        src.connect(audioCtx.destination);
        src.start(0);
        return;
      } catch (e) { /* fallback */ }
    }
    // フォールバック: <audio>
    try {
      buzzerAudio.currentTime = 0;
      const p = buzzerAudio.play();
      if (p && p.catch) p.catch(()=>{});
    } catch (e) {}
  }

  // ============================================================
  // 入室処理
  // ============================================================

  function validateInputs() {
    const name = nameInput.value.trim();
    const room = roomInput.value.trim();
    if (!name) { setStatus('名前を入力してください', true); return null; }
    if (!room) { setStatus('合言葉を入力してください', true); return null; }
    return { name, room };
  }

  hostBtn.addEventListener('click', async () => {
    const v = validateInputs();
    if (!v) return;
    myName = v.name;
    roomCode = v.room;
    role = 'host';
    setStatus('部屋を作成中…');
    hostBtn.disabled = true;
    joinBtn.disabled = true;
    await initAudio();
    startHost();
  });

  joinBtn.addEventListener('click', async () => {
    const v = validateInputs();
    if (!v) return;
    myName = v.name;
    roomCode = v.room;
    role = 'player';
    setStatus('部屋に接続中…');
    hostBtn.disabled = true;
    joinBtn.disabled = true;
    await initAudio();
    startPlayer();
  });

  // 入力時にステータスをクリア
  [nameInput, roomInput].forEach(el => {
    el.addEventListener('input', () => {
      if (entryStatus.textContent) setStatus('');
    });
  });

  // ============================================================
  // ホスト処理
  // ============================================================

  function startHost() {
    const peerId = roomToPeerId(roomCode);

    peer = new Peer(peerId, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    peer.on('open', (id) => {
      myPeerId = id;
      console.log('[Host] open as', id);
      hostRoomName.textContent = roomCode;
      showScreen('host');
      updateHostUI();
    });

    peer.on('connection', (conn) => {
      console.log('[Host] incoming connection', conn.peer);
      conn.on('open', () => {
        const entry = { conn, name: '(接続中)', connected: true };
        connections.set(conn.peer, entry);
        // 現在の状態を新規参加者に送る
        sendTo(conn, { type: 'state', ranking, locked: false });
        updateHostUI();
      });

      conn.on('data', (data) => handleHostMessage(conn, data));

      conn.on('close', () => {
        console.log('[Host] connection closed', conn.peer);
        const e = connections.get(conn.peer);
        if (e) e.connected = false;
        updateHostUI();
      });

      conn.on('error', (err) => {
        console.warn('[Host] connection error', err);
      });
    });

    peer.on('error', (err) => {
      console.error('[Host] peer error', err);
      if (err.type === 'unavailable-id') {
        // 既に同じIDの部屋がある → サブIDで再試行 or 警告
        setStatus('同じ合言葉の部屋が既に存在します。別の合言葉にしてください。', true);
        hostBtn.disabled = false;
        joinBtn.disabled = false;
        try { peer.destroy(); } catch(e) {}
        showScreen('entry');
      } else if (err.type === 'network' || err.type === 'disconnected') {
        setStatus('ネットワークエラー。再度お試しください。', true);
      } else {
        setStatus('エラー: ' + err.type, true);
      }
    });
  }

  function handleHostMessage(conn, data) {
    if (!data || typeof data !== 'object') return;
    const entry = connections.get(conn.peer);
    if (!entry) return;

    if (data.type === 'hello') {
      entry.name = String(data.name || '名無し').slice(0, 12);
      updateHostUI();
      // 改めて最新状態を送る
      sendTo(conn, { type: 'state', ranking, locked: false });
      return;
    }

    if (data.type === 'buzz') {
      // ホスト側の受信時刻が唯一の真実
      const now = performance.now();
      // 既に同じプレイヤーがランキングにいたら無視
      if (ranking.some(r => r.id === conn.peer)) return;

      // ホスト側で時刻の起点を保持（最初の押下を 0ms とする）
      if (ranking.length === 0) {
        hostStartTime = now;
      }
      const relTime = Math.max(0, Math.round(now - hostStartTime));

      ranking.push({
        id: conn.peer,
        name: entry.name,
        time: relTime
      });

      // 全員へブロードキャスト（最新ランキング & ロック状態）
      broadcastState();
      updateHostUI();
    }
  }

  function broadcastState() {
    const payload = {
      type: 'state',
      ranking: ranking.map(r => ({ name: r.name, time: r.time })),
      locked: false,
      firstId: ranking[0] ? ranking[0].id : null
    };
    connections.forEach((e) => {
      if (!e.connected) return;
      const myIndex = ranking.findIndex((r) => r.id === e.conn.peer);
      const firstTime = ranking[0] ? ranking[0].time : 0;
      const myTime = myIndex >= 0 ? ranking[myIndex].time : null;
      // 各接続には自分が1位か判別できるよう、自分のIDも含める
      sendTo(e.conn, {
        ...payload,
        you: {
          hasBuzzed: myIndex >= 0,
          isFirst: !!(ranking[0] && ranking[0].id === e.conn.peer),
          rank: myIndex >= 0 ? myIndex + 1 : null,
          diffMs: myTime === null ? null : Math.max(0, myTime - firstTime)
        }
      });
    });
  }

  function sendTo(conn, obj) {
    try {
      conn.send(obj);
    } catch (e) {
      console.warn('send failed', e);
    }
  }

  function updateHostUI() {
    // 参加者一覧
    const players = Array.from(connections.values());
    const activeCount = players.filter(p => p.connected).length;
    hostPlayerCount.textContent = activeCount;

    playersList.innerHTML = '';
    players.forEach(p => {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (!p.connected) li.classList.add('disconnected');
      playersList.appendChild(li);
    });

    // ランキング
    rankingList.innerHTML = '';
    if (ranking.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'まだ誰も押していません';
      rankingList.appendChild(li);
    } else {
      ranking.forEach((r, i) => {
        const li = document.createElement('li');
        if (i === 0) li.classList.add('first');
        const timeStr = i === 0 ? '基準' : `+${(r.time / 1000).toFixed(3)}秒`;
        li.innerHTML = `
          <span class="rank-num">${i+1}</span>
          <span class="rank-name">${escapeHtml(r.name)}</span>
          <span class="rank-time">${timeStr}</span>
        `;
        rankingList.appendChild(li);
      });
    }
  }

  resetBtn.addEventListener('click', () => {
    ranking = [];
    hostStartTime = 0;
    broadcastState();
    updateHostUI();
  });

  // ============================================================
  // プレイヤー処理
  // ============================================================

  function startPlayer() {
    const hostPeerId = roomToPeerId(roomCode);

    peer = new Peer(undefined, {
      debug: 1,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    peer.on('open', (id) => {
      myPeerId = id;
      console.log('[Player] open as', id);

      // ホストへ接続
      hostConn = peer.connect(hostPeerId, {
        reliable: true,    // 信頼性（順序保証）優先
        serialization: 'json'
      });

      hostConn.on('open', () => {
        console.log('[Player] connected to host');
        setPlayerConn('connected', '接続済み');
        playerRoomName.textContent = roomCode;
        myNameDisplay.textContent = myName;
        showScreen('player');
        // 名前を送る
        sendTo(hostConn, { type: 'hello', name: myName });
      });

      hostConn.on('data', (data) => handlePlayerMessage(data));

      hostConn.on('close', () => {
        console.warn('[Player] disconnected from host');
        setPlayerConn('error', 'ホストとの接続が切れました');
        locked = true;
        buzzBtn.classList.add('locked');
      });

      hostConn.on('error', (err) => {
        console.warn('[Player] connection error', err);
        setPlayerConn('error', '接続エラー');
      });
    });

    peer.on('error', (err) => {
      console.error('[Player] peer error', err);
      if (err.type === 'peer-unavailable') {
        setStatus('その合言葉の部屋は見つかりません。出題者が「部屋をつくる」を押したか確認してください。', true);
      } else if (err.type === 'network' || err.type === 'disconnected') {
        setStatus('ネットワークエラー。再度お試しください。', true);
      } else {
        setStatus('エラー: ' + err.type, true);
      }
      hostBtn.disabled = false;
      joinBtn.disabled = false;
      showScreen('entry');
    });
  }

  function handlePlayerMessage(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'state') {
      // ランキング更新
      const r = data.ranking || [];

      if (r.length === 0) {
        // リセット
        hasBuzzed = false;
        locked = false;
        buzzBtn.classList.remove('locked');
        buzzBtn.classList.remove('pressed');
        resultBanner.classList.remove('win', 'lose');
        resultName.textContent = '―';
        resultSub.textContent = '最初に押した人';
      } else {
        const first = r[0];
        resultName.textContent = first.name;
        if (data.you && data.you.hasBuzzed) {
          buzzBtn.classList.add('locked');
          if (data.you.isFirst) {
            resultBanner.classList.remove('lose');
            resultBanner.classList.add('win');
            resultSub.textContent = 'あなたが1位でした！';
          } else {
            resultBanner.classList.remove('win');
            resultBanner.classList.add('lose');
            const rank = data.you.rank ?? '―';
            const diffSec = typeof data.you.diffMs === 'number'
              ? (data.you.diffMs / 1000).toFixed(3)
              : '0.000';
            resultSub.textContent = `あなたは${rank}位（1位と+${diffSec}秒）`;
          }
        } else {
          resultBanner.classList.remove('win');
          resultBanner.classList.add('lose');
          resultSub.textContent = '最初に押した人';
        }
      }
    }
  }

  // ============================================================
  // 早押しボタン操作
  // ============================================================

  function onBuzz(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    if (role !== 'player') return;
    if (hasBuzzed || locked) return;
    if (!hostConn || !hostConn.open) return;

    hasBuzzed = true;

    // 1. UI即時反映
    buzzBtn.classList.add('pressed');
    // 2. 音再生
    playBuzzer();
    // 3. ホストへ送信（できるだけ早く）
    sendTo(hostConn, { type: 'buzz', t: performance.now() });

    // しばらく押下演出を残す
    setTimeout(() => {
      // 結果がまだ来ていなくても見た目をロックに
      if (!buzzBtn.classList.contains('locked')) {
        // pressedのまま保持
      }
    }, 100);
  }

  // pointerdown が最も低遅延（マウス/タッチ/ペン全対応）
  // touchstart も併用してiOS Safariで確実に動くように
  buzzBtn.addEventListener('pointerdown', onBuzz, { passive: false });
  buzzBtn.addEventListener('touchstart', onBuzz, { passive: false });

  // 連打防止のため click は無視
  buzzBtn.addEventListener('click', (e) => e.preventDefault());

  // ============================================================
  // 初期化
  // ============================================================

  showScreen('entry');

  // ページ離脱時に接続を綺麗に閉じる
  window.addEventListener('beforeunload', () => {
    try { if (peer) peer.destroy(); } catch(e){}
  });

  // 既に名前と部屋が入力されてEnterで送れるように
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
  });
})();
