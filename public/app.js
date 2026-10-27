// Student-facing site: contests, problems, submitting, standings, archive.
/* global MF, TZ */
(function () {
  'use strict';
  const { api, esc, now, setServerNow, fmtClock, fmtDuration, fmtWhenBoth, fmtRange, fmtAgo, fmtMem, fmtPoints, verdictHtml, statusPill, renderMarkdown, makeEditor, toast, qs, qsa, formData, copyText, LANG_NAMES, STORAGE } = MF;
  const app = document.getElementById('app');
  let site = { name: 'Contest', user: null, isAdmin: false, languages: {} };
  const langNames = () => Object.keys(site.languages || {}).length ? Object.fromEntries(Object.entries(site.languages).map(([k, v]) => [k, v.name])) : LANG_NAMES;
  let timers = [];
  const every = (ms, fn) => { fn(); timers.push(setInterval(fn, ms)); };
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); timers = []; };

  // ---------------------------------------------------------------------------
  // routing
  // ---------------------------------------------------------------------------
  const routes = [
    [/^\/$/, home], [/^\/login$/, login], [/^\/register$/, register], [/^\/profile$/, profile],
    [/^\/archive$/, archive], [/^\/my\/submissions$/, mySubmissions],
    [/^\/contest\/(\d+)$/, contestHome], [/^\/contest\/(\d+)\/problem\/(\d+)$/, problemPage],
    [/^\/contest\/(\d+)\/submit$/, submitPage], [/^\/contest\/(\d+)\/submissions$/, (id) => submissionsList(id, 'me')],
    [/^\/contest\/(\d+)\/status$/, (id) => submissionsList(id, 'all')], [/^\/contest\/(\d+)\/standings$/, standings],
    [/^\/submission\/(\d+)$/, submissionPage],
  ];
  function navigate(path) { history.pushState(null, '', path); route(); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || a.origin !== location.origin) return;
    if (a.pathname.startsWith('/admin') || a.pathname.startsWith('/api/')) return;
    e.preventDefault(); navigate(a.pathname + a.search);
  });
  window.addEventListener('popstate', route);

  async function route() {
    clearTimers();
    window.scrollTo(0, 0);
    const path = location.pathname;
    for (const [re, fn] of routes) {
      const m = path.match(re);
      if (m) {
        try { await fn(...m.slice(1)); }
        catch (e) { renderError(e); }
        return;
      }
    }
    app.innerHTML = '<h1>Page not found</h1><p><a href="/">Back to contests</a></p>';
  }

  function renderError(e) {
    if (e.status === 401) {
      app.innerHTML = `<h1>Log in first</h1><p>${esc(e.message)}</p><p><a class="btn primary" href="/login?next=${encodeURIComponent(location.pathname)}">Log in</a> &nbsp; <a href="/register?next=${encodeURIComponent(location.pathname)}">Create an account</a></p>`;
    } else {
      app.innerHTML = `<h1>${e.status === 404 ? 'Not found' : 'Something went wrong'}</h1><p class="msg error">${esc(e.message)}</p><p><a href="/">Back to contests</a></p>`;
    }
  }

  function setNav(active) {
    qsa('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === active));
    qs('[data-nav=mine]').hidden = !site.user;
  }

  function renderUserbox() {
    const ub = qs('#userbox');
    if (site.user) {
      ub.innerHTML = `<a href="/profile"><strong>${esc(site.user.username)}</strong></a>${site.isAdmin ? ' <a href="/admin">Admin</a>' : ''} <a href="#" id="logout">Log out</a>`;
      qs('#logout').onclick = async (e) => { e.preventDefault(); await api.post('/api/logout'); await loadSite(); navigate('/'); };
    } else {
      ub.innerHTML = `<a href="/login">Log in</a> <a class="btn small" href="/register">Create account</a>${site.isAdmin ? ' <a href="/admin">Admin</a>' : ''}`;
    }
  }

  async function loadSite() {
    site = await api.get('/api/site');
    setServerNow(site.now);
    document.title = site.name;
    qs('#brand').textContent = site.name;
    renderUserbox();
  }

  // ---------------------------------------------------------------------------
  // shared pieces
  // ---------------------------------------------------------------------------
  function clockHtml(c) {
    const s = Date.parse(c.start_at), e = Date.parse(c.end_at), t = now();
    if (t < s) return `<div class="clock"><small>Starts in</small>${fmtClock((s - t) / 1000)}</div>`;
    if (t < e) return `<div class="clock running"><small>Time left</small>${fmtClock((e - t) / 1000)}</div>`;
    return `<div class="clock ended"><small>Finished</small>--:--</div>`;
  }
  // Keeps every .clock-slot on the page ticking and reloads when a contest changes state.
  function startClocks(contests) {
    let state = contests.map((c) => contestState(c)).join();
    every(1000, () => {
      qsa('[data-clock]').forEach((el) => { const c = contests.find((x) => String(x.id) === el.dataset.clock); if (c) el.innerHTML = clockHtml(c); });
      const s = contests.map((c) => contestState(c)).join();
      if (s !== state) { state = s; route(); }
    });
  }
  function contestState(c) { const t = now(); return t < Date.parse(c.start_at) ? 'upcoming' : t < Date.parse(c.end_at) ? 'running' : 'ended'; }

  const LB_HELP = {
    short: 'Ranked by problems solved; ties broken by the time of your last accepted submission.',
    long: (c) => `Ranked by problems solved, then by penalty: minutes from the start to each accepted submission, plus ${c.penalty_per_wrong} per rejected attempt on a problem you solved (compilation errors don't count).`,
    adaptive: (c) => `Each problem starts at its full value and loses ${fmtPoints(c.decay_per_minute)} point${c.decay_per_minute === 1 ? '' : 's'} every minute${c.wrong_penalty_pts ? `, and ${fmtPoints(c.wrong_penalty_pts)} per rejected attempt` : ''}. Ranked by total points.`,
  };
  const lbHelp = (c) => typeof LB_HELP[c.leaderboard_type] === 'function' ? LB_HELP[c.leaderboard_type](c) : LB_HELP[c.leaderboard_type] || '';
  const LB_NAME = { short: 'Short leaderboard', long: 'Long leaderboard (penalty time)', adaptive: 'Adaptive points' };

  function contestHeader(c, tab) {
    const st = contestState(c);
    const tabs = [['home', 'Problems', `/contest/${c.id}`], ['submit', 'Submit', `/contest/${c.id}/submit`], ['mine', 'My submissions', `/contest/${c.id}/submissions`], ['status', 'Status', `/contest/${c.id}/status`], ['standings', 'Standings', `/contest/${c.id}/standings`]];
    const show = tabs.filter(([k]) => (k === 'submit' ? st === 'running' : true));
    return `
      <div class="contest-head">
        <div>
          <h1>${esc(c.name)} ${statusPill(st, c.visible)}</h1>
          <div class="meta">${fmtWhenBoth(c.start_at, c.timezone)} &nbsp;→&nbsp; ${fmtWhenBoth(c.end_at, c.timezone)} &nbsp;(${fmtDuration(c.duration_min)})</div>
          <div class="meta">${esc(LB_NAME[c.leaderboard_type] || c.leaderboard_type)}${c.participant_count != null ? ` · ${c.participant_count} participant${c.participant_count === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div data-clock="${c.id}">${clockHtml(c)}</div>
      </div>
      <nav class="tabs">${show.map(([k, name, href]) => `<a href="${href}" class="${k === tab ? 'active' : ''}">${name}</a>`).join('')}</nav>`;
  }

  function contestListHtml(list, emptyText) {
    if (!list.length) return `<p class="empty">${emptyText}</p>`;
    return `<ul class="contest-list">${list.map((c) => `
      <li>
        <div>
          <div class="name"><a href="/contest/${c.id}">${esc(c.name)}</a> ${c.visible === false ? statusPill('', false) : ''}</div>
          <div class="when">${fmtRange(c)} · ${fmtDuration(c.duration_min)} · ${c.problem_count} problem${c.problem_count === 1 ? '' : 's'}${c.participant_count ? ` · ${c.participant_count} participant${c.participant_count === 1 ? '' : 's'}` : ''}</div>
        </div>
        <div data-clock="${c.id}">${clockHtml(c)}</div>
      </li>`).join('')}</ul>`;
  }

  // ---------------------------------------------------------------------------
  // pages
  // ---------------------------------------------------------------------------
  async function home() {
    setNav('home');
    const data = await api.get('/api/contests');
    setServerNow(data.now);
    const groups = { running: [], upcoming: [], ended: [] };
    data.contests.forEach((c) => groups[contestState(c)].push(c));
    groups.upcoming.sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
    app.innerHTML = `
      <h1>Contests</h1>
      ${!site.user ? `<p class="msg">To take part in a contest, <a href="/register">create an account</a> or <a href="/login">log in</a>. Finished contests can be browsed by anyone in the <a href="/archive">archive</a>.</p>` : ''}
      <div class="section-title"><h2>Running now</h2></div>
      ${contestListHtml(groups.running, 'No contest is running right now.')}
      <div class="section-title"><h2>Upcoming</h2></div>
      ${contestListHtml(groups.upcoming, 'Nothing scheduled yet.')}
      <div class="section-title"><h2>Finished</h2><a class="count" href="/archive">all past contests →</a></div>
      ${contestListHtml(groups.ended.slice(0, 5), 'No finished contests yet.')}`;
    startClocks(data.contests);
  }

  async function archive() {
    setNav('archive');
    const data = await api.get('/api/archive');
    setServerNow(data.now);
    app.innerHTML = `
      <h1>Archive</h1>
      <p class="muted">Past contests. Open one to read the problems, the editorials and reference solutions where the organizers published them, and the final standings.</p>
      ${data.contests.length ? `<div class="table-wrap"><table><thead><tr><th>Contest</th><th>When</th><th class="num">Length</th><th class="num">Problems</th><th class="num">Participants</th><th></th></tr></thead><tbody>
        ${data.contests.map((c) => `<tr><td><a href="/contest/${c.id}">${esc(c.name)}</a></td><td>${fmtRange(c)}</td><td class="num">${fmtDuration(c.duration_min)}</td><td class="num">${c.problem_count}</td><td class="num">${c.participant_count}</td><td><a href="/contest/${c.id}/standings">standings</a></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No finished contests yet.</p>'}`;
  }

  function nextParam() { const n = new URLSearchParams(location.search).get('next'); return n && n.startsWith('/') ? n : '/'; }

  async function login() {
    setNav('');
    app.innerHTML = `
      <div class="form-narrow"><h1>Log in</h1>
      <form id="f"><div id="err"></div>
        <label for="login">Username or email</label><input id="login" name="login" type="text" required autocomplete="username" autofocus>
        <label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password">
        <p style="margin-top:1rem"><button class="primary">Log in</button> &nbsp; <a href="/register${location.search}">Create an account</a></p>
      </form></div>`;
    qs('#f').onsubmit = async (e) => {
      e.preventDefault();
      try { await api.post('/api/login', formData(e.target)); await loadSite(); navigate(nextParam()); }
      catch (err) { qs('#err').innerHTML = `<p class="msg error">${esc(err.message)}</p>`; }
    };
  }

  function accountFields(u = {}) {
    return `
      <label for="full_name">Full name</label><input id="full_name" name="full_name" type="text" required value="${esc(u.full_name || '')}" autocomplete="name">
      <label for="username">Username</label><input id="username" name="username" type="text" required pattern="[A-Za-z0-9_.\\-]{3,32}" value="${esc(u.username || '')}" autocomplete="username">
      <p class="help">3–32 characters: letters, numbers, dots, dashes, underscores. Shown on the standings.</p>
      <label for="email">School email</label><input id="email" name="email" type="email" required value="${esc(u.email || '')}" autocomplete="email">
      <label for="pl_number">PL number</label><input id="pl_number" name="pl_number" type="text" required value="${esc(u.pl_number || '')}">`;
  }

  async function register() {
    setNav('');
    app.innerHTML = `
      <div class="form-narrow"><h1>Create an account</h1>
      <p class="muted">Every field is required. One account per email address.</p>
      <form id="f"><div id="err"></div>
        ${accountFields()}
        <label for="password">Password</label><input id="password" name="password" type="password" required minlength="6" autocomplete="new-password">
        <p class="help">At least 6 characters.</p>
        <p style="margin-top:1rem"><button class="primary">Create account</button> &nbsp; <a href="/login${location.search}">I already have one</a></p>
      </form></div>`;
    qs('#f').onsubmit = async (e) => {
      e.preventDefault();
      try { await api.post('/api/register', formData(e.target)); await loadSite(); toast('Welcome!'); navigate(nextParam()); }
      catch (err) { qs('#err').innerHTML = `<p class="msg error">${esc(err.message)}</p>`; window.scrollTo(0, 0); }
    };
  }

  async function profile() {
    setNav('');
    if (!site.user) return navigate('/login?next=/profile');
    const me = (await api.get('/api/me')).user;
    app.innerHTML = `
      <div class="form-narrow"><h1>Your profile</h1>
      <form id="f"><div id="err"></div>
        ${accountFields(me)}
        <label for="new_password">New password <span class="faint">(leave blank to keep the current one)</span></label><input id="new_password" name="new_password" type="password" minlength="6" autocomplete="new-password">
        <hr>
        <label for="current_password">Current password <span class="faint">(required to save changes)</span></label><input id="current_password" name="current_password" type="password" required autocomplete="current-password">
        <p style="margin-top:1rem"><button class="primary">Save changes</button></p>
      </form>
      <p class="small muted">Member since ${new Date(me.created_at).toLocaleDateString()}. <a href="/my/submissions">See all your submissions.</a></p></div>`;
    qs('#f').onsubmit = async (e) => {
      e.preventDefault();
      try { await api.put('/api/me', formData(e.target)); await loadSite(); toast('Saved'); qs('#err').innerHTML = '<p class="msg ok">Profile saved.</p>'; qs('#current_password').value = ''; qs('#new_password').value = ''; }
      catch (err) { qs('#err').innerHTML = `<p class="msg error">${esc(err.message)}</p>`; }
      window.scrollTo(0, 0);
    };
  }

  async function contestHome(id) {
    setNav('home');
    const c = await api.get(`/api/contests/${id}`);
    setServerNow(c.now);
    const st = contestState(c);
    let body = '';
    if (c.description) body += `<div class="statement" id="desc"></div>`;
    if (st === 'upcoming') {
      body += `<p class="msg">This contest hasn't started yet. The problems appear here at the start time, and the clock is the same for everyone. ${site.user ? '' : 'You can <a href="/register">create an account</a> now so you are ready.'}</p>`;
    } else if (st === 'running' && !site.user) {
      body += `<p class="msg"><a class="btn primary" href="/login?next=/contest/${c.id}">Log in to enter</a> &nbsp; or <a href="/register?next=/contest/${c.id}">create an account</a>. You can join at any time; the end time is the same for everyone.</p>`;
    }
    if (c.problems) {
      if (st === 'running' && site.user && !c.entered) { api.post(`/api/contests/${c.id}/enter`).catch(() => {}); }
      const adaptive = c.leaderboard_type === 'adaptive';
      body += `<div class="table-wrap"><table><thead><tr><th>#</th><th>Problem</th><th>Limits</th>${adaptive ? '<th class="num">Worth now</th>' : ''}<th class="num">Solved by</th>${site.user ? '<th>You</th>' : ''}</tr></thead><tbody>
        ${c.problems.map((p) => `<tr class="${p.solved ? 'me' : ''}"><td class="mono"><b>${esc(p.label)}</b></td><td><a href="/contest/${c.id}/problem/${p.id}">${esc(p.title)}</a>${p.has_tests ? '' : ' <span class="faint small">(not judgeable yet)</span>'}</td>
          <td class="small muted nowrap">${p.time_limit_ms / 1000} s · ${p.memory_limit_mb} MB</td>
          ${adaptive ? `<td class="num">${fmtPoints(p.current_points)}<span class="faint"> / ${fmtPoints(p.points)}</span></td>` : ''}
          <td class="num">${p.solver_count}</td>
          ${site.user ? `<td>${p.solved ? '<span class="v v-AC">Solved</span>' : p.attempted ? '<span class="v v-WA">Attempted</span>' : ''}</td>` : ''}</tr>`).join('')}
        ${c.problems.length ? '' : '<tr><td colspan="6" class="empty">No problems have been added yet.</td></tr>'}
      </tbody></table></div>
      <p class="small muted">${esc(lbHelp(c))}</p>`;
    }
    app.innerHTML = contestHeader(c, 'home') + body;
    if (c.description) renderMarkdown(qs('#desc'), c.description);
    startClocks([c]);
  }

  // The code editor + language picker + submit button. Used on the problem page and the submit page.
  function submitBox(contest, problemId, problems, container) {
    const lastLang = STORAGE.get('lang', 'cpp');
    container.innerHTML = `
      <form id="submit-form">
        <div class="editor-bar">
          ${problems ? `<select name="problem_id" id="problem-select">${problems.map((p) => `<option value="${p.id}" ${p.id === problemId ? 'selected' : ''}>${esc(p.label)}. ${esc(p.title)}</option>`).join('')}</select>` : ''}
          <select name="language" id="lang-select">${Object.entries(langNames()).map(([k, v]) => `<option value="${k}" ${k === lastLang ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <label class="small muted" style="margin:0">or load a file: <input type="file" id="file-input" accept=".cpp,.cc,.cxx,.py,.java,.txt"></label>
        </div>
        <div class="editor-box"><textarea id="code" name="source" spellcheck="false"></textarea></div>
        <div class="row"><button class="primary" id="submit-btn">Submit</button><span class="small muted">Your code is judged on all tests; output whitespace doesn't matter. The draft is kept in this browser.</span></div>
        <div id="submit-err"></div>
      </form>`;
    const sel = qs('#lang-select', container);
    const probSel = qs('#problem-select', container);
    const currentProblem = () => Number(probSel ? probSel.value : problemId);
    const draftKey = () => `draft:${contest.id}:${currentProblem()}:${sel.value}`;
    const ed = makeEditor(qs('#code', container), sel.value);
    ed.setValue(STORAGE.get(draftKey(), ''));
    let saveT = null;
    ed.onChange(() => { clearTimeout(saveT); saveT = setTimeout(() => STORAGE.set(draftKey(), ed.getValue()), 400); });
    const reload = () => { ed.setLang(sel.value); ed.setValue(STORAGE.get(draftKey(), '')); };
    sel.onchange = () => { STORAGE.set('lang', sel.value); reload(); };
    if (probSel) probSel.onchange = reload;
    qs('#file-input', container).onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const ext = f.name.split('.').pop().toLowerCase();
      const byExt = { cpp: 'cpp', cc: 'cpp', cxx: 'cpp', py: 'python', java: 'java' }[ext];
      if (byExt) { sel.value = byExt; STORAGE.set('lang', byExt); ed.setLang(byExt); }
      f.text().then((t) => ed.setValue(t));
    };
    qs('#submit-form', container).onsubmit = async (e) => {
      e.preventDefault();
      const btn = qs('#submit-btn', container); btn.disabled = true;
      try {
        const r = await api.post(`/api/contests/${contest.id}/submit`, { problem_id: currentProblem(), language: sel.value, source: ed.getValue() });
        toast('Submitted');
        navigate(`/submission/${r.id}`);
      } catch (err) {
        qs('#submit-err', container).innerHTML = `<p class="msg error">${esc(err.message)}</p>`;
        btn.disabled = false;
      }
    };
    return ed;
  }

  function examplesHtml(examples) {
    if (!examples.length) return '';
    return `<h2>Examples</h2>${examples.map((ex, i) => `
      <div class="examples">
        <div><div class="ex-title"><span>Input ${examples.length > 1 ? i + 1 : ''}</span><button type="button" class="copy" data-copy="${esc(ex.input)}">copy</button></div><pre>${esc(ex.input)}</pre></div>
        <div><div class="ex-title"><span>Output ${examples.length > 1 ? i + 1 : ''}</span><button type="button" class="copy" data-copy="${esc(ex.expected_output)}">copy</button></div><pre>${esc(ex.expected_output)}</pre></div>
      </div>`).join('')}`;
  }

  function miniSubsTable(subs) {
    if (!subs.length) return '<p class="muted small">No submissions to this problem yet.</p>';
    return `<div class="table-wrap"><table><thead><tr><th>#</th><th>When</th><th>Language</th><th>Verdict</th><th class="num">Time</th><th class="num">Memory</th></tr></thead><tbody>
      ${subs.map((s) => `<tr><td><a href="/submission/${s.id}">${s.id}</a></td><td class="nowrap">${fmtAgo(s.submitted_at)}</td><td>${esc(s.language_name || s.language)}</td><td>${verdictHtml(s)}</td><td class="num">${s.time_ms != null ? s.time_ms + ' ms' : ''}</td><td class="num">${fmtMem(s.memory_kb)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  async function problemPage(cid, pid) {
    setNav('home');
    const p = await api.get(`/api/contests/${cid}/problems/${pid}`);
    const c = p.contest;
    const st = contestState(c);
    app.innerHTML = contestHeader(c, 'home') + `
      <div class="problem-nav">${p.all_problems.map((x) => `<a href="/contest/${c.id}/problem/${x.id}" class="${x.id === p.id ? 'active' : ''}" title="${esc(x.title)}">${esc(x.label)}</a>`).join('')}</div>
      <h1>${esc(p.label)}. ${esc(p.title)}</h1>
      <div class="limits">Time limit ${p.time_limit_ms / 1000} s · Memory limit ${p.memory_limit_mb} MB${p.current_points != null ? ` · Worth <b>${fmtPoints(p.current_points)}</b> of ${fmtPoints(p.points)} points right now` : ''}${p.test_count ? ` · ${p.test_count} test${p.test_count === 1 ? '' : 's'}` : ''}</div>
      <div class="statement" id="statement"></div>
      ${examplesHtml(p.examples)}
      ${p.editorial || p.solution_code ? `<h2>Editorial</h2><div class="statement" id="editorial"></div>${p.solution_code ? `<details><summary>Reference solution (${esc(langNames()[p.solution_language] || p.solution_language)})</summary><pre>${esc(p.solution_code)}</pre></details>` : ''}` : ''}
      ${st === 'running' ? (site.user ? `<h2>Submit</h2><div id="submit-box"></div>` : `<p class="msg"><a class="btn primary" href="/login?next=${encodeURIComponent(location.pathname)}">Log in to submit</a></p>`) : st === 'ended' ? '<p class="msg">This contest has finished, so submissions are closed.</p>' : ''}
      ${site.user ? `<h2>Your submissions to this problem</h2><div id="my-subs">${miniSubsTable(p.my_submissions || [])}</div>` : ''}`;
    renderMarkdown(qs('#statement'), p.statement || '*No statement yet.*');
    if (p.editorial) renderMarkdown(qs('#editorial'), p.editorial);
    qsa('.copy').forEach((b) => { b.onclick = () => copyText(b.dataset.copy); });
    if (st === 'running' && site.user) submitBox(c, p.id, null, qs('#submit-box'));
    if ((p.my_submissions || []).some((s) => s.status !== 'done')) {
      later(2000, async () => { const fresh = await api.get(`/api/contests/${cid}/problems/${pid}`); const box = qs('#my-subs'); if (box) box.innerHTML = miniSubsTable(fresh.my_submissions || []); });
    }
    startClocks([c]);
  }

  async function submitPage(cid) {
    setNav('home');
    const c = await api.get(`/api/contests/${cid}`);
    setServerNow(c.now);
    const st = contestState(c);
    app.innerHTML = contestHeader(c, 'submit') + (st !== 'running' ? `<p class="msg">Submissions are only accepted while the contest is running.</p>`
      : !site.user ? `<p class="msg"><a class="btn primary" href="/login?next=${encodeURIComponent(location.pathname)}">Log in to submit</a></p>`
        : !c.problems || !c.problems.length ? '<p class="empty">No problems yet.</p>' : '<h1>Submit a solution</h1><div id="submit-box"></div>');
    if (st === 'running' && site.user && c.problems && c.problems.length) {
      const first = Number(new URLSearchParams(location.search).get('problem')) || c.problems[0].id;
      submitBox(c, first, c.problems, qs('#submit-box'));
    }
    startClocks([c]);
  }

  function subsTable(list, opts = {}) {
    if (!list.length) return `<p class="empty">${opts.empty || 'No submissions yet.'}</p>`;
    return `<div class="table-wrap"><table><thead><tr><th>#</th><th>When</th>${opts.showUser ? '<th>Who</th>' : ''}${opts.showContest ? '<th>Contest</th>' : ''}<th>Problem</th><th>Language</th><th>Verdict</th><th class="num">Time</th><th class="num">Memory</th></tr></thead><tbody>
      ${list.map((s) => `<tr class="${site.user && s.user && s.user.id === site.user.id ? 'me' : ''}">
        <td>${s.can_view_code ? `<a href="/submission/${s.id}">${s.id}</a>` : s.id}</td>
        <td class="nowrap small">${new Date(s.submitted_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
        ${opts.showUser ? `<td>${s.user ? `<b>${esc(s.user.username)}</b>` : '<span class="faint">organizer</span>'}</td>` : ''}
        ${opts.showContest ? `<td><a href="/contest/${s.contest_id}">${esc(s.contest_name)}</a></td>` : ''}
        <td><a href="/contest/${s.contest_id}/problem/${s.problem.id}">${esc(s.problem.label)}. ${esc(s.problem.title)}</a></td>
        <td class="nowrap">${esc(s.language_name)}</td><td>${verdictHtml(s)}</td>
        <td class="num nowrap">${s.time_ms != null ? s.time_ms + ' ms' : ''}</td><td class="num nowrap">${fmtMem(s.memory_kb)}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  async function submissionsList(cid, who) {
    setNav('home');
    const c = await api.get(`/api/contests/${cid}`);
    setServerNow(c.now);
    const mine = who === 'me';
    const page = Number(new URLSearchParams(location.search).get('page') || 0);
    const load = () => api.get(`/api/contests/${cid}/submissions?user=${mine ? 'me' : 'all'}&page=${page}`);
    let data;
    try { data = await load(); } catch (e) { app.innerHTML = contestHeader(c, mine ? 'mine' : 'status'); renderError(e); return; }
    const render = (d) => `
      ${mine ? '<h2 style="margin-top:0">Your submissions</h2>' : `<h2 style="margin-top:0">All submissions</h2><p class="small muted">Everyone's verdicts are public. Source code is only visible to its author${c.show_code_after ? ' until the contest ends' : ''}.</p>`}
      ${subsTable(d.submissions, { showUser: !mine, empty: mine ? 'You have not submitted anything to this contest yet.' : 'Nobody has submitted anything yet.' })}
      ${d.total > d.limit ? `<p class="small">${page > 0 ? `<a href="?page=${page - 1}">← newer</a> ` : ''}${(page + 1) * d.limit < d.total ? `<a href="?page=${page + 1}">older →</a>` : ''}</p>` : ''}`;
    app.innerHTML = contestHeader(c, mine ? 'mine' : 'status') + `<div id="list">${render(data)}</div>`;
    const refresh = async () => { const d = await load(); const el = qs('#list'); if (el) el.innerHTML = render(d); };
    if (contestState(c) === 'running' || data.submissions.some((s) => s.status !== 'done')) timers.push(setInterval(refresh, mine ? 3000 : 10000));
    startClocks([c]);
  }

  async function submissionPage(id) {
    setNav('home');
    let s = await api.get(`/api/submissions/${id}`);
    const render = () => {
      const c = s.contest;
      const testsHtml = s.tests && s.tests.length ? `<h2>Tests</h2><div class="table-wrap"><table><thead><tr><th>Test</th><th>Verdict</th>${s.can_view_code ? '<th class="num">Time</th><th class="num">Memory</th>' : ''}</tr></thead><tbody>
        ${s.tests.map((t) => `<tr><td>${t.test}</td><td class="v v-${esc(t.verdict)}">${esc(site.verdicts?.[t.verdict] || t.verdict)}</td>${s.can_view_code ? `<td class="num">${t.time_ms} ms</td><td class="num">${fmtMem(t.memory_kb)}</td>` : ''}</tr>`).join('')}
        ${s.status === 'done' && s.tests_total > s.tests.length ? `<tr><td colspan="4" class="faint small">Judging stopped at the first failing test (${s.tests_total} tests in total).</td></tr>` : ''}
      </tbody></table></div>` : '';
      return contestHeader(c, s.user && site.user && s.user.id === site.user.id ? 'mine' : 'status') + `
        <h1>Submission ${s.id}</h1>
        <dl class="kv">
          <dt>Problem</dt><dd><a href="/contest/${c.id}/problem/${s.problem.id}">${esc(s.problem.label)}. ${esc(s.problem.title)}</a></dd>
          <dt>By</dt><dd>${s.user ? `<b>${esc(s.user.username)}</b> (${esc(s.user.full_name)})` : 'organizer'}</dd>
          <dt>Submitted</dt><dd>${new Date(s.submitted_at).toLocaleString()}</dd>
          <dt>Language</dt><dd>${esc(s.language_name)}</dd>
          <dt>Verdict</dt><dd>${verdictHtml(s)}${s.status === 'done' && s.tests_total ? ` <span class="faint small">— ${s.tests_passed} of ${s.tests_total} tests passed</span>` : ''}</dd>
          ${s.time_ms != null ? `<dt>Time</dt><dd>${s.time_ms} ms</dd>` : ''}
          ${s.memory_kb != null ? `<dt>Memory</dt><dd>${fmtMem(s.memory_kb)}</dd>` : ''}
        </dl>
        ${s.verdict === 'CE' && s.compile_output != null ? `<h2>Compiler output</h2><pre>${esc(s.compile_output || '(no output)')}</pre>` : ''}
        ${testsHtml}
        ${s.source != null ? `<h2>Source code <button type="button" class="copy" id="copy-src">copy</button></h2><pre>${esc(s.source)}</pre>` : '<p class="muted small">The source code of this submission is private.</p>'}`;
    };
    app.innerHTML = render();
    const wire = () => { const b = qs('#copy-src'); if (b) b.onclick = () => copyText(s.source); };
    wire();
    const poll = async () => {
      if (s.status === 'done') return;
      s = await api.get(`/api/submissions/${id}`);
      app.innerHTML = render(); wire();
      if (s.status !== 'done') later(1500, poll);
    };
    if (s.status !== 'done') later(1500, poll);
    startClocks([s.contest]);
  }

  async function standings(cid) {
    setNav('home');
    const c = await api.get(`/api/contests/${cid}`);
    setServerNow(c.now);
    if (contestState(c) === 'upcoming') { app.innerHTML = contestHeader(c, 'standings') + '<p class="msg">Standings appear once the contest starts.</p>'; startClocks([c]); return; }
    const render = (st) => {
      const type = st.type;
      const scoreHead = type === 'long' ? '<th class="num">Solved</th><th class="num">Penalty</th>' : type === 'adaptive' ? '<th class="num">Points</th>' : '<th class="num">Solved</th>';
      const cellHtml = (cell) => {
        if (!cell) return '';
        if (cell.solved) {
          const sub = type === 'adaptive' ? `${fmtPoints(cell.points)}` : `+${cell.attempts || ''}`;
          return `<span class="cell-ac">${sub}</span><span class="cell-sub">${fmtClock(cell.time_s)}${type === 'adaptive' && cell.attempts ? ` (-${cell.attempts})` : ''}</span>`;
        }
        if (cell.pending) return `<span class="faint">?</span><span class="cell-sub">judging</span>`;
        return cell.attempts ? `<span class="cell-wa">-${cell.attempts}</span>` : '';
      };
      return `
        <div class="row" style="justify-content:space-between"><p class="small muted" style="margin:0">${esc(lbHelp(c))}</p><a class="btn small" href="/api/contests/${c.id}/standings?format=csv" download>Download CSV</a></div>
        <div class="table-wrap"><table style="margin-top:.8rem"><thead><tr><th class="num">#</th><th>Participant</th>${scoreHead}${st.problems.map((p) => `<th class="c" title="${esc(p.title)}"><a href="/contest/${c.id}/problem/${p.id}">${esc(p.label)}</a>${type === 'adaptive' ? `<div class="faint" style="font-weight:400">${fmtPoints(p.points)}</div>` : ''}</th>`).join('')}</tr></thead><tbody>
          ${st.rows.map((r) => `<tr class="${r.user_id === st.me ? 'me' : ''}"><td class="num">${r.rank}</td><td><b>${esc(r.username)}</b> <span class="faint small">${esc(r.full_name)}</span></td>
            ${type === 'long' ? `<td class="num">${r.solves}</td><td class="num">${r.penalty}</td>` : type === 'adaptive' ? `<td class="num"><b>${fmtPoints(r.points)}</b></td>` : `<td class="num"><b>${r.solves}</b>${r.last_ac != null ? `<span class="cell-sub">${fmtClock(r.last_ac)}</span>` : ''}</td>`}
            ${st.problems.map((p) => `<td class="c">${cellHtml(r.cells[p.id])}</td>`).join('')}</tr>`).join('')}
          ${st.rows.length ? '' : `<tr><td colspan="${3 + st.problems.length}" class="empty">Nobody has entered this contest yet.</td></tr>`}
        </tbody></table></div>
        <p class="small faint">Updated ${new Date().toLocaleTimeString()}. ${contestState(c) === 'running' ? 'Refreshes automatically.' : ''}</p>`;
    };
    const st = await api.get(`/api/contests/${cid}/standings`);
    app.innerHTML = contestHeader(c, 'standings') + `<div id="st">${render(st)}</div>`;
    if (contestState(c) === 'running') timers.push(setInterval(async () => { const fresh = await api.get(`/api/contests/${cid}/standings`); const el = qs('#st'); if (el) el.innerHTML = render(fresh); }, 20000));
    startClocks([c]);
  }

  async function mySubmissions() {
    setNav('mine');
    if (!site.user) return navigate('/login?next=/my/submissions');
    const d = await api.get('/api/me/submissions');
    app.innerHTML = `<h1>Your submissions</h1><p class="muted">Everything you have ever submitted, newest first.</p>${subsTable(d.submissions, { showContest: true, empty: 'You have not submitted anything yet.' })}`;
    if (d.submissions.some((s) => s.status !== 'done')) later(3000, mySubmissions);
  }

  // ---------------------------------------------------------------------------
  loadSite().then(route).catch((e) => { app.innerHTML = `<p class="msg error">Could not reach the contest server: ${esc(e.message)}</p>`; });
})();
