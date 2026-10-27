// Helpers shared by the student site (app.js) and the admin panel (admin.js).
/* global TZ, marked, renderMathInElement, CodeMirror */
(function () {
  'use strict';

  // --- API -----------------------------------------------------------------
  async function request(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }
  const api = {
    get: (u) => request('GET', u),
    post: (u, b) => request('POST', u, b ?? {}),
    put: (u, b) => request('PUT', u, b ?? {}),
    del: (u) => request('DELETE', u),
  };

  // --- escaping & formatting ----------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  // Server/client clock difference so countdowns are right even if the student's clock is off.
  let clockOffset = 0;
  function setServerNow(serverNow) { if (serverNow) clockOffset = serverNow - Date.now(); }
  const now = () => Date.now() + clockOffset;

  function fmtClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  function fmtDuration(minutes) {
    const m = Math.round(minutes);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 48) return r ? `${h} h ${r} min` : `${h} h`;
    const d = Math.floor(h / 24);
    return `${d} day${d > 1 ? 's' : ''}${h % 24 ? ` ${h % 24} h` : ''}`;
  }
  function fmtWhen(iso, tz) { return TZ.format(Date.parse(iso), tz || TZ.localZone()); }
  function fmtRange(c) {
    const tz = c.timezone || 'UTC';
    const s = Date.parse(c.start_at), e = Date.parse(c.end_at);
    const sameDay = TZ.utcToZonedInput(s, tz).slice(0, 10) === TZ.utcToZonedInput(e, tz).slice(0, 10);
    const endStr = sameDay ? TZ.format(e, tz, { year: undefined, month: undefined, day: undefined }) : TZ.format(e, tz);
    return `${TZ.format(s, tz)} – ${endStr}`;
  }
  // Shows the contest's own zone first, and the viewer's local zone if different.
  function fmtWhenBoth(iso, tz) {
    const local = TZ.localZone();
    const a = fmtWhen(iso, tz);
    if (local === tz) return a;
    const b = fmtWhen(iso, local);
    return a === b ? a : `${a} <span class="faint">(${esc(b)} your time)</span>`;
  }
  function fmtAgo(iso) {
    const diff = Math.round((now() - Date.parse(iso)) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    return new Date(iso).toLocaleString();
  }
  function fmtMem(kb) { return kb == null ? '' : `${Math.max(1, Math.round(kb / 1024))} MB`; }
  function fmtPoints(p) { return Number.isInteger(p) ? String(p) : Number(p).toFixed(2).replace(/\.?0+$/, ''); }

  function verdictHtml(s) {
    if (s.invalidated) return `<span class="v v-invalid" title="Removed from standings by an organizer">${esc(s.verdict_name || s.verdict || 'Invalidated')}</span>`;
    if (s.status === 'queued') return '<span class="v v-queued">In queue</span>';
    if (s.status === 'judging') return `<span class="v v-judging">Judging${s.tests_total ? ` ${s.tests_passed}/${s.tests_total}` : ''}…</span>`;
    const name = s.verdict_name || s.verdict || '?';
    const where = s.verdict && s.verdict !== 'AC' && s.verdict !== 'CE' && s.verdict !== 'IE' && s.failed_test ? ` on test ${s.failed_test}` : '';
    return `<span class="v v-${esc(s.verdict)}">${esc(name)}${where}</span>`;
  }
  function statusPill(status, visible) {
    if (visible === false) return `<span class="pill hidden">Hidden</span>`;
    return { running: '<span class="pill running"><span class="dot"></span>Running</span>', upcoming: '<span class="pill upcoming">Upcoming</span>', ended: '<span class="pill ended">Finished</span>' }[status] || '';
  }

  // --- markdown + math -----------------------------------------------------
  function renderMarkdown(el, md) {
    if (typeof marked !== 'undefined') el.innerHTML = marked.parse(md || '', { breaks: false, gfm: true });
    else el.textContent = md || '';
    if (typeof renderMathInElement !== 'undefined') {
      try {
        renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }, { left: '\\(', right: '\\)', display: false }, { left: '\\[', right: '\\]', display: true }], throwOnError: false });
      } catch { /* ignore */ }
    }
  }

  // --- code editor (CodeMirror 5 if available, plain textarea otherwise) ---
  const MODES = { cpp: 'text/x-c++src', python: 'text/x-python', java: 'text/x-java' };
  function makeEditor(textarea, lang) {
    if (typeof CodeMirror !== 'undefined') {
      const cm = CodeMirror.fromTextArea(textarea, { lineNumbers: true, mode: MODES[lang] || 'text/plain', indentUnit: 4, tabSize: 4, indentWithTabs: false, lineWrapping: false, viewportMargin: 50,
        extraKeys: { Tab: (c) => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('    ', 'end'), 'Shift-Tab': (c) => c.indentSelection('subtract') } });
      return { getValue: () => cm.getValue(), setValue: (v) => cm.setValue(v), setLang: (l) => cm.setOption('mode', MODES[l] || 'text/plain'), focus: () => cm.focus(), onChange: (f) => cm.on('change', f) };
    }
    textarea.classList.add('code');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const s = textarea.selectionStart, en = textarea.selectionEnd; textarea.value = textarea.value.slice(0, s) + '    ' + textarea.value.slice(en); textarea.selectionStart = textarea.selectionEnd = s + 4; }
    });
    return { getValue: () => textarea.value, setValue: (v) => { textarea.value = v; }, setLang: () => {}, focus: () => textarea.focus(), onChange: (f) => textarea.addEventListener('input', f) };
  }

  // --- misc UI -------------------------------------------------------------
  function toast(msg, ms = 2500) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }
  function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function formData(form) { const o = {}; new FormData(form).forEach((v, k) => { o[k] = v; }); qsa('input[type=checkbox]', form).forEach((c) => { o[c.name] = c.checked; }); return o; }
  function copyText(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied')); }

  const LANG_NAMES = { cpp: 'C++17 (g++)', python: 'Python 3', java: 'Java 21' };
  const STORAGE = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  window.MF = { api, esc, now, setServerNow, fmtClock, fmtDuration, fmtWhen, fmtWhenBoth, fmtRange, fmtAgo, fmtMem, fmtPoints, verdictHtml, statusPill, renderMarkdown, makeEditor, toast, h, qs, qsa, formData, copyText, LANG_NAMES, STORAGE };
})();
