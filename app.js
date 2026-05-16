/* ============================================================
   hayaosi - 対面クイズ大会用 早押し&選択回答システム
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

  // プレイヤー側
  const buzzBtn       = $('buzz-btn');
  const buzzHint      = $('buzz-hint');
  const myNameDisplay = $('my-name-display');
  const playerRoomName= $('player-room-name');
  const playerConnDot = $('player-conn-dot');
  const playerConnTxt = $('player-conn-text');
  const playerScore   = $('player-score');
  const resultBanner  = $('player-result-banner');
  const resultName    = $('player-result-name');
  const resultSub     = $('player-result-sub');
  const playerBuzzStage   = $('player-buzz-stage');
  const playerChoiceStage = $('player-choice-stage');
  const choiceStatus  = $('choice-status');
  const choiceBtns    = document.querySelectorAll('.choice-btn');

  // ホスト側
  const hostRoomName  = $('host-room-name');
  const hostPlayerCount = $('host-player-count');
  const rankingList   = $('ranking-list');
  const playersList   = $('players-list');
  const nextBtn       = $('next-btn');
  const nextBtnChoice = $('next-btn-choice');
  const modeBtns      = document.querySelectorAll('.mode-btn');
  const hostBuzzSection   = $('host-buzz-section');
  const hostChoiceSection = $('host-choice-section');

  const judgeBlock    = $('judge-block');
  const judgeTargetName = $('judge-target-name');
  const judgeCorrect  = $('judge-correct');
  const judgeWrong    = $('judge-wrong');

  const answersList   = $('answers-list');
  const revealBtns    = document.querySelectorAll('.reveal-btn');
  const revealStatus  = $('reveal-status');
  const resetScoresBtn = $('reset-scores-btn');

  // 音声
  const buzzerAudio   = $('buzzer-audio');
  const correctAudio  = $('correct-audio');
  const wrongAudio    = $('wrong-audio');

  // ---- 状態 ----
  let myName = '';
  let roomCode = '';
  let role = null;           // 'host' or 'player'
  let peer = null;
  let myPeerId = null;

  // ホスト側状態
  /** @type {Map<string, {conn:any, name:string, connected:boolean, score:number}>} */
  const connections = new Map();
  /** @type {Array<{id:string, name:string, time:number, judged:'correct'|'wrong'|null}>} */
  let ranking = [];
  let hostStartTime = 0;
  let currentMode = 'buzz';  // 'buzz' or 'choice'
  /** @type {Map<string, number>} 4択モード: peerId -> 1-4 */
  const choices = new Map();
  let revealedAnswer = null; // 4択モードの正解番号

  // プレイヤー側状態
  let hostConn = null;
  let hasBuzzed = false;       // 早押しモード: 自分が押したか
  let buzzLocked = false;      // 早押しモード: 自分以外が押したか(または不正解判定で押せなくなった)
  let myChoice = null;         // 4択モード: 自分の選択
  let myScore = 0;

  // ---- ユーティリティ ----

  function roomToPeerId(code) {
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

  // ---- 音声 (WebAudio 低遅延化) ----
  let audioCtx = null;
  const buffers = { buzzer: null, correct: null, wrong: null };

  async function loadBuffer(name, url) {
    if (buffers[name]) return;
    try {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      buffers[name] = await audioCtx.decodeAudioData(arr);
    } catch (e) {
      console.warn('audio load failed', name, e);
    }
  }

  async function initAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await Promise.all([
        loadBuffer('buzzer',  'sounds/buzzer.mp3'),
        loadBuffer('correct', 'sounds/correct.mp3'),
        loadBuffer('wrong',   'sounds/wrong.mp3'),
      ]);
    } catch (e) {
      console.warn('Audio init failed', e);
    }
  }

  function playSound(name) {
    if (audioCtx && buffers[name]) {
      try {
        const src = audioCtx.createBufferSource();
        src.buffer = buffers[name];
        src.connect(audioCtx.destination);
        src.start(0);
        return;
      } catch (e) {}
    }
    // フォールバック
    const el = name === 'buzzer' ? buzzerAudio :
               name === 'correct' ? correctAudio : wrongAudio;
    try {
      el.currentTime = 0;
      const p = el.play();
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
    myName = v.name; roomCode = v.room; role = 'host';
    setStatus('部屋を作成中…');
    hostBtn.disabled = true; joinBtn.disabled = true;
    await initAudio();
    startHost();
  });

  joinBtn.addEventListener('click', async () => {
    const v = validateInputs();
    if (!v) return;
    myName = v.name; roomCode = v.room; role = 'player';
    setStatus('部屋に接続中…');
    hostBtn.disabled = true; joinBtn.disabled = true;
    await initAudio();
    startPlayer();
  });

  [nameInput, roomInput].forEach(el => {
    el.addEventListener('input', () => {
      if (entryStatus.textContent) setStatus('');
    });
  });
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinBtn.click();
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
      hostRoomName.textContent = roomCode;
      showScreen('host');
      updateHostUI();
    });

    peer.on('connection', (conn) => {
      conn.on('open', () => {
        const entry = { conn, name: '(接続中)', connected: true, score: 0 };
        connections.set(conn.peer, entry);
        sendTo(conn, makeStatePayload(conn.peer));
        updateHostUI();
      });

      conn.on('data', (data) => handleHostMessage(conn, data));

      conn.on('close', () => {
        const e = connections.get(conn.peer);
        if (e) e.connected = false;
        updateHostUI();
      });

      conn.on('error', (err) => console.warn('[Host] conn error', err));
    });

    peer.on('error', (err) => {
      console.error('[Host] peer error', err);
      if (err.type === 'unavailable-id') {
        setStatus('同じ合言葉の部屋が既に存在します。別の合言葉にしてください。', true);
        hostBtn.disabled = false; joinBtn.disabled = false;
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
      sendTo(conn, makeStatePayload(conn.peer));
      return;
    }

    // ===== 早押し =====
    if (data.type === 'buzz') {
      if (currentMode !== 'buzz') return;
      const now = performance.now();
      // 既にこの人がランキングにいる場合は無視
      if (ranking.some(r => r.id === conn.peer)) return;
      // 既に正解者が出ている場合は受け付けない
      if (ranking.some(r => r.judged === 'correct')) return;

      // 「アクティブな」1位（未判定 or 不正解でない人）が既にいる場合はスキップ
      // ※ 不正解の人が出たあとは、次の人が押せるようにする
      const lastActive = ranking.filter(r => r.judged === null).pop();
      if (lastActive) return; // 誰かの判定待ち

      if (ranking.length === 0 ||
          ranking.every(r => r.judged === 'wrong')) {
        // 新しい問題、または全員不正解後の最初の押下
        if (ranking.length === 0) hostStartTime = now;
      }
      const relTime = Math.max(0, Math.round(now - hostStartTime));
      ranking.push({
        id: conn.peer,
        name: entry.name,
        time: relTime,
        judged: null
      });
      broadcastState();
      updateHostUI();
      return;
    }

    // ===== 4択 =====
    if (data.type === 'choice') {
      if (currentMode !== 'choice') return;
      const n = parseInt(data.n, 10);
      if (![1,2,3,4].includes(n)) return;
      // 正解発表後は変更不可
      if (revealedAnswer !== null) return;
      choices.set(conn.peer, n);
      broadcastState();
      updateHostUI();
      return;
    }
  }

  function makeStatePayload(forPeerId) {
    if (currentMode === 'buzz') {
      const firstActive = ranking.find(r => r.judged !== 'wrong');
      const allCorrect = ranking.find(r => r.judged === 'correct');
      return {
        type: 'state',
        mode: 'buzz',
        ranking: ranking.map(r => ({ name: r.name, time: r.time, judged: r.judged })),
        // この人にとってロックされているかどうか
        locked: (() => {
          if (allCorrect) return true;
          // 未判定の人がいて、かつ自分以外
          const pending = ranking.find(r => r.judged === null);
          if (pending && pending.id !== forPeerId) return true;
          // 自分が既にランキングにいる
          if (ranking.some(r => r.id === forPeerId)) return true;
          return false;
        })(),
        myStatus: (() => {
          const me = ranking.find(r => r.id === forPeerId);
          if (!me) return null;
          if (me.judged === 'correct') return 'correct';
          if (me.judged === 'wrong')   return 'wrong';
          // 未判定で自分が現在のpending = 自分が今押した人
          const pending = ranking.find(r => r.judged === null);
          if (pending && pending.id === forPeerId) return 'pending';
          return 'queued';
        })(),
        firstName: firstActive ? firstActive.name : null,
        myScore: (connections.get(forPeerId)?.score) || 0,
      };
    } else {
      const myChoice = choices.get(forPeerId) || null;
      // 公開ペイロード: 正解未発表時は各人の選択は伏せて自分のだけ返す
      const revealed = revealedAnswer !== null;
      return {
        type: 'state',
        mode: 'choice',
        myChoice,
        revealed,
        revealedAnswer,
        myScore: (connections.get(forPeerId)?.score) || 0,
        // 集計はホストのみ持つので各人には送らない
      };
    }
  }

  function broadcastState() {
    connections.forEach((e) => {
      if (!e.connected) return;
      sendTo(e.conn, makeStatePayload(e.conn.peer));
    });
  }

  function sendTo(conn, obj) {
    try { conn.send(obj); } catch (e) { console.warn('send failed', e); }
  }

  // 効果音を全員に流す指示
  function broadcastSound(name) {
    connections.forEach((e) => {
      if (!e.connected) return;
      sendTo(e.conn, { type: 'sound', name });
    });
    // ホスト自身も鳴らす
    playSound(name);
  }

  function updateHostUI() {
    const players = Array.from(connections.values());
    const activeCount = players.filter(p => p.connected).length;
    hostPlayerCount.textContent = activeCount;

    // 参加者一覧&スコア
    playersList.innerHTML = '';
    if (players.length === 0) {
      const li = document.createElement('li');
      li.textContent = '（まだ誰も参加していません）';
      li.style.color = '#aaa';
      playersList.appendChild(li);
    } else {
      // スコア降順
      const sorted = [...players].sort((a,b) => b.score - a.score);
      sorted.forEach(p => {
        const li = document.createElement('li');
        if (!p.connected) li.classList.add('disconnected');
        li.innerHTML = `${escapeHtml(p.name)} <span class="player-score">${p.score}</span>`;
        playersList.appendChild(li);
      });
    }

    if (currentMode === 'buzz') {
      updateBuzzUI();
    } else {
      updateChoiceUI();
    }
  }

  function updateBuzzUI() {
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
        if (r.judged === 'wrong') li.classList.add('wrong-answer');
        const timeStr = i === 0 ? '基準' : '+' + r.time + 'ms';
        let mark = '';
        if (r.judged === 'correct') mark = '<span class="rank-mark correct">◯</span>';
        else if (r.judged === 'wrong') mark = '<span class="rank-mark wrong">✕</span>';
        li.innerHTML = `
          <span class="rank-num">${i+1}</span>
          <span class="rank-name">${escapeHtml(r.name)}</span>
          <span class="rank-time">${timeStr}</span>
          ${mark}
        `;
        rankingList.appendChild(li);
      });
    }

    // 判定ブロックの表示
    const pending = ranking.find(r => r.judged === null);
    if (pending && !ranking.some(r => r.judged === 'correct')) {
      judgeBlock.classList.remove('hidden');
      judgeTargetName.textContent = pending.name;
    } else {
      judgeBlock.classList.add('hidden');
    }
  }

  function updateChoiceUI() {
    // 集計
    const counts = [0, 0, 0, 0];
    choices.forEach(n => { if (n>=1 && n<=4) counts[n-1]++; });
    const total = Array.from(connections.values()).filter(c => c.connected).length;
    for (let i = 1; i <= 4; i++) {
      $('tally-count-' + i).textContent = counts[i-1];
      const pct = total > 0 ? (counts[i-1] / total) * 100 : 0;
      $('tally-fill-' + i).style.width = pct + '%';
    }

    // 個別回答リスト
    answersList.innerHTML = '';
    if (choices.size === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '回答待ち…';
      answersList.appendChild(li);
    } else {
      // 名前で並べる
      const items = [];
      choices.forEach((n, peerId) => {
        const c = connections.get(peerId);
        if (!c) return;
        items.push({ name: c.name, n, peerId });
      });
      items.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      items.forEach(({ name, n }) => {
        const li = document.createElement('li');
        li.className = 'answer-chip';
        li.dataset.n = n;
        if (revealedAnswer !== null) {
          if (n === revealedAnswer) li.classList.add('correct');
          else li.classList.add('wrong');
        }
        li.innerHTML = `<span class="chip-num">${n}</span>${escapeHtml(name)}`;
        answersList.appendChild(li);
      });
    }

    // 正解発表ボタンの選択表示
    revealBtns.forEach(btn => {
      const n = parseInt(btn.dataset.answer, 10);
      btn.classList.toggle('selected', revealedAnswer === n);
    });
    revealStatus.textContent = revealedAnswer !== null
      ? `正解は ${revealedAnswer} 番！`
      : '';
  }

  // ----- モード切替 -----
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;
      modeBtns.forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
      hostBuzzSection.classList.toggle('hidden', mode !== 'buzz');
      hostChoiceSection.classList.toggle('hidden', mode !== 'choice');
      // 切替時はリセット
      ranking = [];
      hostStartTime = 0;
      choices.clear();
      revealedAnswer = null;
      broadcastState();
      updateHostUI();
    });
  });

  // ----- 次の問題へ -----
  function nextQuestion() {
    ranking = [];
    hostStartTime = 0;
    choices.clear();
    revealedAnswer = null;
    broadcastState();
    updateHostUI();
  }
  nextBtn.addEventListener('click', nextQuestion);
  nextBtnChoice.addEventListener('click', nextQuestion);

  // ----- 判定（〇/×） -----
  judgeCorrect.addEventListener('click', () => {
    const pending = ranking.find(r => r.judged === null);
    if (!pending) return;
    pending.judged = 'correct';
    // スコア加算
    const c = connections.get(pending.id);
    if (c) c.score += 1;
    broadcastSound('correct');
    // 結果を送る（resultイベントで結果バナーを表示）
    broadcastResult('correct', pending.name);
    broadcastState();
    updateHostUI();
  });

  judgeWrong.addEventListener('click', () => {
    const pending = ranking.find(r => r.judged === null);
    if (!pending) return;
    pending.judged = 'wrong';
    broadcastSound('wrong');
    broadcastResult('wrong', pending.name);
    broadcastState();
    updateHostUI();
  });

  function broadcastResult(kind, name) {
    connections.forEach((e) => {
      if (!e.connected) return;
      sendTo(e.conn, { type: 'result', kind, name });
    });
  }

  // ----- 正解発表（4択） -----
  revealBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.dataset.answer, 10);
      revealedAnswer = n;
      // 正解者にスコア加算
      choices.forEach((choice, peerId) => {
        if (choice === n) {
          const c = connections.get(peerId);
          if (c) c.score += 1;
        }
      });
      // 各人にrevealを通知
      connections.forEach((e) => {
        if (!e.connected) return;
        const myChoice = choices.get(e.conn.peer);
        const isCorrect = myChoice === n;
        sendTo(e.conn, {
          type: 'reveal',
          answer: n,
          isCorrect,
          myChoice: myChoice || null
        });
      });
      // ホストも音を鳴らす（ピンポン）
      playSound('correct');
      broadcastState();
      updateHostUI();
    });
  });

  // ----- スコアリセット -----
  resetScoresBtn.addEventListener('click', () => {
    if (!confirm('全員のスコアを0にリセットしますか？')) return;
    connections.forEach(c => { c.score = 0; });
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
      hostConn = peer.connect(hostPeerId, {
        reliable: true,
        serialization: 'json'
      });

      hostConn.on('open', () => {
        setPlayerConn('connected', '接続済み');
        playerRoomName.textContent = roomCode;
        myNameDisplay.textContent = myName;
        showScreen('player');
        sendTo(hostConn, { type: 'hello', name: myName });
      });

      hostConn.on('data', (data) => handlePlayerMessage(data));

      hostConn.on('close', () => {
        setPlayerConn('error', 'ホストとの接続が切れました');
        buzzLocked = true;
        buzzBtn.classList.add('locked');
        choiceBtns.forEach(b => b.classList.add('locked'));
      });

      hostConn.on('error', (err) => {
        console.warn('[Player] conn error', err);
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
      hostBtn.disabled = false; joinBtn.disabled = false;
      showScreen('entry');
    });
  }

  function handlePlayerMessage(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'state') {
      applyPlayerState(data);
    } else if (data.type === 'sound') {
      playSound(data.name);
    } else if (data.type === 'result') {
      // 早押し判定結果のバナー表示
      showBuzzResult(data.kind, data.name);
    } else if (data.type === 'reveal') {
      // 4択の正解発表
      showChoiceReveal(data.answer, data.isCorrect, data.myChoice);
    }
  }

  function applyPlayerState(s) {
    // スコア更新
    if (typeof s.myScore === 'number') {
      myScore = s.myScore;
      playerScore.textContent = myScore;
    }

    // モード切替表示
    if (s.mode === 'buzz') {
      playerBuzzStage.classList.remove('hidden');
      playerChoiceStage.classList.add('hidden');

      // ランキング状態
      const r = s.ranking || [];
      buzzLocked = !!s.locked;

      if (r.length === 0) {
        // 新問題
        hasBuzzed = false;
        buzzLocked = false;
        buzzBtn.classList.remove('locked', 'pressed');
        resultBanner.classList.remove('win','lose','correct','incorrect');
        resultName.textContent = '―';
        resultSub.textContent = '問題が出されたらタップ！';
        buzzHint.textContent = '問題が出されたらタップ！';
      } else {
        const firstName = s.firstName || (r[0] && r[0].name) || '―';
        resultName.textContent = firstName;

        if (s.myStatus === 'correct') {
          resultBanner.classList.remove('win','lose','incorrect');
          resultBanner.classList.add('correct');
          resultSub.textContent = '◯ 正解！ +1pt';
        } else if (s.myStatus === 'wrong') {
          resultBanner.classList.remove('win','lose','correct');
          resultBanner.classList.add('incorrect');
          resultSub.textContent = '✕ 残念…';
        } else if (s.myStatus === 'pending') {
          resultBanner.classList.remove('lose','correct','incorrect');
          resultBanner.classList.add('win');
          resultSub.textContent = '判定待ち…';
        } else {
          // 他人が押している
          resultBanner.classList.remove('win','correct','incorrect');
          resultBanner.classList.add('lose');
          resultSub.textContent = '最初に押した人';
        }

        if (buzzLocked) {
          buzzBtn.classList.add('locked');
        } else {
          // 不正解の後、自分はまだ未押下 → 押せる
          buzzBtn.classList.remove('locked', 'pressed');
          hasBuzzed = false;
          buzzHint.textContent = '前の人が不正解！押せます';
        }
      }
    } else if (s.mode === 'choice') {
      playerBuzzStage.classList.add('hidden');
      playerChoiceStage.classList.remove('hidden');

      // 4択UI
      myChoice = s.myChoice || null;
      choiceBtns.forEach(btn => {
        const n = parseInt(btn.dataset.choice, 10);
        btn.classList.remove('selected', 'reveal-correct', 'reveal-wrong', 'locked');
        if (myChoice === n) btn.classList.add('selected');
      });

      if (s.revealed) {
        // 既に正解発表済みの状態で再受信した場合（再接続等）
        choiceBtns.forEach(btn => {
          const n = parseInt(btn.dataset.choice, 10);
          btn.classList.add('locked');
          if (n === s.revealedAnswer) btn.classList.add('reveal-correct');
          else if (myChoice === n) btn.classList.add('reveal-wrong');
        });
        choiceStatus.textContent = `正解は ${s.revealedAnswer} 番！`;
        resultName.textContent = myChoice === s.revealedAnswer ? '◯ 正解' : '✕ 不正解';
        resultBanner.classList.remove('win','lose');
        resultBanner.classList.toggle('correct', myChoice === s.revealedAnswer);
        resultBanner.classList.toggle('incorrect', myChoice !== s.revealedAnswer);
      } else {
        resultBanner.classList.remove('win','lose','correct','incorrect');
        if (myChoice) {
          choiceStatus.textContent = `あなたの回答：${myChoice}（変更可能）`;
          resultName.textContent = '回答済み';
          resultSub.textContent = '正解発表をお待ちください';
        } else {
          choiceStatus.textContent = '回答前';
          resultName.textContent = '―';
          resultSub.textContent = '番号を選んで回答';
        }
      }
    }
  }

  function showBuzzResult(kind, name) {
    // 結果バナーをアニメで強調
    if (kind === 'correct') {
      resultBanner.classList.remove('lose','win','incorrect');
      resultBanner.classList.add('correct');
      resultName.textContent = name;
      resultSub.textContent = '◯ 正解！';
    } else {
      resultBanner.classList.remove('lose','win','correct');
      resultBanner.classList.add('incorrect');
      resultName.textContent = name;
      resultSub.textContent = '✕ 不正解';
    }
  }

  function showChoiceReveal(answer, isCorrect, myCh) {
    choiceBtns.forEach(btn => {
      const n = parseInt(btn.dataset.choice, 10);
      btn.classList.add('locked');
      btn.classList.remove('reveal-correct', 'reveal-wrong');
      if (n === answer) {
        btn.classList.add('reveal-correct');
      } else if (myCh === n) {
        btn.classList.add('reveal-wrong');
      }
    });
    choiceStatus.textContent = `正解は ${answer} 番！`;
    resultBanner.classList.remove('win','lose');
    if (isCorrect) {
      resultBanner.classList.add('correct');
      resultBanner.classList.remove('incorrect');
      resultName.textContent = '◯ 正解';
      resultSub.textContent = '+1pt';
      playSound('correct');
    } else {
      resultBanner.classList.add('incorrect');
      resultBanner.classList.remove('correct');
      resultName.textContent = '✕ 不正解';
      resultSub.textContent = myCh ? `あなたの回答：${myCh}` : '未回答';
      playSound('wrong');
    }
  }

  // ============================================================
  // 早押しボタン操作
  // ============================================================
  function onBuzz(ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (role !== 'player') return;
    if (hasBuzzed || buzzLocked) return;
    if (!hostConn || !hostConn.open) return;

    hasBuzzed = true;
    buzzBtn.classList.add('pressed');
    playSound('buzzer');
    sendTo(hostConn, { type: 'buzz', t: performance.now() });
  }
  buzzBtn.addEventListener('pointerdown', onBuzz, { passive: false });
  buzzBtn.addEventListener('touchstart', onBuzz, { passive: false });
  buzzBtn.addEventListener('click', (e) => e.preventDefault());

  // ============================================================
  // 4択ボタン操作
  // ============================================================
  choiceBtns.forEach(btn => {
    const onChoice = (ev) => {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      if (role !== 'player') return;
      if (btn.classList.contains('locked')) return;
      if (!hostConn || !hostConn.open) return;
      const n = parseInt(btn.dataset.choice, 10);
      // 視覚的に即時反映
      choiceBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      myChoice = n;
      choiceStatus.textContent = `あなたの回答：${n}（変更可能）`;
      sendTo(hostConn, { type: 'choice', n });
    };
    btn.addEventListener('pointerdown', onChoice, { passive: false });
    btn.addEventListener('touchstart', onChoice, { passive: false });
    btn.addEventListener('click', (e) => e.preventDefault());
  });

  // ============================================================
  // 初期化
  // ============================================================
  showScreen('entry');

  window.addEventListener('beforeunload', () => {
    try { if (peer) peer.destroy(); } catch(e){}
  });
})();
