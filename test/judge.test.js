'use strict';
// Exercises the judge end to end: every language, every verdict.
// Run with: npm test   (uses a throwaway data directory)
process.env.DATA_DIR = require('os').tmpdir() + '/miniforces-test-' + process.pid;
process.env.JUDGE_DIR = process.env.DATA_DIR + '/judge';
const test = require('node:test');
const assert = require('node:assert');
const { db, nowIso } = require('../src/db');
const judge = require('../src/judge');

const cases = [
  ['cpp', 'AC', '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<"  "<<a+b<<" \\n\\n";}'],
  ['cpp', 'WA', '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a-b<<"\\n";}'],
  ['cpp', 'CE', 'int main(){ this is not c++ }'],
  ['cpp', 'RE', '#include <iostream>\nint main(){int*p=nullptr; std::cout<<*p; return 0;}'],
  ['cpp', 'TLE', 'int main(){volatile long long x=0; while(true) x++;}'],
  ['cpp', 'MLE', '#include <vector>\n#include <iostream>\nint main(){std::vector<int> v(200000000,1); long long s=0; for(int i=0;i<v.size();i+=1000) s+=v[i]; std::cout<<s;}'],
  ['python', 'AC', 'a,b=map(int,input().split())\nprint(a+b)'],
  ['python', 'WA', 'print(42)'],
  ['python', 'CE', 'print(\n'],
  ['python', 'RE', 'import sys\nprint(1/0)'],
  ['python', 'TLE', 'while True: pass'],
  ['python', 'MLE', 'a=[1]*300000000\nprint(len(a))'],
  ['java', 'AC', 'import java.util.*;\npublic class Solution{public static void main(String[] a){Scanner s=new Scanner(System.in);System.out.println(s.nextLong()+s.nextLong());}}'],
  ['java', 'WA', 'public class Main{public static void main(String[] a){System.out.println("nope");}}'],
  ['java', 'CE', 'public class Main{public static void main(String[] a){int x = "str";}}'],
  ['java', 'RE', 'public class Main{public static void main(String[] a){int[] x=new int[1]; System.out.println(x[5]);}}'],
  ['java', 'TLE', 'public class Main{public static void main(String[] a){long x=0; while(true) x++;}}'],
  ['java', 'MLE', 'public class Main{public static void main(String[] a){long[][] m=new long[64][]; for(int i=0;i<64;i++){m[i]=new long[8000000];} System.out.println(m[63][0]);}}'],
];

test('judge verdicts', { timeout: 300000 }, async () => {
  await judge.start();
  const now = nowIso();
  const c = db.prepare("INSERT INTO contests (name, start_at, end_at, visible, created_at) VALUES ('t', ?, ?, 1, ?)").run(now, now, now);
  const p = db.prepare("INSERT INTO problems (contest_id, title, time_limit_ms, memory_limit_mb, created_at) VALUES (?, 'sum', 1000, 128, ?)").run(c.lastInsertRowid, now);
  db.prepare('INSERT INTO tests (problem_id, ord, input, expected_output, is_example) VALUES (?, 0, ?, ?, 1)').run(p.lastInsertRowid, '2 3\n', '5\n');
  db.prepare('INSERT INTO tests (problem_id, ord, input, expected_output, is_example) VALUES (?, 1, ?, ?, 0)').run(p.lastInsertRowid, '10 20\n', '30');
  const ids = [];
  for (const [lang, expected, src] of cases) {
    const r = db.prepare("INSERT INTO submissions (user_id, contest_id, problem_id, language, source, status, submitted_at, admin_test) VALUES (NULL, ?, ?, ?, ?, 'queued', ?, 1)")
      .run(c.lastInsertRowid, p.lastInsertRowid, lang, src, now);
    ids.push([r.lastInsertRowid, lang, expected]);
    judge.enqueue(r.lastInsertRowid);
  }
  // wait for all to finish
  const deadline = Date.now() + 280000;
  while (Date.now() < deadline) {
    const pending = db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status != 'done'").get().n;
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const failures = [];
  for (const [id, lang, expected] of ids) {
    const s = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    const line = `${lang.padEnd(7)} expected ${expected.padEnd(4)} got ${String(s.verdict).padEnd(4)} test=${s.failed_test} time=${s.time_ms}ms mem=${Math.round((s.memory_kb || 0) / 1024)}MB`;
    console.log(line);
    if (s.verdict !== expected) failures.push(line + '\n' + (s.compile_output || '').slice(0, 300));
  }
  console.log(JSON.stringify(judge.getStatus(), null, 1));
  assert.deepStrictEqual(failures, []);
});
