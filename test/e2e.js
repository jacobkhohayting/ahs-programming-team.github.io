'use strict';
// End-to-end test against a running server (default http://localhost:3000, ADMIN_PASSWORD=admin123).
// Usage: node test/e2e.js
const BASE = process.env.BASE || 'http://localhost:3000';
const ADMIN = process.env.ADMIN_PASSWORD || 'admin123';
const assert = require('node:assert');

class Client {
  constructor() { this.cookie = ''; }
  async req(method, path, body) {
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  }
  get(p) { return this.req('GET', p); } post(p, b = {}) { return this.req('POST', p, b); } put(p, b) { return this.req('PUT', p, b); } del(p) { return this.req('DELETE', p); }
}
const ok = (r, msg) => { if (r.status >= 400) throw new Error(`${msg || ''} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(client, id) { for (let i = 0; i < 120; i++) { const s = ok(await client.get(`/api/submissions/${id}`)); if (s.status === 'done') return s; await sleep(400); } throw new Error('timeout'); }
async function waitDoneAdmin(client, id) { for (let i = 0; i < 120; i++) { const s = ok(await client.get(`/api/admin/submissions/${id}`)); if (s.status === 'done') return s; await sleep(400); } throw new Error('timeout'); }
let step = 0; const log = (m) => console.log(`${String(++step).padStart(2)}. ${m}`);

(async () => {
  const admin = new Client(), ann = new Client(), bob = new Client(), guest = new Client();
  const uniq = Date.now().toString(36);

  // --- admin login ----------------------------------------------------------
  assert.strictEqual((await admin.post('/api/admin/login', { password: 'wrong' })).status, 401);
  ok(await admin.post('/api/admin/login', { password: ADMIN }));
  log('admin login works, wrong password rejected');

  // --- contest + problems --------------------------------------------------
  const now = Date.now();
  const contest = ok(await admin.post('/api/admin/contests', {
    name: `E2E ${uniq}`, description: 'Welcome! Solve **everything**.', timezone: 'America/New_York',
    start_at: new Date(now - 60e3).toISOString(), end_at: new Date(now + 3600e3).toISOString(),
    visible: false, leaderboard_type: 'long', penalty_per_wrong: 10,
  }));
  log(`contest ${contest.id} created (hidden, long leaderboard, ${contest.start_local} .. ${contest.end_local} ${contest.timezone})`);
  // local-time input round trip
  const c2 = ok(await admin.put(`/api/admin/contests/${contest.id}`, { ...contest, start_local: contest.start_local, end_local: contest.end_local, start_at: undefined, end_at: undefined }));
  assert.strictEqual(Math.abs(Date.parse(c2.start_at) - Date.parse(contest.start_at)) < 60e3, true);
  log('time zone round trip (local -> UTC) is consistent');

  const pA = ok(await admin.post(`/api/admin/contests/${contest.id}/problems`, { title: 'Sum', statement: 'Print $a+b$.', time_limit_ms: 1000, memory_limit_mb: 128, points: 100 }));
  const pB = ok(await admin.post(`/api/admin/contests/${contest.id}/problems`, { title: 'Echo', statement: 'Print the input line.', time_limit_ms: 1000, memory_limit_mb: 128, points: 200 }));
  ok(await admin.post(`/api/admin/problems/${pA.id}/tests`, { tests: [{ input: '2 3\n', expected_output: '5\n', is_example: true }, { input: '10 20\n', expected_output: '30\n' }, { input: '-5 5\n', expected_output: '0' }] }));
  ok(await admin.post(`/api/admin/problems/${pB.id}/tests`, { tests: [{ input: 'hello world\n', expected_output: 'hello world\n', is_example: true }, { input: 'secret hidden text\n', expected_output: 'secret hidden text\n' }] }));
  log('two problems with example + hidden tests added');

  // hidden contest is invisible to students
  assert.strictEqual((await guest.get(`/api/contests/${contest.id}`)).status, 404);
  assert.ok(!ok(await guest.get('/api/contests')).contests.some((c) => c.id === contest.id));
  ok(await admin.post(`/api/admin/contests/${contest.id}/visibility`, { visible: true }));
  assert.ok(ok(await guest.get('/api/contests')).contests.some((c) => c.id === contest.id && c.status === 'running'));
  log('hidden contest invisible; published contest appears as running');

  // --- accounts ---------------------------------------------------------------
  const reg = (c, u) => c.post('/api/register', { full_name: u + ' Person', username: u + uniq, password: 'pass123', email: `${u}${uniq}@school.edu`, pl_number: 'PL-' + u });
  ok(await reg(ann, 'ann')); ok(await reg(bob, 'bob'));
  assert.strictEqual((await reg(new Client(), 'ann')).status, 409);
  assert.strictEqual((await new Client().post('/api/register', { full_name: 'x', username: 'nope' + uniq, password: 'pass123', email: 'bad', pl_number: '1' })).status, 400);
  assert.strictEqual((await new Client().post('/api/register', { full_name: '', username: 'nope2' + uniq, password: 'pass123', email: `n${uniq}@x.edu`, pl_number: '1' })).status, 400);
  log('registration: duplicates rejected, all fields required, bad email rejected');
  ok(await ann.put('/api/me', { full_name: 'Ann Updated', username: 'ann' + uniq, email: `ann${uniq}@school.edu`, pl_number: 'PL-9', current_password: 'pass123' }));
  assert.strictEqual((await ann.put('/api/me', { full_name: 'X', username: 'ann' + uniq, email: `ann${uniq}@school.edu`, pl_number: 'PL-9', current_password: 'wrong' })).status, 401);
  assert.strictEqual(ok(await ann.get('/api/me')).user.full_name, 'Ann Updated');
  log('profile edit works and needs the current password');

  // --- problems visible, hidden tests not ------------------------------------
  assert.strictEqual((await guest.get(`/api/contests/${contest.id}/problems/${pA.id}`)).status, 401);
  const probA = ok(await ann.get(`/api/contests/${contest.id}/problems/${pA.id}`));
  assert.strictEqual(probA.examples.length, 1);
  assert.strictEqual(probA.test_count, 3);
  assert.ok(!JSON.stringify(probA).includes('10 20'));
  log('guest must log in to see problems; students see examples only (hidden tests never sent)');
  assert.strictEqual((await ann.get('/api/admin/problems/' + pA.id)).status, 403);
  log('students cannot reach admin endpoints');

  // --- submissions -----------------------------------------------------------
  const submit = (c, pid, language, source) => c.post(`/api/contests/${contest.id}/submit`, { problem_id: pid, language, source });
  const cppSum = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<std::endl;}';
  let r = ok(await submit(ann, pA.id, 'cpp', cppSum));
  let s = await waitDone(ann, r.id);
  assert.strictEqual(s.verdict, 'AC'); assert.strictEqual(s.tests_passed, 3);
  log(`ann AC on A (C++), ${s.time_ms} ms`);
  assert.strictEqual((await submit(ann, pA.id, 'cpp', cppSum)).status, 429);
  log('rapid double submit is rate-limited');
  await sleep(3100);
  r = ok(await submit(bob, pA.id, 'python', 'a,b=map(int,input().split())\nprint(a-b)'));
  s = await waitDone(bob, r.id); assert.strictEqual(s.verdict, 'WA'); assert.strictEqual(s.failed_test, 1);
  log('bob WA on A (python) on test 1');
  await sleep(3100);
  r = ok(await submit(bob, pA.id, 'python', 'a,b=map(int,input().split())\nprint(a+b)'));
  s = await waitDone(bob, r.id); assert.strictEqual(s.verdict, 'AC');
  log('bob AC on A (python)');
  await sleep(3100);
  r = ok(await submit(bob, pB.id, 'java', 'import java.util.*;public class Main{public static void main(String[] a){Scanner s=new Scanner(System.in);System.out.println(s.nextLine());}}'));
  s = await waitDone(bob, r.id); assert.strictEqual(s.verdict, 'AC');
  log('bob AC on B (java)');

  // sandbox escape attempts: a "problem" whose expected output is "everything blocked".
  // An Accepted verdict proves the program could not read secrets, list other submissions, or use the network.
  await sleep(3100);
  const root = process.cwd();
  const pS = ok(await admin.post(`/api/admin/contests/${contest.id}/problems`, { title: 'Sandbox check', time_limit_ms: 2000, memory_limit_mb: 128 }));
  ok(await admin.post(`/api/admin/problems/${pS.id}/tests`, { tests: [{ input: 'x\n', expected_output: ['blocked ' + root + '/data/app.db', 'blocked ' + root + '/.env', 'blocked ' + root + '/data/secret.key', 'blocked /etc/shadow', 'unlistable judge dir', 'no network', 'not root'].join('\n') + '\n' }] }));
  const evil = `#include <bits/stdc++.h>
#include <dirent.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
using namespace std;
int main(){ string line; getline(cin,line);
 vector<string> files={"${root}/data/app.db","${root}/.env","${root}/data/secret.key","/etc/shadow"};
 for(auto&f:files){ ifstream in(f); string c; in>>c; cout<<(in.good()||!c.empty()?"READABLE ":"blocked ")<<f<<"\\n"; }
 DIR* d=opendir("/tmp/miniforces-judge"); cout<<(d?"LISTABLE":"unlistable")<<" judge dir\\n";
 int sock=socket(AF_INET,SOCK_STREAM,0); sockaddr_in a{}; a.sin_family=AF_INET; a.sin_port=htons(80); a.sin_addr.s_addr=inet_addr("1.1.1.1");
 cout<<(connect(sock,(sockaddr*)&a,sizeof(a))==0?"NETWORK":"no network")<<"\\n";
 cout<<(getuid()==0?"ROOT":"not root")<<"\\n"; }`;
  r = ok(await submit(ann, pS.id, 'cpp', evil));
  s = await waitDone(ann, r.id);
  assert.strictEqual(s.verdict, 'AC', 'sandbox probe should find everything blocked (verdict ' + s.verdict + ')');
  log('sandbox: database, .env, secret key, /etc/shadow unreadable; judge dir unlistable; no network; not root');
  ok(await admin.del(`/api/admin/problems/${pS.id}`));

  // --- status page rules -----------------------------------------------------
  const statusList = ok(await guest.get(`/api/contests/${contest.id}/submissions?user=all`));
  assert.ok(statusList.submissions.length >= 4);
  assert.ok(statusList.submissions.every((x) => x.can_view_code === false));
  const annList = ok(await ann.get(`/api/contests/${contest.id}/submissions?user=all`));
  assert.ok(annList.submissions.filter((x) => x.user.username === 'ann' + uniq).every((x) => x.can_view_code === true));
  assert.ok(annList.submissions.filter((x) => x.user.username === 'bob' + uniq).every((x) => x.can_view_code === false));
  const bobSubId = annList.submissions.find((x) => x.user.username === 'bob' + uniq).id;
  assert.strictEqual(ok(await ann.get(`/api/submissions/${bobSubId}`)).source, undefined);
  assert.ok(typeof ok(await admin.get(`/api/admin/submissions/${bobSubId}`)).source === 'string');
  log("everyone sees verdicts; nobody sees other people's code during the contest; admin sees all");

  // --- standings (long) --------------------------------------------------------
  let st = ok(await guest.get(`/api/contests/${contest.id}/standings`));
  const row = (u) => st.rows.find((x) => x.username === u + uniq);
  assert.strictEqual(row('bob').solves, 2); assert.strictEqual(row('ann').solves, 1);
  assert.strictEqual(row('bob').rank, 1);
  assert.ok(row('bob').penalty >= 10, 'bob has a wrong-attempt penalty');
  log(`long standings: bob rank 1 (2 solves, penalty ${row('bob').penalty}), ann rank 2`);
  const csv = ok(await guest.get(`/api/contests/${contest.id}/standings?format=csv`));
  assert.ok(csv.startsWith('"rank","username"'));
  log('CSV export works');

  // switch to short + adaptive and re-check ordering
  ok(await admin.put(`/api/admin/contests/${contest.id}`, { ...contest, visible: true, leaderboard_type: 'adaptive', decay_per_minute: 1, wrong_penalty_pts: 0 }));
  st = ok(await guest.get(`/api/contests/${contest.id}/standings`));
  assert.strictEqual(st.type, 'adaptive'); assert.ok(row('bob').points > row('ann').points);
  const home = ok(await ann.get(`/api/contests/${contest.id}`));
  assert.ok(home.problems[0].current_points <= 100 && home.problems[0].current_points >= 98);
  log(`adaptive standings: bob ${row('bob').points} pts, ann ${row('ann').points} pts; problem A now worth ${home.problems[0].current_points}`);

  // --- invalidate + rejudge ---------------------------------------------------
  ok(await admin.post(`/api/admin/submissions/${bobSubId}/invalidate`, { invalidated: true }));
  st = ok(await guest.get(`/api/contests/${contest.id}/standings`));
  log(`invalidated bob's submission ${bobSubId}: bob now ${row('bob').solves} solve(s)`);
  ok(await admin.post(`/api/admin/submissions/${bobSubId}/invalidate`, { invalidated: false }));
  ok(await admin.post(`/api/admin/problems/${pA.id}/rejudge`));
  for (let i = 0; i < 100; i++) { await sleep(400); if (ok(await admin.get('/api/admin/status')).counts.pending === 0) break; }
  st = ok(await guest.get(`/api/contests/${contest.id}/standings`));
  assert.strictEqual(row('bob').solves, 2);
  log('rejudge of problem A reproduced the same verdicts');

  // --- my submissions / history ---------------------------------------------------
  const mine = ok(await bob.get('/api/me/submissions'));
  assert.strictEqual(mine.submissions.length, 3);
  log('submission history lists all of bob\'s 3 submissions');

  // --- end the contest ----------------------------------------------------------
  ok(await admin.put(`/api/admin/contests/${contest.id}`, { ...contest, visible: true, leaderboard_type: 'long', start_at: new Date(now - 7200e3).toISOString(), end_at: new Date(now - 60e3).toISOString(), show_code_after: true }));
  assert.strictEqual((await submit(ann, pA.id, 'cpp', cppSum)).status, 403);
  assert.strictEqual(ok(await guest.get(`/api/contests/${contest.id}/problems/${pA.id}`)).label, 'A');
  assert.ok(typeof ok(await ann.get(`/api/submissions/${bobSubId}`)).source === 'string');
  assert.ok(ok(await guest.get('/api/archive')).contests.some((c) => c.id === contest.id));
  log('after the end: no submissions, guests can read problems (archive), code visible when enabled');
  ok(await admin.put(`/api/admin/problems/${pA.id}`, { ...pA, editorial: 'Just add them.', solution_code: cppSum, solution_language: 'cpp' }));
  const archived = ok(await guest.get(`/api/contests/${contest.id}/problems/${pA.id}`));
  assert.strictEqual(archived.editorial, 'Just add them.'); assert.strictEqual(archived.solution_code, cppSum);
  log('editorial and reference solution show up in the archive');

  // --- duplicate / delete ----------------------------------------------------------
  const dup = ok(await admin.post(`/api/admin/contests/${contest.id}/duplicate`));
  const dupFull = ok(await admin.get(`/api/admin/contests/${dup.id}`));
  assert.strictEqual(dupFull.problems.length, 2); assert.strictEqual(dupFull.problems[0].test_count, 3); assert.strictEqual(dupFull.visible, 0);
  ok(await admin.del(`/api/admin/contests/${dup.id}`));
  log('duplicate copies problems + tests as hidden; delete works');

  // --- admin test-run (should not appear in status) ----------------------------------
  const tr = ok(await admin.post(`/api/admin/problems/${pA.id}/test-run`, { language: 'cpp', source: cppSum }));
  const trs = await waitDoneAdmin(admin, tr.id);
  assert.strictEqual(trs.verdict, 'AC');
  assert.ok(!ok(await guest.get(`/api/contests/${contest.id}/submissions?user=all`)).submissions.some((x) => x.id === tr.id));
  log('admin test run judged AC and is invisible to students');

  // --- users admin ---------------------------------------------------------------
  const users = ok(await admin.get('/api/admin/users?q=' + uniq)).users;
  assert.strictEqual(users.length, 2); assert.ok(users[0].email && users[0].pl_number);
  const bobId = users.find((u) => u.username === 'bob' + uniq).id;
  ok(await admin.del(`/api/admin/users/${bobId}`));
  assert.strictEqual((await bob.get('/api/me')).data.user, null);
  log('admin sees full user details; deleting a user removes them (and their submissions)');

  console.log('\nALL E2E CHECKS PASSED');
})().catch((e) => { console.error('\nE2E FAILED at step', step + 1, e); process.exit(1); });
