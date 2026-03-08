/**
 * qa_client.js  —  QuestAcademy Supabase Client
 * Loads safely — if Supabase CDN fails, game still runs in offline mode.
 */

const QA_URL = 'https://lueqmpytuwxaotwmkgna.supabase.co';
const QA_KEY = 'sb_publishable_7JTnHKJUYwp5ZZ_lSfVG9w_xtt239VB';

// Safe init — if supabase.js didn't load, everything gracefully degrades
let _sb = null;
try {
  if (window.supabase) {
    _sb = window.supabase.createClient(QA_URL, QA_KEY);
    window._sb = _sb;
  }
} catch(e) {
  console.warn('QA: Supabase init failed, running offline', e);
}

async function _sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _playerColor(username) {
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) & 0xFFFFFF;
  return `hsl(${h % 360},72%,58%)`;
}

const QA = {
  session: null,

  // ── AUTH ────────────────────────────────────────────
  async register(username, password) {
    if (!_sb) return { error: 'Offline mode — cannot register.' };
    username = username.trim().toLowerCase();
    if (username.length < 3) return { error: 'Username must be 3+ characters.' };
    if (password.length < 6) return { error: 'Password must be 6+ characters.' };
    const hash = await _sha256(password);
    const { data, error } = await _sb.from('players')
      .insert({ username, password_hash: hash }).select().single();
    if (error) return { error: error.code === '23505' ? 'Username taken.' : error.message };
    QA.session = data;
    localStorage.setItem('qa_session', JSON.stringify(data));
    return { data };
  },

  async login(username, password) {
    if (!_sb) return { error: 'Offline mode — cannot log in.' };
    username = username.trim().toLowerCase();
    const hash = await _sha256(password);
    const { data, error } = await _sb.from('players')
      .select('*').eq('username', username).eq('password_hash', hash).single();
    if (error || !data) return { error: 'Wrong username or password.' };
    QA.session = data;
    localStorage.setItem('qa_session', JSON.stringify(data));
    _sb.from('players').update({ last_seen: new Date().toISOString() }).eq('username', username);
    return { data };
  },

  async restoreSession() {
    const raw = localStorage.getItem('qa_session');
    if (!raw) return null;
    let username;
    try {
      const parsed = JSON.parse(raw);
      username = (parsed && typeof parsed === 'object') ? parsed.username : parsed;
      if (parsed && typeof parsed === 'object' && parsed.username) QA.session = parsed;
    } catch(e) {
      username = raw;
    }
    if (!username) return null;
    if (_sb) {
      try {
        const { data } = await _sb.from('players').select('*').eq('username', username).single();
        if (data) { QA.session = data; return data; }
      } catch(e) {}
    }
    return QA.session;
  },

  logout() {
    QA.presence.leave();
    QA.session = null;
    localStorage.removeItem('qa_session');
    window.location.href = 'SpawnZone.html';
  },

  async savePlayer(fields) {
    if (!QA.session || !_sb) return null;
    const { data } = await _sb.from('players')
      .update({ ...fields, last_seen: new Date().toISOString() })
      .eq('username', QA.session.username).select().single();
    if (data) QA.session = { ...QA.session, ...data };
    return data;
  },

  playerColor: _playerColor,

  // ── PRESENCE ────────────────────────────────────────
  presence: {
    _ch: null, _iv: null,
    _others: {}, _cbs: [],
    _worldId: -1,
    _pos: { x: 0, z: 8 },
    _activity: 'idle',
    _battleId: null,

    async join(worldId) {
      if (!QA.session || !_sb) return;
      QA.presence._worldId = worldId;
      await _sb.from('presence').upsert({
        username: QA.session.username, world_id: worldId,
        pos_x: 0, pos_z: 8, activity: 'idle',
        hp: QA.session.hp || 20, max_hp: QA.session.max_hp || 20,
        party_id: QA.session.party_id || null, battle_id: null,
        avatar_col: _playerColor(QA.session.username),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'username' });

      QA.presence._ch = _sb.channel(`pres_w${worldId}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'presence',
          filter: `world_id=eq.${worldId}` }, ({ eventType, new: nw, old: ow }) => {
          const row = nw || ow;
          if (!row || row.username === QA.session.username) return;
          if (eventType === 'DELETE') delete QA.presence._others[row.username];
          else QA.presence._others[row.username] = row;
          QA.presence._cbs.forEach(fn => fn({ ...QA.presence._others }));
        }).subscribe();

      const { data } = await _sb.from('presence').select('*')
        .eq('world_id', worldId).neq('username', QA.session.username);
      QA.presence._others = {};
      (data || []).forEach(r => QA.presence._others[r.username] = r);
      QA.presence._cbs.forEach(fn => fn({ ...QA.presence._others }));

      clearInterval(QA.presence._iv);
      QA.presence._iv = setInterval(async () => {
        if (!QA.session) return;
        await _sb.from('presence').upsert({
          username: QA.session.username, world_id: QA.presence._worldId,
          pos_x: QA.presence._pos.x, pos_z: QA.presence._pos.z,
          activity: QA.presence._activity,
          hp: QA.session.hp || 20, max_hp: QA.session.max_hp || 20,
          party_id: QA.session.party_id || null,
          battle_id: QA.presence._battleId,
          avatar_col: _playerColor(QA.session.username),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'username' });
      }, 300);
    },

    setPos(x, z) { QA.presence._pos = { x, z }; },
    setActivity(a, battleId) { QA.presence._activity = a; QA.presence._battleId = battleId || null; },
    onUpdate(fn) { QA.presence._cbs.push(fn); },
    getOthers() { return { ...QA.presence._others }; },

    leave() {
      clearInterval(QA.presence._iv);
      if (QA.presence._ch) _sb.removeChannel(QA.presence._ch);
      if (QA.session) _sb.from('presence').delete().eq('username', QA.session.username);
    },
  },

  // ── PARTY ───────────────────────────────────────────
  party: {
    _data: null, _ch: null, _ivCh: null,
    _cbs: [], _invCbs: [],

    async create() {
      if (!QA.session) return { error: 'Not logged in.' };
      if (QA.session.party_id) return { error: 'Leave your current party first.' };
      const { data, error } = await _sb.from('parties').insert({
        leader: QA.session.username, members: [QA.session.username], status: 'idle',
      }).select().single();
      if (error) return { error: error.message };
      await QA.savePlayer({ party_id: data.id });
      QA.party._data = data;
      QA.party._sub(data.id);
      QA.party._cbs.forEach(fn => fn(data));
      return { data };
    },

    async invite(toUser) {
      if (!QA.party._data) return { error: 'Create a party first.' };
      if (QA.party._data.members.length >= 4) return { error: 'Party full (max 4).' };
      if (QA.party._data.leader !== QA.session.username) return { error: 'Only leader can invite.' };
      toUser = toUser.trim().toLowerCase();
      const { data: p } = await _sb.from('players').select('username').eq('username', toUser).single();
      if (!p) return { error: `Player "${toUser}" not found.` };
      const { error } = await _sb.from('party_invites').insert({
        from_user: QA.session.username, to_user: toUser, party_id: QA.party._data.id,
      });
      if (error) return { error: error.message };
      return { ok: true };
    },

    async accept(inviteId) {
      const { data: inv } = await _sb.from('party_invites').select('*').eq('id', inviteId).single();
      if (!inv) return { error: 'Invite expired.' };
      const { data: party } = await _sb.from('parties').select('*').eq('id', inv.party_id).single();
      if (!party) return { error: 'Party was disbanded.' };
      if (party.members.length >= 4) return { error: 'Party is full.' };
      const members = [...party.members, QA.session.username];
      await _sb.from('parties').update({ members }).eq('id', party.id);
      await _sb.from('party_invites').update({ status: 'accepted' }).eq('id', inviteId);
      await QA.savePlayer({ party_id: party.id });
      QA.party._data = { ...party, members };
      QA.party._sub(party.id);
      QA.party._cbs.forEach(fn => fn(QA.party._data));
      return { data: QA.party._data };
    },

    async decline(inviteId) {
      await _sb.from('party_invites').update({ status: 'declined' }).eq('id', inviteId);
    },

    async leave() {
      if (!QA.party._data) return;
      const members = QA.party._data.members.filter(m => m !== QA.session.username);
      if (!members.length) await _sb.from('parties').delete().eq('id', QA.party._data.id);
      else {
        const leader = QA.party._data.leader === QA.session.username ? members[0] : QA.party._data.leader;
        await _sb.from('parties').update({ members, leader }).eq('id', QA.party._data.id);
      }
      await QA.savePlayer({ party_id: null });
      if (QA.party._ch) _sb.removeChannel(QA.party._ch);
      QA.party._data = null;
      QA.party._cbs.forEach(fn => fn(null));
    },

    async kick(username) {
      if (QA.party._data?.leader !== QA.session.username) return;
      const members = QA.party._data.members.filter(m => m !== username);
      await _sb.from('parties').update({ members }).eq('id', QA.party._data.id);
      await _sb.from('players').update({ party_id: null }).eq('username', username);
    },

    _sub(id) {
      if (QA.party._ch) _sb.removeChannel(QA.party._ch);
      QA.party._ch = _sb.channel(`party_${id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'parties',
          filter: `id=eq.${id}` }, ({ eventType, new: nw }) => {
          QA.party._data = eventType === 'DELETE' ? null : nw;
          QA.party._cbs.forEach(fn => fn(QA.party._data));
        }).subscribe();
    },

    listenInvites() {
      if (!QA.session || QA.party._ivCh) return;
      QA.party._ivCh = _sb.channel(`inv_${QA.session.username}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'party_invites',
          filter: `to_user=eq.${QA.session.username}` }, ({ new: nw }) => {
          QA.party._invCbs.forEach(fn => fn(nw));
        }).subscribe();
    },

    onUpdate(fn) { QA.party._cbs.push(fn); },
    onInvite(fn) { QA.party._invCbs.push(fn); },
    get() { return QA.party._data; },
    isLeader() { return QA.party._data?.leader === QA.session?.username; },
    size() { return QA.party._data?.members?.length || 1; },
    members() { return QA.party._data?.members || (QA.session ? [QA.session.username] : []); },
  },

  // ── BATTLE ──────────────────────────────────────────
  battle: {
    _data: null, _ch: null, _cbs: [], _csClock: null,

    hpMult(n) { return n >= 4 ? 2.0 : n === 3 ? 1.5 : 1.0; },

    async create(cfg) {
      const members = QA.party.members();
      const mult = QA.battle.hpMult(members.length);
      const enemies = cfg.enemies.map(e => ({
        ...e, hp: Math.round(e.maxHp * mult), maxHp: Math.round(e.maxHp * mult),
      }));
      const participants = members.map((u, i) => ({
        username: u, hp: u === QA.session.username ? (QA.session.hp || 20) : 20,
        maxHp: 20, turnDone: false, turnIndex: i,
      }));
      const isBoss = !!cfg.isBoss;
      const { data, error } = await _sb.from('battles').insert({
        type: 'pve', world_id: cfg.worldId, participants, enemies,
        rewards: cfg.rewards || {}, is_void: cfg.isVoid || false,
        is_boss: isBoss, world_config: cfg.worldConfig || {},
        phase: isBoss ? 'cutscene' : 'player',
        cutscene_ready: isBoss ? [] : members,
        battle_log: [],
      }).select().single();
      if (error) return { error: error.message };
      QA.battle._data = data;
      QA.battle._sub(data.id);
      QA.presence.setActivity('in-battle', data.id);
      return { data };
    },

    async joinWild(battleId) {
      const { data: b } = await _sb.from('battles').select('*').eq('id', battleId).single();
      if (!b || b.phase === 'result') return { error: 'Battle unavailable.' };
      const already = b.participants.some(p => p.username === QA.session.username);
      if (!already) {
        const participants = [...b.participants, {
          username: QA.session.username, hp: QA.session.hp || 20, maxHp: 20,
          turnDone: false, turnIndex: b.participants.length,
        }];
        await _sb.from('battles').update({ participants }).eq('id', battleId);
      }
      QA.battle._data = b;
      QA.battle._sub(battleId);
      QA.presence.setActivity('in-battle', battleId);
      return { data: b };
    },

    async markCutsceneDone(battleId) {
      const { data: b } = await _sb.from('battles').select('cutscene_ready,cutscene_timer,participants').eq('id', battleId).single();
      if (!b) return;
      const ready = [...new Set([...(b.cutscene_ready || []), QA.session.username])];
      const update = { cutscene_ready: ready };
      if (!b.cutscene_timer) update.cutscene_timer = new Date().toISOString();
      await _sb.from('battles').update(update).eq('id', battleId);
    },

    watchCutscene(battleId, onBattleStart) {
      QA.battle._sub(battleId);
      const check = (b) => {
        if (b.phase !== 'cutscene') return;
        const members = b.participants.map(p => p.username);
        const allReady = members.every(u => (b.cutscene_ready || []).includes(u));
        const elapsed = b.cutscene_timer
          ? Date.now() - new Date(b.cutscene_timer).getTime() : 0;
        if (allReady || elapsed >= 30000) {
          clearInterval(QA.battle._csClock);
          if (QA.party.isLeader() || b.participants[0]?.username === QA.session.username) {
            _sb.from('battles').update({ phase: 'player' }).eq('id', battleId);
          }
          onBattleStart(b);
        }
      };
      QA.battle._cbs.push(check);
      // Also poll every 2s for timer
      QA.battle._csClock = setInterval(async () => {
        const { data: b } = await _sb.from('battles').select('*').eq('id', battleId).single();
        if (b) check(b);
      }, 2000);
    },

    async submitAction(battleId, action) {
      const { data: b } = await _sb.from('battles').select('*').eq('id', battleId).single();
      if (!b) return;
      const log = [...(b.battle_log || []), { actor: QA.session.username, ...action, ts: Date.now() }];
      const participants = b.participants.map(p =>
        p.username === QA.session.username ? { ...p, turnDone: true, hp: action.newHp ?? p.hp } : p
      );
      const alive = participants.filter(p => p.hp > 0);
      const allDone = alive.every(p => p.turnDone);
      await _sb.from('battles').update({
        battle_log: log, participants, ...(allDone ? { phase: 'enemy' } : {}),
      }).eq('id', battleId);
    },

    async resolveEnemyPhase(battleId, participants, enemies) {
      const { data: b } = await _sb.from('battles').select('round').eq('id', battleId).single();
      const dead_e = enemies.every(e => (e.hp || 0) <= 0);
      const dead_p = participants.every(p => p.hp <= 0);
      const phase = dead_e || dead_p ? 'result' : 'player';
      const winner = dead_e ? 'players' : dead_p ? 'enemies' : null;
      const reset = participants.map(p => ({ ...p, turnDone: false }));
      await _sb.from('battles').update({
        participants: reset, enemies, phase, round: ((b?.round) || 1) + 1, turn_index: 0,
        ...(winner ? { winner, ended_at: new Date().toISOString() } : {}),
      }).eq('id', battleId);
    },

    async applyRewards(battleId) {
      const { data: b } = await _sb.from('battles').select('rewards').eq('id', battleId).single();
      if (!b?.rewards) return;
      const u = QA.session;
      await QA.savePlayer({ gold: (u.gold || 0) + (b.rewards.gold || 0), xp: (u.xp || 0) + (b.rewards.xp || 0) });
      QA.presence.setActivity('idle', null);
    },

    _sub(id) {
      if (QA.battle._ch) _sb.removeChannel(QA.battle._ch);
      QA.battle._ch = _sb.channel(`battle_${id}`)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'battles',
          filter: `id=eq.${id}` }, ({ new: nw }) => {
          QA.battle._data = nw;
          QA.battle._cbs.forEach(fn => fn(nw));
        }).subscribe();
    },

    onChange(fn) { QA.battle._cbs.push(fn); },
    get() { return QA.battle._data; },

    whoseTurn(b) {
      if (!b) return null;
      const alive = (b.participants || []).filter(p => p.hp > 0);
      return alive.length ? alive[(b.turn_index || 0) % alive.length] : null;
    },
    isMyTurn(b) { return QA.battle.whoseTurn(b)?.username === QA.session?.username; },
  },

  // ── PVP ─────────────────────────────────────────────
  pvp: {
    async challenge(opponent) {
      const { data, error } = await _sb.from('battles').insert({
        type: 'pvp', world_id: -1, phase: 'waiting',
        participants: [
          { username: QA.session.username, hp: QA.session.hp || 20, maxHp: 20, turnDone: false, turnIndex: 0, isChallenger: true },
          { username: opponent, hp: 20, maxHp: 20, turnDone: false, turnIndex: 1, isChallenger: false },
        ],
        enemies: [], rewards: { gold: 15, xp: 8 }, battle_log: [],
      }).select().single();
      return error ? { error: error.message } : { data };
    },

    listenChallenges(fn) {
      if (!QA.session) return;
      _sb.channel(`pvp_inc_${QA.session.username}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'battles',
          filter: 'type=eq.pvp' }, ({ new: b }) => {
          if (b.phase === 'waiting' && b.participants?.some(p => p.username === QA.session.username && !p.isChallenger))
            fn(b);
        }).subscribe();
    },
  },
};

window.QA = QA;
