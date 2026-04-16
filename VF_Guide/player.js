/* =============================================================
   VIRTUAL FIELD TRIP — player.js
   -------------------------------------------------------------
   DATA SCHEMA  (*.VFJF — a JSON file)
   -------------------------------------------------------------
   {
     "root":            "Trip Title",
     "start_node":      "node_id",
     "thank_you":       "audio/thankyou.mp3",  // optional — plays on completion
     "thank_you_text":  "Thanks for joining us!", // optional — shown in completion banner
     "nodes": {
       "node_id": {
         "text":    "Narrator text shown in the card.",
         "audio":   "audio/node.mp3",       // optional
         "end":     true,                   // optional — marks a branch as complete without requiring a visit
         "choices": [
           { "text": "Choice label",  "next": "other_node_id" },
           { "text": "Let's go back", "next": "prev_node_id",  "back": true }
           { "text": "End tour",      "next": "end", "end": true }
         ]
       }
     }
   }

   URL FORMAT
   -------------------------------------------------------------
   ?file=K12/Virtual_Fieldtrips/TripName/TripName.VFJF
   ============================================================= */


// ── State ────────────────────────────────────────────────────

let data             = null;       // parsed JSON from the .VFJF file
let fileBase         = '';         // root path used to resolve relative audio URLs
let currentNode      = null;       // id of the node currently on screen
let isPlaying        = false;      // true while narration audio is playing
let visitedNodes     = new Set();  // ids of every node the user has seen
let audioPlayedNodes = new Set();  // ids of nodes whose audio has already played — no replays on revisit
let totalNodes       = 0;
let tripComplete     = false;

// When the trip completes mid-playback, the thank-you clip is queued here
// and fired once the current narration finishes.
let pendingThankYou = null;

const player = document.getElementById('player');


// ── Audio cache ──────────────────────────────────────────────
// Pre-fetches upcoming audio files into Blob URLs so there's no
// network delay between a choice tap and audio start.
// Note: Blob URLs accumulate for the lifetime of the page. For typical
// trip sizes this is negligible; there is intentionally no cache eviction.

const audioCache = new Map();

function prefetchAudio(url) {
  if (audioCache.has(url)) return;

  const entry = { blob: null, objectUrl: null, state: 'loading' };
  audioCache.set(url, entry);

  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then(blob => {
      entry.blob      = blob;
      entry.objectUrl = URL.createObjectURL(blob);
      entry.state     = 'ready';
    })
    .catch(err => {
      console.warn('Audio prefetch failed:', url, err);
      entry.state = 'error';
    });
}

// Pre-fetch audio for every forward child of the given node.
function prefetchNodeAudio(nodeId) {
  const node = data.nodes[nodeId];
  if (!node?.choices) return;

  node.choices.forEach(choice => {
    if (choice.back) return;
    const next = data.nodes[choice.next];
    if (!next?.audio) return;
    const safePath = sanitiseAudioPath(next.audio);
    if (!safePath) return;
    prefetchAudio(buildAudioUrl(safePath));
  });
}

// Return a cached Blob URL if available, otherwise fall back to the
// original network URL (the player will retry on error too).
function resolveAudioSrc(url) {
  const entry = audioCache.get(url);
  if (entry?.state === 'ready' && entry.objectUrl) return entry.objectUrl;
  return url;
}


// ── Path helpers ─────────────────────────────────────────────

// Reject absolute URLs (anything with a scheme before a slash) and
// paths that try to escape the base directory with '..'.
function sanitiseAudioPath(audioPath) {
  if (typeof audioPath !== 'string' || audioPath.trim() === '') return null;
  const colonIdx = audioPath.indexOf(':');
  const slashIdx = audioPath.indexOf('/');
  if (colonIdx !== -1 && (slashIdx === -1 || colonIdx < slashIdx)) return null;
  if (audioPath.includes('..')) return null;
  return audioPath;
}

function buildAudioUrl(audioPath) {
  return fileBase + audioPath;
}

// Validate and sanitise the ?file= parameter.
// Permits only alphanumeric characters, underscores, hyphens, forward
// slashes, and dots — and rejects any path component that is '..'.
function sanitiseFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') return null;
  if (!/^[\w\-./]+$/.test(filePath)) return null;
  if (filePath.split('/').some(part => part === '..')) return null;
  return filePath;
}


// ── Subtree completion ───────────────────────────────────────
// A choice button only gets the ✓ checkmark when the node it points
// to has been visited AND every forward-reachable descendant of that
// node has also been visited.  Back-tagged choices are ignored entirely
// so cycles in the graph don't cause infinite recursion.

function isSubtreeComplete(nodeId, seen = new Set()) {
  // Guard against cycles (shouldn't happen in well-formed data, but safe).
  if (seen.has(nodeId)) return true;
  seen.add(nodeId);

  const node = data.nodes[nodeId];
  if (!node) return true; // unknown node id (e.g. the sentinel "end") — don't block completion

  // End nodes are considered complete regardless of whether they've been visited.
  if (node.end === true) return true;

  // The node itself must have been visited.
  if (!visitedNodes.has(nodeId)) return false;

  // Forward choices: skip back-tagged entries and end-tagged entries.
  const forwardChoices = (node.choices || []).filter(c => !c.back && !c.end);

  // Leaf node (no forward choices) — already visited, so complete.
  if (forwardChoices.length === 0) return true;

  // Every forward child must itself be subtree-complete.
  return forwardChoices.every(c => isSubtreeComplete(c.next, seen));
}


// ── Progress ─────────────────────────────────────────────────
// Progress counts visited nodes as before.  Completion fires when
// the entire tree rooted at start_node is fully explored.

function updateProgress() {
  const pct   = totalNodes > 0 ? Math.round((visitedNodes.size / totalNodes) * 100) : 0;
  const fill  = document.getElementById('progress-bar-fill');
  const pctEl = document.getElementById('progress-pct');
  if (!fill || !pctEl) return;

  fill.style.width  = pct + '%';
  pctEl.textContent = pct + '%';

  if (!tripComplete && isSubtreeComplete(data.start_node)) {
    tripComplete = true;
    fill.style.width = '100%';
    pctEl.textContent = '100%';
    fill.classList.add('complete');
    pctEl.classList.add('complete');
    document.getElementById('book').classList.add('complete');
    scheduleThankYouAudio();
  }
}

// Queue the thank-you clip so it plays after the current narration ends
// rather than interrupting it.
function scheduleThankYouAudio() {
  if (!data.thank_you) return;
  const safePath = sanitiseAudioPath(data.thank_you);
  if (!safePath) return;

  const url = buildAudioUrl(safePath);
  prefetchAudio(url);
  pendingThankYou = url;
}

function flushPendingThankYou() {
  if (!pendingThankYou) return;
  pendingThankYou = null;
  endReward();
}


// ── Initialisation ───────────────────────────────────────────

async function init() {
  const params        = new URLSearchParams(location.search);
  const rawFilePath   = params.get('file');
  const filePath      = sanitiseFilePath(rawFilePath);

  if (!filePath) {
    showError('⚠️', 'No file specified.',
      'Add ?file=Virtual_Fieldtrips/TripName/TripName.VFJF to the URL.');
    return;
  }

  // Derive the directory so relative audio paths resolve correctly.
  const slashIdx = filePath.lastIndexOf('/');
  fileBase = '/' + (slashIdx >= 0 ? filePath.slice(0, slashIdx + 1) : '');

  try {
    const res = await fetch('/' + filePath);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (e) {
    showError('⚠️', 'Could not load trip file.', e.message, filePath);
    return;
  }

  if (!data.nodes || !data.start_node || !data.nodes[data.start_node]) {
    showError('⚠️', 'Invalid trip file.', 'Missing nodes or start_node.');
    return;
  }

  totalNodes = Object.keys(data.nodes).length;

  // Update page title, header h1, and the background image.
  const tripTitle = String(data.name || 'Virtual Field Trip').trim();
  document.title = tripTitle;
  document.body.style.backgroundImage = `url('Virtual_Fieldtrips/${data.root}/bg.png')`;
  setHeaderTitle(tripTitle);

  // Pre-fetch start-node audio and the optional thank-you clip early.
  const startNode = data.nodes[data.start_node];
  if (startNode?.audio) {
    const safePath = sanitiseAudioPath(startNode.audio);
    if (safePath) prefetchAudio(buildAudioUrl(safePath));
  }
  if (data.thank_you) {
    const safePath = sanitiseAudioPath(data.thank_you);
    if (safePath) prefetchAudio(buildAudioUrl(safePath));
  }

  showSplash(tripTitle, !!(startNode?.audio));
}

// Update the h1 so the final word is wrapped in <em> for italic styling.
function setHeaderTitle(tripTitle) {
  const h1    = document.getElementById('title-text');
  const words = tripTitle.split(' ');
  h1.textContent = '';

  if (words.length > 1) {
    h1.appendChild(document.createTextNode(words.slice(0, -1).join(' ') + ' '));
  }

  const em = document.createElement('em');
  em.textContent = words[words.length - 1];
  h1.appendChild(em);
}


// ── Splash screen ────────────────────────────────────────────

function showSplash(tripTitle, hasAudio) {
  const book = document.getElementById('book');
  book.textContent = '';

  const splash = el('div', { id: 'splash' });
  splash.appendChild(el('span', { id: 'splash-icon-v1'}));
  splash.appendChild(el('div', { id: 'splash-title', text: tripTitle }));
  splash.appendChild(el('p', {
    id: 'splash-hint',
    text: hasAudio
      ? 'Audio narration is included — make sure your sound is on.'
      : 'Use the choices below to explore each stop on the trip.',
  }));

  const btn = el('button', { id: 'start-btn', text: 'Begin Tour →' });
  btn.addEventListener('click', () => {
    document.getElementById('progress-widget').style.display = 'flex';
    renderShell();
    goTo(data.start_node, /* playAudio */ true, /* choiceText */ null, /* isBack */ false);
  });
  splash.appendChild(btn);

  book.appendChild(splash);
}


// ── Shell (narrator + choices panels) ────────────────────────

function renderShell() {
  const book = document.getElementById('book');
  book.textContent = '';

  // Narrator panel
  const narrator = el('div', { id: 'narrator' });
  narrator.appendChild(el('div', { id: 'narrator-label', text: 'Narrator' }));

  // Q row — echoes the choice the user just selected
  const qaQuestion = el('div', { id: 'qa-question' });
  qaQuestion.appendChild(el('span', { className: 'qa-label q', text: 'Q:' }));
  qaQuestion.appendChild(el('span', { id: 'qa-question-text' }));
  narrator.appendChild(qaQuestion);

  // A row — narrator's response
  const qaAnswer = el('div', { id: 'qa-answer' });
  qaAnswer.appendChild(el('span', { id: 'a-label', text: 'A:' }));
  qaAnswer.appendChild(el('span', { id: 'narrator-text' }));
  narrator.appendChild(qaAnswer);

  // Animated audio indicator
  const audioIndicator = el('div', { id: 'audio-indicator', className: 'hidden' });
  const wave = el('div', { className: 'wave' });
  for (let i = 0; i < 5; i++) wave.appendChild(el('span'));
  audioIndicator.appendChild(wave);
  audioIndicator.appendChild(document.createTextNode('Playing…'));
  narrator.appendChild(audioIndicator);

  book.appendChild(narrator);

  // Choices panel
  const choices = el('div', { id: 'choices' });
  choices.appendChild(el('div', { id: 'choices-label', text: 'Your response' }));

  // Completion banner — hidden until the full tree is explored.
  // Text is overridden by thank_you_text in the data file if present.
  const banner = el('div', { id: 'complete-banner' });
  banner.appendChild(el('span', { className: 'cb-icon', text: '🎉' }));
  const bannerText = el('span', { className: 'cb-text' });
  bannerText.textContent = data?.thank_you_text?.trim() || "You've explored the entire trip — great work!";
  banner.appendChild(bannerText);
  choices.appendChild(banner);

  book.appendChild(choices);
}


// ── Navigation ───────────────────────────────────────────────
// isBack = true  → backwards: no audio, Q label hidden
// isBack = false → forwards:  play audio, show Q label

function goTo(nodeId, playAudio, choiceText, isBack) {
  const node = data.nodes[nodeId];
  if (!node) { console.warn('Unknown node:', nodeId); return; }

  visitedNodes.add(nodeId);
  currentNode = nodeId;

  renderNarrator(node, isBack ? null : choiceText);
  renderChoices(node);
  updateProgress();
  prefetchNodeAudio(nodeId);

  if (playAudio && node.audio && !audioPlayedNodes.has(nodeId)) {
    audioPlayedNodes.add(nodeId);
    const safePath = sanitiseAudioPath(node.audio);
    if (safePath) {
      const url = buildAudioUrl(safePath);
      playAudioFile(resolveAudioSrc(url), url);
    } else {
      console.warn('Rejected unsafe audio path:', node.audio);
    }
  }
}

function choiceClicked(choice) {
  if (isPlaying) return;
  const isBack = !!choice.back;
  goTo(choice.next, /* playAudio */ !isBack, choice.text, isBack);
}


// ── Audio playback ───────────────────────────────────────────

function playAudioFile(src, canonicalUrl) {
  player.pause();
  player.src = src;
  isPlaying  = true;
  setWave(true);
  lockChoices(true);

  const done = () => {
    isPlaying  = false;
    setWave(false);
    lockChoices(false);
    player.onended = null;
    player.onerror = null;
    // Clear the stored promise reference only after this tick so that any
    // in-flight inflight.catch().then() chains in endThanksText() still see it.
    Promise.resolve().then(() => { player._playPromise = null; });

    if (pendingThankYou) flushPendingThankYou();
  };

  player.onended = done;

  player.onerror = (e) => {
    if (src !== canonicalUrl) {
      player.src = canonicalUrl;
      player.play().catch(err => { console.warn('Audio retry failed:', err); done(); });
    } else {
      console.warn('Audio error:', src, e);
      done();
    }
  };

  const p = player.play();
  player._playPromise = p;
  p.catch(e => { console.warn('play() rejected:', e); done(); });
}


// ── Rendering helpers ────────────────────────────────────────

function renderNarrator(node, choiceText) {
  const qaQuestion = document.getElementById('qa-question');
  const qText      = document.getElementById('qa-question-text');
  const aLabel     = document.getElementById('a-label');

  if (choiceText) {
    qText.textContent = choiceText;
    qaQuestion.classList.add('visible');
    aLabel.style.visibility = 'visible';
  } else {
    qText.textContent = '';
    qaQuestion.classList.remove('visible');
    aLabel.style.visibility = 'hidden';
  }

  // Re-trigger fade-in by forcing a reflow to restart the animation.
  const narratorText = document.getElementById('narrator-text');
  narratorText.style.animation = 'none';
  void narratorText.offsetHeight;
  narratorText.style.animation = '';
  narratorText.classList.add('fade-in');
  narratorText.textContent = node.text || '';
}

function renderChoices(node) {
  const container = document.getElementById('choices');
  const label     = document.getElementById('choices-label');
  const banner    = document.getElementById('complete-banner');

  // Remove old choice buttons while keeping the label and banner.
  Array.from(container.children).forEach(child => {
    if (child !== label && child !== banner) child.remove();
  });

  const choices        = node.choices || [];
  const forwardChoices = choices.filter(c => !c.back);
  const backChoices    = choices.filter(c =>  c.back);

  if (choices.length === 0) {
    const endMsg = document.createElement('p');
    endMsg.style.cssText = 'color:var(--text-muted);font-size:0.85rem;font-style:italic;margin-top:0.5rem;';
    endMsg.textContent = '— End of trip —';
    container.insertBefore(endMsg, banner);
    return;
  }

  forwardChoices.forEach(choice => {
    const btn = el('button', { className: 'choice-btn fade-in', text: choice.text });
    // ✓ only appears once the entire subtree under this choice is fully explored.
    // End-tagged choices use choice.end rather than a real node lookup.
    if (choice.end || isSubtreeComplete(choice.next)) btn.classList.add('visited');
    btn.addEventListener('click', () => choiceClicked(choice));
    container.insertBefore(btn, banner);
  });

  // Back buttons are rendered separately and never receive the 'visited'
  // class — navigating backwards doesn't count as exploring a new stop.
  backChoices.forEach(choice => {
    const btn = el('button', { className: 'choice-btn back-btn fade-in', text: choice.text });
    btn.addEventListener('click', () => choiceClicked(choice));
    container.insertBefore(btn, banner);
  });
}

function lockChoices(locked) {
  document.querySelectorAll('.choice-btn').forEach(btn => { btn.disabled = locked; });
}

function setWave(visible) {
  document.getElementById('audio-indicator')?.classList.toggle('hidden', !visible);
}


// ── Error screen ─────────────────────────────────────────────

function showError(icon, headline, detail, file) {
  const book = document.getElementById('book');
  book.textContent = '';

  const status = el('div', { id: 'status' });
  status.appendChild(el('div', { className: 'big', text: icon }));
  status.appendChild(el('p', { text: headline }));

  if (file) {
    const pFile = el('p');
    pFile.style.cssText = 'margin-top:0.5rem;font-size:0.85rem;';
    pFile.appendChild(document.createTextNode('File: '));
    pFile.appendChild(el('code', { text: file }));
    status.appendChild(pFile);
  }

  if (detail) {
    const p2 = el('p', { text: detail });
    p2.style.cssText = 'margin-top:0.35rem;font-size:0.85rem;';
    status.appendChild(p2);
  }

  book.appendChild(status);
}


// ── DOM utility ──────────────────────────────────────────────
// Lightweight element factory: el(tag, { id, className, text, attrs }) → HTMLElement
// 'attrs' is an optional plain object of additional attributes to set (e.g. data-*, aria-*).

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.id)        node.id         = opts.id;
  if (opts.className) node.className   = opts.className;
  if (opts.text)      node.textContent = opts.text;
  if (opts.attrs) {
    Object.entries(opts.attrs).forEach(([k, v]) => node.setAttribute(k, v));
  }
  return node;
}


// ── Bootstrap ────────────────────────────────────────────────

init();


// ── Dev shortcut ─────────────────────────────────────────────
// In the browser console, type:  VFT.fastMode()
// Each audio clip will be trimmed to ~0.1 s so you can skip through
// nodes instantly without any logic changing.
// Restore with:  VFT.fastMode(false)
// This helper is intentionally stripped in production builds via the
// build pipeline (tree-shaken when VFT is not referenced externally).

function _fastModeHandler() {
  // duration is not available at 'play' time — wait for metadata.
  // If it's already known (e.g. cached blob), seek immediately.
  const seek = () => {
    if (isFinite(player.duration) && player.duration > 0.15) {
      player.currentTime = player.duration - 0.1;
    }
  };

  if (isFinite(player.duration) && player.duration > 0) {
    seek();
  } else {
    // Metadata not yet loaded — wait for it, then seek once.
    player.addEventListener('loadedmetadata', seek, { once: true });
  }
}

window.VFT = {
  fastMode(on = true) {
    if (on) {
      player.addEventListener('play', _fastModeHandler);
      console.info('[VFT] Fast mode ON — audio capped to ~0.1 s');
    } else {
      player.removeEventListener('play', _fastModeHandler);
      console.info('[VFT] Fast mode OFF — normal playback restored');
    }
  },
};


// ── Reward & completion ──────────────────────────────────────

async function serverRewards(itemId, particleName) {
  const params = new URLSearchParams(window.location.search);

  // Pull only the expected parameters and coerce to strings so no
  // object or array values sneak through into the POST body.
  const safeString = (v) => (typeof v === 'string' ? v.slice(0, 512) : '');

  const visitorId          = safeString(params.get('visitorId'));
  const urlSlug            = safeString(params.get('urlSlug'));
  const assetId            = safeString(params.get('assetId'));
  const interactiveNonce   = safeString(params.get('interactiveNonce'));
  const interactivePublicKey = safeString(params.get('interactivePublicKey'));

  const payload = {
    visitorId,
    urlSlug,
    assetId,
    interactiveNonce,
    interactivePublicKey,
    dataObject: {
      itemId: { value: itemId },
      particleName: { value: particleName },
    },
  };

  try {
    const [emoteRes, particleRes] = await Promise.all([
      fetch('https://road-shannon-wendy-menu.trycloudflare.com/webhook/grant-inventory-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => {
        if (!r.ok) throw new Error(`reward-emote HTTP ${r.status}`);
        return r.json();
      }),

      fetch('https://road-shannon-wendy-menu.trycloudflare.com/webhook/play-particle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(r => {
        if (!r.ok) throw new Error(`play-particle HTTP ${r.status}`);
        return r.json();
      }),
    ]);

    console.log('emote:', emoteRes);
    console.log('particle:', particleRes);

    return { emoteRes, particleRes };
  } catch (err) {
    console.error('serverRewards failed:', err);
    return null;
  }
}

// Renamed from EndReward → endReward (consistent camelCase).
function endReward() {
  serverRewards('1d4eee32-409e-45e5-8f0a-b215f6b7cd54', 'classicConfetti_explosion');
  showThanksOverlay();
}

// ── Thanks overlay ───────────────────────────────────────────
// Separated from audio playback and confetti so each concern is
// independently testable and replaceable.

function showThanksOverlay() {
  // Safely read the thank-you message — never use innerHTML for user data.
  const thanksText = data.thank_you_text?.trim() || 'Thanks for exploring with me!';

  const overlay = document.createElement('div');
  overlay.id = 'thanks-overlay';

  const canvas = document.createElement('canvas');
  canvas.id = 'confetti-canvas';

  const card = document.createElement('div');
  card.id = 'thanks-card';

  const icon = el('span', { id: 'thanks-icon', text: '🎉' });

  const heading = el('div', { id: 'thanks-heading', text: 'Tour complete!' });

  const text = el('p', { id: 'thanks-text' });
  text.textContent = thanksText; // textContent — never innerHTML — avoids XSS

  const audioInd = document.createElement('div');
  audioInd.id = 'thanks-audio-indicator';
  const thanksWave = el('div', { className: 'thanks-wave' });
  for (let i = 0; i < 5; i++) thanksWave.appendChild(document.createElement('span'));
  audioInd.appendChild(thanksWave);
  audioInd.appendChild(document.createTextNode('Playing…'));

  card.appendChild(icon);
  card.appendChild(heading);
  card.appendChild(text);
  card.appendChild(audioInd);
  overlay.appendChild(canvas);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  playThanksAudio(audioInd);
  runConfetti(canvas);
}

function playThanksAudio(audioIndicator) {
  if (!data.thank_you) {
    audioIndicator?.classList.add('hidden');
    return;
  }

  const safePath = sanitiseAudioPath(data.thank_you);
  if (!safePath) {
    audioIndicator?.classList.add('hidden');
    return;
  }

  const url = buildAudioUrl(safePath);
  const src = resolveAudioSrc(url);

  // Wait for any in-flight play() promise to settle before touching
  // the player — prevents AbortError on rapid transitions.
  const inflight = player._playPromise || Promise.resolve();
  inflight.catch(() => {}).then(() => {
    // _playPromise is cleared after this tick (see done() in playAudioFile),
    // so by the time we reach here it is already null — safe to reuse player.
    player.src = src;

    const done = () => {
      player.onended      = null;
      player.onerror      = null;
      player._playPromise = null;
      audioIndicator?.classList.add('hidden');
    };

    player.onended = done;
    player.onerror = () => {
      if (src !== url) {
        player.src = url;
        player.play().catch(done);
      } else {
        done();
      }
    };

    const p = player.play();
    player._playPromise = p;
    p.catch(done);
  });
}


// ── Confetti ─────────────────────────────────────────────────

function runConfetti(canvas) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // canvas not supported in this environment

  const W      = canvas.width  = window.innerWidth;
  const H      = canvas.height = window.innerHeight;
  const COLORS = ['#62C7FF', '#0035F0', '#8EE68C', '#004C2C', '#FFEA2F', '#A2DEFF', '#4ADC51'];
  const COUNT  = 180;

  const pieces = Array.from({ length: COUNT }, () => ({
    x:     Math.random() * W,
    y:     Math.random() * -H * 0.6,
    r:     4 + Math.random() * 6,
    dx:    (Math.random() - 0.5) * 2.2,
    dy:    2.5 + Math.random() * 4,
    rot:   Math.random() * Math.PI * 2,
    drot:  (Math.random() - 0.5) * 0.14,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    shape: Math.random() > 0.45 ? 'rect' : 'circle',
    alpha: 1,
  }));

  let start = null;
  const DURATION = 4200;

  function frame(ts) {
    if (!start) start = ts;
    const elapsed = ts - start;
    ctx.clearRect(0, 0, W, H);
    let alive = false;

    for (const p of pieces) {
      p.x   += p.dx;
      p.y   += p.dy;
      p.rot += p.drot;
      if (elapsed > DURATION - 1200) p.alpha = Math.max(0, p.alpha - 0.018);
      if (p.alpha <= 0) continue;
      alive = true;

      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;

      if (p.shape === 'rect') {
        ctx.fillRect(-p.r, -p.r * 0.45, p.r * 2, p.r * 0.9);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.r * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    if (alive && elapsed < DURATION + 400) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, W, H);
  }

  requestAnimationFrame(frame);
}
