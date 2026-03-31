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
         "choices": [
           { "text": "Choice label",  "next": "other_node_id" },
           { "text": "← Go back",     "next": "prev_node_id",  "back": true }
         ]
       }
     }
   }

   URL FORMAT
   -------------------------------------------------------------
   ?file=Virtual_Fieldtrips/TripName/TripName.VFJF

   IFRAME USAGE
   -------------------------------------------------------------
   When the tour completes, player.js posts a message to the
   parent window so the embedding page can close / hide the iframe:

     window.addEventListener('message', (e) => {
       if (e.data?.type === 'vft-complete') {
         // e.g. document.getElementById('tour-frame').remove();
       }
     });
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


// ── Progress ─────────────────────────────────────────────────

function updateProgress() {
  const pct   = totalNodes > 0 ? Math.round((visitedNodes.size / totalNodes) * 100) : 0;
  const fill  = document.getElementById('progress-bar-fill');
  const pctEl = document.getElementById('progress-pct');
  if (!fill || !pctEl) return;

  fill.style.width  = pct + '%';
  pctEl.textContent = pct + '%';

  if (pct >= 100 && !tripComplete) {
    tripComplete = true;
    fill.classList.add('complete');
    pctEl.classList.add('complete');
    document.getElementById('book').classList.add('complete');
    showCompleteBanner();
    scheduleThankYouAudio();
  }
}

function showCompleteBanner() {
  const banner = document.getElementById('complete-banner');
  if (!banner) return;

  // Replace default text with thank_you_text from the data file if provided.
  const thankYouText = data.thank_you_text?.trim();
  if (thankYouText) {
    const textNode = banner.querySelector('.cb-text');
    if (textNode) textNode.textContent = thankYouText;
  }

  banner.classList.add('visible');

  // Notify the parent page so it can close / hide the iframe.
  try {
    window.parent.postMessage({ type: 'vft-complete' }, '*');
  } catch (e) {
    // Silently ignore — not critical if there's no parent.
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

  // If nothing is playing right now, fire straight away.
  if (!isPlaying) flushPendingThankYou();
  // Otherwise the playAudioFile done-callback will call this.
}

function flushPendingThankYou() {
  if (!pendingThankYou) return;
  const url = pendingThankYou;
  pendingThankYou = null;
  playAudioFile(resolveAudioSrc(url), url);
}


// ── Initialisation ───────────────────────────────────────────

async function init() {
  const params   = new URLSearchParams(location.search);
  const filePath = params.get('file');

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

  // Update page title and the header h1.
  const tripTitle = String(data.root || 'Virtual Field Trip').trim();
  document.title = tripTitle;
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
  splash.appendChild(el('div', { id: 'splash-icon', text: '🌍' }));
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

  // Completion banner — hidden until all nodes are visited.
  // Default text is overridden by thank_you_text in the data file if present.
  const banner = el('div', { id: 'complete-banner' });
  banner.appendChild(el('span', { className: 'cb-icon', text: '🎉' }));
  banner.appendChild(el('span', { className: 'cb-text', text: "You've explored the entire trip — great work!" }));
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
    isPlaying = false;
    setWave(false);
    lockChoices(false);
    player.onended = null;
    player.onerror = null;

    // Play the thank-you clip if it was queued while narration ran.
    if (pendingThankYou) flushPendingThankYou();
  };

  player.onended = done;

  player.onerror = (e) => {
    // One retry using the original (non-cached) URL.
    if (src !== canonicalUrl) {
      player.src = canonicalUrl;
      player.play().catch(err => { console.warn('Audio retry failed:', err); done(); });
    } else {
      console.warn('Audio error:', src, e);
      done();
    }
  };

  player.play().catch(e => { console.warn('play() rejected:', e); done(); });
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
    if (visitedNodes.has(choice.next)) btn.classList.add('visited');
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
// Lightweight element factory: el(tag, { id, className, text }) → HTMLElement

function el(tag, opts = {}) {
  const node = document.createElement(tag);
  if (opts.id)        node.id          = opts.id;
  if (opts.className) node.className    = opts.className;
  if (opts.text)      node.textContent  = opts.text;
  return node;
}


// ── Bootstrap ────────────────────────────────────────────────

init();