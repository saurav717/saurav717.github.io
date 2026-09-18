// ===========================================================================
//  Ask Claude -- a chat panel that sits beside the editor.
//
//  ON SIGNING IN. Anthropic publishes no "sign in with Claude" for third-party
//  websites: a Claude.ai or Claude Code subscription cannot be spent from a
//  page like this one, and there is no OAuth flow to offer. So there are
//  exactly two ways this panel can reach the API, and it supports both:
//
//    key    The visitor pastes an API key from console.anthropic.com. It is
//           kept in this browser's localStorage and sent straight to
//           api.anthropic.com -- the SDK sets the header Anthropic requires
//           for direct browser calls. Usage bills the visitor's own account.
//           Nothing about the key ever reaches this site's author.
//
//    proxy  <meta name="claude-endpoint"> names a server that holds the key.
//           The browser then has no key at all and talks only to that server,
//           which bills the person who deployed it. proxy/ has a Cloudflare
//           Worker that does this; tools/deploy_pages.sh injects the endpoint
//           from $CLAUDE_ENDPOINT, the same way the visit collector works.
//
//  With neither configured the panel shows the key card and does nothing
//  else. A plain checkout talks to nobody, which is the same promise the rest
//  of the site makes.
//
//  The SDK is loaded on first use, not at boot: it is 185 KB of vendored
//  bundle, and a visitor who never opens this panel should never pay for it.
// ===========================================================================

/** Where the API key lives. Its own key, so clearing progress never takes the
 *  key with it and exporting progress never carries the key out. */
const KEY_STORE = 'sqlpractice.anthropic-key';
const PREFS_STORE = 'sqlpractice.assistant.v1';

/** Models offered in the picker. `adaptive` is false for the ones that do not
 *  take adaptive thinking or an effort level -- sending either is a 400. */
export const MODELS = [
  { id: 'claude-opus-5',    label: 'Opus 5',    note: 'most capable',        adaptive: true  },
  { id: 'claude-sonnet-5',  label: 'Sonnet 5',  note: 'faster and cheaper',  adaptive: true  },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'fastest and cheapest', adaptive: false },
];
const DEFAULT_MODEL = 'claude-opus-5';

/** A cap, not a budget: it stops a runaway answer, it does not bound spend. */
const MAX_TOKENS = 16000;

const SYSTEM = `You are a SQL tutor embedded in a browser-based SQL practice site. The
learner writes queries against a small toy analytics warehouse that runs on DuckDB-Wasm,
entirely in their browser, and is preparing for analytics-engineering interviews.

How to help:
- Be concrete and short. Show SQL in \`\`\`sql fences; the learner can insert a fenced
  block into their editor with one click, so make each block runnable on its own.
- Only use tables and columns from the schema you are given. If you need something that
  is not there, say so rather than inventing a column.
- When the learner is working on an exercise, coach first: name the concept, point at the
  line that is wrong, suggest the next step. Hand over a complete solution when they ask
  for one -- they can already reveal it from the Show solution button, so refusing helps
  nobody -- but do not lead with it.
- The learner picks a target dialect (Redshift, Snowflake, BigQuery, Postgres). Queries
  run on DuckDB regardless, so when the two differ, say which is which.
- You cannot run queries or see anything the learner has not shared below.`;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The proxy endpoint from <meta name="claude-endpoint">, or '' when unset. */
export function proxyEndpoint() {
  const url = (document.querySelector('meta[name="claude-endpoint"]')?.content || '').trim();
  if (!url) return '';
  // A misconfigured endpoint should be inert, not a page error.
  try {
    const u = new URL(url, location.href);
    return u.protocol === 'https:' || u.hostname === 'localhost' ? u.href : '';
  } catch { return ''; }
}

const storedKey = () => {
  try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; }
};
function storeKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch { /* private mode: the key lives for this page load only */ }
}

/** 'proxy' | 'key' | 'none' -- how, or whether, this panel can reach the API. */
export function authMode() {
  if (proxyEndpoint()) return 'proxy';
  return memKey || storedKey() ? 'key' : 'none';
}

let memKey = '';               // set when localStorage is unavailable
let prefs = loadPrefs();

function loadPrefs() {
  const base = { model: DEFAULT_MODEL, context: { schema: true, exercise: true, editor: true, result: true } };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_STORE) || '{}');
    return { ...base, ...saved, context: { ...base.context, ...(saved.context || {}) } };
  } catch { return base; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_STORE, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// The SDK, loaded on demand
// ---------------------------------------------------------------------------

let Anthropic = null;
let client = null;
let clientFor = '';            // the credential the live client was built with

/**
 * Import the vendored bundle. The build tag deploy_pages.sh injects rides
 * along so a deploy cannot leave a browser holding a stale copy -- the same
 * cache-busting every other module on the deployed site gets.
 */
async function sdk() {
  if (Anthropic) return Anthropic;
  const build = document.querySelector('meta[name="build"]')?.content?.trim();
  const url = new URL('../../engine/anthropic/anthropic-browser.bundle.mjs', import.meta.url);
  if (build) url.search = `?v=${encodeURIComponent(build)}`;
  ({ Anthropic } = await import(url.href));
  return Anthropic;
}

async function anthropic() {
  const proxy = proxyEndpoint();
  const key = proxy ? '' : (memKey || storedKey());
  const want = proxy ? `proxy:${proxy}` : `key:${key.slice(-6)}`;
  if (client && clientFor === want) return client;

  const SDK = await sdk();
  client = new SDK({
    // Deliberate, and the only way a static site can work: this is the
    // visitor's own key, in the visitor's own browser, going to Anthropic.
    dangerouslyAllowBrowser: true,
    // The proxy holds the real key; the SDK still wants a non-empty string.
    apiKey: proxy ? 'proxied' : key,
    ...(proxy ? { baseURL: proxy } : {}),
    maxRetries: 1,
  });
  clientFor = want;
  return client;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Turn whatever the page knows right now into the text block that leads the
 * request. Each part is here only if the matching switch is on, so a learner
 * who does not want their draft leaving the machine can turn it off and it
 * is simply never assembled.
 */
function contextBlock(ctx) {
  const on = prefs.context;
  const parts = [];

  if (on.schema && ctx.schema?.length) {
    const tables = ctx.schema.map(t => {
      const cols = t.columns.map(c => `    ${c.name} ${c.type}${c.note ? `  -- ${c.note}` : ''}`).join('\n');
      return `  ${t.name}${t.rowCount === null ? '' : ` (${t.rowCount.toLocaleString()} rows)`}\n${cols}`;
    }).join('\n');
    parts.push(`<schema engine="DuckDB">\n${tables}\n</schema>`);
  }
  if (ctx.targetEngine) {
    parts.push(`<target_dialect>${ctx.targetEngine}</target_dialect>`);
  }
  if (on.exercise && ctx.exercise) {
    parts.push(`<exercise id="${ctx.exercise.id}" title="${ctx.exercise.title}">\n${ctx.exercise.prompt}\n</exercise>`);
  } else if (ctx.sandbox) {
    parts.push('<mode>Sandbox: free-form SQL, no exercise in progress.</mode>');
  }
  if (on.editor && ctx.editor?.trim()) {
    parts.push(`<editor>\n${ctx.editor.trim()}\n</editor>`);
  }
  if (on.result && ctx.result) {
    parts.push(`<last_result>\n${ctx.result}\n</last_result>`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);

let el = {};                   // the panel's elements, looked up once
let deps = {};                 // markdown, insertSql, context -- injected
let turns = [];                // [{ role, content }] for this page load
let live = null;               // the MessageStream currently running

/** Escaped for the one place this module writes HTML of its own. */
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function init(options = {}) {
  deps = options;
  el = {
    pane:     $('[data-tile="assistant"]'),
    body:     $('#chat-body'),
    form:     $('#chat-form'),
    input:    $('#chat-input'),
    send:     $('#chat-send'),
    stop:     $('#chat-stop'),
    model:    $('#chat-model'),
    reset:    $('#chat-reset'),
    settings: $('#chat-settings'),
    gear:     $('#chat-gear'),
  };
  if (!el.pane) return;

  el.model.innerHTML = MODELS.map(m =>
    `<option value="${esc(m.id)}"${m.id === prefs.model ? ' selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('');
  el.model.addEventListener('change', () => { prefs.model = el.model.value; savePrefs(); });

  el.gear.addEventListener('click', () => {
    const open = el.settings.hidden;
    el.settings.hidden = !open;
    el.gear.classList.toggle('btn-primary', open);
    if (open) renderSettings();
  });

  el.reset.addEventListener('click', () => {
    if (live) return;
    turns = [];
    renderThread();
  });

  el.form.addEventListener('submit', (e) => { e.preventDefault(); void send(); });
  el.stop.addEventListener('click', () => live?.abort());

  // ↵ sends, ⇧↵ makes a new line -- the convention every chat box uses.
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void send();
    }
  });
  el.input.addEventListener('input', growInput);

  // One handler for every Insert button the thread will ever grow.
  el.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.chat-insert');
    if (btn) { deps.insertSql?.(decodeURIComponent(btn.dataset.sql)); return; }
    const save = e.target.closest('#chat-key-save');
    if (save) { saveKeyFromCard(); return; }
    const forget = e.target.closest('#chat-key-forget');
    if (forget) { memKey = ''; storeKey(''); client = null; renderThread(); }
  });

  // Enter in the key field saves it, the way the button does.
  el.body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'chat-key-input') { e.preventDefault(); saveKeyFromCard(); }
  });

  renderThread();
}

function growInput() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
}

/** Called when Sandbox mode is toggled, so the empty state stays accurate. */
export function refresh() {
  if (el.pane && !turns.length) renderThread();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSettings() {
  const mode = authMode();
  const rows = [
    ['schema', 'Warehouse schema', 'table and column names, types and notes'],
    ['exercise', 'Current exercise', 'its title and prompt'],
    ['editor', 'Editor contents', 'the SQL you have written'],
    ['result', 'Last result', 'the columns, row count or error from your last run'],
  ];
  el.settings.innerHTML =
    `<div class="chat-set-title">Send with each message</div>` +
    rows.map(([k, label, note]) => `
      <label class="chat-set-row" title="${esc(note)}">
        <input type="checkbox" data-ctx="${k}"${prefs.context[k] ? ' checked' : ''}>
        <span>${esc(label)}</span>
        <span class="chat-set-note">${esc(note)}</span>
      </label>`).join('') +
    (mode === 'proxy'
      ? `<div class="chat-set-title">Account</div>
         <p class="chat-set-note">Requests go through this site's own endpoint, so no key is stored in your browser.</p>`
      : mode === 'key'
        ? `<div class="chat-set-title">Account</div>
           <p class="chat-set-note">Your API key is in this browser only, and goes straight to Anthropic.</p>
           <button type="button" class="btn btn-ghost btn-mini" id="chat-key-forget">Forget my key</button>`
        : '');

  el.settings.querySelectorAll('[data-ctx]').forEach(box => {
    box.addEventListener('change', () => {
      prefs.context[box.dataset.ctx] = box.checked;
      savePrefs();
    });
  });
}

/** The card shown when there is no way to reach the API yet. */
function keyCard() {
  return `
    <div class="chat-card">
      <h3>Connect an Anthropic account</h3>
      <p>Anthropic does not offer a “sign in with Claude” for third-party sites, and a
         Claude.ai subscription cannot be spent from a web page — so this panel needs an
         <strong>API key</strong> from the developer console.</p>
      <ol>
        <li>Open <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com/settings/keys</a> and create a key.</li>
        <li>Paste it below. It is stored in this browser only and sent straight to Anthropic — this site has no server and never sees it.</li>
      </ol>
      <div class="chat-key-row">
        <input type="password" id="chat-key-input" placeholder="sk-ant-…" autocomplete="off" spellcheck="false">
        <button type="button" class="btn btn-primary" id="chat-key-save">Save</button>
      </div>
      <p class="chat-card-note">Usage bills your own Anthropic account. Clear it any time from the ⚙ menu.</p>
    </div>`;
}

function saveKeyFromCard() {
  const input = $('#chat-key-input');
  const key = (input?.value || '').trim();
  if (!key) return;
  if (!/^sk-ant-/.test(key)) {
    input.setCustomValidity('');
    if (!confirm('That does not look like an Anthropic API key (they start with "sk-ant-"). Save it anyway?')) return;
  }
  memKey = key;
  storeKey(key);
  client = null;
  renderThread();
  el.input.focus();
}

function emptyState() {
  const ideas = (deps.context?.() ?? {}).sandbox
    ? ['What does <code>QUALIFY</code> do, and which engines have it?',
       'Write a query that finds gaps in a daily series.',
       'How do I pivot rows into columns here?']
    : ['Why is my window frame returning the wrong running total?',
       'Explain the difference between <code>ROWS</code> and <code>RANGE</code>.',
       'What is wrong with the query in my editor?'];
  return `
    <div class="chat-empty">
      <p>Ask about the exercise, the schema, or the SQL in your editor. Claude sees whatever
         you have switched on under ⚙ — nothing else.</p>
      <ul>${ideas.map(i => `<li>${i}</li>`).join('')}</ul>
    </div>`;
}

function turnHtml(turn, index) {
  if (turn.role === 'user') {
    return `<div class="chat-turn chat-user"><div class="chat-text">${esc(turn.content).replace(/\n/g, '<br>')}</div></div>`;
  }
  const thinking = turn.thinking?.trim()
    ? `<details class="chat-thinking"><summary>Reasoning</summary><div>${esc(turn.thinking).replace(/\n/g, '<br>')}</div></details>`
    : '';
  const body = turn.content
    ? deps.markdown(turn.content)
    : (turn.streaming ? '<p class="chat-wait">…</p>' : '');
  const err = turn.error ? `<p class="chat-err">${esc(turn.error)}</p>` : '';
  const note = turn.truncated ? '<p class="chat-note">Answer hit the length cap. Ask for the rest.</p>' : '';
  return `<div class="chat-turn chat-claude" data-turn="${index}">${thinking}<div class="chat-text">${body}</div>${err}${note}</div>`;
}

/** Give every ```sql block a button that drops it into the editor. */
function wireInserts(scope) {
  scope.querySelectorAll('.chat-claude pre > code').forEach(code => {
    const pre = code.parentElement;
    if (pre.querySelector('.chat-insert')) return;
    const sql = code.textContent;
    if (!sql.trim()) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-mini chat-insert';
    btn.textContent = 'Insert';
    btn.title = 'Put this query in the editor';
    btn.dataset.sql = encodeURIComponent(sql);
    pre.append(btn);
  });
}

function renderThread({ keepScroll = false } = {}) {
  if (!el.body) return;
  // Follow a streaming answer down, but never scroll a thread that has
  // nothing in it: the key card is taller than the panel, and landing on its
  // last line hides the heading that explains what it is asking for.
  const atBottom = turns.length
    ? (keepScroll ? el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight < 40 : true)
    : false;

  const mode = authMode();
  el.body.innerHTML =
    (mode === 'none' ? keyCard() : '') +
    (!turns.length && mode !== 'none' ? emptyState() : '') +
    turns.map(turnHtml).join('');
  wireInserts(el.body);

  const ready = mode !== 'none';
  el.input.disabled = !ready;
  el.send.disabled = !ready || !!live;
  el.model.disabled = !!live;
  el.stop.hidden = !live;
  el.send.hidden = !!live;
  el.reset.disabled = !!live || !turns.length;

  if (atBottom) el.body.scrollTop = el.body.scrollHeight;
}

// Streaming repaints the whole thread, which is cheap here (a handful of
// turns) and keeps one rendering path. rAF keeps it to one repaint a frame.
let painting = false;
function schedulePaint() {
  if (painting) return;
  painting = true;
  requestAnimationFrame(() => { painting = false; renderThread({ keepScroll: true }); });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** What a failure should say to someone who is not holding the SDK docs. */
function explain(err, SDK) {
  if (SDK && err instanceof SDK.AuthenticationError) {
    return 'Anthropic rejected that API key. Check it in the console, then re-enter it under ⚙.';
  }
  if (SDK && err instanceof SDK.PermissionDeniedError) {
    return 'That key is not allowed to use this model. Try a different model, or a key with broader access.';
  }
  if (SDK && err instanceof SDK.RateLimitError) {
    return 'Rate limited by Anthropic. Wait a moment and ask again.';
  }
  if (SDK && err instanceof SDK.APIUserAbortError) return 'Stopped.';
  if (SDK && err instanceof SDK.APIConnectionError) {
    return proxyEndpoint()
      ? 'Could not reach the configured endpoint. It may be down, or missing its CORS headers.'
      : 'Could not reach api.anthropic.com. Check your connection, or whether something is blocking the request.';
  }
  if (SDK && err instanceof SDK.APIError) return `Anthropic returned ${err.status}: ${err.message}`;
  return String(err?.message ?? err);
}

async function send() {
  const text = el.input.value.trim();
  if (!text || live || authMode() === 'none') return;

  el.input.value = '';
  growInput();
  turns.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '', thinking: '', streaming: true };
  turns.push(reply);
  renderThread();

  let SDK = null;
  try {
    SDK = await sdk();
    const api = await anthropic();
    const ctx = deps.context?.() ?? {};
    const model = MODELS.find(m => m.id === prefs.model) ?? MODELS[0];

    // The context block leads the first user turn only: it is the biggest
    // thing in the request, and re-stating a schema that has not changed on
    // every turn would spend tokens to say the same thing again.
    const block = contextBlock(ctx);
    const messages = turns
      .filter(t => t.role === 'user' || t.content)
      .map((t, i) => ({
        role: t.role,
        content: i === 0 && t.role === 'user' && block ? `${block}\n\n${t.content}` : t.content,
      }));

    live = api.messages.stream({
      model: model.id,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages,
      // Adaptive thinking earns its latency on "why is this window frame
      // wrong"; the models that do not take it simply go without.
      ...(model.adaptive
        ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } }
        : {}),
    });
    live.on('text', (delta) => { reply.content += delta; schedulePaint(); });
    live.on('thinking', (delta) => { reply.thinking += delta; schedulePaint(); });

    const final = await live.finalMessage();
    if (final.stop_reason === 'max_tokens') reply.truncated = true;
    if (final.stop_reason === 'refusal') {
      reply.error = 'Claude declined to answer that one.';
    }
  } catch (e) {
    reply.error = explain(e, SDK);
    // An abort with nothing streamed yet is a cancelled turn, not an answer.
    if (!reply.content && reply.error === 'Stopped.') turns.pop();
  } finally {
    live = null;
    reply.streaming = false;
    renderThread({ keepScroll: true });
  }
}
