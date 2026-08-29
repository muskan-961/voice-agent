const titleEl = document.getElementById('slide-title');
const bulletsEl = document.getElementById('slide-bullets');
const slideEl = document.getElementById('slide');
const dotsEl = document.getElementById('dots');
const slideCounterEl = document.getElementById('slide-counter');
const prevSlideBtn = document.getElementById('prev-slide-btn');
const nextSlideBtn = document.getElementById('next-slide-btn');
const micBtn = document.getElementById('mic-btn');
const micLabel = document.getElementById('mic-label');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');
const micTestBtn = document.getElementById('mic-test-btn');
const micTestResults = document.getElementById('mic-test-results');
const micTestStatus = document.getElementById('mic-test-status');
const micTestInterim = document.getElementById('mic-test-interim');
const micTestLog = document.getElementById('mic-test-log');
const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const providerSelect = document.getElementById('provider-select');
const apiKeyInput = document.getElementById('api-key-input');
const modelInput = document.getElementById('model-input');
const baseUrlInput = document.getElementById('base-url-input');
const toggleKeyVisibility = document.getElementById('toggle-key-visibility');
const settingsSaved = document.getElementById('settings-saved');
const settingsClear = document.getElementById('settings-clear');
const activeProviderEl = document.getElementById('active-provider');
const errorBanner = document.getElementById('error-banner');
const errorBannerText = document.getElementById('error-banner-text');
const errorBannerRetry = document.getElementById('error-banner-retry');
const resumeBtn = document.getElementById('resume-btn');
const downloadTranscriptBtn = document.getElementById('download-transcript-btn');
const themeToggle = document.getElementById('theme-toggle');

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
const synth = window.speechSynthesis;

// ---- Theme (light/dark) ---------------------------------------------------

const THEME_STORAGE_KEY = 'voiceSlides.theme';

function systemPrefersLight() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
}

// theme is 'light', 'dark', or null (follow system preference).
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const effective = theme || (systemPrefersLight() ? 'light' : 'dark');
  // Icon shows what clicking will switch TO, not the current state.
  themeToggle.textContent = effective === 'light' ? '🌙' : '☀️';
  themeToggle.setAttribute('aria-label', effective === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // ignore
  }
  applyTheme(stored === 'light' || stored === 'dark' ? stored : null);
}

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme || (systemPrefersLight() ? 'light' : 'dark');
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // ignore — theme just won't persist across reloads
  }
});

let slides = [];
let currentSlideIndex = 0;
let convoMessages = [];
let recognition = null;
let sessionActive = false;
let currentAbortController = null;
let appState = 'idle'; // idle | listening | thinking | speaking

let micTestRecognition = null;
let micTestActive = false;

// Handled locally, bypassing the LLM entirely — instant and don't depend
// on the network or tool-calling being reliable.
const STOP_COMMAND_RE = /^(stop( talking)?|be quiet|quiet|pause|shut up)[.!]?$/i;
const NEXT_COMMAND_RE = /^(next( slide)?|skip( slide)?|forward)[.!]?$/i;
const PREV_COMMAND_RE = /^(previous( slide)?|go back|back|prev( slide)?)[.!]?$/i;

// Shared by the "next/previous slide" voice commands and the arrow-key
// handler further down — deliberate manual navigation always interrupts
// whatever's playing and drops out of the uninterrupted walkthrough, same
// as any other real user action.
function navigateSlide(direction) {
  turnGeneration++;
  autoAdvance = false;
  abortPrefetch();
  hideBanner();
  if (synth.speaking) {
    bargeInPending = true;
    synth.cancel();
  }
  const nextIndex =
    direction > 0
      ? Math.min(currentSlideIndex + 1, slides.length - 1)
      : Math.max(currentSlideIndex - 1, 0);
  renderSlide(nextIndex);
  if (sessionActive) setState('listening');
}

function handleLocalCommand(transcript) {
  const clean = transcript.trim();
  if (STOP_COMMAND_RE.test(clean)) {
    appendTranscript('user', transcript);
    // Guarded rather than unconditional: calling cancel() on an already-
    // idle engine (very likely here — "stop" is often said when nothing's
    // playing) is one of the known triggers for Chrome's speechSynthesis
    // engine going silently unresponsive after repeated cancel cycles.
    if (synth.speaking) synth.cancel();
    if (currentAbortController) currentAbortController.abort();
    setState('listening');
    return true;
  }
  if (NEXT_COMMAND_RE.test(clean)) {
    appendTranscript('user', transcript);
    navigateSlide(1);
    return true;
  }
  if (PREV_COMMAND_RE.test(clean)) {
    appendTranscript('user', transcript);
    navigateSlide(-1);
    return true;
  }
  return false;
}

const KICKOFF_TEXT = '(The listener just started the presentation. Greet them briefly and introduce slide 0.)';

function buildContinueText(nextIndex) {
  const isLast = nextIndex === slides.length - 1;
  const title = slides[nextIndex] ? slides[nextIndex].title : '';
  return (
    `(No questions so far — continue the presentation. Move on to slide ${nextIndex} ("${title}") ` +
    `and explain it in your own words.${isLast ? ' This is the final slide, so wrap up the talk after explaining it.' : ''})`
  );
}

// ---- LLM provider settings ------------------------------------------------

const DEFAULT_PROVIDER = 'openai';

const PROVIDER_PRESETS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  // Google's OpenAI-compatibility endpoint — accepts the same
  // chat-completions/tools request shape as the others.
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.6-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' },
};

// Reports which provider/model actually handled the last request — sourced
// from the server's response (server.js echoes back the provider's own
// reported model, not just what we asked for), since after an automatic
// rate-limit fallback the actual provider can silently diverge from
// whatever's still shown in the settings fields above.
function providerNameFromBaseUrl(baseUrl) {
  if (!baseUrl) return 'unknown';
  const normalized = baseUrl.replace(/\/+$/, '');
  for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
    if (preset.baseUrl && preset.baseUrl.replace(/\/+$/, '') === normalized) {
      return key.charAt(0).toUpperCase() + key.slice(1);
    }
  }
  return baseUrl; // custom/unrecognized endpoint — show the raw URL
}

function updateActiveProviderDisplay(provider) {
  if (!provider || !provider.model) return;
  const name = providerNameFromBaseUrl(provider.baseUrl);
  const fallbackTag = sessionUsingFallback ? ' (fallback)' : '';
  activeProviderEl.textContent = `Using: ${name}${fallbackTag} · ${provider.model}`;
}

const LLM_STORAGE_KEY = 'voiceSlides.llmConfig';

function loadStoredLlmConfig() {
  try {
    const raw = localStorage.getItem(LLM_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveLlmConfigToStorage() {
  try {
    localStorage.setItem(
      LLM_STORAGE_KEY,
      JSON.stringify({
        provider: providerSelect.value,
        apiKey: apiKeyInput.value.trim(),
        model: modelInput.value.trim(),
        baseUrl: baseUrlInput.value.trim(),
      })
    );
  } catch {
    // private browsing / storage disabled — settings just won't persist
  }
  settingsSaved.hidden = false;
  clearTimeout(saveLlmConfigToStorage._t);
  saveLlmConfigToStorage._t = setTimeout(() => {
    settingsSaved.hidden = true;
  }, 1500);
}

function getLlmConfig() {
  return {
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
  };
}

// True when the currently configured provider is already the dedicated
// Groq fallback target — there's nothing to "fall back" to in that case.
// Blank settings fields now resolve to the server's primary default
// (OpenAI), NOT Groq, so this checks the actual baseUrl rather than just
// "is everything blank".
function isAlreadyOnGroqFallback() {
  const baseUrl = getLlmConfig().baseUrl;
  if (!baseUrl) return false;
  return baseUrl.replace(/\/+$/, '') === PROVIDER_PRESETS.groq.baseUrl.replace(/\/+$/, '');
}

// Once a rate limit forces a fallback (see handleTurnFailure), every
// subsequent request in the session routes to the server's dedicated Groq
// fallback credentials instead of retrying the provider that's already
// known to be rate limited.
let sessionUsingFallback = false;

function getEffectiveLlmConfig() {
  return sessionUsingFallback ? { useFallback: true } : getLlmConfig();
}

function applyProviderPreset(provider) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS[DEFAULT_PROVIDER];
  baseUrlInput.value = preset.baseUrl;
  modelInput.value = preset.model;
  apiKeyInput.value = '';
}

function initLlmSettings() {
  const stored = loadStoredLlmConfig();
  if (stored && PROVIDER_PRESETS[stored.provider]) {
    providerSelect.value = stored.provider;
    baseUrlInput.value = stored.baseUrl || PROVIDER_PRESETS[stored.provider].baseUrl;
    modelInput.value = stored.model || PROVIDER_PRESETS[stored.provider].model;
    apiKeyInput.value = stored.apiKey || '';
  } else {
    providerSelect.value = DEFAULT_PROVIDER;
    applyProviderPreset(DEFAULT_PROVIDER);
  }
}

settingsToggle.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

providerSelect.addEventListener('change', () => {
  applyProviderPreset(providerSelect.value);
  saveLlmConfigToStorage();
});

[apiKeyInput, modelInput, baseUrlInput].forEach((el) => {
  el.addEventListener('change', saveLlmConfigToStorage);
});

toggleKeyVisibility.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

settingsClear.addEventListener('click', () => {
  try {
    localStorage.removeItem(LLM_STORAGE_KEY);
  } catch {
    // ignore
  }
  providerSelect.value = DEFAULT_PROVIDER;
  applyProviderPreset(DEFAULT_PROVIDER);
});

// ---- Presentation state -----------------------------------------------

let autoAdvance = false; // walking through the deck end-to-end, uninterrupted
let bargeInPending = false; // true while an interruption is actively cancelling speech
let prefetchPromise = null;
let prefetchController = null;
let prefetchIndex = null;
let turnGeneration = 0; // bumped on every real interruption to invalidate stale async work

function abortPrefetch() {
  if (prefetchController) prefetchController.abort();
  prefetchPromise = null;
  prefetchController = null;
  prefetchIndex = null;
}

function prefetchNextSlide() {
  if (!autoAdvance) return;
  const nextIndex = currentSlideIndex + 1;
  if (nextIndex >= slides.length) return;

  prefetchIndex = nextIndex;
  prefetchController = new AbortController();
  prefetchPromise = fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: convoMessages, userText: buildContinueText(nextIndex), llmConfig: getEffectiveLlmConfig() }),
    signal: prefetchController.signal,
  })
    .then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, data })))
    .catch((err) => ({ ok: false, networkFailure: true, err }));
}

function maybeAutoAdvance() {
  if (!sessionActive || !autoAdvance) return;
  const nextIndex = currentSlideIndex + 1;
  if (nextIndex >= slides.length) {
    autoAdvance = false;
    return;
  }

  if (prefetchPromise && prefetchIndex === nextIndex) {
    const promise = prefetchPromise;
    const gen = turnGeneration;
    setState('thinking');
    promise.then((result) => {
      // A real interruption may have started a new turn while this
      // background prefetch was still in flight — discard it rather
      // than clobbering whatever's happening now.
      if (gen !== turnGeneration) return;
      prefetchPromise = null;
      prefetchController = null;
      prefetchIndex = null;
      if (result.ok && result.data && !result.data.error) {
        hideBanner();
        applyChatResponse(result.data);
        return;
      }
      const classification = classifyError(result);
      handleTurnFailure(buildContinueText(nextIndex), { silent: true }, classification, 0);
    });
  } else {
    sendTurn(buildContinueText(nextIndex), { silent: true });
  }
}

// ---- Error recovery: rate limits, token/context limits, lost connection --

const MAX_AUTO_RETRIES = 5;
let reconnectPending = false;

// Session-wide "exception budget" (distinct from per-turn retries above):
// counts repeated LLM/content failures — empty or hallucinated-empty
// replies, and turns that exhausted their retries — across the whole
// session. A flaky network is not the AI being broken and doesn't count
// here (that's handled separately via waitForReconnect, which can
// legitimately wait a long time). The point is the same one the LiveKit
// reliability writeup makes: a voice agent that just keeps failing forever
// is worse than one that gracefully says "I'm stuck" and stops.
let sessionExceptionCount = 0;
const MAX_SESSION_EXCEPTIONS = 3;

function recordSessionSuccess() {
  sessionExceptionCount = 0;
}

// Returns true if the exception budget was exhausted (and the session was
// ended) — callers should skip their own follow-up messaging in that case.
function recordSessionException(reason) {
  sessionExceptionCount++;
  console.warn('[session] exception recorded:', reason, 'count =', sessionExceptionCount);
  if (sessionExceptionCount < MAX_SESSION_EXCEPTIONS) return false;

  endSessionAfterSpeaking(
    "I'm having repeated trouble putting together good answers, so I'm going to stop here rather than keep going in circles. Feel free to start again.",
    {
      bannerMessage: `Ended the session after ${MAX_SESSION_EXCEPTIONS} repeated failures in a row, rather than leaving you talking to a dead line.`,
    }
  );
  return true;
}

// Tuned down from the browser default (rate 1, volume 1) for two reasons:
// slightly slower gives the background slide prefetch more time to land
// (less dead air between slides), and — more importantly for barge-in
// accuracy — a quieter utterance bleeds less energy back into the mic
// through the speakers, giving the VAD layer below more headroom before a
// false trigger. Applied everywhere the app speaks. Volume dropped further
// (was 0.85) after confirming in real use that echo cancellation alone
// wasn't enough to stop the AI cutting itself off mid-sentence.
const TTS_RATE = 0.88;
const TTS_VOLUME = 0.6;

function createUtterance(text) {
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = TTS_RATE;
  utter.volume = TTS_VOLUME;
  return utter;
}

// Chrome/Edge have a long-standing bug where speechSynthesis silently
// stops producing audio — .speaking stays true, no error fires, nothing
// comes out — typically after repeated cancel()/speak() cycles pile up
// within a session (exactly what this app does on every interruption).
// The standard, widely-used workaround is to periodically nudge the
// engine with pause()+resume(); this runs for the page's whole lifetime
// since the bug isn't tied to any particular utterance.
setInterval(() => {
  if (synth.speaking) {
    synth.pause();
    synth.resume();
  }
}, 5000);

// Speaks a short notice without going through the normal speak() pipeline —
// deliberately doesn't touch appState/auto-advance/prefetch, since these
// notices fire from error-recovery paths where we're mid-retry, not
// finishing a real turn.
function speakNotice(text) {
  if (!text) return;
  if (synth.speaking) synth.cancel();
  appendTranscript('assistant', text);
  synth.speak(createUtterance(text));
}

// Like speakNotice, but ends the session once the utterance finishes —
// used for a graceful, audible sign-off rather than cutting the apology
// short (endSession() itself calls synth.cancel()). If bannerMessage is
// given, it's (re-)shown after endSession() runs, since endSession()
// unconditionally clears any banner and we want this one to stick around
// for anyone reading the screen rather than listening.
function endSessionAfterSpeaking(text, { bannerMessage = null } = {}) {
  autoAdvance = false;
  abortPrefetch();
  appendTranscript('assistant', text);
  setState('speaking');
  const utter = createUtterance(text);
  const finish = () => {
    endSession();
    if (bannerMessage) showBanner(bannerMessage, { danger: true });
  };
  utter.onend = finish;
  utter.onerror = finish;
  synth.speak(utter);
}

function extractErrorText(errorField) {
  if (!errorField) return '';
  if (typeof errorField === 'string') return errorField;
  if (typeof errorField === 'object') {
    // Server wraps the provider's raw error body as { error: {...} }, and
    // providers themselves typically nest as { error: { message, code } } —
    // handle either shape. `status` covers Google's native error shape
    // (e.g. status: "RESOURCE_EXHAUSTED"), which uses that field instead
    // of `type` for the enum string.
    const inner = errorField.error && typeof errorField.error === 'object' ? errorField.error : errorField;
    return [inner.code, inner.type, inner.status, inner.message].filter(Boolean).join(' ') || JSON.stringify(errorField);
  }
  return String(errorField);
}

function classifyError({ networkFailure = false, status = null, data = null } = {}) {
  if (networkFailure || !navigator.onLine) {
    return { kind: 'network', message: 'Lost connection to the server.' };
  }
  const rawText = extractErrorText(data?.error);
  const text = rawText.toLowerCase();

  if (
    status === 429 ||
    text.includes('rate_limit') ||
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('resource_exhausted') ||
    text.includes('resource exhausted')
  ) {
    const retryMatch = /try again in ([\d.]+)\s*s/i.exec(rawText);
    return {
      kind: 'rate_limit',
      message: rawText || 'Rate limit reached.',
      retryAfterSec: retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null,
    };
  }
  if (
    text.includes('context_length') ||
    text.includes('context length') ||
    text.includes('maximum context') ||
    text.includes('too many tokens') ||
    text.includes('token limit')
  ) {
    return { kind: 'context_length', message: rawText || 'The conversation exceeded the model\'s token limit.' };
  }
  if (text.includes('fetch failed') || text.includes('econnrefused') || text.includes('enotfound') || text.includes('network')) {
    return { kind: 'network', message: rawText || 'Network error reaching the LLM provider.' };
  }
  return { kind: 'other', message: rawText || 'Request to the LLM failed.' };
}

function showBanner(message, { retry = null, danger = false } = {}) {
  errorBannerText.textContent = message;
  errorBanner.classList.toggle('danger', danger);
  errorBannerRetry.hidden = !retry;
  errorBanner._retryHandler = retry;
  errorBanner.hidden = false;
}

function hideBanner() {
  errorBanner.hidden = true;
  errorBanner._retryHandler = null;
}

errorBannerRetry.addEventListener('click', () => {
  const handler = errorBanner._retryHandler;
  hideBanner();
  if (handler) handler();
});

function waitForReconnect(cb) {
  if (reconnectPending) return;
  reconnectPending = true;
  const cleanup = () => {
    reconnectPending = false;
    window.removeEventListener('online', onOnline);
    clearInterval(pollId);
  };
  const onOnline = () => {
    cleanup();
    cb();
  };
  window.addEventListener('online', onOnline);
  // Fallback poll in case the online/offline events don't fire reliably.
  const pollId = setInterval(() => {
    if (navigator.onLine) {
      cleanup();
      cb();
    }
  }, 5000);
}

function handleTurnFailure(userText, { silent }, classification, retryCount) {
  console.error('[chat]', classification.kind, classification.message);
  const gen = turnGeneration;
  // Reaching this function at all is proof of life — a legitimate backoff
  // sequence can run well past the watchdog's window across several
  // retries, so extend it each time rather than let it fire mid-retry.
  if (appState === 'thinking') armThinkingWatchdog();
  // Voice-first "degrade, never go silent": say something on the FIRST
  // failure of a turn so a listener not looking at the screen still knows
  // something's wrong, but don't repeat it on every silent auto-retry.
  const firstFailure = retryCount === 0;

  if (classification.kind === 'rate_limit') {
    // Groq has an entirely separate quota from whatever's configured, so
    // there's no reason to sit through backoff retries against a provider
    // that's already known to be rate limited — switch once, immediately,
    // and stay on the fallback for the rest of the session.
    if (!sessionUsingFallback && !isAlreadyOnGroqFallback()) {
      sessionUsingFallback = true;
      showBanner('Rate limit reached on the selected provider — switching to the Groq fallback for the rest of this session.');
      speakNotice("I'm hitting a rate limit on the selected provider, so I'm switching to the backup and trying again.");
      sendTurn(userText, { silent, retryCount: 0 });
      return;
    }

    if (retryCount >= MAX_AUTO_RETRIES) {
      if (recordSessionException('rate_limit_exhausted')) return; // session ended gracefully
      showBanner(`LLM token/rate limit reached and automatic retries were exhausted. ${classification.message}`, {
        retry: () => sendTurn(userText, { silent, retryCount: 0 }),
        danger: true,
      });
      speakNotice("I'm still stuck on a rate limit and I've run out of automatic retries. You can try again in a bit.");
      setState('listening');
      return;
    }
    const delayMs = classification.retryAfterSec
      ? classification.retryAfterSec * 1000 + 500
      : Math.min(2000 * 2 ** retryCount, 30000);
    showBanner(`LLM token/rate limit reached — retrying automatically in ${Math.ceil(delayMs / 1000)}s…`);
    if (firstFailure) speakNotice("I'm hitting a rate limit — give me a few seconds and I'll try again.");
    setTimeout(() => {
      if (gen !== turnGeneration) return; // superseded by a real interruption
      sendTurn(userText, { silent, retryCount: retryCount + 1 });
    }, delayMs);
    return;
  }

  if (classification.kind === 'context_length') {
    if (retryCount >= 2) {
      // Trimming already happened and it's still too big — further
      // retries won't help, so stop and let the user decide.
      if (recordSessionException('context_length_exhausted')) return;
      showBanner(`Conversation is still too long for the model's token limit even after trimming history. ${classification.message}`, {
        retry: () => sendTurn(userText, { silent, retryCount: 0 }),
        danger: true,
      });
      speakNotice("This conversation is still too long for me to handle, even after trimming it down.");
      setState('listening');
      return;
    }
    // Waiting doesn't help here — the conversation itself is too big.
    // Keep the system prompt plus only the most recent exchanges so the
    // next request fits the model's context window, then retry.
    if (convoMessages.length > 7) {
      convoMessages = [convoMessages[0], ...convoMessages.slice(-6)];
    }
    showBanner('Conversation got too long for the model\'s token limit — trimmed older history and retrying…');
    if (firstFailure) speakNotice("This conversation's gotten a bit long for me — trimming some older history and trying again.");
    setTimeout(() => {
      if (gen !== turnGeneration) return;
      hideBanner();
      sendTurn(userText, { silent, retryCount: retryCount + 1 });
    }, 300);
    return;
  }

  if (classification.kind === 'network') {
    // Auto-retries on the browser's 'online' event / a 5s poll, but also
    // offer a manual retry — "we lost connection" can be a misdiagnosis
    // (e.g. the server itself is down, not the user's actual internet),
    // in which case navigator.onLine never flips and the automatic path
    // silently loops forever with nothing for the user to act on.
    showBanner('Connection lost — will pick back up automatically once you\'re back online.', {
      retry: () => sendTurn(userText, { silent, retryCount: 0 }),
      danger: true,
    });
    if (firstFailure) speakNotice("Looks like we lost connection — I'll pick back up as soon as we're back online.");
    setState('listening');
    waitForReconnect(() => {
      if (gen !== turnGeneration) return;
      sendTurn(userText, { silent, retryCount: 0 });
    });
    return;
  }

  // Not something blind retrying fixes (bad API key, unknown model, etc.).
  if (recordSessionException('llm_error')) return;
  showBanner(classification.message, {
    retry: () => sendTurn(userText, { silent, retryCount: 0 }),
    danger: true,
  });
  speakNotice("Something went wrong on my end talking to the AI service. You can retry from the banner above.");
  setState('listening');
}

// ---- Conversation persistence (resume + downloadable reference) --------

const SESSION_STORAGE_KEY = 'voiceSlides.session';
const TRANSCRIPT_STORAGE_KEY = 'voiceSlides.transcriptLog';

let transcriptLog = [];

function saveSessionState() {
  try {
    localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ convoMessages, currentSlideIndex, savedAt: Date.now() })
    );
  } catch {
    // private browsing / storage disabled — resuming just won't be offered
  }
}

function loadSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSessionState() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function saveTranscriptLog() {
  try {
    localStorage.setItem(TRANSCRIPT_STORAGE_KEY, JSON.stringify(transcriptLog));
  } catch {
    // ignore
  }
}

function loadStoredTranscriptLog() {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function renderStoredTranscript() {
  transcriptEl.innerHTML = '';
  transcriptLog.forEach((e) => {
    const line = document.createElement('div');
    line.className = `line ${e.role}`;
    line.textContent = `${e.role === 'user' ? 'You' : 'AI'}: ${e.text}`;
    transcriptEl.appendChild(line);
  });
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function downloadTranscript() {
  if (!transcriptLog.length) return;
  const lines = transcriptLog.map(
    (e) => `[${new Date(e.at).toLocaleString()}] ${e.role === 'user' ? 'You' : 'AI'}: ${e.text}`
  );
  const blob = new Blob([lines.join('\n\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `voice-slides-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

downloadTranscriptBtn.addEventListener('click', downloadTranscript);

// Last-resort safety net: guarantees the user is never left in silence
// indefinitely, regardless of the specific cause. Every other fix in this
// file closes one *known* silent-failure path (malformed response shape,
// lost error status, etc.) — this one catches whatever's left, known or
// not, by bounding how long we can sit in "thinking" with nothing
// happening. Re-armed on every legitimate retry attempt (see
// handleTurnFailure) so it only fires on a genuine stall, not a normal
// multi-step backoff sequence that's still actively making progress.
let thinkingWatchdogId = null;
const THINKING_WATCHDOG_MS = 15000;

function armThinkingWatchdog() {
  clearThinkingWatchdog();
  const gen = turnGeneration;
  thinkingWatchdogId = setTimeout(() => {
    if (gen !== turnGeneration || appState !== 'thinking') return;
    console.warn('[watchdog] stuck in "thinking" with no progress for', THINKING_WATCHDOG_MS, 'ms — forcing recovery');
    if (recordSessionException('stuck_thinking')) return; // session ended gracefully
    speakNotice("Sorry, that took too long and I didn't get anything back — could you try again?");
    setState('listening');
  }, THINKING_WATCHDOG_MS);
}

function clearThinkingWatchdog() {
  if (thinkingWatchdogId) clearTimeout(thinkingWatchdogId);
  thinkingWatchdogId = null;
}

function setState(next) {
  appState = next;
  micBtn.classList.remove('listening', 'thinking', 'speaking');
  if (next === 'listening') {
    statusEl.textContent = 'Listening…';
    micBtn.classList.add('listening');
    clearThinkingWatchdog();
  } else if (next === 'thinking') {
    statusEl.textContent = 'Thinking…';
    micBtn.classList.add('thinking');
    armThinkingWatchdog();
  } else if (next === 'speaking') {
    statusEl.textContent = 'Speaking… (talk anytime to interrupt)';
    micBtn.classList.add('speaking');
    clearThinkingWatchdog();
  } else {
    statusEl.textContent = 'Idle';
    clearThinkingWatchdog();
  }
}

function renderSlide(index) {
  const s = slides[index];
  if (!s) return;
  currentSlideIndex = index;
  titleEl.textContent = s.title;
  bulletsEl.innerHTML = '';
  s.bullets.forEach((b) => {
    const li = document.createElement('li');
    li.textContent = b;
    bulletsEl.appendChild(li);
  });
  [...dotsEl.children].forEach((d, i) => d.classList.toggle('active', i === index));
  slideCounterEl.textContent = `Slide ${index + 1} of ${slides.length} · use ← → to navigate`;
  slideEl.classList.remove('flash');
  void slideEl.offsetWidth;
  slideEl.classList.add('flash');
}

function renderDots() {
  dotsEl.innerHTML = '';
  slides.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'dot';
    d.addEventListener('click', () => renderSlide(i));
    dotsEl.appendChild(d);
  });
}

function appendTranscript(role, text) {
  const line = document.createElement('div');
  line.className = `line ${role}`;
  line.textContent = `${role === 'user' ? 'You' : 'AI'}: ${text}`;
  transcriptEl.appendChild(line);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;

  transcriptLog.push({ role, text, at: new Date().toISOString() });
  saveTranscriptLog();
  downloadTranscriptBtn.disabled = false;
}

async function loadSlides() {
  const res = await fetch('/api/slides');
  slides = await res.json();
  renderDots();
  renderSlide(0);
}

function speak(text) {
  if (!text) {
    setState('listening');
    return;
  }
  appendTranscript('assistant', text);
  setState('speaking');
  speakUtterance(text);
  prefetchNextSlide();
}

// Separate from speak() so it can retry itself: Chrome/Edge's
// speechSynthesis engine can go silently unresponsive after enough
// cancel()/speak() cycles pile up in a session (.speaking stays true, no
// error ever fires, no audio ever comes out — matches "it worked earlier
// in the session, then just stopped"). onstart firing is our signal that
// audio is genuinely playing; if it doesn't fire within STUCK_TIMEOUT_MS,
// force a hard reset and retry once before giving up quietly.
const TTS_STUCK_TIMEOUT_MS = 2500;

function speakUtterance(text, isRetry = false) {
  const utter = createUtterance(text);
  let started = false;

  const stuckTimer = setTimeout(() => {
    if (started) return;
    console.warn('[tts] speechSynthesis did not start within timeout — engine appears stuck, resetting', { isRetry });
    // Detach handlers before cancelling so the stale utterance's onend/
    // onerror can't fire later and stomp on the retry attempt's state.
    utter.onend = null;
    utter.onerror = null;
    synth.cancel();
    if (!isRetry) {
      speakUtterance(text, true);
    } else if (appState === 'speaking') {
      setState('listening');
    }
  }, TTS_STUCK_TIMEOUT_MS);

  utter.onstart = () => {
    started = true;
    clearTimeout(stuckTimer);
    // Fresh utterance, fresh baseline — reset to the seed value (not 0)
    // so the adaptive barge-in check behaves like the absolute-only check
    // until real data from this utterance has had a moment to arrive.
    vadSpeakingBaseline = VAD_BARGE_IN_THRESHOLD / VAD_BARGE_IN_RELATIVE_MARGIN;
  };
  utter.onend = () => {
    clearTimeout(stuckTimer);
    if (appState === 'speaking') setState('listening');
    if (bargeInPending) {
      bargeInPending = false;
      return;
    }
    maybeAutoAdvance();
  };
  utter.onerror = () => {
    clearTimeout(stuckTimer);
    if (appState === 'speaking') setState('listening');
    bargeInPending = false;
  };
  synth.speak(utter);
}

function applyChatResponse(data) {
  // Different OpenAI-compatible providers don't all guarantee the exact
  // same response shape (e.g. `reply` coming back as something other than
  // a plain string). This function is called from two places that don't
  // wrap it in a try/catch, so an unexpected shape here would otherwise
  // throw silently — the AI just goes quiet with zero feedback, which is
  // exactly the "never go silent" failure mode we built error recovery to
  // avoid elsewhere. Keep this defensive rather than trusting the shape.
  try {
    convoMessages = data.messages;
    if (Number.isInteger(data.slideIndex)) {
      renderSlide(data.slideIndex);
    }
    saveSessionState();
    updateActiveProviderDisplay(data.provider);

    // The HTTP call succeeded, but that doesn't mean the LLM actually
    // produced anything usable — streams occasionally finish with an empty
    // or blank completion, and some providers may send non-string content.
    // Treat both as a content failure, not a silent no-op, and count it
    // toward the same exception budget as repeated request failures.
    const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
    if (!reply) {
      if (recordSessionException('empty_reply')) return; // session ended gracefully
      speakNotice("Sorry, I didn't quite get that together — could you try asking again?");
      setState('listening');
      return;
    }

    recordSessionSuccess();
    speak(reply);
  } catch (err) {
    console.error('[chat] failed to process response', err);
    if (recordSessionException('malformed_response')) return; // session ended gracefully
    speakNotice("Sorry, I got back something I couldn't quite understand — could you try again?");
    setState('listening');
  }
}

async function sendTurn(userText, { silent = false, retryCount = 0 } = {}) {
  setState('thinking');
  // Only append the transcript line on the first attempt — retries re-send
  // the same turn and shouldn't duplicate it.
  if (!silent && retryCount === 0) appendTranscript('user', userText);

  const controller = new AbortController();
  currentAbortController = controller;
  const gen = turnGeneration;

  let res = null;
  let data = null;
  let networkFailure = false;
  try {
    res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: convoMessages, userText, llmConfig: getEffectiveLlmConfig() }),
      signal: controller.signal,
    });
    data = await res.json();
  } catch (err) {
    if (err.name === 'AbortError') return;
    networkFailure = true;
  }

  if (gen !== turnGeneration) return; // superseded by a real interruption

  if (!networkFailure && res.ok) {
    hideBanner();
    applyChatResponse(data);
    return;
  }

  const classification = classifyError({ networkFailure, status: res ? res.status : null, data });
  handleTurnFailure(userText, { silent }, classification, retryCount);
}

// ---- Voice Activity Detection --------------------------------------------
//
// SpeechRecognition grabs the microphone itself with no way for us to pass
// audio constraints, so it may or may not get echo cancellation from the
// browser — inconsistent across platforms. That's the root cause of the AI
// mistaking its own voice (bled back in through the speakers) for the
// user's: SpeechRecognition can transcribe that bleed into a full,
// grammatical "final" result just like real speech.
//
// This VAD layer opens its own getUserMedia stream *with echo cancellation,
// noise suppression, and AGC explicitly requested* (the same WebRTC-grade
// processing real voice-call apps rely on to avoid hearing themselves) and
// measures real-time energy on that already-cleaned stream via the Web
// Audio API. Genuine near-field human speech clears the energy threshold;
// residual echo of the AI's own voice — after echo cancellation, and with
// the AI's own volume turned down (see TTS_VOLUME above) — mostly doesn't.
//
// It does two jobs:
// 1. Fast barge-in: while the AI is speaking, SUSTAINED voice energy (see
//    VAD_BARGE_IN_SUSTAIN_MS) cancels it immediately — this is what makes
//    interruption feel instant, instead of waiting ~1-2s for
//    SpeechRecognition to finalize a transcript. Requiring the energy to
//    hold for a short window (not just a single frame) filters out brief
//    echo transients without meaningfully slowing down real interruptions.
// 2. Per-utterance gate: a SpeechRecognition final result only counts as
//    real user input if the VAD also saw voice activity during that
//    utterance — see vadActiveDuringUtterance below.
let vadStream = null;
let vadAudioContext = null;
let vadAnalyser = null;
let vadDataArray = null;
let vadRafId = null;
let vadAvailable = false; // true once the echo-cancelled stream is up
let vadActive = false; // instantaneous "energy above threshold right now"
let vadActiveDuringUtterance = false; // latched true if VAD fired since the last recognition.onstart
let vadLastActiveAt = 0;
let vadBargeInSustainedSince = null; // performance.now() timestamp the barge-in threshold was first crossed, or null

// Two separate thresholds, not one, because the two jobs above have very
// different false-positive costs: the per-utterance gate is already
// backed by a full recognized transcript (a second, independent check),
// so it can stay relatively sensitive. The fast barge-in path acts on
// raw energy alone — a false positive there audibly cuts the AI off
// mid-word — so it's deliberately much stricter, with a longer required
// hold.
const VAD_ENERGY_THRESHOLD = 0.032; // RMS for the per-utterance gate; tune per environment if needed
const VAD_BARGE_IN_THRESHOLD = 0.09; // absolute RMS floor specifically for fast barge-in
const VAD_HANGOVER_MS = 300; // bridge brief dips within one utterance
const VAD_BARGE_IN_SUSTAIN_MS = 450; // how long energy must hold before it counts as a real interruption

// A fixed absolute threshold alone can't fit every room/mic/speaker setup
// — confirmed in real use that it still occasionally reacts to the AI's
// own echo. So the fast barge-in check is adaptive: alongside the
// absolute floor above, it also tracks a slow-moving baseline of "how
// loud is the AI's own bleed right now" during the current utterance, and
// requires the sustained energy to spike well above THAT — self-
// calibrating to whatever the actual echo level is in this session,
// rather than trusting one guessed number to work everywhere. Seeded so
// that behavior is equivalent to the absolute-only check until enough of
// the utterance has played for the baseline to mean anything.
const VAD_BASELINE_DECAY = 0.05; // EWMA weight per animation-frame tick
const VAD_BARGE_IN_RELATIVE_MARGIN = 1.7; // sustained energy must exceed baseline * this
let vadSpeakingBaseline = VAD_BARGE_IN_THRESHOLD / VAD_BARGE_IN_RELATIVE_MARGIN;

async function startVAD() {
  if (vadStream) return true; // already running
  try {
    vadStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    console.warn('VAD: microphone unavailable, falling back to unfiltered recognition results', err);
    vadAvailable = false;
    return false;
  }

  const Ctor = window.AudioContext || window.webkitAudioContext;
  vadAudioContext = new Ctor();
  const source = vadAudioContext.createMediaStreamSource(vadStream);
  vadAnalyser = vadAudioContext.createAnalyser();
  vadAnalyser.fftSize = 512;
  vadAnalyser.smoothingTimeConstant = 0.4;
  source.connect(vadAnalyser);
  vadDataArray = new Uint8Array(vadAnalyser.fftSize);
  vadAvailable = true;

  const tick = () => {
    vadAnalyser.getByteTimeDomainData(vadDataArray);
    let sumSquares = 0;
    for (let i = 0; i < vadDataArray.length; i++) {
      const v = (vadDataArray[i] - 128) / 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / vadDataArray.length);
    const now = performance.now();

    // Per-utterance gate — lower threshold, but only ever consulted
    // alongside a full recognized transcript (see vadActiveDuringUtterance
    // usage in setupRecognition), so it can afford to be more sensitive.
    if (rms > VAD_ENERGY_THRESHOLD) {
      vadActive = true;
      vadActiveDuringUtterance = true;
      vadLastActiveAt = now;
    } else if (now - vadLastActiveAt > VAD_HANGOVER_MS) {
      vadActive = false;
    }

    // Track this utterance's typical echo/bleed level — paused while a
    // barge-in candidate is actively being evaluated, so a genuine
    // interruption in progress doesn't contaminate the baseline it's
    // being measured against.
    if (appState === 'speaking' && vadBargeInSustainedSince === null) {
      vadSpeakingBaseline = vadSpeakingBaseline * (1 - VAD_BASELINE_DECAY) + rms * VAD_BASELINE_DECAY;
    }

    // Fast barge-in — acts on raw energy alone with no transcript to back
    // it up, so it requires BOTH a high absolute floor AND a genuine spike
    // above this utterance's own adaptive baseline, sustained for a while,
    // before cutting the AI off.
    if (rms > VAD_BARGE_IN_THRESHOLD && rms > vadSpeakingBaseline * VAD_BARGE_IN_RELATIVE_MARGIN) {
      if (vadBargeInSustainedSince === null) vadBargeInSustainedSince = now;
      if (
        appState === 'speaking' &&
        synth.speaking &&
        !bargeInPending &&
        now - vadBargeInSustainedSince >= VAD_BARGE_IN_SUSTAIN_MS
      ) {
        bargeInPending = true;
        synth.cancel();
        setState('listening');
      }
    } else {
      vadBargeInSustainedSince = null;
    }

    vadRafId = requestAnimationFrame(tick);
  };
  tick();
  return true;
}

function stopVAD() {
  if (vadRafId) cancelAnimationFrame(vadRafId);
  vadRafId = null;
  if (vadStream) {
    vadStream.getTracks().forEach((t) => t.stop());
    vadStream = null;
  }
  if (vadAudioContext) {
    vadAudioContext.close().catch(() => {});
    vadAudioContext = null;
  }
  vadAnalyser = null;
  vadAvailable = false;
  vadActive = false;
  vadActiveDuringUtterance = false;
  vadBargeInSustainedSince = null;
}

function setupRecognition() {
  recognition = new SpeechRecognitionCtor();
  // continuous:false + restart-on-end (below) gives a fresh recognition
  // session per utterance, which finalizes transcripts far more reliably
  // than continuous mode — important for longer utterances not getting
  // mis-segmented (and silently dropped) mid-sentence.
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  // Reset the per-utterance VAD latch at the start of each recognition
  // cycle (continuous:false means this fires once per utterance attempt).
  recognition.onstart = () => {
    vadActiveDuringUtterance = false;
  };

  // Note: we deliberately do NOT cancel speech on onspeechstart or on
  // interim (non-final) results. Without headphones, the mic picks up
  // the AI's own voice bleeding in from the speakers, which trips those
  // events constantly — that was cutting the AI off after a single word
  // even when nobody was actually interrupting it. Raw audio energy or a
  // partial word is too easily false-triggered by that feedback; a full
  // CONFIRMED FINAL transcript is much less likely to come from faint
  // speaker bleed than from someone actually talking, so that's one layer
  // of defense. The VAD layer above is the second, stronger one: it only
  // counts a final transcript as real user input if the independent,
  // echo-cancelled getUserMedia stream also detected voice energy during
  // that utterance — residual AI-voice bleed rarely clears that bar even
  // when SpeechRecognition itself manages to transcribe it.
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const transcript = result[0].transcript.trim();
      if (!transcript) continue;

      if (vadAvailable && !vadActiveDuringUtterance) {
        // The recognizer transcribed *something*, but our own echo-
        // cancelled mic stream never saw real voice energy during it —
        // almost certainly the AI hearing itself, not the user. Ignore.
        console.log('[VAD] ignored transcript with no corroborating voice energy:', transcript);
        continue;
      }

      // Any real user speech ends the uninterrupted end-to-end walkthrough
      // — from here on the presenter only responds to what's asked. Bump
      // the generation counter so any stale async work (e.g. a background
      // prefetch that was already in flight) gets discarded instead of
      // clobbering this turn once it resolves.
      turnGeneration++;
      autoAdvance = false;
      abortPrefetch();
      hideBanner();
      if (synth.speaking) {
        bargeInPending = true;
        synth.cancel();
      }
      if (appState === 'speaking') setState('listening');
      if (handleLocalCommand(transcript)) continue;
      // A confirmed new utterance supersedes whatever's in flight.
      if (currentAbortController) currentAbortController.abort();
      sendTurn(transcript);
    }
  };

  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('Speech recognition error:', event.error);
  };

  recognition.onend = () => {
    if (sessionActive) {
      try {
        recognition.start();
      } catch {
        // already starting; ignore
      }
    }
  };
}

function beginSession() {
  if (micTestActive) stopMicTest();
  sessionActive = true;
  autoAdvance = true;
  sessionExceptionCount = 0;
  sessionUsingFallback = false;
  micBtn.classList.add('active');
  micLabel.textContent = 'End Conversation';
  micTestBtn.disabled = true;
  resumeBtn.hidden = true;

  startVAD(); // best-effort; onresult falls back gracefully if this fails

  setupRecognition();
  try {
    recognition.start();
  } catch (err) {
    console.error(err);
  }
}

function startSession() {
  if (!SpeechRecognitionCtor) {
    statusEl.textContent = 'Speech recognition not supported — use Chrome or Edge.';
    return;
  }
  convoMessages = [];
  transcriptLog = [];
  transcriptEl.innerHTML = '';
  saveTranscriptLog();
  clearSessionState();
  beginSession();
  sendTurn(KICKOFF_TEXT, { silent: true });
}

// Shows/hides "Resume Previous Session" based on whether there's actually
// something to resume, and relabels the main button so it's clear
// clicking it starts fresh rather than continuing — used both at page
// load and after ending a conversation.
function updateResumeAvailability() {
  const saved = loadSessionState();
  const hasResumable = !!(saved && Array.isArray(saved.convoMessages) && saved.convoMessages.length > 1);
  resumeBtn.hidden = !hasResumable;
  if (!sessionActive) {
    micLabel.textContent = hasResumable ? 'New Conversation' : 'Start Conversation';
  }
}

// Continues a paused or unexpectedly-ended conversation (e.g. "End
// Conversation" was clicked, automatic retries were exhausted, or the tab
// was closed/reloaded) using the conversation + slide position saved to
// localStorage.
function resumeSession() {
  if (!SpeechRecognitionCtor) {
    statusEl.textContent = 'Speech recognition not supported — use Chrome or Edge.';
    return;
  }
  const saved = loadSessionState();
  if (!saved || !Array.isArray(saved.convoMessages) || !saved.convoMessages.length) return;

  convoMessages = saved.convoMessages;
  renderStoredTranscript();
  renderSlide(saved.currentSlideIndex || 0);
  beginSession();
  sendTurn(
    `(The listener just resumed after a pause. Briefly welcome them back, then continue from slide ${currentSlideIndex}.)`,
    { silent: true }
  );
}

function endSession() {
  sessionActive = false;
  autoAdvance = false;
  abortPrefetch();
  hideBanner();
  // Deliberately NOT clearing the saved session here — ending a
  // conversation should behave like pausing it, not discarding it. The
  // resumable snapshot stays in localStorage so "Resume Previous Session"
  // (surfaced below) picks up right where this left off. A genuine reset
  // is still available via "New/Start Conversation", which explicitly
  // wipes everything.
  stopVAD();
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
  }
  synth.cancel();
  if (currentAbortController) currentAbortController.abort();
  micBtn.classList.remove('active');
  micTestBtn.disabled = false;
  setState('idle');
  updateResumeAvailability();
}

micBtn.addEventListener('click', () => {
  if (sessionActive) {
    endSession();
  } else {
    startSession();
  }
});

resumeBtn.addEventListener('click', resumeSession);

prevSlideBtn.addEventListener('click', () => navigateSlide(-1));
nextSlideBtn.addEventListener('click', () => navigateSlide(1));

document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  // Don't hijack arrow keys while the user is editing a form field (e.g.
  // moving the cursor inside the API key/model inputs).
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (document.activeElement && document.activeElement.isContentEditable) return;
  if (!slides.length) return;
  e.preventDefault();
  navigateSlide(e.key === 'ArrowRight' ? 1 : -1);
});

// Standalone mic diagnostic: runs its own SpeechRecognition instance,
// completely separate from the conversation loop, so you can confirm
// the browser is capturing your voice at all before troubleshooting
// anything about the AI's responses.
function startMicTest() {
  if (!SpeechRecognitionCtor) {
    micTestStatus.textContent = 'Speech recognition not supported in this browser — try Chrome or Edge.';
    micTestStatus.classList.add('danger');
    micTestResults.hidden = false;
    return;
  }
  if (sessionActive) return;

  micTestActive = true;
  micTestResults.hidden = false;
  micTestBtn.textContent = 'Stop Mic Test';
  micTestBtn.classList.add('active');
  micTestLog.innerHTML = '';
  micTestInterim.textContent = '';
  micTestStatus.textContent = 'Listening… say something.';
  micTestStatus.classList.remove('danger');
  micBtn.disabled = true;

  micTestRecognition = new SpeechRecognitionCtor();
  micTestRecognition.continuous = false;
  micTestRecognition.interimResults = true;
  micTestRecognition.lang = 'en-US';

  micTestRecognition.onaudiostart = () => {
    micTestStatus.textContent = 'Microphone connected. Listening…';
  };
  micTestRecognition.onspeechstart = () => {
    micTestStatus.textContent = 'Hearing speech…';
  };
  micTestRecognition.onspeechend = () => {
    micTestStatus.textContent = 'Processing…';
  };
  micTestRecognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        const conf = result[0].confidence;
        const li = document.createElement('li');
        const time = new Date().toLocaleTimeString();
        const confText = Number.isFinite(conf) ? ` (confidence ${(conf * 100).toFixed(0)}%)` : '';
        li.textContent = `[${time}] "${text}"${confText}`;
        micTestLog.prepend(li);
        micTestInterim.textContent = '';
        micTestStatus.textContent = 'Heard you! Keep talking or click Stop Mic Test.';
      } else {
        interim += result[0].transcript;
      }
    }
    if (interim) micTestInterim.textContent = interim;
  };
  micTestRecognition.onerror = (event) => {
    micTestStatus.classList.add('danger');
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      micTestStatus.textContent = 'Microphone permission denied — allow mic access for this site and try again.';
    } else if (event.error === 'no-speech') {
      micTestStatus.classList.remove('danger');
      micTestStatus.textContent = "Didn't hear anything — try speaking louder or check your input device.";
    } else if (event.error !== 'aborted') {
      micTestStatus.textContent = `Error: ${event.error}`;
    }
  };
  micTestRecognition.onend = () => {
    if (micTestActive) {
      try {
        micTestRecognition.start();
      } catch {
        // already starting; ignore
      }
    }
  };

  try {
    micTestRecognition.start();
  } catch (err) {
    micTestStatus.textContent = 'Could not start microphone: ' + err.message;
    micTestStatus.classList.add('danger');
  }
}

function stopMicTest() {
  micTestActive = false;
  if (micTestRecognition) {
    micTestRecognition.onend = null;
    micTestRecognition.stop();
    micTestRecognition = null;
  }
  micTestBtn.textContent = 'Test Microphone';
  micTestBtn.classList.remove('active');
  micBtn.disabled = false;
}

micTestBtn.addEventListener('click', () => {
  if (micTestActive) {
    stopMicTest();
  } else {
    startMicTest();
  }
});

initTheme();
initLlmSettings();

transcriptLog = loadStoredTranscriptLog();
downloadTranscriptBtn.disabled = transcriptLog.length === 0;

loadSlides().then(() => {
  micBtn.disabled = false;
  micTestBtn.disabled = false;
  if (!SpeechRecognitionCtor) {
    statusEl.textContent = 'Speech recognition not supported in this browser — try Chrome or Edge.';
  }
  updateResumeAvailability();
});
