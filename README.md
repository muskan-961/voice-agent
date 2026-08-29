# Voice-Guided Slides

An AI voice presenter that talks through a 6-slide deck on "Antibiotics:
From Discovery to Resistance," automatically jumps to the slide most
relevant to whatever you ask, and can be interrupted mid-sentence just by
talking over it.

Built entirely on free tooling — no paid API required.

## How it works

- **Speech-to-text & text-to-speech**: the browser's native Web Speech API
  (`SpeechRecognition` + `speechSynthesis`). Free, no API key, works in
  Chrome/Edge.
- **The "brain"**: OpenAI by default, or Groq/Gemini, via an OpenAI-compatible
  chat-completions request (Gemini through Google's OpenAI-compatibility
  endpoint) — with a `change_slide` tool the model calls whenever your
  question is best answered by a different slide. Pick a provider and paste
  an API key directly in the page's **LLM Settings** panel, or configure a
  default in `.env` for the server to fall back to.
- **Automatic rate-limit fallback**: if the configured provider hits a rate
  limit, the app immediately switches to a dedicated Groq fallback
  (`GROQ_API_KEY` in `.env`) for the rest of the session — no manual
  intervention, and a banner + spoken notice explain the switch. The
  fallback is independent of whatever's set as the primary default, so
  changing the primary provider never removes it.
- **Uninterrupted playback**: if you don't say anything, the AI walks
  through the whole deck end-to-end on its own, syncing the visible slide to
  whatever it's currently explaining. The moment you talk — a question or a
  command — it drops out of that walkthrough and only responds to you from
  then on.
- **Interruption**: while the browser is listening, a confirmed final
  transcript of you talking immediately cancels playback
  (`speechSynthesis.cancel()`) and starts processing what you said.
- **Voice Activity Detection**: `SpeechRecognition` grabs the mic on its own
  with no control over audio processing, so on many setups it happily
  transcribes the AI's own voice bleeding back in through the speakers as if
  it were you talking. To guard against that, a second, independent
  `getUserMedia` stream is opened with echo cancellation, noise suppression,
  and AGC explicitly requested (the same processing real voice-call apps use
  to avoid hearing themselves), and its real-time energy is used to gate
  recognition results — a transcript only counts as real user input if this
  echo-cancelled stream also detected genuine voice energy during that
  utterance.
- **Backend**: a small stateless Express server. Its only job is to proxy
  chat turns to whichever LLM provider/key it's given — no database, no
  session storage, no build step.

## Setup

1. Get an [OpenAI API key](https://platform.openai.com/api-keys) (the
   default provider), and optionally a free
   [Groq API key](https://console.groq.com/keys) too — Groq doubles as the
   automatic rate-limit fallback regardless of which provider is primary.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure your keys (optional — you can also just paste a key into
   the page's LLM Settings panel instead, though that won't get you the
   automatic Groq fallback unless `GROQ_API_KEY` is also set in `.env`):
   ```bash
   cp .env.example .env
   # then edit .env and paste LLM_API_KEY (OpenAI) and GROQ_API_KEY (fallback)
   ```
4. Run it:
   ```bash
   npm start
   ```
5. Open http://localhost:3000 in **Chrome or Edge** (Web Speech API isn't
   well supported in Firefox/Safari).

## Using it

1. (Optional) Open **⚙ LLM Settings** to pick a different provider or paste
   an API key — or leave it blank to use the server's `.env` default
   (OpenAI). The key is stored only in your browser's `localStorage` and
   sent to your own server per request; it's never logged. The small
   "Using: ..." line below the button always shows which provider/model
   actually handled the last request, confirmed by the server rather than
   just what's in the settings fields — useful since the automatic Groq
   fallback can make those diverge mid-session.
2. Click **Start Conversation** and allow microphone access.
3. The AI greets you and introduces slide 0. Stay quiet and it will keep
   going through the whole deck on its own, slide by slide.
4. Ask a question about any topic in the deck — e.g. "Who discovered
   penicillin?" or "Why don't antibiotics work as well anymore?" — and
   watch the slide jump to match your question while the AI answers out
   loud. From this point on it's in Q&A mode and won't auto-advance.
5. Say "next slide" / "previous slide" / "stop" for instant, direct control
   (handled locally, no LLM round-trip).
6. Interrupt anytime: just start talking while the AI is speaking and it
   will stop and listen.
7. Click **End Conversation** to stop, or use **Test Microphone** any time
   to check the browser is actually capturing your voice.

Headphones still give the cleanest results, but the VAD layer described
above filters out most cases of the AI hearing its own voice through the
speakers even without them. If it's still happening in a particularly echoey
room, try raising `VAD_ENERGY_THRESHOLD` in `public/app.js` (this requires
louder/clearer voice energy before a transcript counts as real user speech —
lowering it does the opposite and would make false triggers worse).

## Project structure

```
server.js        Express server: serves the frontend + /api/chat (LLM proxy, with Groq fallback)
slides.js         Slide content, the change_slide tool schema, system prompt builder
public/
  index.html      Slide viewer + transcript + mic button
  app.js          SpeechRecognition/SpeechSynthesis state machine, chat calls
  styles.css      Styling
```
