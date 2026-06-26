'use strict';

// ═══════════════════════════════════════════════════════════════════════
// SUPABASE CLIENT
// ═══════════════════════════════════════════════════════════════════════
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ═══════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════
const state = {
  user:          null,
  artists:       [],
  songs:         [],
  queue:         [],
  queueIndex:    -1,
  isPlaying:     false,
  ytPlayer:      null,
  ytReady:       false,
  progressTimer: null,
  currentSong:   null,
  currentArtist: null,
  currentView:   'home',
  searchQuery:   '',
};

// ═══════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════
function extractYouTubeId(url) {
  if (!url) return null;
  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /\/embed\/([A-Za-z0-9_-]{11})/,
    /\/shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function ytThumb(id) {
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

function formatTime(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6)  return 'Bonne nuit';
  if (h < 12) return 'Bonjour';
  if (h < 18) return 'Bon après-midi';
  return 'Bonsoir';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════
// DOM HELPERS
// ═══════════════════════════════════════════════════════════════════════
const $  = id  => document.getElementById(id);
const $q = sel => document.querySelector(sel);
const $qa = sel => [...document.querySelectorAll(sel)];
const show = el => el?.classList.remove('hidden');
const hide = el => el?.classList.add('hidden');

// ═══════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════
let _toastTimer = null;
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ═══════════════════════════════════════════════════════════════════════
// MODALS
// ═══════════════════════════════════════════════════════════════════════
function openModal(id) {
  const m = $(id); if (!m) return;
  m.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => m.classList.add('modal-open')));
}
function closeModal(id) {
  const m = $(id); if (!m) return;
  m.classList.remove('modal-open');
  setTimeout(() => m.classList.add('hidden'), 220);
}

let _confirmCb = null;
function showConfirm(title, message, cb) {
  $('confirm-title').textContent   = title;
  $('confirm-message').textContent = message;
  _confirmCb = cb;
  openModal('modal-confirm');
}

// ═══════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════
async function login(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

async function register(email, password) {
  const { error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
}

async function logout() {
  stopProgressTimer();
  if (state.ytPlayer && state.ytReady) state.ytPlayer.stopVideo();
  await sb.auth.signOut();
}

// ═══════════════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════════════
async function fetchArtists() {
  const { data, error } = await sb.from('artists').select('*').order('name');
  if (error) throw error;
  state.artists = data ?? [];
}

async function fetchSongs() {
  const { data, error } = await sb
    .from('songs').select('*, artists(name)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  state.songs = (data ?? []).map(s => ({
    ...s, artist_name: s.artists?.name ?? null,
  }));
}

async function addArtist({ name, genre, image_url }) {
  const { error } = await sb.from('artists').insert({
    user_id: state.user.id,
    name, genre: genre || null, image_url: image_url || null,
  });
  if (error) throw error;
  await fetchArtists();
}

async function addSong({ title, artist_id, youtube_url }) {
  const youtube_id = extractYouTubeId(youtube_url);
  if (!youtube_id) throw new Error('Lien YouTube invalide. Utilise un lien youtube.com/watch ou youtu.be/…');
  const { error } = await sb.from('songs').insert({
    user_id: state.user.id,
    title, artist_id: artist_id || null, youtube_url, youtube_id,
  });
  if (error) throw error;
  await fetchSongs();
}

async function deleteArtist(id) {
  const { error } = await sb.from('artists').delete().eq('id', id);
  if (error) throw error;
  await fetchArtists();
  await fetchSongs();
}

async function deleteSong(id) {
  const { error } = await sb.from('songs').delete().eq('id', id);
  if (error) throw error;
  await fetchSongs();
}

// ═══════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════
function showView(name, artistId) {
  $qa('.view').forEach(v => v.classList.remove('active'));
  $qa('.nav-item').forEach(n => n.classList.remove('active'));

  $(`view-${name}`)?.classList.add('active');

  const navKey = name === 'artist-detail' ? 'artists' : name;
  $q(`.nav-item[data-view="${navKey}"]`)?.classList.add('active');

  state.currentView = name;
  $('main-content').scrollTop = 0;

  if      (name === 'home')          renderHome();
  else if (name === 'library')       renderLibrary();
  else if (name === 'artists')       renderArtists();
  else if (name === 'artist-detail') {
    state.currentArtist = artistId;
    renderArtistDetail(artistId);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER — SONG ROW
// ═══════════════════════════════════════════════════════════════════════
function songRowHTML(song, index, showArtist = true) {
  const thumb = song.youtube_id ? ytThumb(song.youtube_id) : null;
  const active = state.currentSong?.id === song.id ? ' active' : '';
  return `
<div class="song-row${active}" data-song-id="${song.id}" data-index="${index}">
  <div class="song-num-wrap">
    <span class="song-num">${index + 1}</span>
    <svg class="icon-play-sm" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
  </div>
  ${thumb
    ? `<img class="song-thumb" src="${escHtml(thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />`
    : `<div class="song-thumb song-thumb-placeholder"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`
  }
  <div class="song-meta">
    <span class="song-name">${escHtml(song.title)}</span>
    ${showArtist && song.artist_name ? `<span class="song-artist-name">${escHtml(song.artist_name)}</span>` : ''}
  </div>
  <button class="btn-delete-song" data-song-id="${song.id}" title="Supprimer">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
  </button>
</div>`;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER — ARTIST CARD
// ═══════════════════════════════════════════════════════════════════════
function artistCardHTML(artist) {
  const initials = artist.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const bg = artist.image_url ? `background-image:url('${escHtml(artist.image_url)}')` : '';
  return `
<div class="artist-card" data-artist-id="${artist.id}">
  <div class="card-img-wrap" style="${bg}">
    ${!artist.image_url ? `<span class="card-initials">${escHtml(initials)}</span>` : ''}
    <button class="card-play-btn" data-artist-id="${artist.id}">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
    </button>
  </div>
  <p class="card-title">${escHtml(artist.name)}</p>
  <p class="card-sub">${artist.genre ? escHtml(artist.genre) : 'Artiste'}</p>
</div>`;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER — HOME
// ═══════════════════════════════════════════════════════════════════════
function renderHome() {
  $('greeting').textContent = getGreeting();

  // Featured grid (6 most recent songs)
  const recent = state.songs.slice(0, 6);
  const featEl = $('featured-songs');
  if (!recent.length) {
    featEl.innerHTML = `<div class="empty-state"><p>Aucune musique pour l'instant.<br>Commence par ajouter tes artistes favoris !</p></div>`;
  } else {
    featEl.innerHTML = recent.map(s => {
      const thumb = s.youtube_id ? ytThumb(s.youtube_id) : '';
      const active = state.currentSong?.id === s.id ? ' style="background:rgba(29,185,84,.2)"' : '';
      return `<div class="featured-item" data-song-id="${s.id}"${active}>
        ${thumb ? `<img src="${escHtml(thumb)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}
        <svg class="featured-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        <span>${escHtml(s.title)}</span>
      </div>`;
    }).join('');
  }

  // Artists row
  const artEl = $('home-artists-row');
  if (!state.artists.length) {
    artEl.innerHTML = `<p class="empty-inline">Aucun artiste — <a href="#" data-action="open-add-artist">en ajouter un</a></p>`;
  } else {
    artEl.innerHTML = state.artists.slice(0, 8).map(artistCardHTML).join('');
  }

  // Recent songs
  const recEl = $('home-recent-songs');
  if (!state.songs.length) {
    recEl.innerHTML = `<p class="empty-inline">Aucune musique — <a href="#" data-action="open-add-song">en ajouter une</a></p>`;
  } else {
    recEl.innerHTML = state.songs.slice(0, 8).map((s, i) => songRowHTML(s, i)).join('');
  }
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER — LIBRARY
// ═══════════════════════════════════════════════════════════════════════
function renderLibrary(filter) {
  const q = filter ?? state.searchQuery;
  const songs = q
    ? state.songs.filter(s =>
        s.title.toLowerCase().includes(q.toLowerCase()) ||
        (s.artist_name ?? '').toLowerCase().includes(q.toLowerCase()))
    : state.songs;

  $('library-count').textContent = `${songs.length} musique${songs.length !== 1 ? 's' : ''}`;
  const el = $('library-songs-list');

  if (!songs.length) {
    el.innerHTML = `<div class="empty-state"><p>${q ? 'Aucun résultat.' : 'Ta bibliothèque est vide.<br>Ajoute tes premières musiques !'}</p></div>`;
    return;
  }
  el.innerHTML = songs.map((s, i) => songRowHTML(s, i)).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER — ARTISTS
// ═══════════════════════════════════════════════════════════════════════
function renderArtists(filter) {
  const q = filter ?? state.searchQuery;
  const artists = q
    ? state.artists.filter(a => a.name.toLowerCase().includes(q.toLowerCase()))
    : state.artists;
  const el = $('artists-grid');

  if (!artists.length) {
    el.innerHTML = `<div class="empty-state"><p>${q ? 'Aucun résultat.' : 'Aucun artiste pour l\'instant.<br>Ajoute tes artistes favoris !'}</p></div>`;
    return;
  }
  el.innerHTML = artists.map(artistCardHTML).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// RENDER — ARTIST DETAIL
// ═══════════════════════════════════════════════════════════════════════
function renderArtistDetail(artistId) {
  const artist = state.artists.find(a => a.id === artistId);
  if (!artist) { showView('artists'); return; }

  $('artist-detail-name').textContent  = artist.name;
  $('artist-detail-genre').textContent = artist.genre ?? '';

  const heroImg = $('artist-hero-image');
  if (artist.image_url) {
    heroImg.style.backgroundImage = `url('${artist.image_url}')`;
    heroImg.innerHTML = '';
  } else {
    heroImg.style.backgroundImage = '';
    heroImg.style.background = 'linear-gradient(135deg, #1DB954 0%, #0d7a3a 100%)';
    const initials = artist.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    heroImg.innerHTML = `<span style="font-size:3.5rem;font-weight:900;color:rgba(255,255,255,.35)">${escHtml(initials)}</span>`;
  }

  $('play-all-btn').dataset.artistId = artistId;

  const artistSongs = state.songs.filter(s => s.artist_id === artistId);
  const el = $('artist-songs-list');
  if (!artistSongs.length) {
    el.innerHTML = `<div class="empty-state"><p>Aucune musique pour cet artiste.<br><a href="#" data-action="open-add-song">En ajouter une</a></p></div>`;
    return;
  }
  el.innerHTML = artistSongs.map((s, i) => songRowHTML(s, i, false)).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// YOUTUBE PLAYER
// ═══════════════════════════════════════════════════════════════════════
window.onYouTubeIframeAPIReady = function () {
  state.ytPlayer = new YT.Player('yt-player', {
    height: '1', width: '1',
    playerVars: { autoplay: 0, controls: 0, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        state.ytReady = true;
        state.ytPlayer.setVolume(parseInt($('volume-slider').value));
      },
      onStateChange: e => {
        if (e.data === YT.PlayerState.PLAYING) {
          state.isPlaying = true;
          startProgressTimer();
          updatePlayPauseBtn(true);
        } else if (e.data === YT.PlayerState.PAUSED) {
          state.isPlaying = false;
          stopProgressTimer();
          updatePlayPauseBtn(false);
        } else if (e.data === YT.PlayerState.ENDED) {
          stopProgressTimer();
          playNext();
        }
      },
    },
  });
};

function playSongNow(song) {
  if (!state.ytReady || !song?.youtube_id) return;
  state.currentSong = song;

  // Player bar UI
  $('player-title').textContent  = song.title;
  $('player-artist').textContent = song.artist_name ?? '';

  const thumb = ytThumb(song.youtube_id);
  $('player-thumb').innerHTML = thumb
    ? `<img src="${escHtml(thumb)}" alt="" />`
    : `<svg class="no-song-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;

  // Highlight active rows everywhere
  $qa('.song-row').forEach(r => r.classList.remove('active'));
  $qa(`[data-song-id="${song.id}"]`).forEach(r => r.classList.add('active'));

  show($('player-bar'));
  state.ytPlayer.loadVideoById(song.youtube_id);
}

function playQueue(songs, startIndex = 0) {
  if (!songs.length) return;
  state.queue      = songs;
  state.queueIndex = startIndex;
  playSongNow(songs[startIndex]);
}

function togglePlay() {
  if (!state.currentSong || !state.ytReady) return;
  state.isPlaying ? state.ytPlayer.pauseVideo() : state.ytPlayer.playVideo();
}

function playNext() {
  if (!state.queue.length) return;
  state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  playSongNow(state.queue[state.queueIndex]);
}

function playPrev() {
  if (!state.queue.length) return;
  if ((state.ytPlayer?.getCurrentTime() ?? 0) > 3) {
    state.ytPlayer.seekTo(0, true);
    return;
  }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playSongNow(state.queue[state.queueIndex]);
}

function startProgressTimer() {
  stopProgressTimer();
  state.progressTimer = setInterval(updateProgress, 500);
}
function stopProgressTimer() {
  clearInterval(state.progressTimer);
  state.progressTimer = null;
}

function updateProgress() {
  if (!state.ytPlayer || !state.isPlaying) return;
  const cur   = state.ytPlayer.getCurrentTime() || 0;
  const total = state.ytPlayer.getDuration()    || 0;
  $('time-current').textContent = formatTime(cur);
  $('time-total').textContent   = formatTime(total);
  const pct = total > 0 ? (cur / total) * 100 : 0;
  $('progress-fill').style.width  = `${pct}%`;
  $('progress-thumb').style.left  = `${pct}%`;
}

function updatePlayPauseBtn(playing) {
  const btn = $('play-pause-btn');
  btn.querySelector('.icon-play')[playing ? 'classList' : 'classList'][playing ? 'add' : 'remove']('hidden');
  btn.querySelector('.icon-pause')[playing ? 'classList' : 'classList'][playing ? 'remove' : 'add']('hidden');
}

// ═══════════════════════════════════════════════════════════════════════
// ARTIST SELECT (in "add song" modal)
// ═══════════════════════════════════════════════════════════════════════
function populateArtistSelect(preselect) {
  $('song-artist').innerHTML = '<option value="">— Sans artiste —</option>' +
    state.artists.map(a =>
      `<option value="${a.id}"${preselect === a.id ? ' selected' : ''}>${escHtml(a.name)}</option>`
    ).join('');
}

// ═══════════════════════════════════════════════════════════════════════
// EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════
function initEvents() {

  // ── AUTH TABS ─────────────────────────────────────────────────
  $qa('.auth-tab').forEach(tab => tab.addEventListener('click', () => {
    $qa('.auth-tab').forEach(t => t.classList.remove('active'));
    $qa('.auth-form').forEach(f => f.classList.remove('active'));
    tab.classList.add('active');
    $(`${tab.dataset.tab}-form`).classList.add('active');
  }));

  // ── LOGIN ─────────────────────────────────────────────────────
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Connexion…';
    const err = $('login-error'); hide(err);
    try {
      await login($('login-email').value, $('login-password').value);
    } catch (ex) {
      err.textContent = ex.message; show(err);
      btn.disabled = false; btn.textContent = 'Se connecter';
    }
  });

  // ── REGISTER ──────────────────────────────────────────────────
  $('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Création…';
    const errEl = $('register-error'), succEl = $('register-success');
    hide(errEl); hide(succEl);
    try {
      await register($('reg-email').value, $('reg-password').value);
      succEl.textContent = 'Compte créé ! Vérifie ton email pour confirmer.';
      show(succEl); btn.textContent = '✓ Compte créé';
    } catch (ex) {
      errEl.textContent = ex.message; show(errEl);
      btn.disabled = false; btn.textContent = 'Créer un compte';
    }
  });

  // ── LOGOUT ────────────────────────────────────────────────────
  $('logout-btn').addEventListener('click', () =>
    showConfirm('Se déconnecter', 'Tu vas être déconnecté(e).', logout)
  );

  // ── SIDEBAR NAV ───────────────────────────────────────────────
  $qa('.nav-item').forEach(el => el.addEventListener('click', e => {
    e.preventDefault();
    showView(el.dataset.view);
  }));
  $q('.sidebar-logo').addEventListener('click', () => showView('home'));

  // ── OPEN MODALS ───────────────────────────────────────────────
  $('open-add-artist').addEventListener('click', () => {
    $('form-add-artist').reset();
    $('artist-image-preview').innerHTML = '';
    hide($('add-artist-error'));
    openModal('modal-add-artist');
  });

  $('open-add-song').addEventListener('click', () => {
    $('form-add-song').reset();
    hide($('youtube-preview')); hide($('add-song-error'));
    populateArtistSelect(state.currentArtist);
    openModal('modal-add-song');
  });

  // ── CLOSE MODALS ──────────────────────────────────────────────
  $qa('.modal-close, .modal-backdrop').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset?.modal ?? el.closest('.modal')?.id;
      if (id) closeModal(id);
    });
  });

  // ── CONFIRM YES ───────────────────────────────────────────────
  $('confirm-yes').addEventListener('click', async () => {
    if (_confirmCb) { await _confirmCb(); _confirmCb = null; }
    closeModal('modal-confirm');
  });

  // ── ADD ARTIST ────────────────────────────────────────────────
  $('form-add-artist').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    const errEl = $('add-artist-error'); hide(errEl);
    btn.disabled = true;
    try {
      await addArtist({
        name:      $('artist-name').value.trim(),
        genre:     $('artist-genre').value.trim(),
        image_url: $('artist-image').value.trim(),
      });
      closeModal('modal-add-artist');
      toast('Artiste ajouté !', 'success');
      if (state.currentView === 'home')    renderHome();
      if (state.currentView === 'artists') renderArtists();
    } catch (ex) {
      errEl.textContent = ex.message; show(errEl);
    } finally { btn.disabled = false; }
  });

  // Artist image preview
  $('artist-image').addEventListener('input', e => {
    const url = e.target.value.trim();
    const prev = $('artist-image-preview');
    prev.innerHTML = url
      ? `<img src="${escHtml(url)}" alt="Aperçu" onerror="this.parentElement.innerHTML='<span class=form-error-inline>Image introuvable</span>'" />`
      : '';
  });

  // ── ADD SONG ──────────────────────────────────────────────────
  $('form-add-song').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type=submit]');
    const errEl = $('add-song-error'); hide(errEl);
    btn.disabled = true;
    try {
      await addSong({
        title:       $('song-title').value.trim(),
        artist_id:   $('song-artist').value || null,
        youtube_url: $('song-youtube').value.trim(),
      });
      closeModal('modal-add-song');
      toast('Musique ajoutée !', 'success');
      if (state.currentView === 'home')          renderHome();
      if (state.currentView === 'library')       renderLibrary();
      if (state.currentView === 'artist-detail') renderArtistDetail(state.currentArtist);
    } catch (ex) {
      errEl.textContent = ex.message; show(errEl);
    } finally { btn.disabled = false; }
  });

  // YouTube URL live preview
  $('song-youtube').addEventListener('input', e => {
    const id = extractYouTubeId(e.target.value.trim());
    const prev = $('youtube-preview');
    if (id) {
      $('yt-thumb-preview').src    = ytThumb(id);
      $('yt-id-display').textContent = `✓ ID : ${id}`;
      show(prev);
    } else { hide(prev); }
  });

  // ── DELEGATED CLICKS (song rows, artist cards, etc.) ──────────
  document.addEventListener('click', e => {

    // Delete song
    const delSong = e.target.closest('.btn-delete-song');
    if (delSong) {
      e.stopPropagation();
      const id   = delSong.dataset.songId;
      const song = state.songs.find(s => s.id === id);
      showConfirm('Supprimer la musique', `Supprimer "${song?.title ?? 'cette musique'}" ?`, async () => {
        await deleteSong(id);
        if (state.currentSong?.id === id) { hide($('player-bar')); state.currentSong = null; }
        toast('Musique supprimée.', 'info');
        if (state.currentView === 'home')          renderHome();
        if (state.currentView === 'library')       renderLibrary();
        if (state.currentView === 'artist-detail') renderArtistDetail(state.currentArtist);
      });
      return;
    }

    // Play song row
    const songRow = e.target.closest('.song-row');
    if (songRow) {
      const id    = songRow.dataset.songId;
      const song  = state.songs.find(s => s.id === id); if (!song) return;
      const rows  = [...songRow.parentElement.querySelectorAll('.song-row')];
      const queue = rows.map(r => state.songs.find(s => s.id === r.dataset.songId)).filter(Boolean);
      const idx   = queue.findIndex(s => s.id === id);
      playQueue(queue, idx >= 0 ? idx : 0);
      return;
    }

    // Artist card play button
    const cardPlay = e.target.closest('.card-play-btn');
    if (cardPlay) {
      e.stopPropagation();
      const songs = state.songs.filter(s => s.artist_id === cardPlay.dataset.artistId);
      songs.length ? playQueue(songs, 0) : toast('Cet artiste n\'a pas encore de musique.', 'info');
      return;
    }

    // Artist card → detail
    const artistCard = e.target.closest('.artist-card');
    if (artistCard) {
      showView('artist-detail', artistCard.dataset.artistId);
      return;
    }

    // Featured item
    const feat = e.target.closest('.featured-item');
    if (feat) {
      const id  = feat.dataset.songId;
      const idx = state.songs.findIndex(s => s.id === id);
      playQueue(state.songs.slice(0, 6), idx >= 0 ? idx : 0);
      return;
    }

    // Play all button (artist detail)
    if (e.target.closest('#play-all-btn')) {
      const songs = state.songs.filter(s => s.artist_id === $('play-all-btn').dataset.artistId);
      songs.length ? playQueue(songs, 0) : toast('Aucune musique pour cet artiste.', 'info');
      return;
    }

    // Delete artist
    if (e.target.closest('#delete-artist-btn')) {
      const artist = state.artists.find(a => a.id === state.currentArtist);
      showConfirm('Supprimer l\'artiste', `Supprimer "${artist?.name ?? 'cet artiste'}" et toutes ses musiques ?`, async () => {
        await deleteArtist(state.currentArtist);
        toast('Artiste supprimé.', 'info');
        showView('artists');
      });
      return;
    }

    // See-all links
    const seeAll = e.target.closest('[data-view]');
    if (seeAll && seeAll.tagName === 'A') {
      e.preventDefault(); showView(seeAll.dataset.view); return;
    }

    // data-action links
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      e.preventDefault();
      if (actionEl.dataset.action === 'open-add-artist') $('open-add-artist').click();
      if (actionEl.dataset.action === 'open-add-song')   $('open-add-song').click();
    }
  });

  // ── PLAYER CONTROLS ───────────────────────────────────────────
  $('play-pause-btn').addEventListener('click', togglePlay);
  $('next-btn').addEventListener('click', playNext);
  $('prev-btn').addEventListener('click', playPrev);

  $('progress-bar').addEventListener('click', e => {
    if (!state.ytReady || !state.currentSong) return;
    const r = $('progress-bar').getBoundingClientRect();
    state.ytPlayer.seekTo(((e.clientX - r.left) / r.width) * (state.ytPlayer.getDuration() || 0), true);
  });

  $('volume-slider').addEventListener('input', e => {
    if (state.ytReady) state.ytPlayer.setVolume(parseInt(e.target.value));
  });

  // ── SEARCH ────────────────────────────────────────────────────
  $('search-input').addEventListener('input', e => {
    state.searchQuery = e.target.value;
    if (state.currentView === 'library') renderLibrary(state.searchQuery);
    if (state.currentView === 'artists') renderArtists(state.searchQuery);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// SHOW / HIDE APP vs AUTH
// ═══════════════════════════════════════════════════════════════════════
async function showApp(user) {
  state.user = user;
  $('user-email-display').textContent = user.email ?? '';
  $('user-avatar').textContent        = (user.email ?? '?')[0].toUpperCase();
  hide($('auth-screen'));
  show($('app'));
  await Promise.all([fetchArtists(), fetchSongs()]);
  showView('home');
}

function showAuth() {
  state.user = null; state.songs = []; state.artists = [];
  stopProgressTimer();
  show($('auth-screen'));
  hide($('app'));
  hide($('player-bar'));
}

// ═══════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════
async function init() {
  // Guard: config not set
  if (SUPABASE_URL === 'YOUR_SUPABASE_URL' || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;
                  background:#121212;color:#fff;font-family:sans-serif;text-align:center;padding:2rem">
        <div>
          <div style="font-size:3rem;margin-bottom:1rem">🎵</div>
          <h2 style="color:#1DB954;font-size:1.5rem;margin-bottom:.75rem">Configuration requise</h2>
          <p style="color:#b3b3b3;line-height:1.8">
            Ouvre <code style="background:#282828;padding:3px 8px;border-radius:4px;color:#fff">js/config.js</code>
            et remplace<br>
            <code style="color:#1DB954">YOUR_SUPABASE_URL</code> et
            <code style="color:#1DB954">YOUR_SUPABASE_ANON_KEY</code><br>
            avec tes clés Supabase.
          </p>
          <p style="margin-top:1.25rem;color:#737373;font-size:.85rem">
            Exécute aussi <code style="background:#282828;padding:2px 6px;border-radius:4px;color:#b3b3b3">supabase/schema.sql</code>
            dans l'éditeur SQL Supabase.
          </p>
        </div>
      </div>`;
    return;
  }

  initEvents();

  // Check current session
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) { await showApp(session.user); }
  else               { showAuth(); }

  // Listen for auth changes
  sb.auth.onAuthStateChange(async (event, session) => {
    if      (event === 'SIGNED_IN'  && session?.user) await showApp(session.user);
    else if (event === 'SIGNED_OUT')                   showAuth();
  });

  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
}

init();
