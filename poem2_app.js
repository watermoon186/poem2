(function(){
  const LOCAL_KEY = 'blind_poetry_multi_v1';
  const $ = id => document.getElementById(id);
  const getLocal = () => JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
  const saveLocal = data => localStorage.setItem(LOCAL_KEY, JSON.stringify({ ...getLocal(), ...data }));
  const clearRoomLocal = () => saveLocal({ roomId: null, playerId: null, roomCode: '' });
  const randomCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s=''; for(let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  };
  const escapeHtml = str => String(str || '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;').replaceAll('\n','<br>');
  const formatTime = v => v ? new Date(v).toLocaleString('zh-CN',{hour12:false}) : '未知时间';
  function client(){
    const local = getLocal();
    if(!local.supabaseUrl || !local.supabaseAnonKey) throw new Error('请先填写并保存 Supabase 配置');
    if(!window.supabase) throw new Error('Supabase SDK 未加载');
    if(!window.__bpClient || window.__bpUrl !== local.supabaseUrl || window.__bpKey !== local.supabaseAnonKey){
      window.__bpUrl = local.supabaseUrl; window.__bpKey = local.supabaseAnonKey;
      window.__bpClient = window.supabase.createClient(local.supabaseUrl, local.supabaseAnonKey);
    }
    return window.__bpClient;
  }
  async function ensureUniqueCode(sb){
    let code = randomCode();
    for(let i=0;i<8;i++){
      const { data } = await sb.from('rooms').select('id').eq('code', code).maybeSingle();
      if(!data) return code;
      code = randomCode();
    }
    return code;
  }
  function renderNav(active){
    return `<div class="nav">
      <a href="index.html" class="${active==='index'?'active':''}">首页</a>
      <a href="gallery.html" class="${active==='gallery'?'active':''}">作品广场</a>
      <a href="ranking.html" class="${active==='ranking'?'active':''}">排行榜</a>
    </div>`;
  }

  const App = {
    initHome(){
      const local = getLocal();
      if($('navMount')) $('navMount').innerHTML = renderNav('index');
      if($('supabaseUrl')) $('supabaseUrl').value = local.supabaseUrl || '';
      if($('supabaseAnonKey')) $('supabaseAnonKey').value = local.supabaseAnonKey || '';
      if($('nickname')) $('nickname').value = local.nickname || '';
      if($('joinCode')) $('joinCode').value = local.roomCode || '';
      if($('createBox')) $('createBox').classList.add('hidden');
      if($('joinBox')) $('joinBox').classList.add('hidden');
    },
    saveConfig(){
      const supabaseUrl = $('supabaseUrl').value.trim();
      const supabaseAnonKey = $('supabaseAnonKey').value.trim();
      if(!supabaseUrl || !supabaseAnonKey) return alert('请先填写 Supabase URL 和 anon key');
      saveLocal({ supabaseUrl, supabaseAnonKey });
      try { client(); } catch(e) {}
      alert('配置已保存');
    },
    showCreate(){ $('createBox').classList.remove('hidden'); $('joinBox').classList.add('hidden'); },
    showJoin(){ $('joinBox').classList.remove('hidden'); $('createBox').classList.add('hidden'); },
    async createRoom(){
      try{
        const nickname = $('nickname').value.trim();
        if(!nickname) return alert('请先输入昵称');
        saveLocal({ nickname });
        const sb = client();
        const code = await ensureUniqueCode(sb);
        const theme = $('themeInput').value.trim() || '自由创作';
        const totalRounds = Number($('totalRounds').value || 4);
        const revealMode = $('revealMode').value || 'final';
        const linePosition = $('linePosition').value || 'upper';
        const { data: room, error: roomError } = await sb.from('rooms').insert({
          code, theme, total_rounds: totalRounds, current_round: 1, status: 'waiting', revealed: false, reveal_mode: revealMode, current_round_revealed: false,
        }).select().single();
        if(roomError) throw roomError;
        const { data: player, error: playerError } = await sb.from('players').insert({
          room_id: room.id, nickname, role: 'A', line_position: linePosition,
        }).select().single();
        if(playerError) throw playerError;
        saveLocal({ roomId: room.id, playerId: player.id, roomCode: room.code });
        location.href = `room.html?code=${encodeURIComponent(room.code)}`;
      }catch(e){ console.error(e); alert('创建房间失败：' + e.message); }
    },
    async joinRoom(){
      try{
        const nickname = $('nickname').value.trim();
        const code = $('joinCode').value.trim().toUpperCase();
        if(!nickname) return alert('请先输入昵称');
        if(!code) return alert('请输入邀请码');
        saveLocal({ nickname, roomCode: code });
        const sb = client();
        const { data: room, error: roomError } = await sb.from('rooms').select('*').eq('code', code).maybeSingle();
        if(roomError) throw roomError;
        if(!room) return alert('房间不存在');
        const { data: existingPlayers, error: playersError } = await sb.from('players').select('*').eq('room_id', room.id).order('created_at',{ascending:true});
        if(playersError) throw playersError;
        if(existingPlayers.length >= 2) return alert('房间已满');
        const host = existingPlayers[0];
        const linePosition = host?.line_position === 'upper' ? 'lower' : 'upper';
        const role = existingPlayers.some(p => p.role === 'A') ? 'B' : 'A';
        const { data: player, error: playerError } = await sb.from('players').insert({ room_id: room.id, nickname, role, line_position: linePosition }).select().single();
        if(playerError) throw playerError;
        const { error: updateError } = await sb.from('rooms').update({ status:'playing' }).eq('id', room.id);
        if(updateError) throw updateError;
        saveLocal({ roomId: room.id, playerId: player.id, roomCode: room.code });
        location.href = `room.html?code=${encodeURIComponent(room.code)}`;
      }catch(e){ console.error(e); alert('加入房间失败：' + e.message); }
    },
    async initGallery(){
      if($('navMount')) $('navMount').innerHTML = renderNav('gallery');
      try{ await App.loadGallery(); } catch(e){ console.error(e); }
    },
    async loadGallery(){
      const sb = client();
      const keyword = $('gallerySearch')?.value?.trim();
      const box = $('galleryList'); if(box) box.innerHTML = '<div class="empty">加载中…</div>';
      let query = sb.from('poems').select('*').order('likes_count',{ascending:false}).order('created_at',{ascending:false}).limit(40);
      if(keyword) query = query.or(`theme.ilike.%${keyword}%,authors.ilike.%${keyword}%,poem_text.ilike.%${keyword}%`);
      const { data, error } = await query;
      if(error) throw error;
      const list = data || [];
      if(!list.length){ box.innerHTML = '<div class="empty">还没有公开作品，快成为第一个发布的人吧。</div>'; return; }
      box.innerHTML = list.map(item => `<div class="gallery-item"><div class="meta">主题：${escapeHtml(item.theme||'自由创作')} ｜ 作者：${escapeHtml(item.authors||'匿名')} ｜ ${formatTime(item.created_at)}</div><div class="poem-box">${escapeHtml(item.poem_text||'')}</div><div class="like-row"><div class="small muted">模式：${item.reveal_mode==='round'?'每轮公布':'最终公布'} ｜ 共 ${item.total_rounds||4} 轮</div><button class="btn-secondary" onclick="BlindPoetry.likePoem('${item.id}')">❤️ 点赞（${item.likes_count||0}）</button></div></div>`).join('');
    },
    async initRanking(){
      if($('navMount')) $('navMount').innerHTML = renderNav('ranking');
      const sb = client();
      const box = $('rankingList'); box.innerHTML = '<div class="empty">加载中…</div>';
      const { data, error } = await sb.from('poems').select('id, theme, authors, likes_count, created_at').order('likes_count',{ascending:false}).order('created_at',{ascending:false}).limit(30);
      if(error){ box.innerHTML = `<div class="empty">暂时无法读取排行榜：${escapeHtml(error.message)}</div>`; return; }
      const list = data || [];
      if(!list.length){ box.innerHTML = '<div class="empty">排行榜还没有数据。</div>'; return; }
      box.innerHTML = list.map((item,index)=>`<div class="rank-item"><div class="topbar" style="margin-bottom:8px;"><div><span class="pill">TOP ${index+1}</span></div><div class="heart">❤️ ${item.likes_count||0}</div></div><div style="font-weight:800;margin-bottom:6px;">${escapeHtml(item.theme||'自由创作')}</div><div class="meta">作者：${escapeHtml(item.authors||'匿名')} ｜ ${formatTime(item.created_at)}</div></div>`).join('');
    },
    async likePoem(poemId){
      try{
        const sb = client();
        const local = getLocal();
        const userKey = local.userKey || ('u_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
        if(!local.userKey) saveLocal({ userKey });
        const { error } = await sb.from('poem_likes').insert({ poem_id: poemId, user_key: userKey });
        if(error) throw error;
        if(location.pathname.endsWith('/gallery.html') || location.pathname.endsWith('gallery.html')) await App.loadGallery();
        if(location.pathname.endsWith('/ranking.html') || location.pathname.endsWith('ranking.html')) await App.initRanking();
      }catch(e){ alert(e.message.includes('duplicate') || e.message.includes('unique') ? '你已经点过赞了' : '点赞失败：' + e.message); }
    },
    async initRoom(){
      if($('navMount')) $('navMount').innerHTML = renderNav('');
      try{
        const sb = client();
        const local = getLocal();
        const code = new URLSearchParams(location.search).get('code') || local.roomCode;
        if(!code) throw new Error('缺少房间邀请码');
        if($('roomLinkCode')) $('roomLinkCode').textContent = code;
        let roomId = local.roomId, playerId = local.playerId;
        if(!roomId){
          const { data: room } = await sb.from('rooms').select('id').eq('code', code).maybeSingle();
          roomId = room?.id;
        }
        if(!playerId && roomId && local.nickname){
          const { data: players } = await sb.from('players').select('id, nickname, created_at').eq('room_id', roomId).eq('nickname', local.nickname).order('created_at',{ascending:false}).limit(1);
          playerId = players?.[0]?.id;
        }
        if(!roomId || !playerId) throw new Error('本机没有这个房间的玩家身份，请从首页重新创建或加入');
        saveLocal({ roomId, playerId, roomCode: code });
        const state = { room:null, player:null, players:[], lines:[], subscription:null };
        async function refresh(){
          const [{data:room,error:e1},{data:player,error:e2},{data:players,error:e3},{data:lines,error:e4}] = await Promise.all([
            sb.from('rooms').select('*').eq('id', roomId).single(),
            sb.from('players').select('*').eq('id', playerId).single(),
            sb.from('players').select('*').eq('room_id', roomId).order('created_at',{ascending:true}),
            sb.from('lines').select('*').eq('room_id', roomId).order('round_no',{ascending:true}).order('created_at',{ascending:true}),
          ]);
          if(e1||e2||e3||e4) throw (e1||e2||e3||e4);
          state.room=room; state.player=player; state.players=players||[]; state.lines=lines||[]; render();
        }
        function orderRoundLines(lines){ return [...lines].sort((a,b)=> (a.line_position==='lower'?2:1)-(b.line_position==='lower'?2:1)); }
        function fillCurrentRoundReveal(roundNo){ const lines = orderRoundLines(state.lines.filter(l=>l.round_no===roundNo)); $('roundRevealMeta').textContent = `第 ${roundNo} 轮`; $('roundRevealText').textContent = lines.map(l=>l.content).join('\n') || '暂无内容'; $('nextRoundBtn').textContent = roundNo >= state.room.total_rounds ? '结束并进入总揭晓' : '进入下一轮'; }
        function fillPoems(){
          const linesA = state.lines.filter(l=>l.role==='A').sort((a,b)=>a.round_no-b.round_no);
          const linesB = state.lines.filter(l=>l.role==='B').sort((a,b)=>a.round_no-b.round_no);
          const mixed = [];
          for(let i=1;i<=state.room.total_rounds;i++) orderRoundLines(state.lines.filter(l=>l.round_no===i)).forEach(item=>mixed.push(item.content));
          $('poemA').textContent = linesA.map(l=>`【${l.round_no}】${l.content}`).join('\n') || '暂无';
          $('poemB').textContent = linesB.map(l=>`【${l.round_no}】${l.content}`).join('\n') || '暂无';
          $('mixedPoem').textContent = mixed.join('\n') || '暂无';
        }
        function render(){
          $('roomCode').textContent = state.room.code;
          $('playerRole').textContent = `身份：${state.player.role}`;
          $('playerPart').textContent = `书写部分：${state.player.line_position==='lower'?'下半句':'上半句'}`;
          $('roundInfo').textContent = `第 ${state.room.current_round} / ${state.room.total_rounds} 轮`;
          $('roomStatus').textContent = `状态：${state.room.status}`;
          $('revealModeInfo').textContent = `公布方式：${state.room.reveal_mode==='round'?'每轮公布':'最终公布'}`;
          $('themeInfo').textContent = `主题：${state.room.theme || '自由创作'}`;
          $('playersInfo').textContent = `当前房间成员：${state.players.map(p=>`${p.role} - ${p.nickname}（${p.line_position==='lower'?'下半句':'上半句'}）`).join('，') || '-'}`;
          ['writeCard','waitingCard','roundRevealCard','revealCard'].forEach(id=>$(id).classList.add('hidden'));
          const currentRound = state.room.current_round;
          const myRoundLine = state.lines.find(l=>l.player_id===state.player.id && l.round_no===currentRound);
          const roundLines = state.lines.filter(l=>l.round_no===currentRound);
          const bothJoined = state.players.length===2;
          const bothSubmitted = roundLines.length>=2;
          if(!bothJoined){ $('waitingCard').classList.remove('hidden'); $('waitingTitle').textContent='等待同学加入'; $('waitingText').textContent='房间还没有满员，请把邀请码发给你的同学。'; return; }
          if(state.room.status === 'finished'){
            $('revealCard').classList.remove('hidden');
            if(state.room.revealed) fillPoems(); else { $('mixedPoem').textContent='全部轮次已结束，点击“揭晓”显示完整结果。'; $('poemA').textContent=''; $('poemB').textContent=''; }
            return;
          }
          if(state.room.reveal_mode === 'round' && state.room.current_round_revealed && bothSubmitted){ $('roundRevealCard').classList.remove('hidden'); fillCurrentRoundReveal(currentRound); return; }
          if(myRoundLine){ $('waitingCard').classList.remove('hidden'); $('waitingTitle').textContent='等待中'; $('waitingText').textContent = bothSubmitted ? '本轮双方都已提交，系统将进入下一轮。若未自动更新，请点刷新状态。' : '你已经提交了本轮诗句。双盲模式下，暂时不会显示对方的内容。'; return; }
          $('writeCard').classList.remove('hidden');
          $('writeLabel').textContent = `第 ${currentRound} 轮：请写${state.player.line_position==='lower'?'下半句':'上半句'}`;
          $('lineInput').value=''; $('submitStatus').textContent='';
        }
        async function advanceRoundIfNeeded(roundNo){
          const { data: roundLines, error } = await sb.from('lines').select('*').eq('room_id', roomId).eq('round_no', roundNo);
          if(error) throw error;
          if(roundLines.length < 2) return;
          if(state.room.reveal_mode === 'round'){
            const { error: e } = await sb.from('rooms').update({ status:'playing', current_round_revealed:true }).eq('id', roomId); if(e) throw e; return;
          }
          if(roundNo >= state.room.total_rounds){ const { error:e } = await sb.from('rooms').update({ status:'finished' }).eq('id', roomId); if(e) throw e; }
          else { const { error:e } = await sb.from('rooms').update({ current_round: roundNo + 1, status:'playing', current_round_revealed:false }).eq('id', roomId).eq('current_round', roundNo); if(e) throw e; }
        }
        window.roomPage = {
          refresh,
          async submitLine(){
            try{
              const content = $('lineInput').value.trim(); if(!content) return alert('请先输入内容');
              const roundNo = state.room.current_round;
              const { error } = await sb.from('lines').insert({ room_id:roomId, player_id:playerId, role:state.player.role, line_position:state.player.line_position, round_no:roundNo, content });
              if(error) throw error;
              $('submitStatus').textContent='已提交';
              await advanceRoundIfNeeded(roundNo); await refresh();
            }catch(e){ console.error(e); $('submitStatus').textContent='提交失败：'+e.message; }
          },
          async goNextRound(){
            try{
              const currentRound = state.room.current_round;
              if(currentRound >= state.room.total_rounds){ const { error } = await sb.from('rooms').update({ status:'finished', current_round_revealed:false }).eq('id', roomId); if(error) throw error; }
              else { const { error } = await sb.from('rooms').update({ current_round: currentRound+1, status:'playing', current_round_revealed:false }).eq('id', roomId); if(error) throw error; }
              await refresh();
            }catch(e){ alert('进入下一轮失败：'+e.message); }
          },
          async revealPoem(){ const { error } = await sb.from('rooms').update({ revealed:true }).eq('id', roomId); if(error) return alert('揭晓失败：'+error.message); await refresh(); },
          async publishCurrentPoem(){
            try{
              if(state.room.status !== 'finished') return alert('请在作品完成后再发布');
              const mixed = $('mixedPoem').textContent.trim(); if(!mixed || mixed==='暂无' || mixed.includes('点击“揭晓”')) return alert('请先揭晓作品');
              const authors = state.players.map(p=>p.nickname).join(' × ');
              const payload = { room_id: state.room.id, room_code: state.room.code, theme: state.room.theme || '自由创作', reveal_mode: state.room.reveal_mode || 'final', total_rounds: state.room.total_rounds || 4, authors, poem_text: mixed, likes_count: 0 };
              const { error } = await sb.from('poems').upsert(payload, { onConflict:'room_id' }); if(error) throw error;
              $('publishStatus').textContent='已发布到作品广场';
            }catch(e){ $('publishStatus').textContent='发布失败：'+e.message; }
          },
          async restartRoom(){
            if(!confirm('确定在当前房间再来一局吗？将清空旧诗句。')) return;
            const { error: e1 } = await sb.from('lines').delete().eq('room_id', roomId); if(e1) return alert('清空旧内容失败：'+e1.message);
            const { error: e2 } = await sb.from('rooms').update({ current_round:1, status:'playing', revealed:false, current_round_revealed:false }).eq('id', roomId); if(e2) return alert('重置房间失败：'+e2.message);
            $('lineInput').value=''; $('submitStatus').textContent=''; $('publishStatus').textContent='';
            await refresh();
          },
          leaveRoom(){ clearRoomLocal(); location.href = 'index.html'; },
          async copyResult(){
            const text = [`双盲诗歌｜房间 ${state.room.code}`,`主题：${state.room.theme || '自由创作'}`,`模式：${state.room.reveal_mode==='round'?'每轮公布':'最终公布'}`,'','交错合成版：',$('mixedPoem').textContent,'','A：',$('poemA').textContent,'','B：',$('poemB').textContent].join('\n');
            await navigator.clipboard.writeText(text); alert('已复制到剪贴板');
          }
        };
        await refresh();
        const channel = sb.channel('room-' + roomId)
          .on('postgres_changes',{event:'*',schema:'public',table:'rooms',filter:`id=eq.${roomId}`},()=>window.roomPage.refresh())
          .on('postgres_changes',{event:'*',schema:'public',table:'players',filter:`room_id=eq.${roomId}`},()=>window.roomPage.refresh())
          .on('postgres_changes',{event:'*',schema:'public',table:'lines',filter:`room_id=eq.${roomId}`},()=>window.roomPage.refresh())
          .subscribe();
        window.addEventListener('beforeunload', ()=> sb.removeChannel(channel));
      }catch(e){ console.error(e); alert('进入房间失败：' + e.message); }
    }
  };
  window.BlindPoetry = App;
})();
