import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { activateLocalLogin, changeLocalPassword, disableLocalLogin, issueLocalActivation, loginLocally, localSessionGuardSql, takeAuthAttempt } from '../lib/local-auth-service.ts';
import { digest, hashPassword, passwordError, verifyPassword } from '../lib/local-password.ts';
import { localAuthSchemaStatements } from '../lib/local-auth-schema.ts';

const migrationFiles = (await readdir(new URL('../drizzle/', import.meta.url))).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort();
const migrations = await Promise.all(migrationFiles.map(n => readFile(new URL(`../drizzle/${n}`, import.meta.url), 'utf8')));
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const sql of migrations) db.exec(sql);
  db.exec(`INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES
    ('student-001','学生一','博士',2024,'实验'),('student-002','学生二','硕士',2025,'实验');
    INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
    (1,'original-open-1','学生一','student','student-001'),
    (2,'original-open-2','学生二','student','student-002'),
    (3,'admin-open','超管','superadmin',NULL),(4,'mentor-open','导师','mentor',NULL);
    INSERT INTO progress_entries(student_id,kind,title,submitted_by_user_id) VALUES ('student-001','实验','历史记录',1);
    INSERT INTO app_sessions(token_hash,app_user_id,expires_at) VALUES ('old-session',1,datetime('now','+1 day'));`);
  let batchQueue = Promise.resolve();
  const d1 = {
    prepare(sql) {
      let bindings = [];
      const statement = {
        sql,
        bind(...args) { bindings = args; return statement; },
        async first() { return db.prepare(sql).get(...bindings) ?? null; },
        async all() {
          const results = db.prepare(sql).all(...bindings);
          return { results, meta: { changes: db.prepare('SELECT changes() AS n').get().n } };
        },
        async run() { const result = db.prepare(sql).run(...bindings); return { results: [], meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
    batch(statements) {
      const result = batchQueue.then(async () => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const s of statements) results.push(await (/RETURNING/i.test(s.sql) ? s.all() : s.run()));
          db.exec('COMMIT');
          return results;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      batchQueue = result.catch(() => {});
      return result;
    },
  };
  return { db, d1 };
}
const password = 'My research password 2026!';
function sessionUser(db, token) {
  return db.prepare(`SELECT u.id,u.student_id FROM app_sessions s JOIN app_users u ON u.id=s.app_user_id
    LEFT JOIN local_credentials c ON c.app_user_id=u.id
    WHERE s.token_hash=? AND u.active=1 AND datetime(s.expires_at)>CURRENT_TIMESTAMP AND ${localSessionGuardSql}`).get(digest(token));
}

test('scrypt salts passwords, preserves Unicode, verifies failures and enforces length', async () => {
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword('incorrect password input', first), false);
  assert.equal(await verifyPassword(password, null), false);
  assert.equal(await verifyPassword(password, 'malformed'), false);
  assert.ok(passwordError('short'));
  assert.ok(passwordError('x'.repeat(129)));
  const unicode = '科研进展密码短语需要足够长才能安全使用🔒';
  assert.equal(await verifyPassword(unicode, await hashPassword(unicode)), true);
});

test('activation and local login reuse exact app_user and student, preserving historical work and Feishu binding', async () => {
  const {db,d1} = fixture();
  const before = db.prepare('SELECT * FROM progress_entries').all();
  const invitation = await issueLocalActivation(d1,3,1,'student-001');
  assert.equal(db.prepare('SELECT count(*) AS n FROM app_users').get().n,4);
  assert.equal(db.prepare('SELECT count(*) AS n FROM app_sessions').get().n,0);
  assert.equal(db.prepare('SELECT activation_hash FROM local_credentials').get().activation_hash,digest(invitation.token));
  const result = await activateLocalLogin(d1,invitation.token,password);
  assert.equal(result.username,'why');
  assert.equal(db.prepare('SELECT activation_hash FROM local_credentials').get().activation_hash,null);
  const login = await loginLocally(d1,' WHY ',password);
  assert.deepEqual({...sessionUser(db,login.token)},{id:1,student_id:'student-001'});
  assert.equal(db.prepare('SELECT feishu_open_id FROM app_users WHERE id=1').get().feishu_open_id,'original-open-1');
  assert.deepEqual(db.prepare('SELECT * FROM progress_entries').all(),before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_auth_events').get().n,2);
  await assert.rejects(activateLocalLogin(d1,invitation.token,password), /链接/);
  db.close();
});

test('only superadmins can issue links; role, active state and exact student binding are checked', async () => {
  const {db,d1}=fixture();
  for (const actor of [1,4,999]) await assert.rejects(issueLocalActivation(d1,actor,1,'student-001'));
  await assert.rejects(issueLocalActivation(d1,3,1,'student-002'));
  await assert.rejects(issueLocalActivation(d1,3,3,'student-001'));
  db.exec('UPDATE app_users SET active=0 WHERE id=1');
  await assert.rejects(issueLocalActivation(d1,3,1,'student-001'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_credentials').get().n,0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_auth_events').get().n,0);
  db.close();
});

test('reissue invalidates old link, old password and sessions; expiry and disable are enforced', async () => {
  const {db,d1}=fixture();
  const old=await issueLocalActivation(d1,3,1,'student-001');
  const fresh=await issueLocalActivation(d1,3,1,'student-001');
  await assert.rejects(activateLocalLogin(d1,old.token,password));
  db.exec("UPDATE local_credentials SET activation_expires_at=datetime('now','-1 second')");
  await assert.rejects(activateLocalLogin(d1,fresh.token,password));
  const active=await issueLocalActivation(d1,3,1,'student-001');
  await activateLocalLogin(d1,active.token,password);
  const session=await loginLocally(d1,'why',password);
  assert.ok(sessionUser(db,session.token));
  const reset=await issueLocalActivation(d1,3,1,'student-001');
  assert.equal(sessionUser(db,session.token),undefined);
  await assert.rejects(loginLocally(d1,'why',password));
  await disableLocalLogin(d1,3,1,'student-001');
  await assert.rejects(activateLocalLogin(d1,reset.token,password));
  db.close();
});

test('local sessions never inherit elevated roles or a reassigned student; Feishu sessions still work', async () => {
  const {db,d1}=fixture();
  const link=await issueLocalActivation(d1,3,1,'student-001');
  await activateLocalLogin(d1,link.token,password);
  const session=await loginLocally(d1,'why',password);
  for (const mutation of ["UPDATE app_users SET role='superadmin' WHERE id=1", 'UPDATE app_users SET active=0 WHERE id=1', "UPDATE students SET active=0 WHERE id='student-001'"]) {
    db.exec(mutation);
    assert.equal(sessionUser(db,session.token),undefined);
    await assert.rejects(loginLocally(d1,'why',password));
    db.exec("UPDATE app_users SET role='student',active=1 WHERE id=1; UPDATE students SET active=1");
  }
  db.exec("UPDATE app_users SET student_id=NULL WHERE id=2; UPDATE app_users SET student_id='student-002' WHERE id=1");
  assert.equal(sessionUser(db,session.token),undefined);
  await assert.rejects(issueLocalActivation(d1,3,1,'student-002'));
  const feishuToken='feishu-test';
  db.prepare('INSERT INTO app_sessions(token_hash,app_user_id,expires_at) VALUES (?,?,?)').run(digest(feishuToken),3,'2099-01-01');
  assert.equal(sessionUser(db,feishuToken).id,3);
  db.close();
});

test('activation racing a reset cannot use the superseded token', async () => {
  const {db,d1}=fixture();
  const link=await issueLocalActivation(d1,3,1,'student-001');
  const pending=activateLocalLogin(d1,link.token,password);
  const reset=await issueLocalActivation(d1,3,1,'student-001');
  await assert.rejects(pending);
  await activateLocalLogin(d1,reset.token,password);
  db.close();
});

test('durable limits enforce per-user attempts and allow recovery after window', async () => {
  const {db,d1}=fixture();
  const now=Date.now();
  for (let i=0;i<10;i++) await takeAuthAttempt(d1,'username','student-001',10,now);
  await assert.rejects(takeAuthAttempt(d1,'username','student-001',10,now),e=>e.status===429);
  await takeAuthAttempt(d1,'username','student-002',10,now);
  await takeAuthAttempt(d1,'username','student-001',10,now+900001);
  assert.ok(db.prepare('SELECT key FROM local_auth_attempts').all().every(r=>/^[a-f0-9]{64}$/.test(r.key)));
  db.close();
});

test('runtime schema is idempotent and migration keeps existing sessions as Feishu', () => {
  const {db}=fixture();
  for (const sql of localAuthSchemaStatements) db.exec(sql);
  for (const sql of localAuthSchemaStatements) db.exec(sql);
  assert.equal(db.prepare('SELECT auth_method FROM app_sessions').get().auth_method,'feishu');
  assert.equal(db.prepare('SELECT version FROM app_schema_meta').get().version,22);
  db.close();
});

test('changing password requires current password and session, revokes every old session and preserves data', async () => {
  const {db,d1}=fixture();
  const link=await issueLocalActivation(d1,3,1,'student-001');
  await activateLocalLogin(d1,link.token,password);
  const first=await loginLocally(d1,'why',password);
  const second=await loginLocally(d1,'why',password);
  const updated='An updated research password 2026!';
  const before=db.prepare('SELECT * FROM progress_entries').all();
  await assert.rejects(changeLocalPassword(d1,1,digest(first.token),'incorrect current password',updated));
  await assert.rejects(changeLocalPassword(d1,1,digest(first.token),password,'123456789'));
  await assert.rejects(changeLocalPassword(d1,1,digest(first.token),password,password));
  await assert.rejects(changeLocalPassword(d1,1,digest('missing-session'),password,updated));
  assert.ok(sessionUser(db,first.token));
  await changeLocalPassword(d1,1,digest(first.token),password,updated);
  assert.equal(sessionUser(db,first.token),undefined);
  assert.equal(sessionUser(db,second.token),undefined);
  await assert.rejects(loginLocally(d1,'why',password));
  const fresh=await loginLocally(d1,'why',updated);
  assert.equal(sessionUser(db,fresh.token).id,1);
  assert.deepEqual(db.prepare('SELECT * FROM progress_entries').all(),before);
  const audit=db.prepare("SELECT * FROM local_auth_events WHERE action='change_password'").get();
  assert.equal(audit.actor_user_id,1);
  assert.equal(audit.app_user_id,1);
  assert.ok(!JSON.stringify(audit).includes(updated));
  db.close();
});

test('a session from another student cannot change a password even when both know the same password', async () => {
  const {db,d1}=fixture();
  for (const [id,student] of [[1,'student-001'],[2,'student-002']]) {
    const link=await issueLocalActivation(d1,3,id,student);
    await activateLocalLogin(d1,link.token,password);
  }
  const session=await loginLocally(d1,'why',password);
  await assert.rejects(changeLocalPassword(d1,2,digest(session.token),password,'Updated research password 2026!'));
  const other=await loginLocally(d1,'sy',password);
  assert.equal(sessionUser(db,other.token).id,2);
  db.close();
});

test('a password change racing a reset cannot restore credentials or reuse its revoked session', async () => {
  const {db,d1}=fixture();
  const link=await issueLocalActivation(d1,3,1,'student-001');
  await activateLocalLogin(d1,link.token,password);
  const session=await loginLocally(d1,'why',password);
  let rowRead, continueChange;
  const selected=new Promise(resolve=>{rowRead=resolve;});
  const resume=new Promise(resolve=>{continueChange=resolve;});
  const originalPrepare=d1.prepare;
  d1.prepare=(sql)=>{
    const statement=originalPrepare(sql);
    if (sql.includes('SELECT password_hash, version')) {
      const first=statement.first;
      statement.first=async()=>{ const row=await first(); rowRead(); await resume; return row; };
    }
    return statement;
  };
  const pending=changeLocalPassword(d1,1,digest(session.token),password,'Updated research password 2026!');
  await selected;
  await issueLocalActivation(d1,3,1,'student-001');
  continueChange();
  await assert.rejects(pending);
  assert.equal(db.prepare('SELECT password_hash FROM local_credentials WHERE app_user_id=1').get().password_hash,null);
  assert.equal(sessionUser(db,session.token),undefined);
  db.close();
});

test('short initials are accepted; resetting a legacy student-ID login returns its new initials', async () => {
  const {db,d1}=fixture();
  const link=await issueLocalActivation(d1,3,2,'student-002');
  assert.equal(link.username,'sy');
  await activateLocalLogin(d1,link.token,password);
  assert.ok(await loginLocally(d1,' SY ',password));
  db.prepare("UPDATE local_credentials SET username='student-002' WHERE app_user_id=2").run();
  const reset=await issueLocalActivation(d1,3,2,'student-002');
  assert.equal(reset.username,'sy');
  assert.equal(db.prepare('SELECT username FROM local_credentials WHERE app_user_id=2').get().username,'sy');
  db.close();
});
