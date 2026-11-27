import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#0f5f5c',
    pw_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_on INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ua TEXT
  );
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#1971c2',
    kind TEXT NOT NULL DEFAULT 'board',          -- board | outline
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    schedule TEXT NOT NULL DEFAULT 'work',       -- which hours the tasks are planned into
    columns TEXT NOT NULL DEFAULT '["To do","In progress","Done"]',
    meta TEXT NOT NULL DEFAULT '{}',
    target_date TEXT,
    sort REAL NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    ext_source TEXT, ext_id TEXT, ext_account INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE project_members (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'editor',
    PRIMARY KEY (project_id, user_id)
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',         -- todo | doing | done
    col INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 2,         -- 0 ASAP, 1 high, 2 medium, 3 low
    duration INTEGER NOT NULL DEFAULT 30,        -- minutes
    min_chunk INTEGER,                           -- smallest block; null = user default
    deadline TEXT,                               -- YYYY-MM-DD
    start_after TEXT,                            -- YYYY-MM-DD
    assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assign_mode TEXT NOT NULL DEFAULT 'fixed',   -- fixed | rotate
    schedule TEXT,                               -- null = project schedule
    auto INTEGER NOT NULL DEFAULT 1,             -- 0 = on the Later list (not scheduled)
    recur TEXT,                                  -- JSON {freq, every, days, window, anchor}
    points TEXT NOT NULL DEFAULT '[]',           -- checklist [{t, done}]
    meta TEXT NOT NULL DEFAULT '{}',
    sort REAL NOT NULL DEFAULT 0,
    grp INTEGER NOT NULL DEFAULT 0,              -- plan group (outline projects)
    do_next INTEGER,                             -- timestamp: "do next" request
    spent REAL NOT NULL DEFAULT 0,               -- minutes worked (non-recurring)
    done_at INTEGER, done_by INTEGER,
    created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    ext_source TEXT, ext_id TEXT, ext_account INTEGER, ext_updated TEXT
  );
  CREATE INDEX tasks_project ON tasks(project_id);
  CREATE INDEX tasks_ext ON tasks(ext_source, ext_id);
  CREATE TABLE occurrences (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    period INTEGER NOT NULL,
    status TEXT NOT NULL,                        -- done | skipped
    at INTEGER NOT NULL, by INTEGER, spent REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, period)
  );
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                          -- google | ics | vikunja
    label TEXT NOT NULL,
    secret TEXT NOT NULL,                        -- encrypted JSON
    state TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'ok',
    error TEXT,
    last_sync INTEGER
  );
  CREATE TABLE calendars (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    use_busy INTEGER NOT NULL DEFAULT 0,
    is_plan INTEGER NOT NULL DEFAULT 0,
    writable INTEGER NOT NULL DEFAULT 0,
    last_near INTEGER, last_far INTEGER,
    UNIQUE (account_id, ext_id)
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    start INTEGER NOT NULL, end INTEGER NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    free INTEGER NOT NULL DEFAULT 0,             -- shown as free / transparent
    ours INTEGER NOT NULL DEFAULT 0,             -- written by this app
    descr TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX events_cal_time ON events(calendar_id, start);
  CREATE TABLE plan_events (                     -- what we wrote into the plan calendar
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    period INTEGER NOT NULL DEFAULT 0,
    start INTEGER NOT NULL, end INTEGER NOT NULL,
    title TEXT NOT NULL,
    UNIQUE (calendar_id, ext_id)
  );
  CREATE TABLE overrides (                       -- user moved (pin) or deleted (defer) a plan block
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    period INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,                          -- pin | defer
    start INTEGER NOT NULL, end INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE appts (                           -- local busy time: breaks, interruptions, blocked time
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start INTEGER NOT NULL, end INTEGER NOT NULL,
    title TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'appt'
  );
  CREATE TABLE work_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    period INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL,                          -- work | research
    start INTEGER NOT NULL, end INTEGER NOT NULL,
    note TEXT, done INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX work_log_user ON work_log(user_id, start);
  CREATE TABLE active (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    period INTEGER NOT NULL DEFAULT 0,
    since INTEGER NOT NULL, mode TEXT, note TEXT
  );
  CREATE TABLE outbox (                          -- calendar log entries waiting to be written
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, descr TEXT NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0, error TEXT
  );
  CREATE TABLE push_subs (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    ua TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE notif_sent (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    user_id INTEGER, at INTEGER NOT NULL, text TEXT NOT NULL
  );
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN last_login INTEGER;
  ALTER TABLE sessions ADD COLUMN ip TEXT;
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
    actor_id INTEGER, target_id INTEGER, ip TEXT,
    kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_at ON audit(at);
  CREATE TABLE logs (
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
    level TEXT NOT NULL, src TEXT NOT NULL, msg TEXT NOT NULL, user_id INTEGER
  );
  CREATE INDEX logs_at ON logs(at);
  CREATE TABLE ip_bans (
    ip TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT NOT NULL,
    created_at INTEGER NOT NULL, by INTEGER, hits INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  ALTER TABLE tasks ADD COLUMN location TEXT;
  ALTER TABLE tasks ADD COLUMN wait_event TEXT;          -- follow-up waits for an event (e.g. washer_done) …
  ALTER TABLE tasks ADD COLUMN wait_until INTEGER;       -- … or until this time
  ALTER TABLE tasks ADD COLUMN source_task INTEGER;      -- created as follow-up of this task
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                                  -- api | display
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    users TEXT NOT NULL DEFAULT '[]',                    -- display: which users it shows
    created_at INTEGER NOT NULL, last_used INTEGER
  );
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,                                 -- credential id (base64url)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
    name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used INTEGER
  );
  `,
  `
  ALTER TABLE calendars ADD COLUMN include_words TEXT NOT NULL DEFAULT '';   -- block only events whose title contains one of these
  ALTER TABLE calendars ADD COLUMN exclude_words TEXT NOT NULL DEFAULT '';   -- never block events whose title contains one of these
  `,
  `
  ALTER TABLE events ADD COLUMN series TEXT;            -- recurring series (Google recurringEventId / ICS UID); null = single event
  CREATE TABLE event_buffers (                          -- travel / blocked time before and after a calendar event (whole series)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    series TEXT NOT NULL,
    before INTEGER NOT NULL DEFAULT 0, after INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, calendar_id, series)
  );
  `,
  `
  ALTER TABLE event_buffers ADD COLUMN block INTEGER;   -- null = calendar rules, 1 = always blocks, 0 = never blocks
  `,
  `
  ALTER TABLE sessions ADD COLUMN mfa INTEGER NOT NULL DEFAULT 1;   -- signed in with two factors (passkey, or password + code); existing sessions keep working
  `,
  `
  ALTER TABLE calendars ADD COLUMN mirror_to INTEGER;   -- filtered copy: events passing the keyword filter are copied into this (Google) calendar
  CREATE TABLE mirror_events (
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,   -- source
    src TEXT NOT NULL, ext_id TEXT NOT NULL, sig TEXT NOT NULL,
    PRIMARY KEY (calendar_id, src)
  );
  `,
  `
  ALTER TABLE calendars ADD COLUMN others_block INTEGER NOT NULL DEFAULT 0;   -- (replaced by only_mine)
  `,
  `
  ALTER TABLE calendars ADD COLUMN only_mine INTEGER NOT NULL DEFAULT 0;      -- 1 = only events with my words block; default: everything not on the others list blocks
  `,
  `
  CREATE TABLE invites (                                -- one-time invitation (link or code) from an existing user
    code_hash TEXT PRIMARY KEY,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,   -- joins this project right away
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    used_by INTEGER, used_at INTEGER
  );
  `,
  `
  CREATE TABLE conflicts (                              -- a group event overlapping one of your own blocking events
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,                                  -- group calendar id : event id
    g_cal INTEGER NOT NULL, g_ext TEXT NOT NULL, g_title TEXT NOT NULL, m_title TEXT NOT NULL,
    start INTEGER NOT NULL, end INTEGER NOT NULL,
    choice TEXT NOT NULL DEFAULT '',                    -- 'work' = the group event wins, 'mine' = your own event wins
    by_me INTEGER NOT NULL DEFAULT 0,                   -- you decided (otherwise the default rule)
    marked INTEGER NOT NULL DEFAULT 0,                  -- #TAG-blocked is written in the group event
    notified INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, key)
  );
  `,
  `
  ALTER TABLE users ADD COLUMN email TEXT;              -- for e-mail notifications
  `,
  `
  CREATE TABLE event_rules (                            -- when an event (series) may be moved to, e.g. a doctor's opening hours
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    series TEXT NOT NULL,
    hours TEXT,                                         -- name of an hours set (Settings → Planning → Hours)
    PRIMARY KEY (user_id, calendar_id, series)
  );
  `,
  `
  ALTER TABLE events ADD COLUMN location TEXT;          -- the place, copied into filtered calendars
  ALTER TABLE events ADD COLUMN link TEXT;              -- video call / event link
  `,
  `
  ALTER TABLE event_rules ADD COLUMN win TEXT;          -- own window: {"days":[1..5],"s":"08:00","e":"11:00"}
  ALTER TABLE event_rules ADD COLUMN rank TEXT;         -- own place in the ranking: just above this key (cal:ID | tasks | end); null = automatic
  `,
  `
  ALTER TABLE conflicts ADD COLUMN m_cal INTEGER;       -- your own event of the clash
  ALTER TABLE conflicts ADD COLUMN m_ext TEXT;
  `,
  `
  ALTER TABLE conflicts ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;   -- decided and put away: not shown or asked again
  `,
  `
  ALTER TABLE events ADD COLUMN dup TEXT;               -- copies of one appointment in several calendars share this key ("Also in …")
  `,
  `
  ALTER TABLE conflicts ADD COLUMN m_marked INTEGER NOT NULL DEFAULT 0;   -- #TAG-blocked is written in your own event (the group event won)
  `,
  `
  ALTER TABLE calendars ADD COLUMN watch TEXT;          -- Google push channel: {"id","res","token","exp"}
  `,
  `
  ALTER TABLE plan_events ADD COLUMN sig TEXT;          -- fingerprint of what was written (title, notes, busy): rewritten when it changes
  `,
  `
  CREATE TABLE event_track (                            -- an appointment you started, paused or marked done (menu bar)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    start INTEGER NOT NULL,                             -- the planned start, to clear old rows
    since INTEGER,                                      -- running since; null = paused or done
    spent REAL NOT NULL DEFAULT 0,                      -- minutes before the last pause
    done_at INTEGER,
    PRIMARY KEY (user_id, calendar_id, ext_id)
  );
  `,
  `
  ALTER TABLE event_track ADD COLUMN ended INTEGER;     -- the real end given with Done (earlier or later than planned)
  `,
  `
  CREATE TABLE travel_times (                           -- minutes from home to a place (Google Maps), the buffer before events there
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    place TEXT NOT NULL,                                -- the event's place, lower case
    car INTEGER, bike INTEGER,                          -- null: no route
    at INTEGER NOT NULL,
    PRIMARY KEY (user_id, place)
  );
  `,
  `
  ALTER TABLE event_track ADD COLUMN began INTEGER;     -- the real start given with Start (earlier or later than planned)
  `,
  `
  CREATE TABLE oauth_clients (                          -- apps registered for the Claude connector (OAuth dynamic client registration)
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    secret_hash TEXT,                                   -- null = public client (PKCE only)
    created_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, scope TEXT,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE oauth_tokens (                           -- one row per connection a user allowed
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    access_hash TEXT UNIQUE, access_exp INTEGER,
    refresh_hash TEXT UNIQUE, refresh_exp INTEGER,
    created_at INTEGER NOT NULL, last_used INTEGER, ip TEXT
  );
  `,
  `
  CREATE TABLE share_requests (                         -- "join my project?": asked by ID, the other person accepts or declines
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    UNIQUE(project_id, to_id)
  );
  `,
];

const ver = db.prepare('PRAGMA user_version').get().user_version;
for (let v = ver; v < MIGRATIONS.length; v++) {
  db.exec('BEGIN');
  try { db.exec(MIGRATIONS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

const cache = new Map();
const st = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
export const all = (sql, ...p) => st(sql).all(...p);
export const get = (sql, ...p) => st(sql).get(...p);
export const run = (sql, ...p) => st(sql).run(...p);
export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };

export function kvGet(key) { const r = get('SELECT value FROM kv WHERE key = ?', key); return r ? J(r.value, null) : null; }
export function kvSet(key, v) { run('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(v)); }
