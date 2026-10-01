import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { provisionLocalOnlyStudentLogins } from '../lib/local-only-student-logins.ts';
import { confirmedRoster } from '../lib/confirmed-roster.ts';
import { hashPassword, verifyPassword } from '../lib/local-password.ts';

const directory = new URL('../drizzle/', import.meta.url);
const migrations = await Promise.all((await readdir(directory)).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()
  .map(n => readFile(new URL(n, directory), 'utf8')));

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const sql of migrations) db.exec(sql);
  for (const s of confirmedRoster) db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES (?,?,?,?,'实验')").run(s.id,s.name,s.degree,s.gradeYear);
  db.exec(`INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
    (1,'ou_existing_user','原学生','student','student-001'),(2,'ou_existing_admin','超管','superadmin',NULL);
    INSERT INTO local_credentials(app_user_id,student_id,username,password_hash) VALUES (1,'student-001','why','unchanged-hash');
    INSERT INTO progress_entries(student_id,kind,title,submitted_by_user_id) VALUES ('student-005','实验','保留的历史数据',2);`);
  let queue = Promise.resolve();
  const d1 = {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { return {meta:{changes:Number(db.prepare(sql).run(...args).changes)}}; },
      };
      return statement;
    },
    batch(statements) {
      const result = queue.then(async () => {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const s of statements) results.push(await s.run());
          db.exec('COMMIT');
          return results;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  return {db,d1};
}

test('concurrent provisioning creates only three exact student accounts and preserves all existing data', async () => {
  const {db,d1} = fixture();
  try {
    const before = ['students','app_users','local_credentials','progress_entries'].map(t => db.prepare(`SELECT * FROM ${t}`).all());
    await Promise.all([provisionLocalOnlyStudentLogins(d1), provisionLocalOnlyStudentLogins(d1)]);
    const accounts = db.prepare(`SELECT u.*,c.username,c.password_hash,c.must_change_password,c.authorized_role FROM app_users u
      JOIN local_credentials c ON c.app_user_id=u.id WHERE u.id>2 ORDER BY u.student_id`).all();
    assert.equal(accounts.length,3);
    assert.equal(new Set(accounts.map(a=>a.password_hash)).size,3);
    for (const [index,id,username] of [[0,'student-005','mjur'],[1,'student-006','abbasi'],[2,'student-026','zhh']]) {
      const a=accounts[index];
      assert.equal(a.student_id,id);
      assert.equal(a.feishu_open_id,`local:${id}`);
      assert.equal(a.username,username);
      assert.equal(a.role,'student');
      assert.equal(a.authorized_role,'student');
      assert.equal(a.active,1);
      assert.equal(a.must_change_password,1);
      assert.equal(await verifyPassword('123456789',a.password_hash),true);
    }
    assert.deepEqual(db.prepare('SELECT * FROM students').all(),before[0]);
    assert.deepEqual(db.prepare('SELECT * FROM app_users WHERE id<=2').all(),before[1]);
    assert.deepEqual(db.prepare('SELECT * FROM local_credentials WHERE app_user_id=1').all(),before[2]);
    assert.deepEqual(db.prepare('SELECT * FROM progress_entries').all(),before[3]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_login_rollouts').get().n,3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally { db.close(); }
});

test('replay cannot reset personal passwords, re-enable disabled credentials, or recreate deleted accounts', async () => {
  const {db,d1} = fixture();
  try {
    await provisionLocalOnlyStudentLogins(d1);
    db.prepare("UPDATE local_credentials SET password_hash=?,must_change_password=0 WHERE username='mjur'").run(await hashPassword('Personal8'));
    db.exec("UPDATE local_credentials SET password_hash=NULL,must_change_password=0 WHERE username='abbasi'");
    const credentials=db.prepare('SELECT * FROM local_credentials').all();
    await provisionLocalOnlyStudentLogins(d1);
    assert.deepEqual(db.prepare('SELECT * FROM local_credentials').all(),credentials);
    db.exec("DELETE FROM local_credentials WHERE student_id IN ('student-005','student-006','student-026'); DELETE FROM app_users WHERE student_id IN ('student-005','student-006','student-026')");
    await provisionLocalOnlyStudentLogins(d1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM app_users').get().n,2);
  } finally { db.close(); }
});

test('conflicting, disabled, elevated, renamed, and already verified identities are never taken over', async () => {
  const cases = [
    "UPDATE students SET active=0 WHERE id='student-005'",
    "UPDATE students SET display_name='另一个人' WHERE id='student-005'",
    "INSERT INTO app_users(feishu_open_id,display_name,role,student_id,active) VALUES ('ou_inactive_user','停用','student','student-005',0)",
    "INSERT INTO app_users(feishu_open_id,display_name,role,student_id) VALUES ('ou_elevated_user','管理','admin','student-005')",
    "INSERT INTO app_users(feishu_open_id,display_name,role) VALUES ('local:student-005','占用','student')",
    "UPDATE local_credentials SET username='mjur' WHERE app_user_id=1",
    "UPDATE local_credentials SET student_id='student-005' WHERE app_user_id=1",
    `INSERT INTO student_identity_binding_batches(id,actor_user_id,request_id,record_count) VALUES (1,2,'fixture-batch',26);
     INSERT INTO student_feishu_identity_bindings(student_id,feishu_open_id,batch_id,verified_by_user_id,contact_kind,active)
       VALUES ('student-005','ou_bound_identity',1,2,'email',0)`,
  ];
  for (const conflict of cases) {
    const {db,d1}=fixture();
    try {
      db.exec(conflict);
      const before=db.prepare('SELECT * FROM app_users').all();
      const creds=db.prepare('SELECT * FROM local_credentials').all();
      await provisionLocalOnlyStudentLogins(d1);
      assert.deepEqual(db.prepare("SELECT * FROM app_users WHERE student_id IS NULL OR student_id NOT IN ('student-006','student-026')").all(),before);
      assert.deepEqual(db.prepare("SELECT * FROM local_credentials WHERE username NOT IN ('abbasi','zhh')").all(),creds);
      assert.equal(db.prepare("SELECT count(*) AS n FROM local_credentials WHERE username='abbasi'").get().n,1);
    } finally { db.close(); }
  }
});

test('a failed transaction leaves no partial users, credentials, or completion markers', async () => {
  const {db,d1}=fixture();
  try {
    db.exec(`CREATE TRIGGER reject_third_credential BEFORE INSERT ON local_credentials WHEN NEW.username='zhh'
      BEGIN SELECT RAISE(ABORT,'test failure'); END;`);
    await assert.rejects(provisionLocalOnlyStudentLogins(d1),/test failure/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM app_users').get().n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_credentials').get().n,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_login_rollouts').get().n,0);
  } finally { db.close(); }
});

test('the new zhh enrollment never takes over a renamed profile, occupied username, or existing user', async () => {
  for (const conflict of [
    "UPDATE students SET display_name='不同的人' WHERE id='student-026'",
    "UPDATE local_credentials SET username='zhh' WHERE app_user_id=1",
    "INSERT INTO app_users(feishu_open_id,display_name,role,student_id) VALUES ('ou_existing_zhh','钟昊航','student','student-026')",
  ]) {
    const {db,d1}=fixture();
    try {
      db.exec(conflict);
      const original=db.prepare("SELECT * FROM app_users WHERE student_id='student-026'").all();
      const originalCredential=db.prepare("SELECT * FROM local_credentials WHERE username='zhh'").all();
      await provisionLocalOnlyStudentLogins(d1);
      assert.deepEqual(db.prepare("SELECT * FROM app_users WHERE student_id='student-026'").all(),original);
      assert.deepEqual(db.prepare("SELECT * FROM local_credentials WHERE username='zhh'").all(),originalCredential);
      assert.equal(db.prepare("SELECT count(*) AS n FROM local_login_rollouts WHERE rollout_key='local-only-students-20261001:student-026'").get().n,0);
    } finally {db.close();}
  }
});
