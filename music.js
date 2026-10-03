// Music: a compact Spotify remote inside the planner screen.
// It controls the Spotify app that is already running on one of the user's devices (Spotify Connect) through
// Spotify's official Web API. It plays nothing itself, needs Spotify Premium, and keeps the login token only in
// this browser. Sign-in is the Authorization Code flow with PKCE, so there is no client secret anywhere.
// Not available through the API, and therefore not offered: Spotify DJ, radio/recommendations, an artist's top tracks.
(() => {
  const CLIENT_ID = 'ebd2a40d505d4e6aaee2cc0cad2ecd6a';
  const REDIRECT = 'https://gabrielguti-01.github.io/planner-voice/';
  const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-read-recently-played';
  const API = 'https://api.spotify.com/v1';
  const MOCK = new URLSearchParams(location.search).has('mock');
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k, d = '') => { try { return localStorage.getItem('planner.music.' + k) ?? d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('planner.music.' + k, v); } catch {} },
    del: (k) => { try { localStorage.removeItem('planner.music.' + k); } catch {} },
  };
  const note = (t, bad) => { const el = $('muStatus'); if (el) { el.textContent = t || ''; el.className = 'meta' + (bad ? ' bad' : ''); } };

  // ---------------------------------------------------------------- sign-in (PKCE)
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const connected = () => MOCK || !!store.get('refresh');

  async function login() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    store.set('verifier', verifier); store.set('state', state);
    const q = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state });
    location.href = 'https://accounts.spotify.com/authorize?' + q;
  }
  async function token(body) {
    const r = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...body }) });
    if (!r.ok) throw new Error('Spotify sign-in was refused (' + r.status + ').');
    const j = await r.json();
    store.set('access', j.access_token); store.set('exp', String(Date.now() + (j.expires_in - 60) * 1000));
    if (j.refresh_token) store.set('refresh', j.refresh_token);
    return j.access_token;
  }
  async function finishLogin() {
    const p = new URLSearchParams(location.search);
    if (!p.get('code') && !p.get('error')) return false;
    const ok = p.get('code') && p.get('state') === store.get('state');
    const code = p.get('code'), verifier = store.get('verifier');
    history.replaceState(null, '', location.pathname); // never leave the code in the address bar
    store.del('state'); store.del('verifier');
    if (!ok) { note(p.get('error') ? 'Spotify sign-in was cancelled.' : 'Spotify sign-in could not be verified. Try again.', true); return true; }
    try { await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }); } catch (e) { note(e.message, true); }
    return true;
  }
  async function access() {
    if (+store.get('exp', '0') > Date.now() && store.get('access')) return store.get('access');
    if (!store.get('refresh')) throw new Error('Not connected to Spotify.');
    try { return await token({ grant_type: 'refresh_token', refresh_token: store.get('refresh') }); }
    catch (e) { disconnect(); throw new Error('Spotify needs you to connect again.'); }
  }
  function disconnect() { for (const k of ['access', 'exp', 'refresh']) store.del(k); show(); }

  // ---------------------------------------------------------------- API
  async function api(path, opts = {}, retry = true) {
    const r = await fetch(API + path, { ...opts, headers: { Authorization: 'Bearer ' + (await access()), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (r.status === 401 && retry) { store.del('exp'); return api(path, opts, false); }
    if (r.status === 204 || r.status === 202) return null;
    const text = await r.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const reason = j?.error?.reason || '', msg = j?.error?.message || '';
      if (reason === 'NO_ACTIVE_DEVICE' || /no active device/i.test(msg)) throw new Error('Open Spotify on your phone or computer first, then choose it under Device.');
      if (reason === 'PREMIUM_REQUIRED') throw new Error('Spotify says this needs Premium.');
      if (r.status === 429) throw new Error('Spotify is asking to slow down. Try again in a moment.');
      throw new Error(msg || 'Spotify answered ' + r.status + '.');
    }
    return j;
  }
  const put = (path, body) => api(path, { method: 'PUT', ...(body ? { body: JSON.stringify(body) } : {}) });
  const post = (path) => api(path, { method: 'POST' });

  // ---------------------------------------------------------------- demo data (?mock=1)
  const demo = { is_playing: true, shuffle_state: false, repeat_state: 'off', progress_ms: 42000, device: { id: 'd1', name: 'iPhone', volume_percent: 60, supports_volume: false },
    item: { name: 'Demo Song', uri: 'x', duration_ms: 201000, artists: [{ name: 'Demo Artist' }], album: { name: 'Demo Album', images: [] } } };

  // ---------------------------------------------------------------- state and rendering
  let state = null, open = false, timer = 0, ducked = false, undock = 0;
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const img = (images) => (images && images.length ? images[images.length - 1].url : '');

  async function refresh() {
    if (!connected()) return;
    try { state = MOCK ? demo : await api('/me/player'); paint(); } catch (e) { note(e.message, true); }
  }
  function paint() {
    const it = state?.item;
    $('musicBtn').classList.toggle('playing', !!state?.is_playing);
    if (!open) return;
    $('muTitle').textContent = it ? it.name : 'Nothing playing';
    $('muArtist').textContent = it ? (it.artists || []).map((a) => a.name).join(', ') || it.show?.name || '' : 'Open Spotify on a device to start';
    const art = it ? (it.album?.images?.[0]?.url || it.images?.[0]?.url || '') : '';
    $('muArt').style.backgroundImage = art ? `url("${art}")` : 'none';
    $('muPlay').textContent = state?.is_playing ? 'Pause' : 'Play';
    $('muShuffle').classList.toggle('on', !!state?.shuffle_state);
    $('muRepeat').classList.toggle('on', !!state && state.repeat_state !== 'off');
    $('muRepeat').textContent = state?.repeat_state === 'track' ? 'Repeat 1' : 'Repeat';
    const dur = it?.duration_ms || 0;
    $('muSeek').max = String(dur); if (!$('muSeek').matches(':active')) $('muSeek').value = String(state?.progress_ms || 0);
    $('muNow').textContent = mmss(state?.progress_ms || 0); $('muDur').textContent = mmss(dur);
    const vol = state?.device?.supports_volume !== false && state?.device;
    $('muVolRow').classList.toggle('hidden', !vol);
    if (vol && !$('muVol').matches(':active')) $('muVol').value = String(state.device.volume_percent ?? 50);
  }
  function show() {
    const on = connected();
    $('muConnect').classList.toggle('hidden', on);
    $('muBody').classList.toggle('hidden', !on);
  }

  // act, then re-read the player a moment later (Spotify applies commands asynchronously)
  async function act(fn) {
    try { note(''); await fn(); } catch (e) { note(e.message, true); }
    setTimeout(refresh, 600);
  }
  const playing = () => !!state?.is_playing;

  // ---------------------------------------------------------------- lists
  function row(title, sub, image, onTap, round) {
    const b = document.createElement('button');
    b.className = 'mu-row';
    const pic = document.createElement('i'); pic.className = 'mu-pic' + (round ? ' round' : ''); if (image) pic.style.backgroundImage = `url("${image}")`;
    const txt = document.createElement('span'); const t = document.createElement('b'); t.textContent = title; const s = document.createElement('small'); s.textContent = sub;
    txt.append(t, s); b.append(pic, txt); b.onclick = onTap;
    return b;
  }
  function heading(text) { const h = document.createElement('h2'); h.textContent = text; return h; }
  function fill(el, nodes, empty) { el.innerHTML = ''; if (!nodes.length) { const p = document.createElement('p'); p.className = 'meta'; p.textContent = empty; el.append(p); } else el.append(...nodes); }

  const playTrack = (t) => act(() => put('/me/player/play', t.album?.uri ? { context_uri: t.album.uri, offset: { uri: t.uri } } : { uris: [t.uri] }));
  const playContext = (uri) => act(() => put('/me/player/play', { context_uri: uri }));
  const trackRow = (t) => row(t.name, (t.artists || []).map((a) => a.name).join(', '), img(t.album?.images), () => playTrack(t));

  async function search(q) {
    q = q.trim(); if (!q) return;
    const recent = [q, ...JSON.parse(store.get('searches', '[]')).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    store.set('searches', JSON.stringify(recent)); chips();
    const out = $('muResults'); fill(out, [], 'Searching…');
    try {
      const r = MOCK ? { tracks: { items: [demo.item] }, artists: { items: [{ id: 'a', name: 'Demo Artist', images: [] }] }, albums: { items: [] }, playlists: { items: [] } }
        : await api('/search?' + new URLSearchParams({ q, type: 'track,artist,album,playlist', limit: '5' }));
      const nodes = [];
      const tracks = (r.tracks?.items || []).filter(Boolean), artists = (r.artists?.items || []).filter(Boolean), albums = (r.albums?.items || []).filter(Boolean), lists = (r.playlists?.items || []).filter(Boolean);
      if (tracks.length) nodes.push(heading('Songs'), ...tracks.map(trackRow));
      if (artists.length) nodes.push(heading('Artists'), ...artists.map((a) => row(a.name, 'Artist', img(a.images), () => artist(a), true)));
      if (albums.length) nodes.push(heading('Albums'), ...albums.map((a) => row(a.name, (a.artists || []).map((x) => x.name).join(', '), img(a.images), () => playContext(a.uri))));
      if (lists.length) nodes.push(heading('Playlists'), ...lists.map((p) => row(p.name, p.owner?.display_name ? 'by ' + p.owner.display_name : 'Playlist', img(p.images), () => playContext(p.uri))));
      fill(out, nodes, 'Nothing found.');
    } catch (e) { fill(out, [], e.message); }
  }
  async function artist(a) {
    const out = $('muResults'); fill(out, [], 'Loading…');
    try {
      const r = MOCK ? { items: [] } : await api(`/artists/${a.id}/albums?` + new URLSearchParams({ include_groups: 'album,single', limit: '10' }));
      const nodes = [heading(a.name), row('Play ' + a.name, 'Start from this artist', img(a.images), () => playContext('spotify:artist:' + a.id), true),
        ...(r.items || []).map((al) => row(al.name, (al.release_date || '').slice(0, 4) + ' · ' + (al.album_type || 'album'), img(al.images), () => playContext(al.uri)))];
      fill(out, nodes, 'No albums listed.');
    } catch (e) { fill(out, [], e.message); }
  }
  function chips() {
    const el = $('muRecentQ'); el.innerHTML = '';
    for (const q of JSON.parse(store.get('searches', '[]'))) { const b = document.createElement('button'); b.className = 'mu-chip'; b.textContent = q; b.onclick = () => { $('muQ').value = q; search(q); }; el.append(b); }
  }
  async function playlists() {
    const out = $('muList'); fill(out, [], 'Loading…');
    try {
      const r = MOCK ? { items: [{ name: 'Demo Playlist', uri: 'p', images: [], items: { total: 12 } }] } : await api('/me/playlists?limit=20');
      fill(out, (r.items || []).filter(Boolean).map((p) => row(p.name, 'Playlist', img(p.images), () => playContext(p.uri))), 'No playlists found.');
    } catch (e) { fill(out, [], e.message); }
  }
  async function recent() {
    const out = $('muList'); fill(out, [], 'Loading…');
    try {
      const r = MOCK ? { items: [{ track: demo.item }] } : await api('/me/player/recently-played?limit=10');
      const seen = new Set();
      fill(out, (r.items || []).map((x) => x.track).filter((t) => t && !seen.has(t.uri) && seen.add(t.uri)).map(trackRow), 'Nothing recent.');
    } catch (e) { fill(out, [], e.message); }
  }
  async function devices() {
    const sel = $('muDevice');
    try {
      const r = MOCK ? { devices: [{ id: 'd1', name: 'iPhone', is_active: true }] } : await api('/me/player/devices');
      sel.innerHTML = '';
      const list = r.devices || [];
      if (!list.length) { const o = document.createElement('option'); o.textContent = 'No device found: open Spotify and play something, then tap here again'; o.value = ''; sel.append(o); return; }
      for (const d of list) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name + (d.is_active ? ' (playing here)' : ''); o.selected = !!d.is_active; sel.append(o); }
    } catch (e) { note(e.message, true); }
  }

  // ---------------------------------------------------------------- panel
  function setOpen(on) {
    open = on;
    $('music').classList.toggle('hidden', !on);
    clearInterval(timer);
    if (!on) return;
    show(); chips();
    if (connected()) { refresh(); devices(); playlists(); timer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 5000); }
  }

  // ---------------------------------------------------------------- pause while the planner listens or speaks
  // Called by the main screen on every state change. Music that was playing is paused while the planner is
  // listening, speaking or saving, and resumed shortly after it goes quiet. Music the user paused stays paused.
  async function onState(s) {
    if (!connected() || MOCK) return;
    clearTimeout(undock);
    if (s === 'listening' || s === 'speaking') {
      if (ducked) return;
      try {
        const now = await api('/me/player');
        if (now?.is_playing) { ducked = true; await put('/me/player/pause'); }
      } catch {}
    } else if (s === 'idle' && ducked) {
      undock = setTimeout(async () => { ducked = false; try { await put('/me/player/play'); } catch {} refresh(); }, 1500);
    }
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    if (!$('music') || !$('musicBtn')) return;
    $('musicBtn').onclick = () => setOpen(true);
    $('muClose').onclick = () => setOpen(false);
    $('muLogin').onclick = () => (MOCK ? note('Demo mode: sign-in is skipped.') : login().catch((e) => note(e.message, true)));
    $('muOut').onclick = disconnect;
    $('muPlay').onclick = () => act(() => put(playing() ? '/me/player/pause' : '/me/player/play'));
    $('muNext').onclick = () => act(() => post('/me/player/next'));
    $('muPrev').onclick = () => act(() => post('/me/player/previous'));
    $('muShuffle').onclick = () => act(() => put('/me/player/shuffle?state=' + !state?.shuffle_state));
    $('muRepeat').onclick = () => act(() => put('/me/player/repeat?state=' + ({ off: 'context', context: 'track', track: 'off' }[state?.repeat_state || 'off'])));
    $('muSeek').onchange = () => act(() => put('/me/player/seek?position_ms=' + $('muSeek').value));
    $('muVol').onchange = () => act(() => put('/me/player/volume?volume_percent=' + $('muVol').value));
    // the list goes stale quickly (a phone's Spotify drops off when it sleeps), so reload it whenever it is opened
    $('muDevice').addEventListener('focus', devices);
    $('muDevice').addEventListener('pointerdown', devices);
    $('muDevice').onchange = () => $('muDevice').value && act(() => put('/me/player', { device_ids: [$('muDevice').value], play: playing() }));
    $('muGo').onclick = () => search($('muQ').value);
    $('muQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') search($('muQ').value); });
    $('muTabLists').onclick = playlists;
    $('muTabRecent').onclick = recent;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) setOpen(false); });
    finishLogin().then((came) => { if (came) setOpen(true); else if (connected()) refresh(); });
  }
  window.PlannerMusic = { onState, open: () => setOpen(true) };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
