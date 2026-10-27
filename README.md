# MiniForces

A small, self-hosted Codeforces-style contest site for a school or club, with a
built-in judge for **C++, Python and Java**. One Node.js process, one SQLite file,
no build step.

Students create an account, enter running contests, read problems, write code in
the browser (or upload a file), submit as many times as they like and get a verdict
within seconds: Accepted, Wrong Answer, Compilation Error, Runtime Error, Time Limit
Exceeded or Memory Limit Exceeded. Everyone can watch the status page and the
standings; nobody can see anyone else's code while a contest runs. Organizers
manage everything from a password-protected admin area.

## Requirements

- **Node.js 22.5 or newer** (the database uses Node's built-in SQLite).
- **Linux** for the judge. The server itself runs anywhere, but running student
  programs safely uses Linux features (resource limits, unprivileged users, network
  namespaces). macOS works for trying things out without isolation.
- `g++`, `python3`, `javac`/`java` on the PATH (Ubuntu/Debian:
  `sudo apt install g++ python3 default-jdk`).

Or use Docker, which bundles all of that (see below).

## Quick start

```bash
npm install
cp .env.example .env        # then edit .env and set ADMIN_PASSWORD
npm start
```

Open <http://localhost:3000>. The admin area is at <http://localhost:3000/admin>
and asks for the password from `.env`.

On startup the judge self-tests every language and prints a line like
`judge self-test: C++, Python and Java all OK (network isolated) (unprivileged user)`.
The admin **Judge** page shows the same information at any time.

### Running it for real

Run the server **as root** on a Linux machine (`sudo npm start`, or as a systemd
service) so the judge can run student programs as an unprivileged user with no
network access. The server never needs root for anything else; it only uses it to
*drop* privileges before running student code, and it locks `data/` and `.env` to
mode 700/600 so student programs cannot read them. The sandbox test in
`test/e2e.js` verifies this.

If you run it as a normal user, everything works but student programs run as that
same user. Fine for trying it out on your laptop, not for a real contest.

Put it behind HTTPS (Caddy is the easiest: `reverse_proxy localhost:3000`) and set
`COOKIE_SECURE=1` and `TRUST_PROXY=1` in `.env`.

### Docker

```bash
cp .env.example .env        # set ADMIN_PASSWORD
docker compose up -d --build
```

The site is on port 3000; the database is in `./data`. Inside the container the
judge runs programs as an unprivileged user with all resource limits. Docker's
default security profile does not allow creating network namespaces, so student
programs could reach the network unless you uncomment `cap_add: [SYS_ADMIN]` in
`docker-compose.yml` (or run natively as root, where it works out of the box).

The image uses Debian's OpenJDK 17; the language picker always shows the versions
that are actually installed.

## How a contest works

1. **Create it** in the admin area: name, description, time zone, start and end
   time (entered in that time zone; students see it converted to theirs), the
   leaderboard type and its parameters. New contests are **hidden**.
2. **Add problems** in order (they get labels A, B, C…). Each has a Markdown
   statement (with `$...$` math), a time limit, a memory limit and, for adaptive
   contests, a maximum score.
3. **Add tests** to each problem: type them in, paste many at once, or upload
   pairs of files (`1.in`/`1.out`, `input3.txt`/`output3.txt` …). Tick the ones
   that should be shown as **examples** in the statement; all the others stay
   hidden. Every test is used for judging; a submission is Accepted only if it
   passes all of them (no partial credit). Output comparison ignores extra
   whitespace and trailing newlines.
4. **Try a solution** on the problem page to make sure the tests and limits are
   right. Try-runs are judged like real submissions but never shown to students.
5. **Publish** the contest. It appears in the list; the problems become visible
   at the start time, to everyone at once.

While a contest is **running**, logged-in students can enter it at any time (the
end time is the same for everyone), read the problems, submit, see their own
submissions and source code, and watch the status page (everyone's verdicts) and
the standings. Entering a contest or submitting adds you to its leaderboard.

Once it is **finished**, submissions close. Anyone, even without an account, can
read the problems, the final standings and everyone's verdicts; the contest moves
to the **Archive**. Per contest you can additionally allow everyone to read
everyone's source code, and show editorials and reference solutions that you wrote
on each problem. Students keep their full submission history under
"My submissions".

### Leaderboard types

- **short** – most problems solved; ties broken by the time of the last accepted
  submission (earlier is better).
- **long** (ICPC style) – most solved, then lowest penalty. Penalty = for each
  solved problem, whole minutes from the contest start to the accepted
  submission, plus *penalty per wrong attempt* (default 10) for every rejected
  submission to that problem before it was solved. Wrong attempts on problems that
  were never solved do not count; compilation errors never count.
- **adaptive** – every problem starts at its maximum score and loses *points per
  minute* every full minute of the contest (never below 0); optionally minus some
  points per rejected attempt. Highest total wins; ties by last accepted time.

Submissions after a problem is solved, invalidated submissions and admin try-runs
never affect the standings. Standings can be downloaded as CSV.

### Admin operations

Contests: create, edit, **duplicate** (copies problems and tests as a new hidden
contest), hide/publish, delete, rejudge everything. Problems: add, reorder, edit,
remove, rejudge. Tests: add, edit, delete, reorder, mark as example, bulk upload.
Users: see every account's full name, username, email and PL number, edit them,
reset passwords, delete. Submissions: filter by contest/problem/verdict/user, read
anyone's source code and compiler output, **rejudge**, **invalidate** (keep it but
remove it from the standings), delete.

Deleting is permanent and cascades: deleting a contest removes its problems, tests,
entries and submissions; deleting a problem removes its tests and submissions;
deleting a user removes their submissions and contest entries.

## The judge

| Language | Compile | Run |
|---|---|---|
| C++ | `g++ -O2 -std=gnu++17 -o prog main.cpp` | `./prog` |
| Python | `python3 -m py_compile main.py` (syntax errors are compilation errors) | `python3 main.py` |
| Java | `javac Name.java` (the file is named after the `public class`; `Main` if none) | `java -Xmx<limit>m -Xss64m Name` |

Programs read standard input and write standard output. Tests are run in order,
examples first, and judging stops at the first failure; students see the verdict
and the number of the failing test, never hidden inputs or outputs.

Verdicts: **Accepted**, **Wrong Answer**, **Compilation Error** (compiler output
is shown to the author), **Runtime Error** (non-zero exit or crash),
**Time Limit Exceeded** (CPU time over the limit, or stuck for longer than the wall
clock allowance), **Memory Limit Exceeded** (peak memory over the limit, or an
out-of-memory error). Time is measured as CPU time; memory as peak resident size.
The time limit can be scaled per language with `JUDGE_TIME_FACTOR_PYTHON` and
`JUDGE_TIME_FACTOR_JAVA`.

Every program runs in its own temporary directory through `src/judge/runner.py`,
which applies CPU, address-space, stack, process-count, file-size and
open-file limits, kills the whole process group on timeout, and - when the server
runs as root - switches to an unprivileged user (`JUDGE_UID_BASE` + worker
number) and, where the kernel allows it, a network namespace with no interfaces.
Java is limited with `-Xmx` instead of an address-space limit.

## Configuration

Everything is in `.env` (see `.env.example`): `ADMIN_PASSWORD` (required),
`SITE_NAME`, `PORT`, `HOST`, `JUDGE_WORKERS`, `JUDGE_UID_BASE`,
`JUDGE_TIME_FACTOR_PYTHON`, `JUDGE_TIME_FACTOR_JAVA`, `SUBMIT_COOLDOWN_MS`,
`COOKIE_SECURE`, `TRUST_PROXY`, `DATA_DIR`, `JUDGE_DIR`, `CXX`, `PYTHON`, `JAVAC`,
`JAVA`.

## Data and backups

Everything is in `data/app.db` (SQLite, WAL mode) plus `data/secret.key`, which
signs login cookies. To back up, copy the `data` folder (or run
`sqlite3 data/app.db ".backup backup.db"` while the server is running).
Deleting `secret.key` logs everyone out.

## Tests

```bash
npm test                 # judge verdicts for all languages + standings math (no server needed)
npm start &              # then, against the running server:
node test/e2e.js         # full flow: accounts, contests, submissions, visibility rules, sandbox, admin
```

## Project layout

```
server.js            Express app, static files, security headers
src/config.js        .env loading and settings
src/db.js            SQLite schema (node:sqlite)
src/auth.js          password hashing (scrypt), signed cookie sessions, admin gate
src/standings.js     the three leaderboards + CSV
src/judge/index.js   queue, compile/run pipeline, verdicts, self-test
src/judge/runner.py  sandboxed process runner (limits, uid drop, network namespace)
src/routes/public.js student-facing API
src/routes/admin.js  admin API
public/              the front end: index.html + app.js (students), admin.html + admin.js
public/vendor/*      served from node_modules: CodeMirror (editor), marked (Markdown), KaTeX (math)
```
