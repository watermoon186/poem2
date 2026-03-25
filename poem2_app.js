const STORAGE_KEY = 'poem2_multi_v3';
const ROOM_LIFECYCLE_MINUTES = 1;

const state = {
  supabase: null,
  room: null,
  player: null,
  players: [],
  lines: [],
  subscription: null,
  meKey: null,
};

function $(id) { return document.getElementById(id); }
function show(el, visible) {
  const node = typeof el === 'string' ? $(el) : el;
  if (!node) return;
  node.classList.toggle('hidden', !visible);
}
function nowTs() { return new Date().toISOString(); }
function escapeHtml(v='') { return v.replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }
function randomCode() { return Math.random().toString(36).slice(2, 8).toUpperCase(); }

function getLocal() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
function saveLocal(patch) {
  const merged = { ...getLocal(), ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}
function ensureMeKey() {
  const local = getLocal();
  if (local.meKey) return local.meKey;
  const meKey = crypto.randomUUID();
  saveLocal({ meKey });
  return meKey;
}
function getInviteCodeFromUrl() {
  return new URLSearchParams(location.search).get('code')?.toUpperCase() || '';
}

function initSupabase() {
  const local = getLocal();
  if ($('supabaseUrl')) $('supabaseUrl').value = local.supabaseUrl || '';
  if ($('supabaseAnonKey')) $('supabaseAnonKey').value = local.supabaseAnonKey || '';
  if ($('nickname')) $('nickname').value = local.nickname || '';
  state.meKey = ensureMeKey();
  if (local.supabaseUrl && local.supabaseAnonKey) {
    state.supabase = window.supabase.createClient(local.supabaseUrl, local.supabaseAnonKey);
  }
}

function saveConfig() {
  const supabaseUrl = $('supabaseUrl').value.trim();
  const supabaseAnonKey = $('supabaseAnonKey').value.trim();
  if (!supabaseUrl || !supabaseAnonKey) return alert('请先填写 Supabase 配置');
  saveLocal({ supabaseUrl, supabaseAnonKey });
  state.supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);
  alert('配置已保存');
  location.reload();
}

async function ensureClient() {
  if (!state.supabase) {
    initSupabase();
  }
  if (!state.supabase) throw new Error('请先填写并保存 Supabase 配置');
  return state.supabase;
}

async function safeCleanupRooms() {
  const supabase = await ensureClient();
  try { await supabase.rpc('cleanup_stale_rooms'); } catch (e) { console.warn(e); }
}

async function createRoom() {
  const supabase = await ensureClient();
  await safeCleanupRooms();
  const nickname = $('nickname').value.trim();
  if (!nickname) return alert('请先输入昵称');
  saveLocal({ nickname });
  let code = randomCode();
  for (let i = 0; i < 5; i++) {
    const { data: roomExists } = await supabase.from('rooms').select('id').eq('code', code).maybeSingle();
    if (!roomExists) break;
    code = randomCode();
  }
  const theme = $('themeInput').value.trim() || '自由创作';
  const totalRounds = Number($('totalRounds').value || 4);
  const revealMode = $('revealMode').value || 'final';
  const linePosition = $('linePosition').value || 'upper';

  const { data: room, error: roomError } = await supabase.from('rooms').insert({
    code,
    theme,
    total_rounds: totalRounds,
    current_round: 1,
    status: 'waiting',
    revealed: false,
    reveal_mode: revealMode,
    current_round_revealed: false,
    visibility: 'public',
    empty_since: null,
    updated_at: nowTs(),
  }).select().single();
  if (roomError) throw roomError;

  const { data: player, error: playerError } = await supabase.from('players').insert({
    room_id: room.id,
    nickname,
    role: 'A',
    line_position: linePosition,
    is_active: true,
    left_at: null,
    last_seen_at: nowTs(),
  }).select().single();
  if (playerError) throw playerError;

  await supabase.from('rooms').update({ owner_player_id: player.id, updated_at: nowTs() }).eq('id', room.id);
  saveLocal({ roomId: room.id, playerId: player.id, roomCode: room.code, nickname });
  location.href = `room.html?code=${encodeURIComponent(room.code)}`;
}

async function showJoinFromList(code, theme) {
  $('joinModalTitle').textContent = theme || '进入房间';
  $('joinInviteCode').value = code || '';
  $('joinModalMask').classList.add('show');
}
function hideJoinModal() {
  $('joinModalMask')?.classList.remove('show');
}

async function joinRoom() {
  const supabase = await ensureClient();
  await safeCleanupRooms();
  const nickname = ($('nickname')?.value || $('joinNickname')?.value || '').trim();
  if (!nickname) return alert('请先输入昵称');
  saveLocal({ nickname });
  const code = (($('joinCode')?.value || $('joinInviteCode')?.value || getInviteCodeFromUrl()) || '').trim().toUpperCase();
  if (!code) return alert('请填写邀请码');

  const { data: room, error: roomError } = await supabase.from('rooms').select('*').eq('code', code).maybeSingle();
  if (roomError) throw roomError;
  if (!room) return alert('没有找到该房间');
  if (['closed', 'archived'].includes(room.status)) return alert('该房间已经结束');

  const { data: players, error: playersError } = await supabase.from('players').select('*').eq('room_id', room.id).order('created_at', { ascending: true });
  if (playersError) throw playersError;

  let player = players.find(p => p.nickname === nickname);
  if (player) {
    const { error } = await supabase.from('players').update({ is_active: true, left_at: null, last_seen_at: nowTs() }).eq('id', player.id);
    if (error) throw error;
  } else {
    if (players.length >= 2) return alert('房间已满');
    const host = players[0];
    const role = host?.role === 'A' ? 'B' : 'A';
    const linePosition = host?.line_position === 'upper' ? 'lower' : 'upper';
    const { data: newPlayer, error } = await supabase.from('players').insert({
      room_id: room.id,
      nickname,
      role,
      line_position: linePosition,
      is_active: true,
      left_at: null,
      last_seen_at: nowTs(),
    }).select().single();
    if (error) throw error;
    player = newPlayer;
  }

  const activePlayers = [...players.filter(p => p.id !== player.id), { ...player, is_active: true }].filter(p => p.is_active).length;
  await supabase.from('rooms').update({
    status: activePlayers >= 2 ? 'playing' : room.status,
    empty_since: null,
    updated_at: nowTs(),
  }).eq('id', room.id);
  await supabase.rpc('touch_room_presence', { p_room_id: room.id, p_player_id: player.id, p_nickname: nickname });

  saveLocal({ roomId: room.id, playerId: player.id, roomCode: room.code, nickname });
  location.href = `room.html?code=${encodeURIComponent(room.code)}`;
}

function orderRoundLines(lines) {
  return [...lines].sort((a, b) => {
    const pa = a.line_position === 'lower' ? 2 : 1;
    const pb = b.line_position === 'lower' ? 2 : 1;
    return pa - pb;
  });
}

function buildMixedPoem(room, lines) {
  const output = [];
  for (let i = 1; i <= room.total_rounds; i++) {
    orderRoundLines(lines.filter(l => l.round_no === i)).forEach(line => output.push(line.content));
  }
  return output.join('\n');
}

async function hydrateRoomPage() {
  const supabase = await ensureClient();
  const local = getLocal();
  const roomCode = getInviteCodeFromUrl() || local.roomCode || '';
  if (!roomCode) return;
  if ($('roomExitBtn')) $('roomExitBtn').onclick = leaveCurrentRoom;
  if ($('roomEndBtn')) $('roomEndBtn').onclick = endRoomByOwner;
  if ($('roomRefreshBtn')) $('roomRefreshBtn').onclick = refreshState;
  if ($('submitLineBtn')) $('submitLineBtn').onclick = submitLine;
  if ($('revealPoemBtn')) $('revealPoemBtn').onclick = revealPoem;
  if ($('nextRoundBtn')) $('nextRoundBtn').onclick = nextRound;
  if ($('publishBtn')) $('publishBtn').onclick = publishCurrentPoem;
  if ($('restartBtn')) $('restartBtn').onclick = restartRoom;

  await safeCleanupRooms();
  await refreshState();
  subscribeRoom();
  setInterval(async () => {
    if (state.room?.id && state.player?.id) {
      try { await supabase.rpc('touch_room_presence', { p_room_id: state.room.id, p_player_id: state.player.id, p_nickname: state.player.nickname }); } catch {}
    }
  }, 25000);
}

function subscribeRoom() {
  if (!state.room || !state.supabase) return;
  if (state.subscription) state.supabase.removeChannel(state.subscription);
  state.subscription = state.supabase.channel('room-' + state.room.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${state.room.id}` }, refreshState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_id=eq.${state.room.id}` }, refreshState)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lines', filter: `room_id=eq.${state.room.id}` }, refreshState)
    .subscribe();
}

async function refreshState() {
  const supabase = await ensureClient();
  const local = getLocal();
  const roomCode = getInviteCodeFromUrl() || local.roomCode || '';
  let roomId = local.roomId;

  if (!roomId && roomCode) {
    const { data: roomByCode } = await supabase.from('rooms').select('id').eq('code', roomCode).maybeSingle();
    roomId = roomByCode?.id;
  }
  if (!roomId) return;

  const playerId = local.playerId;
  const [{ data: room }, { data: players }, { data: lines }] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).single(),
    supabase.from('players').select('*').eq('room_id', roomId).order('created_at', { ascending: true }),
    supabase.from('lines').select('*').eq('room_id', roomId).order('round_no', { ascending: true }).order('created_at', { ascending: true }),
  ]);

  state.room = room;
  state.players = players || [];
  state.lines = lines || [];
  state.player = (players || []).find(p => p.id === playerId) || (players || []).find(p => p.nickname === local.nickname) || null;

  if (state.room && state.player) {
    await supabase.rpc('touch_room_presence', { p_room_id: state.room.id, p_player_id: state.player.id, p_nickname: state.player.nickname });
  }
  renderRoom();
}

function renderRoom() {
  if (!state.room) return;
  if (!state.player) {
    $('roomMain').innerHTML = '<div class="card"><div class="empty">你还没有进入该房间，请返回首页重新输入邀请码。</div></div>';
    return;
  }
  const activePlayers = state.players.filter(p => p.is_active);
  const currentRound = state.room.current_round;
  const myLine = state.lines.find(l => l.player_id === state.player.id && l.round_no === currentRound);
  const currentRoundLines = state.lines.filter(l => l.round_no === currentRound);
  const bothSubmitted = currentRoundLines.length >= 2;
  const finished = state.room.status === 'finished';
  const closed = ['closed', 'archived'].includes(state.room.status);
  const amOwner = state.room.owner_player_id === state.player.id;

  $('roomCode').textContent = state.room.code;
  $('roomTheme').textContent = state.room.theme;
  $('roomRole').textContent = state.player.role;
  $('roomPart').textContent = state.player.line_position === 'lower' ? '下半句' : '上半句';
  $('roomStatus').textContent = state.room.status;
  $('roomRound').textContent = `${state.room.current_round} / ${state.room.total_rounds}`;
  $('roomMode').textContent = state.room.reveal_mode === 'round' ? '每轮公布' : '最终公布';
  $('roomOwner').textContent = state.players.find(p => p.id === state.room.owner_player_id)?.nickname || '—';
  $('roomMembers').textContent = state.players.map(p => `${p.nickname}（${p.line_position === 'upper' ? '上半句' : '下半句'} / ${p.is_active ? '在线' : '离开'}）`).join('，');
  $('ownerOnly').classList.toggle('hidden', !amOwner);
  $('roomHint').textContent = closed
    ? '这个房间已结束，不能继续提交内容。'
    : activePlayers.length < 2
      ? `房间当前未满员。若双方都离开，房间将在 ${ROOM_LIFECYCLE_MINUTES} 分钟后自动归档。`
      : '已满员，可以继续创作。';

  show('writeCard', false);
  show('waitingCard', false);
  show('roundRevealCard', false);
  show('finalRevealCard', false);

  if (closed) {
    show('waitingCard', true);
    $('waitingText').textContent = '房间已关闭或归档。你仍可以去作品广场查看已发布作品。';
    return;
  }
  if (!finished && activePlayers.length < 2) {
    show('waitingCard', true);
    $('waitingText').textContent = '等待另一位成员进入或重新返回房间。';
    return;
  }
  if (finished) {
    show('finalRevealCard', true);
    const mixed = buildMixedPoem(state.room, state.lines);
    $('mixedPoem').textContent = state.room.revealed ? mixed || '暂无内容' : '作品已完成，点击“揭晓作品”查看。';
    $('publishTheme').value = state.room.theme || '';
    return;
  }
  if (state.room.reveal_mode === 'round' && bothSubmitted && state.room.current_round_revealed) {
    show('roundRevealCard', true);
    $('roundRevealTitle').textContent = `第 ${currentRound} 轮揭晓`;
    $('roundRevealText').textContent = orderRoundLines(currentRoundLines).map(l => l.content).join('\n') || '暂无内容';
    $('nextRoundBtn').textContent = currentRound >= state.room.total_rounds ? '结束并进入总揭晓' : '进入下一轮';
    return;
  }
  if (myLine) {
    show('waitingCard', true);
    $('waitingText').textContent = bothSubmitted
      ? '双方都已提交，本轮即将推进。若未自动更新，请点刷新。'
      : '你已经提交了本轮内容，正在等待对方提交。';
    return;
  }
  show('writeCard', true);
  $('writeLabel').textContent = `请写第 ${currentRound} 轮的${state.player.line_position === 'upper' ? '上半句' : '下半句'}`;
  $('lineInput').value = '';
}

async function submitLine() {
  const supabase = await ensureClient();
  const content = $('lineInput').value.trim();
  if (!content) return alert('请先输入一句诗');
  if (content.length > 80) return alert('请控制在 80 字以内');
  const currentRound = state.room.current_round;
  const already = state.lines.find(l => l.player_id === state.player.id && l.round_no === currentRound);
  if (already) return alert('你已经提交过这一轮');
  const { error } = await supabase.from('lines').insert({
    room_id: state.room.id,
    player_id: state.player.id,
    role: state.player.role,
    line_position: state.player.line_position,
    round_no: currentRound,
    content,
  });
  if (error) throw error;
  await advanceRoundIfNeeded(currentRound);
  await refreshState();
}

async function advanceRoundIfNeeded(roundNo) {
  const supabase = await ensureClient();
  const { data: roundLines, error } = await supabase.from('lines').select('*').eq('room_id', state.room.id).eq('round_no', roundNo);
  if (error) throw error;
  if (roundLines.length < 2) return;
  if (state.room.reveal_mode === 'round') {
    await supabase.from('rooms').update({ status: 'playing', current_round_revealed: true, updated_at: nowTs() }).eq('id', state.room.id);
    return;
  }
  if (roundNo >= state.room.total_rounds) {
    await supabase.from('rooms').update({ status: 'finished', updated_at: nowTs() }).eq('id', state.room.id);
  } else {
    await supabase.from('rooms').update({
      current_round: roundNo + 1,
      status: 'playing',
      current_round_revealed: false,
      updated_at: nowTs(),
    }).eq('id', state.room.id).eq('current_round', roundNo);
  }
}

async function nextRound() {
  const supabase = await ensureClient();
  const currentRound = state.room.current_round;
  if (currentRound >= state.room.total_rounds) {
    await supabase.from('rooms').update({ status: 'finished', updated_at: nowTs() }).eq('id', state.room.id);
  } else {
    await supabase.from('rooms').update({
      current_round: currentRound + 1,
      status: 'playing',
      current_round_revealed: false,
      updated_at: nowTs(),
    }).eq('id', state.room.id);
  }
  await refreshState();
}

async function revealPoem() {
  const supabase = await ensureClient();
  await supabase.from('rooms').update({ revealed: true, updated_at: nowTs() }).eq('id', state.room.id);
  await refreshState();
}

async function publishCurrentPoem() {
  const supabase = await ensureClient();
  if (state.room.status !== 'finished') return alert('请在作品完成后发布');
  const theme = $('publishTheme').value.trim() || state.room.theme || '自由创作';
  const poemText = buildMixedPoem(state.room, state.lines);
  if (!poemText.trim()) return alert('还没有完整作品');
  const authors = state.players.map(p => p.nickname).join(' × ');
  await supabase.from('rooms').update({ theme, updated_at: nowTs() }).eq('id', state.room.id);
  const { error } = await supabase.from('poems').upsert({
    room_id: state.room.id,
    room_code: state.room.code,
    theme,
    reveal_mode: state.room.reveal_mode,
    total_rounds: state.room.total_rounds,
    authors,
    poem_text: poemText,
    updated_at: nowTs(),
  }, { onConflict: 'room_id' });
  if (error) throw error;
  $('publishStatus').textContent = '已发布到作品广场';
}

async function restartRoom() {
  const supabase = await ensureClient();
  if (!confirm('确定在当前房间再来一局吗？将清空旧内容。')) return;
  const del = await supabase.from('lines').delete().eq('room_id', state.room.id);
  if (del.error) throw del.error;
  const upd = await supabase.from('rooms').update({
    current_round: 1,
    status: 'playing',
    revealed: false,
    current_round_revealed: false,
    ended_by_owner: false,
    ended_at: null,
    updated_at: nowTs(),
  }).eq('id', state.room.id);
  if (upd.error) throw upd.error;
  await refreshState();
}

async function leaveCurrentRoom() {
  const supabase = await ensureClient();
  if (!state.room || !state.player) return;
  await supabase.rpc('leave_room', { p_room_id: state.room.id, p_player_id: state.player.id });
  saveLocal({ roomId: null, playerId: null, roomCode: null });
  location.href = 'index.html';
}

async function endRoomByOwner() {
  const supabase = await ensureClient();
  if (!confirm('结束后该房间将停止创作，是否继续？')) return;
  const { data, error } = await supabase.rpc('end_room', { p_room_id: state.room.id, p_player_id: state.player.id });
  if (error) throw error;
  if (!data) return alert('只有房主可以结束房间');
  await refreshState();
}

async function loadRoomsPage() {
  const supabase = await ensureClient();
  await safeCleanupRooms();
  const list = $('roomsList');
  list.innerHTML = '<div class="empty">加载中…</div>';
  const { data: rooms, error } = await supabase.from('rooms').select('*').eq('visibility', 'public').in('status', ['waiting', 'playing', 'finished']).order('created_at', { ascending: false });
  if (error) throw error;
  if (!rooms?.length) {
    list.innerHTML = '<div class="empty">目前还没有可展示的房间。</div>';
    return;
  }
  const roomIds = rooms.map(r => r.id);
  const { data: players } = await supabase.from('players').select('*').in('room_id', roomIds);
  list.innerHTML = rooms.map(room => {
    const memberList = (players || []).filter(p => p.room_id === room.id);
    const activeCount = memberList.filter(p => p.is_active).length;
    const owner = memberList.find(p => p.id === room.owner_player_id)?.nickname || '—';
    return `<div class="item">
      <h3>${escapeHtml(room.theme)}</h3>
      <div class="meta">房主：${escapeHtml(owner)} · 当前在线 ${activeCount}/${memberList.length || 0} · 状态：${escapeHtml(room.status)}</div>
      <div class="statline">
        <span class="badge">邀请码进入</span>
        <span class="badge">${room.reveal_mode === 'round' ? '每轮公布' : '最终公布'}</span>
      </div>
      <div class="actions">
        <button class="btn-secondary" onclick="showJoinFromList('${room.code}','${escapeHtml(room.theme)}')">输入邀请码进入</button>
      </div>
    </div>`;
  }).join('');
}

async function loadPoemList(targetId, mode='gallery') {
  const supabase = await ensureClient();
  const box = $(targetId);
  if (!box) return;
  box.innerHTML = '<div class="empty">加载中…</div>';
  let query = supabase.from('poems').select('*');
  if (mode === 'gallery') query = query.order('created_at', { ascending: false });
  else query = query.order('likes_count', { ascending: false }).order('created_at', { ascending: false });
  const { data, error } = await query.limit(50);
  if (error) throw error;
  if (!data?.length) {
    box.innerHTML = '<div class="empty">还没有已发布作品。</div>';
    return;
  }
  const local = getLocal();
  const meKey = local.meKey || ensureMeKey();
  const ids = data.map(p => p.id);
  const { data: likes } = await supabase.from('poem_likes').select('poem_id,user_key').in('poem_id', ids).eq('user_key', meKey);
  const likedSet = new Set((likes || []).map(x => x.poem_id));
  box.innerHTML = data.map((poem, idx) => `<div class="item">
      <h3>${mode === 'ranking' ? `#${idx + 1} ` : ''}${escapeHtml(poem.theme)}</h3>
      <div class="meta">${escapeHtml(poem.authors || '匿名')} · ${new Date(poem.created_at).toLocaleString()} · ❤️ ${poem.likes_count}</div>
      <div class="poem-box">${escapeHtml((poem.poem_text || '').slice(0, 80))}${(poem.poem_text || '').length > 80 ? '…' : ''}</div>
      <div class="actions">
        <a class="btn-secondary" href="poem.html?id=${poem.id}">查看全文</a>
        <button class="${likedSet.has(poem.id) ? 'btn-danger' : 'btn-primary'}" onclick="toggleLike('${poem.id}', ${likedSet.has(poem.id)})">${likedSet.has(poem.id) ? '取消点赞' : '点赞'}</button>
      </div>
    </div>`).join('');
}

async function toggleLike(poemId, alreadyLiked) {
  const supabase = await ensureClient();
  const meKey = ensureMeKey();
  if (alreadyLiked) {
    await supabase.from('poem_likes').delete().eq('poem_id', poemId).eq('user_key', meKey);
  } else {
    await supabase.from('poem_likes').insert({ poem_id: poemId, user_key: meKey });
  }
  if ($('galleryList')) loadPoemList('galleryList', 'gallery');
  if ($('rankingList')) loadPoemList('rankingList', 'ranking');
  if ($('poemLikeBtn')) loadPoemDetail();
}

async function loadPoemDetail() {
  const supabase = await ensureClient();
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  const { data: poem, error } = await supabase.from('poems').select('*').eq('id', id).single();
  if (error) throw error;
  $('poemTitle').textContent = poem.theme;
  $('poemMeta').textContent = `${poem.authors || '匿名'} · ❤️ ${poem.likes_count}`;
  $('poemText').textContent = poem.poem_text || '暂无内容';
  const meKey = ensureMeKey();
  const { data: liked } = await supabase.from('poem_likes').select('id').eq('poem_id', id).eq('user_key', meKey).maybeSingle();
  $('poemLikeBtn').textContent = liked ? '取消点赞' : '点赞';
  $('poemLikeBtn').className = liked ? 'btn-danger' : 'btn-primary';
  $('poemLikeBtn').onclick = () => toggleLike(id, !!liked);
}

function wireCommonActions() {
  initSupabase();
  $('saveConfigBtn')?.addEventListener('click', saveConfig);
  $('createRoomBtn')?.addEventListener('click', () => createRoom().catch(showErr));
  $('joinRoomBtn')?.addEventListener('click', () => joinRoom().catch(showErr));
  $('joinModalClose')?.addEventListener('click', hideJoinModal);
  $('joinModalConfirm')?.addEventListener('click', () => joinRoom().catch(showErr));
}

function showErr(e) {
  console.error(e);
  alert(e?.message || String(e));
}

window.addEventListener('beforeunload', () => {
  if (state.room?.id && state.player?.id && state.supabase) {
    state.supabase.rpc('leave_room', { p_room_id: state.room.id, p_player_id: state.player.id }).then(() => {}).catch(() => {});
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  wireCommonActions();
  const page = document.body.dataset.page;
  try {
    if (page === 'rooms') await loadRoomsPage();
    if (page === 'room') await hydrateRoomPage();
    if (page === 'gallery') await loadPoemList('galleryList', 'gallery');
    if (page === 'ranking') await loadPoemList('rankingList', 'ranking');
    if (page === 'poem') await loadPoemDetail();
  } catch (e) {
    showErr(e);
  }
});

window.showJoinFromList = showJoinFromList;
window.toggleLike = toggleLike;
