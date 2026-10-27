'use strict';
// The judge: takes queued submissions, compiles them, runs every test in a
// sandbox (see runner.py) and stores a verdict.
//
// Verdicts: AC (all tests pass), WA, CE, RE, TLE, MLE, IE (judge problem).
// Judging stops at the first failing test (like Codeforces). Students only
// ever see the verdict and the number of the failing test - never hidden data.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('../config');
const { db, nowIso } = require('../db');

const RUNNER = path.join(__dirname, 'runner.py');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_COMPILE_OUTPUT = 16 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;

const state = {
  isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  unshareNet: false,          // network isolation available?
  uidBase: Number(process.env.JUDGE_UID_BASE || 65000),
  gid: Number(process.env.JUDGE_GID || 65534),
  probed: false,
  notes: [],
  languages: {},              // lang -> { ok, message } from the self-test
  versions: {},               // lang -> detected tool version string
  queue: [],
  active: 0,
  slots: [],
  judgedCount: 0,
};

for (let i = 0; i < config.judgeWorkers; i++) {
  state.slots.push({ index: i, uid: state.isRoot ? state.uidBase + i : null, busy: false });
}

fs.mkdirSync(config.judgeDir, { recursive: true });
try { fs.chmodSync(config.judgeDir, 0o711); } catch { /* ignore */ }

// ---------------------------------------------------------------------------
// Low-level: run something through runner.py
// ---------------------------------------------------------------------------
function runSandboxed(spec, specDir) {
  return new Promise((resolve) => {
    const specPath = path.join(specDir, `spec-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
    const child = spawn(config.compilers.python, ['-I', RUNNER, specPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: (spec.wall_limit_ms || 10000) + 20000,
      killSignal: 'SIGKILL',
      env: { PATH: process.env.PATH },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, error: `runner failed to start: ${e.message}` }));
    child.on('close', () => {
      try { fs.unlinkSync(specPath); } catch { /* ignore */ }
      const line = out.trim().split('\n').pop();
      try { resolve(JSON.parse(line)); }
      catch { resolve({ ok: false, error: `runner produced no result: ${(err || out).slice(0, 500)}` }); }
    });
  });
}

function childEnv() {
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', TMPDIR: '/tmp' };
}

function makeWorkDir(prefix) {
  const dir = path.join(config.judgeDir, `${prefix}-${crypto.randomBytes(12).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o777); // the (unprivileged) program may create scratch files here
  return dir;
}

function readCapped(file, cap = MAX_READ_BYTES) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(st.size, cap));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), truncated: st.size > cap };
  } catch { return { text: '', truncated: false }; }
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------
function javaClassName(source) {
  const m = /public\s+(?:final\s+|abstract\s+)*class\s+([A-Za-z_$][\w$]*)/.exec(source)
    || /\bclass\s+([A-Za-z_$][\w$]*)/.exec(source);
  return m ? m[1] : 'Main';
}

const LANGS = {
  cpp: {
    srcName: () => 'main.cpp',
    compile: () => [config.compilers.cpp, '-O2', '-std=gnu++17', '-pipe', '-o', 'prog', 'main.cpp'],
    run: () => ['./prog'],
    asHeadroomMb: 32,
    timeFactor: 1,
  },
  python: {
    srcName: () => 'main.py',
    compile: () => [config.compilers.python, '-m', 'py_compile', 'main.py'],
    run: () => [config.compilers.python, 'main.py'],
    asHeadroomMb: 96,
    timeFactor: config.timeFactorPython,
  },
  java: {
    srcName: (src) => `${javaClassName(src)}.java`,
    compile: (src) => [config.compilers.javac, '-encoding', 'UTF-8', '-d', '.', `${javaClassName(src)}.java`],
    run: (src, memMb) => [config.compilers.java, `-Xmx${memMb}m`, '-Xss64m', '-XX:+UseSerialGC', '-XX:-UsePerfData',
      '-Dfile.encoding=UTF-8', '-cp', '.', javaClassName(src)],
    asHeadroomMb: null, // JVM reserves huge virtual ranges: enforce via -Xmx instead of RLIMIT_AS
    timeFactor: config.timeFactorJava,
  },
};

const OOM_PATTERNS = /bad_alloc|MemoryError|OutOfMemoryError|Cannot allocate memory|out of memory/i;

// Detects installed tool versions so the UI can show e.g. "Python 3.13.2" instead of a guess.
function detectVersions() {
  const { spawnSync } = require('child_process');
  const first = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } });
      return ((r.stdout || '') + (r.stderr || '')).split('\n').find((l) => l.trim()) || '';
    } catch { return ''; }
  };
  const gpp = /(\d+\.\d+(?:\.\d+)?)/.exec(first(config.compilers.cpp, ['--version']));
  const py = /Python (\d+\.\d+(?:\.\d+)?)/.exec(first(config.compilers.python, ['--version']));
  const jv = /"?(\d+(?:\.\d+)*)/.exec(first(config.compilers.java, ['-version']).replace(/^.*version\s*/i, ''));
  state.versions = { cpp: gpp ? `g++ ${gpp[1]}` : 'g++', python: py ? `Python ${py[1]}` : 'Python 3', java: jv ? `Java ${jv[1].split('.')[0]}` : 'Java' };
}

// Language list for the UI, with detected versions.
function getLanguages() {
  return {
    cpp: { name: `C++17 (${state.versions.cpp || 'g++'})`, ext: 'cpp' },
    python: { name: state.versions.python || 'Python 3', ext: 'py' },
    java: { name: state.versions.java || 'Java', ext: 'java' },
  };
}

// ---------------------------------------------------------------------------
// Compile + run helpers
// ---------------------------------------------------------------------------
async function compile(lang, source, dir, slot) {
  const L = LANGS[lang];
  fs.writeFileSync(path.join(dir, L.srcName(source)), source, { mode: 0o644 });
  const res = await runSandboxed({
    cmd: L.compile(source), cwd: dir,
    stdout: path.join(dir, 'compile.out'), stderr: path.join(dir, 'compile.err'),
    cpu_limit_sec: 30, wall_limit_ms: 45000, nproc: 256, fsize_bytes: 256 * 1024 * 1024, nofile: 256,
    uid: slot.uid, gid: slot.uid != null ? state.gid : null, unshare_net: state.unshareNet, env: childEnv(),
  }, dir);
  const out = readCapped(path.join(dir, 'compile.out'), MAX_COMPILE_OUTPUT).text
    + readCapped(path.join(dir, 'compile.err'), MAX_COMPILE_OUTPUT).text;
  if (!res.ok) return { ok: false, internal: true, output: res.error || res.sandbox_error || out };
  if (res.timed_out) return { ok: false, output: 'Compilation timed out.\n' + out };
  if (res.exit_code !== 0) return { ok: false, output: out || `Compiler exited with code ${res.exit_code ?? res.signal}` };
  return { ok: true, output: out };
}

function tokens(s) { return s.split(/\s+/).filter(Boolean); }
function outputsMatch(expected, actual) {
  const a = tokens(expected), b = tokens(actual);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function runTest(lang, source, dir, slot, test, limits) {
  const L = LANGS[lang];
  const tl = Math.round(limits.timeLimitMs * (L.timeFactor || 1));
  const memMb = limits.memoryLimitMb;
  const inPath = path.join(dir, 'input.txt');
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  fs.writeFileSync(inPath, test.input, { mode: 0o644 });
  for (const f of [outPath, errPath]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

  const res = await runSandboxed({
    cmd: L.run(source, memMb), cwd: dir, stdin: inPath, stdout: outPath, stderr: errPath,
    cpu_limit_sec: Math.ceil(tl / 1000) + 1,
    wall_limit_ms: Math.max(tl * 2, tl + 1000),
    as_bytes: L.asHeadroomMb == null ? null : (memMb + L.asHeadroomMb) * 1024 * 1024,
    stack_bytes: L.asHeadroomMb == null ? null : memMb * 1024 * 1024,
    nproc: slot.uid != null ? 128 : 1024, fsize_bytes: MAX_OUTPUT_BYTES, nofile: 64,
    uid: slot.uid, gid: slot.uid != null ? state.gid : null, unshare_net: state.unshareNet, env: childEnv(),
  }, dir);

  const r = { time_ms: res.cpu_ms || 0, memory_kb: res.max_rss_kb || 0, verdict: 'IE', detail: '' };
  if (!res.ok) { r.detail = res.error || res.sandbox_error || 'runner failure'; return r; }
  const stderr = readCapped(errPath, 4096).text;
  const memLimitKb = memMb * 1024;
  const oom = OOM_PATTERNS.test(stderr);
  const javaSlack = lang === 'java' ? 256 * 1024 : 0;

  if (res.timed_out || r.time_ms > tl) r.verdict = 'TLE';
  else if (oom || r.memory_kb > memLimitKb + javaSlack) r.verdict = 'MLE';
  else if (res.signal != null) {
    if (res.signal === 24 /* SIGXCPU */ || res.signal === 9) r.verdict = 'TLE';
    else { r.verdict = 'RE'; r.detail = `killed by signal ${res.signal}`; }
  } else if (res.exit_code !== 0) { r.verdict = 'RE'; r.detail = `exit code ${res.exit_code}`; }
  else {
    const out = readCapped(outPath);
    r.verdict = !out.truncated && outputsMatch(test.expected_output, out.text) ? 'AC' : 'WA';
  }
  if (r.verdict === 'TLE') r.time_ms = tl;
  return r;
}

// ---------------------------------------------------------------------------
// Judging a submission
// ---------------------------------------------------------------------------
function loadSubmission(id) {
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
}

async function judgeSubmission(id, slot) {
  const sub = loadSubmission(id);
  if (!sub) return;
  const problem = db.prepare('SELECT * FROM problems WHERE id = ?').get(sub.problem_id);
  if (!problem) { finish(id, { verdict: 'IE', compile_output: 'Problem no longer exists.' }); return; }
  const tests = db.prepare('SELECT id, input, expected_output FROM tests WHERE problem_id = ? ORDER BY is_example DESC, ord ASC, id ASC').all(problem.id);
  db.prepare("UPDATE submissions SET status = 'judging', verdict = NULL, failed_test = NULL, tests_passed = 0, tests_total = ?, judge_log = NULL WHERE id = ?").run(tests.length, id);

  const dir = makeWorkDir(`sub${id}`);
  try {
    if (!LANGS[sub.language]) { finish(id, { verdict: 'IE', compile_output: `Unknown language ${sub.language}` }); return; }
    const c = await compile(sub.language, sub.source, dir, slot);
    if (!c.ok) {
      finish(id, { verdict: c.internal ? 'IE' : 'CE', compile_output: c.output.slice(0, MAX_COMPILE_OUTPUT) });
      return;
    }
    const log = [];
    let verdict = 'AC', failed = null, timeMs = 0, memKb = 0, passed = 0;
    if (tests.length === 0) { verdict = 'IE'; }
    for (let i = 0; i < tests.length; i++) {
      const r = await runTest(sub.language, sub.source, dir, slot, tests[i],
        { timeLimitMs: problem.time_limit_ms, memoryLimitMb: problem.memory_limit_mb });
      log.push({ test: i + 1, verdict: r.verdict, time_ms: r.time_ms, memory_kb: r.memory_kb });
      timeMs = Math.max(timeMs, r.time_ms); memKb = Math.max(memKb, r.memory_kb);
      if (r.verdict !== 'AC') { verdict = r.verdict; failed = i + 1; break; }
      passed++;
    }
    finish(id, {
      verdict, failed_test: failed, tests_passed: passed, tests_total: tests.length,
      time_ms: timeMs, memory_kb: memKb, compile_output: c.output.slice(0, MAX_COMPILE_OUTPUT) || null,
      judge_log: JSON.stringify(log),
    });
  } catch (e) {
    console.error(`judge: submission ${id} failed:`, e);
    finish(id, { verdict: 'IE', compile_output: `Judge error: ${e.message}` });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    state.judgedCount++;
  }
}

function finish(id, r) {
  db.prepare(`UPDATE submissions SET status = 'done', verdict = ?, failed_test = ?, tests_passed = ?, tests_total = COALESCE(?, tests_total),
    time_ms = ?, memory_kb = ?, compile_output = ?, judge_log = ?, judged_at = ? WHERE id = ?`)
    .run(r.verdict, r.failed_test ?? null, r.tests_passed ?? 0, r.tests_total ?? null, r.time_ms ?? null, r.memory_kb ?? null,
      r.compile_output ?? null, r.judge_log ?? null, nowIso(), id);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function enqueue(id) {
  id = Number(id);
  if (!state.queue.includes(id)) state.queue.push(id);
  pump();
}

function pump() {
  if (!state.probed) return; // wait until the sandbox has been probed
  for (const slot of state.slots) {
    if (slot.busy || state.queue.length === 0) continue;
    const id = state.queue.shift();
    slot.busy = true; state.active++;
    judgeSubmission(id, slot)
      .catch((e) => console.error('judge error', e))
      .finally(() => { slot.busy = false; state.active--; pump(); });
  }
}

function requeue(id) {
  db.prepare("UPDATE submissions SET status = 'queued', verdict = NULL, failed_test = NULL, judge_log = NULL, judged_at = NULL WHERE id = ?").run(id);
  enqueue(id);
}

// ---------------------------------------------------------------------------
// Startup: probe the sandbox, self-test every language, resume the queue
// ---------------------------------------------------------------------------
async function probe() {
  const dir = makeWorkDir('probe');
  try {
    const trySpec = async (unshare) => runSandboxed({
      cmd: [config.compilers.python, '-c', 'print("ok")'], cwd: dir,
      stdout: path.join(dir, 'o'), stderr: path.join(dir, 'e'),
      cpu_limit_sec: 5, wall_limit_ms: 10000, nproc: 64, nofile: 64,
      uid: state.slots[0].uid, gid: state.slots[0].uid != null ? state.gid : null, unshare_net: unshare, env: childEnv(),
    }, dir);
    let r = await trySpec(true);
    if (r.ok && r.exit_code === 0) state.unshareNet = true;
    else {
      state.unshareNet = false;
      state.notes.push('Network isolation (unshare) is not available on this host; student programs can reach the network.');
      r = await trySpec(false);
      if (!(r.ok && r.exit_code === 0)) {
        if (state.isRoot) {
          state.notes.push('Could not run programs as an unprivileged user; running them as the server user instead.');
          for (const s of state.slots) s.uid = null;
        }
        const r2 = await trySpec(false);
        if (!(r2.ok && r2.exit_code === 0)) state.notes.push('Sandbox probe failed: ' + JSON.stringify(r2).slice(0, 300));
      }
    }
    if (!state.isRoot) state.notes.push('The server is not running as root, so student programs run as the same user as the server. For real isolation run with Docker (see README).');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    state.probed = true;
  }
}

const SELF_TEST_SOURCES = {
  cpp: '#include <bits/stdc++.h>\nint main(){long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n";}\n',
  python: 'a,b=map(int,input().split())\nprint(a+b)\n',
  java: 'import java.util.*;\npublic class Main{public static void main(String[] x){Scanner s=new Scanner(System.in);System.out.println(s.nextLong()+s.nextLong());}}\n',
};

async function selfTest() {
  for (const lang of Object.keys(LANGS)) {
    const dir = makeWorkDir('selftest');
    const slot = state.slots[0];
    try {
      const c = await compile(lang, SELF_TEST_SOURCES[lang], dir, slot);
      if (!c.ok) { state.languages[lang] = { ok: false, message: 'compile failed: ' + c.output.slice(0, 300) }; continue; }
      const r = await runTest(lang, SELF_TEST_SOURCES[lang], dir, slot, { input: '2 3\n', expected_output: '5\n' }, { timeLimitMs: 2000, memoryLimitMb: 256 });
      state.languages[lang] = r.verdict === 'AC'
        ? { ok: true, message: `OK (${r.time_ms} ms, ${Math.round(r.memory_kb / 1024)} MB)` }
        : { ok: false, message: `verdict ${r.verdict} ${r.detail || ''}`.trim() };
    } catch (e) {
      state.languages[lang] = { ok: false, message: e.message };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const bad = Object.entries(state.languages).filter(([, v]) => !v.ok);
  if (bad.length) console.warn('judge self-test problems:', bad.map(([k, v]) => `${k}: ${v.message}`).join(' | '));
  else console.log('judge self-test: C++, Python and Java all OK' + (state.unshareNet ? ' (network isolated)' : '') + (state.slots[0].uid != null ? ' (unprivileged user)' : ''));
}

async function start() {
  detectVersions();
  await probe();
  for (const n of state.notes) console.warn('judge:', n);
  // resume anything that was waiting when the server last stopped
  for (const row of db.prepare("SELECT id FROM submissions WHERE status IN ('queued','judging') ORDER BY id").all()) enqueue(row.id);
  selfTest().catch((e) => console.error('self-test failed', e));
}

function getStatus() {
  return {
    isRoot: state.isRoot, unshareNet: state.unshareNet, probed: state.probed, notes: state.notes,
    workers: state.slots.map((s) => ({ index: s.index, uid: s.uid, busy: s.busy })),
    queueLength: state.queue.length, active: state.active, judgedSinceStart: state.judgedCount,
    languages: state.languages, versions: state.versions, judgeDir: config.judgeDir,
  };
}

module.exports = { enqueue, requeue, start, getStatus, selfTest, getLanguages, LANGS };
