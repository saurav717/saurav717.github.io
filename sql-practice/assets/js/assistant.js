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
/** Past conversations. Its own key again, for the same reason: clearing
 *  progress must not take the chats, and the key must never ride along. */
const HISTORY_STORE = 'sqlpractice.assistant.history.v1';

/** How much history to keep. localStorage is a few megabytes for the whole
 *  origin and the seed data is already in it, so the cap is deliberately
 *  modest -- and a write that still does not fit drops the oldest chats
 *  rather than throwing the newest one away. */
const HISTORY_MAX_CHATS = 40;
const HISTORY_MAX_CHARS = 20000;   // per message, stored; the thread on screen is untouched

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

What you can see:
- Each message carries a <screen> block holding what is on the learner's screen at that
  moment: the exercise, the hints they have uncovered, the SQL in the editor and where
  their caret is, the rows the last query returned, what Check answer said, and the
  portability and dialect tabs. It is re-read for every message, so trust the newest one
  and ignore earlier copies — the editor and the results will have moved on.
- Read it before asking. If the answer is already on their screen, use it rather than
  asking them to paste it back to you.
- You still cannot run queries yourself, and a switch under ⚙ can withhold any part of
  that block. If something you need is genuinely not there, say which part is missing.
- If the reference solution appears, they revealed it themselves — you may discuss it
  freely. If it does not appear, they have not, so coach rather than hand it over.`;

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
  const base = {
    model: DEFAULT_MODEL,
    // All on: the point of the panel is not having to paste the screen into
    // it. Anyone who wants less can say so under ⚙, and that choice sticks.
    context: {
      schema: true, exercise: true, editor: true, result: true,
      hints: true, feedback: true, lint: true, dialect: true, recent: true,
    },
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_STORE) || '{}');
    return { ...base, ...saved, context: { ...base.context, ...(saved.context || {}) } };
  } catch { return base; }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_STORE, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
//
// Every conversation is filed in this browser as it happens, so closing the
// panel -- or the tab -- no longer throws the answer away. There is no server
// here and there is not going to be one, so "your chats" means localStorage:
// this browser, this machine, nobody else's, and gone when the browser's site
// data is cleared. The History button says as much, because a list titled
// "previous chats" otherwise implies an account that does not exist.
//
// What is stored is the text of the turns, not the <screen> block that rode
// along with them: that block is rebuilt from the live page every time a
// message is sent, and a stale copy of somebody's editor is exactly the thing
// not worth keeping on disk. The reasoning summaries go the same way -- they
// are the longest part of a thread and the least useful to reread.

/** [{ id, title, created, updated, turns: [{ role, content }] }], newest first. */
let history = loadHistory();
/** Which stored chat the thread on screen is. Null until it has been filed. */
let threadId = null;

function loadHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_STORE) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(c => c && typeof c.id === 'string' && Array.isArray(c.turns) && c.turns.length)
      .map(c => ({
        id: c.id,
        title: String(c.title || '').slice(0, 120),
        created: Number(c.created) || Date.now(),
        updated: Number(c.updated) || Number(c.created) || Date.now(),
        turns: c.turns
          .filter(t => t && (t.role === 'user' || t.role === 'assistant'))
          .map(t => ({ role: t.role, content: String(t.content ?? '') })),
      }))
      .filter(c => c.turns.length)
      .slice(0, HISTORY_MAX_CHATS);
  } catch { return []; }
}

/**
 * Write the list back, shedding the oldest chats until it fits.
 *
 * A quota error here must not lose the conversation the learner is in the
 * middle of, so the newest entry is the last thing given up -- and if even one
 * chat will not fit, the panel carries on with the in-memory list and simply
 * stops persisting.
 */
function saveHistory() {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      localStorage.setItem(HISTORY_STORE, JSON.stringify(history));
      return true;
    } catch {
      if (history.length <= 1) break;
      history = history.slice(0, Math.max(1, Math.floor(history.length / 2)));
    }
  }
  try { localStorage.removeItem(HISTORY_STORE); } catch { /* private mode */ }
  return false;
}

const chatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A chat is named after the question that started it. */
function titleFor(turns) {
  const first = turns.find(t => t.role === 'user' && t.content.trim());
  const line = (first?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled chat';
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
}

/** The turns as they are stored: text only, capped, and nothing half-written. */
function storableTurns() {
  return turns
    .filter(t => t.content && t.content.trim() && !t.streaming)
    .map(t => ({ role: t.role, content: t.content.slice(0, HISTORY_MAX_CHARS) }));
}

/**
 * File the thread on screen. Called after every completed answer, so a chat is
 * in the list the moment it has one -- there is no Save button to forget.
 */
function rememberThread() {
  const stored = storableTurns();
  if (!stored.length) return;
  const now = Date.now();
  const at = history.findIndex(c => c.id === threadId);
  const entry = {
    id: threadId ?? (threadId = chatId()),
    title: at >= 0 ? history[at].title : titleFor(stored),
    created: at >= 0 ? history[at].created : now,
    updated: now,
    turns: stored,
  };
  if (at >= 0) history.splice(at, 1);
  history.unshift(entry);                       // newest first, and a reply promotes it
  if (history.length > HISTORY_MAX_CHATS) history.length = HISTORY_MAX_CHATS;
  saveHistory();
  updateHistoryCount();
}

/** Put the current thread away and start an empty one. */
function startNewChat() {
  rememberThread();
  turns = [];
  threadId = null;
  renderThread();
  if (!el.history.hidden) renderHistory();
}

/** Reopen a stored chat. The one on screen is filed first, never dropped. */
function openChat(id) {
  if (live) return;
  const chat = history.find(c => c.id === id);
  if (!chat) return;
  if (threadId !== id) rememberThread();
  threadId = chat.id;
  // A copy: editing the live thread must not rewrite the stored one until
  // rememberThread says so.
  turns = chat.turns.map(t => ({ ...t }));
  renderThread();
  renderHistory();
  el.body.scrollTop = 0;
  el.input.focus();
}

function deleteChat(id) {
  history = history.filter(c => c.id !== id);
  saveHistory();
  if (threadId === id) threadId = null;         // the thread stays on screen, unfiled
  updateHistoryCount();
  renderHistory();
}

function clearHistory() {
  if (!history.length) return;
  if (!confirm(`Delete all ${history.length} saved chat${history.length === 1 ? '' : 's'} from this browser? This cannot be undone.`)) return;
  history = [];
  threadId = null;
  // Removed, not written back as an empty list: "delete all" should leave
  // nothing of the chats behind, not a tidy record that there were some.
  try { localStorage.removeItem(HISTORY_STORE); } catch { /* private mode */ }
  updateHistoryCount();
  renderHistory();
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

/** An XML-ish tag with attributes, skipped entirely when the body is empty. */
function tag(name, body, attrs = {}) {
  const text = String(body ?? '').trim();
  if (!text) return '';
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${String(v).replace(/"/g, "'")}"`).join('');
  return `<${name}${a}>\n${text}\n</${name}>`;
}

/**
 * Everything on the screen, as the text block that leads a request.
 *
 * The rule this follows is the one a person sitting next to the learner would
 * follow: look at the screen, then answer. So the exercise, the hints already
 * uncovered, the query being written, the rows that came back, what Check
 * said and what the portability tab is warning about all go in together --
 * and they go in *fresh on every message*, not once at the top of the
 * conversation, because "why did that fail?" is about the run that just
 * happened, not the state of the page ten minutes ago.
 *
 * Each part is here only if the matching switch is on, so a learner who does
 * not want their draft leaving the machine can turn it off and it is simply
 * never assembled.
 */
function contextBlock(ctx) {
  const on = prefs.context;
  const parts = [];
  const seen = (name) => (ctx.activeTab === name ? 'yes' : 'no');

  if (on.schema && ctx.schema?.length) {
    const tables = ctx.schema.map(t => {
      const cols = t.columns.map(c => `    ${c.name} ${c.type}${c.note ? `  -- ${c.note}` : ''}`).join('\n');
      return `  ${t.name}${t.rowCount === null ? '' : ` (${t.rowCount.toLocaleString()} rows)`}\n${cols}`;
    }).join('\n');
    parts.push(tag('schema', tables, { engine: 'DuckDB' }));
  }
  if (ctx.targetEngine) {
    parts.push(`<target_dialect>${ctx.targetEngine}</target_dialect>`);
  }

  const ex = ctx.exercise;
  if (on.exercise && ex) {
    parts.push(tag('exercise', ex.prompt, {
      id: ex.id, title: ex.title, track: ex.track,
      difficulty: ex.difficulty, status: ex.status,
      order_matters: ex.ordered === undefined ? '' : String(!!ex.ordered),
    }));
    if (on.hints && ex.hints?.length) {
      parts.push(tag('hints_already_revealed',
        ex.hints.map((h, i) => `${i + 1}. ${h}`).join('\n'),
        { remaining: ex.hintsLeft }));
    }
    if (on.hints && ex.solution) {
      parts.push(tag('reference_solution', ex.solution,
        { note: 'the learner has revealed this already' }));
    }
  } else if (ctx.sandbox) {
    parts.push('<mode>Sandbox: free-form SQL, no exercise in progress.</mode>');
  }

  if (on.editor && ctx.editor) {
    parts.push(tag('editor', ctx.editor.text,
      { caret: ctx.editor.caret, would_run: ctx.editor.running }));
    if (ctx.editor.selection) parts.push(tag('editor_selection', ctx.editor.selection));
  }

  if (on.result) {
    parts.push(tag('results_tab', ctx.results, { showing: seen('results'), summary: ctx.result }));
  }
  if (on.feedback) parts.push(tag('feedback_tab', ctx.feedback, { showing: seen('feedback') }));
  if (on.lint) parts.push(tag('portability_tab', ctx.lint, { showing: seen('portability') }));
  if (on.dialect) parts.push(tag('dialect_notes_tab', ctx.dialect, { showing: seen('dialect') }));
  if (on.result && ctx.status) parts.push(`<status_bar>${ctx.status}</status_bar>`);

  if (on.recent && ctx.recent?.length) {
    parts.push(tag('recent_runs', ctx.recent.map(r =>
      `${r.what}: ${r.outcome}\n${String(r.sql ?? '').trim()}`).join('\n\n')));
  }

  const body = parts.filter(Boolean).join('\n\n');
  return body ? `<screen>\n${body}\n</screen>` : '';
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
    history:  $('#chat-history'),
    histBtn:  $('#chat-history-btn'),
    histCount:$('#chat-history-count'),
  };
  if (!el.pane) return;

  el.model.innerHTML = MODELS.map(m =>
    `<option value="${esc(m.id)}"${m.id === prefs.model ? ' selected' : ''}>${esc(m.label)} — ${esc(m.note)}</option>`).join('');
  el.model.addEventListener('change', () => { prefs.model = el.model.value; savePrefs(); });

  // The two drawers share the top of the panel, so opening one closes the
  // other -- both at once leaves the thread itself a two-line slot.
  el.gear.addEventListener('click', () => { showDrawer(el.settings.hidden ? 'settings' : null); });
  el.histBtn.addEventListener('click', () => { showDrawer(el.history.hidden ? 'history' : null); });

  el.reset.addEventListener('click', () => {
    if (live) return;
    startNewChat();
  });

  // One handler for the whole list, however long it grows.
  el.history.addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { e.stopPropagation(); deleteChat(del.dataset.del); return; }
    if (e.target.closest('#chat-history-clear')) { clearHistory(); return; }
    const open = e.target.closest('[data-chat]');
    if (open) openChat(open.dataset.chat);
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

  updateHistoryCount();
  renderThread();
}

/** Show one of the two drawers above the thread, or neither. */
function showDrawer(which) {
  el.settings.hidden = which !== 'settings';
  el.history.hidden = which !== 'history';
  el.gear.classList.toggle('btn-primary', which === 'settings');
  el.histBtn.classList.toggle('btn-on', which === 'history');
  el.histBtn.setAttribute('aria-pressed', String(which === 'history'));
  if (which === 'settings') renderSettings();
  if (which === 'history') renderHistory();
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

/** "just now" / "14 min ago" / "3 days ago" -- enough to find a chat by. */
function ago(ts) {
  const secs = Math.max(0, (Date.now() - ts) / 1000);
  if (secs < 90) return 'just now';
  const units = [[60, 'min'], [60, 'hour'], [24, 'day'], [7, 'week']];
  let n = secs, label = 'sec';
  for (const [size, name] of units) {
    if (n < size) break;
    n /= size; label = name;
  }
  const whole = Math.floor(n);
  return `${whole} ${label}${whole === 1 ? '' : 's'} ago`;
}

/** The drawer behind the History button: every chat this browser has kept. */
function renderHistory() {
  if (!el.history) return;
  const rows = history.map(chat => {
    const replies = chat.turns.filter(t => t.role === 'assistant').length;
    const asks = chat.turns.length - replies;
    const current = chat.id === threadId;
    return `
      <div class="chat-hist-row${current ? ' chat-hist-on' : ''}">
        <button type="button" class="chat-hist-open" data-chat="${esc(chat.id)}"
                title="${esc(chat.title)}"${current ? ' aria-current="true"' : ''}>
          <span class="chat-hist-title">${esc(chat.title)}</span>
          <span class="chat-hist-meta">${asks} question${asks === 1 ? '' : 's'} · ${esc(ago(chat.updated))}${current ? ' · open' : ''}</span>
        </button>
        <button type="button" class="chat-hist-del" data-del="${esc(chat.id)}"
                title="Delete this chat" aria-label="Delete this chat">✕</button>
      </div>`;
  }).join('');

  el.history.innerHTML =
    `<div class="chat-set-title">Previous chats</div>` +
    (history.length
      ? `${rows}
         <div class="chat-hist-foot">
           <p class="chat-set-note">Kept in this browser only — no account, nothing uploaded.
              The screen that went with each question is not stored.</p>
           <button type="button" class="btn btn-ghost btn-mini" id="chat-history-clear">Delete all</button>
         </div>`
      : `<p class="chat-set-note chat-set-lede">No chats yet. Every conversation is filed here
           as soon as Claude answers, and stays in this browser until you delete it.</p>`);
}

/** The count on the History button, so the drawer advertises itself. */
function updateHistoryCount() {
  if (!el.histCount) return;
  el.histCount.textContent = String(history.length);
  el.histCount.hidden = history.length === 0;
}

function renderSettings() {
  const mode = authMode();
  const rows = [
    ['schema', 'Warehouse schema', 'table and column names, types and notes'],
    ['exercise', 'Current exercise', 'its title, prompt and whether you have solved it'],
    ['hints', 'Hints and solution', 'only the ones you have already revealed'],
    ['editor', 'Editor contents', 'the SQL you have written, and where your caret is'],
    ['result', 'Results tab', 'the rows that came back, or the error, and the status line'],
    ['feedback', 'Feedback tab', 'what Check answer said about your query'],
    ['lint', 'Portability tab', 'what will not run on your target engine'],
    ['dialect', 'Dialect notes tab', 'how this answer is spelled on other warehouses'],
    ['recent', 'Recent runs', 'the last few queries you ran, and how they went'],
  ];
  el.settings.innerHTML =
    `<div class="chat-set-title">What Claude sees on your screen</div>` +
    `<p class="chat-set-note chat-set-lede">Read fresh every time you send, so you never
      have to paste your query or your results in. Turn off anything you would rather
      keep to yourself.</p>` +
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
    : ['Why did that fail?',
       'Is this the right join for what the prompt is asking?',
       'Why are my numbers off by one row?'];
  return `
    <div class="chat-empty">
      <p>Just ask — Claude reads your screen first. The exercise, your query, the rows
         that came back and what Check answer said all go along with the question, so
         there is nothing to paste. The ⚙ menu says exactly what that means, and lets
         you hold anything back.</p>
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

    // The screen block leads the *newest* user turn, not the first one.
    //
    // It used to lead the first, to avoid re-sending a schema that had not
    // changed -- but the schema is the only part of it that does not change.
    // The editor, the grid and the verdict move with every run, and a block
    // pinned to the first turn meant the second question was answered against
    // a screen the learner had left behind. One copy per request either way;
    // this way it is the current one.
    const block = contextBlock(ctx);
    const sent = turns.filter(t => t.role === 'user' || t.content);
    const newest = sent.map(t => t.role).lastIndexOf('user');
    const messages = sent.map((t, i) => ({
      role: t.role,
      content: i === newest && block ? `${block}\n\n${t.content}` : t.content,
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
    // Filed the moment there is something worth keeping -- no Save button to
    // forget, and a closed tab costs nothing.
    rememberThread();
    if (!el.history.hidden) renderHistory();
  }
}
