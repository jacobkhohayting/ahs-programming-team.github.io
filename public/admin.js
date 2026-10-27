// Admin panel: contests, problems, tests, users, submissions, judge status.
/* global MF, TZ */
(function () {
  'use strict';
  const { api, esc, fmtDuration, fmtMem, fmtPoints, verdictHtml, statusPill, renderMarkdown, makeEditor, toast, qs, qsa, formData, LANG_NAMES, STORAGE } = MF;
  const app = document.getElementById('app');
  let status = null; // /api/admin/status
  const langNames = () => status && status.languages ? Object.fromEntries(Object.entries(status.languages).map(([k, v]) => [k, v.name])) : LANG_NAMES;
  let timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); timers = []; };

  const routes = [
    [/^\/admin\/?$/, () => navigate('/admin/contests')],
    [/^\/admin\/contests$/, contests], [/^\/admin\/contests\/new$/, () => contestForm(null)], [/^\/admin\/contests\/(\d+)$/, (id) => contestForm(id)],
    [/^\/admin\/problems\/(\d+)$/, problemEditor],
    [/^\/admin\/users$/, users], [/^\/admin\/submissions$/, submissions], [/^\/admin\/submissions\/(\d+)$/, submissionDetail],
    [/^\/admin\/judge$/, judgePage],
  ];
  function navigate(path) { history.pushState(null, '', path); route(); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || a.origin !== location.origin) return;
    if (!a.pathname.startsWith('/admin')) return;
    e.preventDefault(); navigate(a.pathname + a.search);
  });
  window.addEventListener('popstate', route);

  async function route() {
    clearTimers();
    if (!status) {
      const site = await api.get('/api/site').catch(() => ({}));
      if (!site.isAdmin) return loginForm(null);
      try { status = await api.get('/api/admin/status'); }
      catch (e) { return loginForm(e); }
    }
    document.title = `Admin – ${status.config.siteName}`;
    qs('#brand').textContent = `${status.config.siteName} admin`;
    qs('#userbox').innerHTML = `<a href="/">Student site</a> <a href="#" id="logout">Log out</a>`;
    qs('#logout').onclick = async (e) => { e.preventDefault(); await api.post('/api/admin/logout'); status = null; route(); };
    const path = location.pathname;
    for (const [re, fn] of routes) {
      const m = path.match(re);
      if (m) {
        qsa('#nav a').forEach((a) => a.classList.toggle('active', path.startsWith(a.getAttribute('href'))));
        try { await fn(...m.slice(1)); } catch (e) { app.innerHTML = `<p class="msg error">${esc(e.message)}</p>`; }
        return;
      }
    }
    app.innerHTML = '<h1>Not found</h1>';
  }

  function loginForm(err) {
    qs('#userbox').innerHTML = '<a href="/">Student site</a>';
    app.innerHTML = `<div class="form-narrow"><h1>Admin area</h1>
      ${err && err.status !== 403 ? `<p class="msg error">${esc(err.message)}</p>` : ''}
      <form id="f"><div id="err"></div><label for="pw">Admin password</label><input id="pw" name="password" type="password" required autofocus autocomplete="current-password">
      <p style="margin-top:1rem"><button class="primary">Enter</button></p></form>
      <p class="help">The password is set with ADMIN_PASSWORD in the server's .env file.</p></div>`;
    qs('#f').onsubmit = async (e) => {
      e.preventDefault();
      try { await api.post('/api/admin/login', formData(e.target)); status = null; route(); }
      catch (er) { qs('#err').innerHTML = `<p class="msg error">${esc(er.message)}</p>`; }
    };
  }

  const confirmDo = async (msg, fn) => { if (confirm(msg)) { try { await fn(); } catch (e) { alert(e.message); } } };
  const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  // ---------------------------------------------------------------------------
  // contests
  // ---------------------------------------------------------------------------
  async function contests() {
    const d = await api.get('/api/admin/contests');
    app.innerHTML = `<div class="row" style="justify-content:space-between"><h1>Contests</h1><a class="btn primary" href="/admin/contests/new">New contest</a></div>
      ${d.contests.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Start (contest zone)</th><th class="num">Length</th><th>Type</th><th class="num">Problems</th><th class="num">Entrants</th><th class="num">Subs</th><th></th></tr></thead><tbody>
        ${d.contests.map((c) => `<tr><td><a href="/admin/contests/${c.id}"><b>${esc(c.name)}</b></a></td><td>${statusPill(c.status)} ${c.visible ? '' : statusPill('', false)}</td>
          <td class="small">${esc(TZ.format(Date.parse(c.start_at), c.timezone))}</td><td class="num">${fmtDuration((Date.parse(c.end_at) - Date.parse(c.start_at)) / 60000)}</td><td>${esc(c.leaderboard_type)}</td>
          <td class="num">${c.problem_count}</td><td class="num">${c.participant_count}</td><td class="num">${c.submission_count}</td>
          <td class="nowrap"><button class="small" data-vis="${c.id}" data-to="${c.visible ? 0 : 1}">${c.visible ? 'Hide' : 'Publish'}</button> <button class="small" data-dup="${c.id}">Duplicate</button> <a class="btn small" href="/contest/${c.id}" target="_blank">View</a></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No contests yet. Create one, add problems and tests, then publish it.</p>'}`;
    qsa('[data-vis]').forEach((b) => { b.onclick = async () => { await api.post(`/api/admin/contests/${b.dataset.vis}/visibility`, { visible: b.dataset.to === '1' }); toast(b.dataset.to === '1' ? 'Published' : 'Hidden'); contests(); }; });
    qsa('[data-dup]').forEach((b) => { b.onclick = async () => { const c = await api.post(`/api/admin/contests/${b.dataset.dup}/duplicate`); toast('Duplicated (hidden)'); navigate(`/admin/contests/${c.id}`); }; });
  }

  const LB_DESC = {
    short: 'Most solves wins; ties go to whoever got their last accepted solution earliest.',
    long: 'ICPC style: most solves, then lowest penalty (minutes to each accepted solution + a fixed penalty per rejected attempt on solved problems).',
    adaptive: 'Each problem has a maximum score that drops by a fixed amount every minute of the contest (never below zero). Highest total wins.',
  };

  async function contestForm(id) {
    const c = id ? await api.get(`/api/admin/contests/${id}`) : null;
    const tz = c ? c.timezone : (STORAGE.get('admin:tz', null) || TZ.localZone());
    const v = (k, d) => (c ? c[k] : d);
    app.innerHTML = `
      <h1>${c ? esc(c.name) : 'New contest'} ${c ? statusPill(c.status) + ' ' + (c.visible ? '' : statusPill('', false)) : ''}</h1>
      ${c ? `<p class="row"><a class="btn small" href="/contest/${c.id}" target="_blank">Open student view</a><a class="btn small" href="/admin/submissions?contest=${c.id}">Submissions (${c.submission_count})</a><a class="btn small" href="/contest/${c.id}/standings" target="_blank">Standings</a>
        <button class="small" id="dup">Duplicate</button><button class="small" id="rejudge-all">Rejudge everything</button><button class="small danger" id="del">Delete contest</button></p>` : ''}
      <form id="f"><div id="err"></div>
        <div class="admin-grid"><div>
          <h2>Settings</h2>
          <label>Name</label><input name="name" type="text" required value="${esc(v('name', ''))}">
          <label>Description <span class="faint">(Markdown, shown on the contest page)</span></label><textarea name="description" rows="4">${esc(v('description', ''))}</textarea>
          <label>Time zone <span class="faint">(times below are entered in this zone)</span></label><input name="timezone" type="text" list="tzlist" required value="${esc(tz)}"><datalist id="tzlist">${status.timezones.map((z) => `<option value="${esc(z)}">`).join('')}</datalist>
          <div class="field-inline">
            <div><label>Start</label><input name="start_local" type="datetime-local" required value="${esc(c ? c.start_local : '')}"></div>
            <div><label>End</label><input name="end_local" type="datetime-local" required value="${esc(c ? c.end_local : '')}"></div>
          </div>
          <p class="help" id="dur"></p>
          <label class="check"><input type="checkbox" name="visible" ${v('visible', 0) ? 'checked' : ''}> Visible to students (published)</label>
          <p class="help">Hidden contests are invisible to everyone but you. You can prepare everything while hidden and publish when ready.</p>
        </div><div>
          <h2>Leaderboard</h2>
          <label>Type</label><select name="leaderboard_type" id="lb">${['short', 'long', 'adaptive'].map((t) => `<option value="${t}" ${v('leaderboard_type', 'short') === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <p class="help" id="lb-desc"></p>
          <div data-lb="long"><label>Penalty per rejected attempt (minutes)</label><input name="penalty_per_wrong" type="number" min="0" step="1" value="${esc(v('penalty_per_wrong', 10))}"></div>
          <div data-lb="adaptive"><label>Points lost per minute (every problem)</label><input name="decay_per_minute" type="number" min="0" step="any" value="${esc(v('decay_per_minute', 1))}">
            <label>Points lost per rejected attempt <span class="faint">(0 = none)</span></label><input name="wrong_penalty_pts" type="number" min="0" step="any" value="${esc(v('wrong_penalty_pts', 0))}">
            <p class="help">Each problem's maximum points are set on the problem itself.</p></div>
          <h2>After the contest</h2>
          <label class="check"><input type="checkbox" name="show_code_after" ${v('show_code_after', 0) ? 'checked' : ''}> Everyone can read everyone's source code</label>
          <label class="check"><input type="checkbox" name="show_editorial" ${v('show_editorial', 1) ? 'checked' : ''}> Show editorials and reference solutions</label>
          <p class="help">During the contest nobody can see anyone else's code, only verdicts and standings.</p>
        </div></div>
        <p style="margin-top:1rem"><button class="primary">${c ? 'Save changes' : 'Create contest'}</button> ${c ? '' : '<span class="help" style="display:inline">You add problems on the next screen.</span>'}</p>
      </form>
      ${c ? `<h2>Problems</h2><div id="problems"></div>
        <form id="add-problem" class="row"><input name="title" type="text" placeholder="New problem title" required style="max-width:360px"><button class="primary">Add problem</button></form>` : ''}`;
    const f = qs('#f');
    const lb = qs('#lb');
    const updateLb = () => { qs('#lb-desc').textContent = LB_DESC[lb.value]; qsa('[data-lb]').forEach((el) => { el.hidden = el.dataset.lb !== lb.value; }); };
    lb.onchange = updateLb; updateLb();
    const updateDur = () => {
      const d = formData(f);
      const s = TZ.zonedToUtc(d.start_local, d.timezone), e = TZ.zonedToUtc(d.end_local, d.timezone);
      qs('#dur').textContent = Number.isNaN(s) || Number.isNaN(e) ? (TZ.isValidZone(d.timezone) ? '' : 'Unknown time zone - use a name like America/New_York.')
        : e <= s ? 'End must be after start.' : `Length: ${fmtDuration((e - s) / 60000)}. Students in other time zones see these times converted automatically.`;
    };
    ['input', 'change'].forEach((ev) => f.addEventListener(ev, updateDur)); updateDur();
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = formData(f);
      try {
        STORAGE.set('admin:tz', body.timezone);
        if (c) { await api.put(`/api/admin/contests/${c.id}`, body); toast('Saved'); contestForm(c.id); }
        else { const created = await api.post('/api/admin/contests', body); toast('Contest created'); navigate(`/admin/contests/${created.id}`); }
      } catch (err) { qs('#err').innerHTML = `<p class="msg error">${esc(err.message)}</p>`; window.scrollTo(0, 0); }
    };
    if (!c) return;
    qs('#dup').onclick = async () => { const d = await api.post(`/api/admin/contests/${c.id}/duplicate`); toast('Duplicated (hidden)'); navigate(`/admin/contests/${d.id}`); };
    qs('#rejudge-all').onclick = () => confirmDo(`Rejudge all ${c.submission_count} submissions in this contest?`, async () => { const r = await api.post(`/api/admin/contests/${c.id}/rejudge`); toast(`${r.count} submissions queued`); });
    qs('#del').onclick = () => confirmDo(`Delete "${c.name}" with all its problems, tests and ${c.submission_count} submissions? This cannot be undone.`, async () => { await api.del(`/api/admin/contests/${c.id}`); toast('Deleted'); navigate('/admin/contests'); });
    const renderProblems = () => {
      const ps = c.problems;
      qs('#problems').innerHTML = ps.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>Title</th><th>Limits</th>${c.leaderboard_type === 'adaptive' ? '<th class="num">Max points</th>' : ''}<th class="num">Tests</th><th class="num">Examples</th><th class="num">Subs</th><th class="num">Solvers</th><th></th></tr></thead><tbody>
        ${ps.map((p, i) => `<tr><td class="mono"><b>${esc(p.label)}</b></td><td><a href="/admin/problems/${p.id}">${esc(p.title)}</a>${p.test_count ? '' : ' <span class="v v-WA small">no tests</span>'}</td><td class="small muted nowrap">${p.time_limit_ms} ms · ${p.memory_limit_mb} MB</td>
          ${c.leaderboard_type === 'adaptive' ? `<td class="num">${fmtPoints(p.points)}</td>` : ''}<td class="num">${p.test_count}</td><td class="num">${p.example_count}</td><td class="num">${p.submission_count}</td><td class="num">${p.solver_count}</td>
          <td class="nowrap"><button class="small" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="small" data-move="${i}" data-dir="1" ${i === ps.length - 1 ? 'disabled' : ''}>↓</button> <button class="small danger" data-delp="${p.id}">Remove</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No problems yet. Add one below, then write its statement and tests.</p>';
      qsa('[data-move]').forEach((b) => { b.onclick = async () => {
        const i = Number(b.dataset.move), j = i + Number(b.dataset.dir);
        const order = ps.map((p) => p.id); [order[i], order[j]] = [order[j], order[i]];
        await api.post(`/api/admin/contests/${c.id}/problems/reorder`, { order }); contestForm(c.id);
      }; });
      qsa('[data-delp]').forEach((b) => { b.onclick = () => { const p = ps.find((x) => x.id === Number(b.dataset.delp)); confirmDo(`Remove problem "${p.title}" and its ${p.submission_count} submissions?`, async () => { await api.del(`/api/admin/problems/${p.id}`); contestForm(c.id); }); }; });
    };
    renderProblems();
    qs('#add-problem').onsubmit = async (e) => {
      e.preventDefault();
      try { const p = await api.post(`/api/admin/contests/${c.id}/problems`, { title: formData(e.target).title }); navigate(`/admin/problems/${p.id}`); }
      catch (err) { alert(err.message); }
    };
  }

  // ---------------------------------------------------------------------------
  // problem editor
  // ---------------------------------------------------------------------------
  // Pairs uploaded files into tests: a.in + a.out, 1.in + 1.ans, input3.txt + output3.txt, test_02.in + test_02.out ...
  function pairFiles(files) {
    const inputs = new Map(), outputs = new Map();
    for (const f of files) {
      const name = f.name.toLowerCase();
      const base = name.replace(/\.[^.]+$/, '');
      const ext = name.slice(base.length);
      let key = null, kind = null;
      if (['.in', '.inp', '.input'].includes(ext)) { key = base; kind = 'in'; }
      else if (['.out', '.ans', '.a', '.output', '.sol', '.expected'].includes(ext)) { key = base; kind = 'out'; }
      else if (/input/.test(base)) { key = base.replace(/input/g, '#'); kind = 'in'; }
      else if (/output|answer/.test(base)) { key = base.replace(/output|answer/g, '#'); kind = 'out'; }
      if (!key) continue;
      (kind === 'in' ? inputs : outputs).set(key, f);
    }
    const keys = [...inputs.keys()].filter((k) => outputs.has(k)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return keys.map((k) => ({ input: inputs.get(k), output: outputs.get(k) }));
  }

  async function problemEditor(pid) {
    const p = await api.get(`/api/admin/problems/${pid}`);
    app.innerHTML = `
      <p class="small"><a href="/admin/contests/${p.contest.id}">← ${esc(p.contest.name)}</a></p>
      <h1>${esc(p.label)}. ${esc(p.title)}</h1>
      <p class="row"><a class="btn small" href="/contest/${p.contest.id}/problem/${p.id}" target="_blank">Student view</a><a class="btn small" href="/admin/submissions?problem=${p.id}">Submissions</a><button class="small" id="rejudge">Rejudge all submissions to this problem</button></p>
      <form id="f"><div id="err"></div>
        <div class="field-inline">
          <div><label>Title</label><input name="title" type="text" required value="${esc(p.title)}"></div>
          <div><label>Time limit (ms)</label><input name="time_limit_ms" type="number" min="100" max="60000" step="100" value="${p.time_limit_ms}"></div>
          <div><label>Memory limit (MB)</label><input name="memory_limit_mb" type="number" min="16" max="4096" value="${p.memory_limit_mb}"></div>
          <div><label>Max points <span class="faint">(adaptive contests)</span></label><input name="points" type="number" min="0" step="any" value="${esc(p.points)}"></div>
        </div>
        <div class="split">
          <div><label>Statement <span class="faint">(Markdown; $...$ for math)</span></label><textarea name="statement" rows="18" id="statement">${esc(p.statement)}</textarea></div>
          <div><label>Preview</label><div class="preview" id="preview"></div></div>
        </div>
        <details><summary>Editorial and reference solution (shown in the archive after the contest, if enabled)</summary>
          <label>Editorial <span class="faint">(Markdown)</span></label><textarea name="editorial" rows="8">${esc(p.editorial)}</textarea>
          <label>Reference solution</label><select name="solution_language">${Object.entries(langNames()).map(([k, v]) => `<option value="${k}" ${p.solution_language === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <textarea name="solution_code" class="code" rows="12" style="min-height:12rem">${esc(p.solution_code)}</textarea>
        </details>
        <p><button class="primary">Save problem</button></p>
      </form>

      <h2>Tests <span class="faint small" style="font-weight:400">(${p.tests.length}; examples are shown to students, the rest stay hidden; all are used for judging)</span></h2>
      <div id="tests"></div>
      <div class="split">
        <div><h3>Add a test</h3>
          <form id="add-test"><label>Input</label><textarea name="input" class="code" rows="5" style="min-height:6rem"></textarea>
            <label>Expected output</label><textarea name="expected_output" class="code" rows="5" style="min-height:6rem"></textarea>
            <label class="check"><input type="checkbox" name="is_example"> Example (visible to students)</label>
            <p><button class="primary">Add test</button></p></form>
        </div>
        <div><h3>Upload many tests</h3>
          <div class="drop">Pick files in pairs, e.g. <code>1.in</code> + <code>1.out</code>, <code>a.in</code> + <code>a.ans</code>, or <code>input1.txt</code> + <code>output1.txt</code>. Matching pairs become tests, in name order.<br><br>
            <input type="file" id="bulk-files" multiple><br><label class="check"><input type="checkbox" id="bulk-example"> Mark the first uploaded pair as an example</label><button class="small" id="bulk-go">Upload</button> <span id="bulk-msg" class="small"></span></div>
          <h3>Or paste many tests</h3>
          <p class="help">Separate input from output with a line containing only <code>---</code>, and tests from each other with a line containing only <code>===</code>.</p>
          <textarea id="paste-tests" class="code" rows="6" style="min-height:7rem" placeholder="2 3&#10;---&#10;5&#10;===&#10;10 20&#10;---&#10;30"></textarea>
          <p><button class="small" id="paste-go">Add pasted tests</button></p>
        </div>
      </div>

      <h2>Try a solution</h2>
      <p class="help">Judges your code against every test above exactly like a student submission, but it never appears on the status page or standings. Use it to check that your tests and limits are right.</p>
      <div class="editor-bar"><select id="try-lang">${Object.entries(langNames()).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select><button class="small" id="try-ref" ${p.solution_code ? '' : 'disabled'}>Use the reference solution</button></div>
      <div class="editor-box"><textarea id="try-code" spellcheck="false"></textarea></div>
      <p><button class="primary" id="try-go">Run</button></p>
      <div id="try-result"></div>`;

    const f = qs('#f');
    const preview = () => renderMarkdown(qs('#preview'), qs('#statement').value);
    qs('#statement').addEventListener('input', preview); preview();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api.put(`/api/admin/problems/${p.id}`, formData(f)); toast('Saved'); }
      catch (err) { qs('#err').innerHTML = `<p class="msg error">${esc(err.message)}</p>`; window.scrollTo(0, 0); }
    };
    qs('#rejudge').onclick = () => confirmDo('Rejudge every submission to this problem? Do this after changing tests or limits.', async () => { const r = await api.post(`/api/admin/problems/${p.id}/rejudge`); toast(`${r.count} submissions queued`); });

    const renderTests = () => {
      const t = p.tests;
      qs('#tests').innerHTML = t.length ? `<div class="table-wrap"><table class="test-list"><thead><tr><th>#</th><th>Example</th><th style="width:38%">Input</th><th style="width:38%">Expected output</th><th></th></tr></thead><tbody>
        ${t.map((x, i) => `<tr data-tid="${x.id}"><td>${i + 1}</td><td><label class="check" style="margin:0"><input type="checkbox" data-ex="${x.id}" ${x.is_example ? 'checked' : ''}> shown</label></td>
          <td><pre>${esc(x.input)}</pre></td><td><pre>${esc(x.expected_output)}</pre></td>
          <td class="nowrap"><button class="small" data-edit="${x.id}">Edit</button> <button class="small" data-tmove="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button> <button class="small" data-tmove="${i}" data-dir="1" ${i === t.length - 1 ? 'disabled' : ''}>↓</button> <button class="small danger" data-tdel="${x.id}">Delete</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No tests yet. Students cannot submit until this problem has at least one test.</p>';
      qsa('[data-ex]').forEach((cb) => { cb.onchange = async () => { await api.put(`/api/admin/tests/${cb.dataset.ex}`, { is_example: cb.checked }); toast(cb.checked ? 'Now shown as an example' : 'Now hidden'); }; });
      qsa('[data-tdel]').forEach((b) => { b.onclick = () => confirmDo('Delete this test?', async () => { await api.del(`/api/admin/tests/${b.dataset.tdel}`); problemEditor(pid); }); });
      qsa('[data-tmove]').forEach((b) => { b.onclick = async () => { const i = Number(b.dataset.tmove), j = i + Number(b.dataset.dir); const order = t.map((x) => x.id); [order[i], order[j]] = [order[j], order[i]]; await api.post(`/api/admin/problems/${p.id}/tests/reorder`, { order }); problemEditor(pid); }; });
      qsa('[data-edit]').forEach((b) => { b.onclick = () => {
        const x = t.find((y) => y.id === Number(b.dataset.edit));
        const tr = qs(`tr[data-tid="${x.id}"]`);
        tr.innerHTML = `<td colspan="5"><form class="edit-test"><div class="split"><div><label>Input</label><textarea name="input" class="code" style="min-height:8rem">${esc(x.input)}</textarea></div><div><label>Expected output</label><textarea name="expected_output" class="code" style="min-height:8rem">${esc(x.expected_output)}</textarea></div></div>
          <p class="row"><button class="primary small">Save test</button><button type="button" class="small" data-cancel>Cancel</button></p></form></td>`;
        qs('[data-cancel]', tr).onclick = () => renderTests();
        qs('form', tr).onsubmit = async (e) => { e.preventDefault(); const d = formData(e.target); await api.put(`/api/admin/tests/${x.id}`, { input: d.input, expected_output: d.expected_output }); toast('Test saved'); problemEditor(pid); };
      }; });
    };
    renderTests();

    qs('#add-test').onsubmit = async (e) => {
      e.preventDefault();
      try { await api.post(`/api/admin/problems/${p.id}/tests`, formData(e.target)); toast('Test added'); problemEditor(pid); }
      catch (err) { alert(err.message); }
    };
    qs('#bulk-go').onclick = async () => {
      const pairs = pairFiles([...qs('#bulk-files').files]);
      const msg = qs('#bulk-msg');
      if (!pairs.length) { msg.textContent = 'No matching input/output pairs found in the selected files.'; return; }
      const tests = [];
      for (const [i, pr] of pairs.entries()) tests.push({ input: await pr.input.text(), expected_output: await pr.output.text(), is_example: i === 0 && qs('#bulk-example').checked });
      try { await api.post(`/api/admin/problems/${p.id}/tests`, { tests }); toast(`${tests.length} tests added`); problemEditor(pid); }
      catch (err) { msg.textContent = err.message; }
    };
    qs('#paste-go').onclick = async () => {
      const raw = qs('#paste-tests').value;
      const tests = raw.split(/\r?\n===\r?\n|^===\r?\n|\r?\n===$/).map((block) => block.split(/\r?\n---\r?\n|^---\r?\n|\r?\n---$/)).filter((parts) => parts.length >= 2)
        .map(([input, output]) => ({ input: input.replace(/\s+$/, '') + '\n', expected_output: output.replace(/\s+$/, '') + '\n', is_example: false }));
      if (!tests.length) { alert('Could not find any tests. Separate input and output with a --- line and tests with a === line.'); return; }
      try { await api.post(`/api/admin/problems/${p.id}/tests`, { tests }); toast(`${tests.length} tests added`); problemEditor(pid); }
      catch (err) { alert(err.message); }
    };

    // try a solution
    const tryLang = qs('#try-lang');
    tryLang.value = STORAGE.get('lang', 'cpp');
    const ed = makeEditor(qs('#try-code'), tryLang.value);
    ed.setValue(STORAGE.get(`admin-try:${p.id}`, ''));
    ed.onChange(() => STORAGE.set(`admin-try:${p.id}`, ed.getValue()));
    tryLang.onchange = () => { ed.setLang(tryLang.value); STORAGE.set('lang', tryLang.value); };
    qs('#try-ref').onclick = () => { const d = formData(f); tryLang.value = d.solution_language; ed.setLang(tryLang.value); ed.setValue(d.solution_code); };
    qs('#try-go').onclick = async () => {
      const out = qs('#try-result');
      try {
        const r = await api.post(`/api/admin/problems/${p.id}/test-run`, { language: tryLang.value, source: ed.getValue() });
        out.innerHTML = '<p class="v v-judging">Judging…</p>';
        const poll = async () => {
          const s = await api.get(`/api/admin/submissions/${r.id}`);
          out.innerHTML = submissionResultHtml(s);
          if (s.status !== 'done') later(1000, poll);
        };
        poll();
      } catch (err) { out.innerHTML = `<p class="msg error">${esc(err.message)}</p>`; }
    };
  }

  function submissionResultHtml(s) {
    return `<p>Verdict: ${verdictHtml(s)} ${s.status === 'done' ? `<span class="faint small">${s.tests_passed}/${s.tests_total} tests${s.time_ms != null ? `, ${s.time_ms} ms, ${fmtMem(s.memory_kb)}` : ''}</span>` : ''}</p>
      ${s.verdict === 'CE' ? `<pre>${esc(s.compile_output || '')}</pre>` : ''}
      ${s.tests && s.tests.length ? `<div class="table-wrap"><table style="max-width:520px"><thead><tr><th>Test</th><th>Verdict</th><th class="num">Time</th><th class="num">Memory</th></tr></thead><tbody>${s.tests.map((t) => `<tr><td>${t.test}</td><td class="v v-${esc(t.verdict)}">${esc(status.verdicts[t.verdict] || t.verdict)}</td><td class="num">${t.time_ms} ms</td><td class="num">${fmtMem(t.memory_kb)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // users
  // ---------------------------------------------------------------------------
  async function users() {
    const q = new URLSearchParams(location.search).get('q') || '';
    const d = await api.get(`/api/admin/users?q=${encodeURIComponent(q)}`);
    app.innerHTML = `<h1>Users <span class="faint small" style="font-weight:400">(${d.users.length})</span></h1>
      <form class="row" id="search"><input type="text" name="q" placeholder="Search name, username, email, PL number" value="${esc(q)}" style="max-width:360px"><button>Search</button></form>
      ${d.users.length ? `<div class="table-wrap"><table><thead><tr><th>Username</th><th>Full name</th><th>Email</th><th>PL number</th><th>Joined</th><th class="num">Contests</th><th class="num">Subs</th><th></th></tr></thead><tbody>
        ${d.users.map((u) => `<tr><td><b>${esc(u.username)}</b></td><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.pl_number)}</td><td class="small nowrap">${new Date(u.created_at).toLocaleDateString()}</td><td class="num">${u.contest_count}</td><td class="num"><a href="/admin/submissions?user=${u.id}">${u.submission_count}</a></td>
          <td class="nowrap"><button class="small" data-edit="${u.id}">Edit</button> <button class="small" data-pw="${u.id}">Reset password</button> <button class="small danger" data-del="${u.id}">Delete</button></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="empty">No users match.</p>'}`;
    qs('#search').onsubmit = (e) => { e.preventDefault(); navigate(`/admin/users?q=${encodeURIComponent(formData(e.target).q)}`); };
    qsa('[data-del]').forEach((b) => { b.onclick = () => { const u = d.users.find((x) => x.id === Number(b.dataset.del)); confirmDo(`Delete ${u.username} (${u.email}) and all ${u.submission_count} of their submissions? This cannot be undone.`, async () => { await api.del(`/api/admin/users/${u.id}`); users(); }); }; });
    qsa('[data-pw]').forEach((b) => { b.onclick = async () => { const u = d.users.find((x) => x.id === Number(b.dataset.pw)); const pw = prompt(`New password for ${u.username} (at least 6 characters):`); if (!pw) return; try { await api.put(`/api/admin/users/${u.id}`, { new_password: pw }); toast('Password changed'); } catch (e) { alert(e.message); } }; });
    qsa('[data-edit]').forEach((b) => { b.onclick = async () => {
      const u = d.users.find((x) => x.id === Number(b.dataset.edit));
      const full_name = prompt('Full name:', u.full_name); if (full_name == null) return;
      const username = prompt('Username:', u.username); if (username == null) return;
      const email = prompt('Email:', u.email); if (email == null) return;
      const pl_number = prompt('PL number:', u.pl_number); if (pl_number == null) return;
      try { await api.put(`/api/admin/users/${u.id}`, { full_name, username, email, pl_number }); toast('Saved'); users(); } catch (e) { alert(e.message); }
    }; });
  }

  // ---------------------------------------------------------------------------
  // submissions
  // ---------------------------------------------------------------------------
  async function submissions() {
    const params = new URLSearchParams(location.search);
    const [d, cl] = await Promise.all([api.get(`/api/admin/submissions?${params}`), api.get('/api/admin/contests')]);
    const page = Number(params.get('page') || 0);
    app.innerHTML = `<h1>Submissions <span class="faint small" style="font-weight:400">(${d.total})</span></h1>
      <form class="row" id="filter">
        <select name="contest"><option value="">All contests</option>${cl.contests.map((c) => `<option value="${c.id}" ${params.get('contest') === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <select name="verdict"><option value="">Any verdict</option>${Object.entries(status.verdicts).map(([k, v]) => `<option value="${k}" ${params.get('verdict') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
        <input type="text" name="q" placeholder="username or name" value="${esc(params.get('q') || '')}" style="max-width:220px">
        ${params.get('user') ? `<input type="hidden" name="user" value="${esc(params.get('user'))}">` : ''}${params.get('problem') ? `<input type="hidden" name="problem" value="${esc(params.get('problem'))}">` : ''}
        <button>Filter</button> <a href="/admin/submissions" class="small">clear</a>
      </form>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>When</th><th>Who</th><th>Contest</th><th>Problem</th><th>Lang</th><th>Verdict</th><th class="num">Time</th><th class="num">Mem</th><th></th></tr></thead><tbody>
        ${d.submissions.map((s) => `<tr><td><a href="/admin/submissions/${s.id}">${s.id}</a></td><td class="nowrap small">${when(s.submitted_at)}</td><td>${s.user_id ? `<b>${esc(s.username)}</b>` : '<span class="faint">test run</span>'}</td><td class="small">${esc(s.contest_name)}</td><td>${esc(s.label)}. ${esc(s.problem_title)}</td><td class="small nowrap">${esc(s.language_name)}</td><td>${verdictHtml(s)}</td><td class="num">${s.time_ms ?? ''}</td><td class="num">${fmtMem(s.memory_kb)}</td>
          <td class="nowrap"><button class="small" data-rj="${s.id}">Rejudge</button> <button class="small" data-inv="${s.id}" data-to="${s.invalidated ? 0 : 1}">${s.invalidated ? 'Restore' : 'Invalidate'}</button></td></tr>`).join('')}
        ${d.submissions.length ? '' : '<tr><td colspan="10" class="empty">No submissions match.</td></tr>'}
      </tbody></table></div>
      ${d.total > d.limit ? `<p class="small">${page > 0 ? `<a href="?${new URLSearchParams({ ...Object.fromEntries(params), page: page - 1 })}">← newer</a> ` : ''}${(page + 1) * d.limit < d.total ? `<a href="?${new URLSearchParams({ ...Object.fromEntries(params), page: page + 1 })}">older →</a>` : ''}</p>` : ''}`;
    qs('#filter').onsubmit = (e) => { e.preventDefault(); const f = formData(e.target); const p = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => { if (v) p.set(k, v); }); navigate(`/admin/submissions?${p}`); };
    wireSubButtons(() => submissions());
    if (d.submissions.some((s) => s.status !== 'done')) later(3000, submissions);
  }

  function wireSubButtons(refresh) {
    qsa('[data-rj]').forEach((b) => { b.onclick = async () => { await api.post(`/api/admin/submissions/${b.dataset.rj}/rejudge`); toast('Rejudging'); refresh(); }; });
    qsa('[data-inv]').forEach((b) => { b.onclick = async () => { await api.post(`/api/admin/submissions/${b.dataset.inv}/invalidate`, { invalidated: b.dataset.to === '1' }); toast(b.dataset.to === '1' ? 'Removed from standings' : 'Restored'); refresh(); }; });
  }

  async function submissionDetail(id) {
    const s = await api.get(`/api/admin/submissions/${id}`);
    app.innerHTML = `<p class="small"><a href="/admin/submissions">← Submissions</a></p><h1>Submission ${s.id}</h1>
      <dl class="kv">
        <dt>Who</dt><dd>${s.user_id ? `<b>${esc(s.username)}</b> (${esc(s.full_name)})` : 'admin test run'}</dd>
        <dt>Contest</dt><dd>${esc(s.contest_name)}</dd>
        <dt>Problem</dt><dd><a href="/admin/problems/${s.problem_id}">${esc(s.label)}. ${esc(s.problem_title)}</a></dd>
        <dt>Submitted</dt><dd>${new Date(s.submitted_at).toLocaleString()}${s.judged_at ? ` · judged ${new Date(s.judged_at).toLocaleString()}` : ''}</dd>
        <dt>Language</dt><dd>${esc(s.language_name)}</dd>
        <dt>Verdict</dt><dd>${verdictHtml(s)}${s.invalidated ? ' <span class="faint small">(invalidated: not counted in standings)</span>' : ''}</dd>
      </dl>
      <p class="row"><button class="small" data-rj="${s.id}">Rejudge</button><button class="small" data-inv="${s.id}" data-to="${s.invalidated ? 0 : 1}">${s.invalidated ? 'Restore to standings' : 'Invalidate (remove from standings)'}</button><button class="small danger" id="del">Delete submission</button></p>
      ${submissionResultHtml(s)}
      <h2>Source code</h2><pre>${esc(s.source)}</pre>`;
    wireSubButtons(() => submissionDetail(id));
    qs('#del').onclick = () => confirmDo('Delete this submission permanently?', async () => { await api.del(`/api/admin/submissions/${s.id}`); navigate('/admin/submissions'); });
    if (s.status !== 'done') later(1500, () => submissionDetail(id));
  }

  // ---------------------------------------------------------------------------
  // judge
  // ---------------------------------------------------------------------------
  async function judgePage() {
    status = await api.get('/api/admin/status');
    const j = status.judge;
    app.innerHTML = `<h1>Judge</h1>
      <div class="split">
        <div><h2>Languages</h2>
          ${Object.entries(j.languages).length ? `<table><tbody>${Object.entries(j.languages).map(([k, v]) => `<tr><td><b>${esc(langNames()[k] || k)}</b></td><td class="${v.ok ? 'v v-AC' : 'v v-WA'}">${v.ok ? 'working' : 'not working'}</td><td class="small muted">${esc(v.message)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Self-test has not finished yet.</p>'}
          <p><button id="selftest">Run self-test again</button></p>
        </div>
        <div><h2>Sandbox</h2>
          <dl class="kv">
            <dt>Runs as</dt><dd>${j.workers[0] && j.workers[0].uid != null ? `unprivileged user (uid ${j.workers[0].uid}${j.workers.length > 1 ? `… one per worker` : ''})` : 'the server user'}</dd>
            <dt>Network</dt><dd>${j.unshareNet ? 'isolated: programs cannot reach the network' : 'not isolated'}</dd>
            <dt>Workers</dt><dd>${j.workers.length} (${j.active} busy)</dd>
            <dt>Queue</dt><dd>${j.queueLength} waiting</dd>
            <dt>Judged since start</dt><dd>${j.judgedSinceStart}</dd>
            <dt>Time factors</dt><dd>Python ×${status.config.timeFactorPython}, Java ×${status.config.timeFactorJava}</dd>
            <dt>Work dir</dt><dd class="mono small">${esc(j.judgeDir)}</dd>
            <dt>Data dir</dt><dd class="mono small">${esc(status.config.dataDir)}</dd>
          </dl>
          ${j.notes.length ? `<div class="msg warn">${j.notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>` : '<p class="msg ok">Programs run as an unprivileged user with CPU, memory, process and file-size limits.</p>'}
        </div>
      </div>
      <h2>Totals</h2>
      <dl class="kv"><dt>Users</dt><dd>${status.counts.users}</dd><dt>Contests</dt><dd>${status.counts.contests}</dd><dt>Submissions</dt><dd>${status.counts.submissions}</dd><dt>Pending</dt><dd>${status.counts.pending}</dd></dl>`;
    qs('#selftest').onclick = async () => { qs('#selftest').disabled = true; await api.post('/api/admin/selftest'); judgePage(); };
  }

  route();
})();
