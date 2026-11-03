import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { provisionAdministratorLogins } from '../lib/administrator-logins.ts';
import { upgradeLocalCredentialsSchema } from '../lib/local-auth-schema.ts';
import { loginLocally, localSessionGuardSql, issueLocalActivation } from '../lib/local-auth-service.ts';
import { digest, hashPassword } from '../lib/local-password.ts';

const directory=new URL('../drizzle/',import.meta.url);
const names=(await readdir(directory)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort();
const sqls=await Promise.all(names.map(n=>readFile(new URL(n,directory),'utf8')));
function fixture(version=24) {
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(let i=0;i<names.length;i++) if(Number(names[i].slice(0,4))<=version) db.exec(sqls[i]);
  db.exec(`INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES
    ('student-001','原学生','博士',2024,'实验'),('student-002','佘阳','博士',2023,'实验'),('student-003','另一个档案','博士',2025,'实验');
    INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
    (1,'ou_fixture_sy','佘阳','superadmin','student-002'),(24,'ou_fixture_yxh','于兴华','superadmin',NULL),
    (2,'ou_fixture_student','原学生','student','student-001');
    INSERT INTO local_credentials(app_user_id,student_id,username,password_hash,version,must_change_password)
      VALUES (2,'student-001','why','preserved-student-hash',7,1);
    INSERT INTO app_sessions(token_hash,app_user_id,expires_at,auth_method,local_credential_version,local_student_id)
      VALUES ('preserved-session',2,datetime('now','+1 day'),'local',7,'student-001');
    INSERT INTO progress_entries(student_id,kind,title,submitted_by_user_id) VALUES ('student-002','实验','历史记录',1);`);
  let queue=Promise.resolve();
  const d1={
    prepare(sql) {
      let args=[];
      const statement={sql,bind(...values){args=values;return statement;},
        async first(){return db.prepare(sql).get(...args)??null;},
        async all(){return {results:db.prepare(sql).all(...args),meta:{changes:db.prepare('SELECT changes() AS n').get().n}};},
        async run(){return {results:[],meta:{changes:Number(db.prepare(sql).run(...args).changes)}};},
      };return statement;
    },
    batch(statements){
      const result=queue.then(async()=>{
        db.exec('BEGIN');
        try {const results=[];for(const s of statements)results.push(await (/RETURNING/i.test(s.sql)?s.all():s.run()));db.exec('COMMIT');return results;}
        catch(error){db.exec('ROLLBACK');throw error;}
      });queue=result.catch(()=>{});return result;
    },
  };return {db,d1};
}
function sessionUser(db,token){return db.prepare(`SELECT u.id FROM app_sessions s JOIN app_users u ON u.id=s.app_user_id
  LEFT JOIN local_credentials c ON c.app_user_id=u.id WHERE s.token_hash=? AND u.active=1 AND ${localSessionGuardSql}`).get(digest(token));}

test('schema 24 runtime and SQL migrations preserve all credentials, sessions and role authorization',async()=>{
  for(const mode of ['runtime','sql']) {
    const {db,d1}=fixture(23);
    try {
      const before=db.prepare('SELECT * FROM local_credentials').all();
      const sessions=db.prepare('SELECT * FROM app_sessions').all();
      if(mode==='runtime') await Promise.all([upgradeLocalCredentialsSchema(d1),upgradeLocalCredentialsSchema(d1)]);
      else db.exec(sqls[names.findIndex(n=>n.startsWith('0024_'))]);
      const migrated=db.prepare('SELECT * FROM local_credentials').all();
      assert.deepEqual(migrated.map(c=>{const rest={...c};delete rest.authorized_role;return rest;}),before.map(c=>({...c})));
      assert.equal(migrated[0].authorized_role,'student');
      assert.deepEqual(db.prepare('SELECT * FROM app_sessions').all(),sessions);
      await provisionAdministratorLogins(d1);
      const after=db.prepare('SELECT * FROM local_credentials').all();
      await upgradeLocalCredentialsSchema(d1);
      assert.deepEqual(db.prepare('SELECT * FROM local_credentials').all(),after);
      assert.equal(after.find(c=>c.app_user_id===24).student_id,null);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    } finally {db.close();}
  }
});

test('administrator enrollment is exact, concurrent-safe, audited, and preserves roles and all prior records',async()=>{
  const {db,d1}=fixture();
  try {
    const users=db.prepare('SELECT * FROM app_users').all();
    const history=db.prepare('SELECT * FROM progress_entries').all();
    const student=db.prepare('SELECT * FROM local_credentials WHERE app_user_id=2').get();
    await Promise.all([provisionAdministratorLogins(d1),provisionAdministratorLogins(d1)]);
    const admins=db.prepare('SELECT * FROM local_credentials WHERE app_user_id IN (1,24) ORDER BY app_user_id').all();
    assert.deepEqual(admins.map(c=>[c.app_user_id,c.student_id,c.username,c.authorized_role,c.must_change_password]),[
      [1,'student-002','sy','superadmin',0],[24,null,'yxh','superadmin',0],
    ]);
    assert.notEqual(admins[0].password_hash,admins[1].password_hash);
    assert.ok(admins.every(c=>/^scrypt:16384:8:5:/.test(c.password_hash)));
    assert.deepEqual(db.prepare('SELECT * FROM app_users').all(),users);
    assert.deepEqual(db.prepare('SELECT * FROM progress_entries').all(),history);
    assert.deepEqual(db.prepare('SELECT * FROM local_credentials WHERE app_user_id=2').get(),student);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_auth_events').get().n,2);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_login_rollouts').get().n,2);
    db.exec("UPDATE local_credentials SET password_hash='new-personal-hash',version=2 WHERE app_user_id=1; UPDATE local_credentials SET password_hash=NULL,version=2 WHERE app_user_id=24");
    const changed=db.prepare('SELECT * FROM local_credentials').all();
    await provisionAdministratorLogins(d1);
    assert.deepEqual(db.prepare('SELECT * FROM local_credentials').all(),changed);
    db.exec('DELETE FROM local_credentials WHERE app_user_id IN (1,24)');
    await provisionAdministratorLogins(d1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM local_credentials').get().n,1);
  } finally {db.close();}
});

test('a delayed old-schema upgrader preserves administrator credentials created by the first upgrader',async()=>{
  const {db,d1}=fixture(23);
  try {
    let observed,release;
    const read=new Promise(resolve=>{observed=resolve;});
    const resume=new Promise(resolve=>{release=resolve;});
    let first=true;
    const delayed={...d1,prepare(sql){
      const statement=d1.prepare(sql);
      if(sql==='PRAGMA table_info(local_credentials)'&&first){
        first=false;const all=statement.all;
        statement.all=async()=>{const old=await all();observed();await resume;return old;};
      }
      return statement;
    }};
    const pending=upgradeLocalCredentialsSchema(delayed);
    await read;
    await upgradeLocalCredentialsSchema(d1);
    await provisionAdministratorLogins(d1);
    const before=db.prepare('SELECT * FROM local_credentials').all();
    release();await pending;
    assert.deepEqual(db.prepare('SELECT * FROM local_credentials').all(),before);
    assert.equal(db.prepare('SELECT authorized_role FROM local_credentials WHERE app_user_id=24').get().authorized_role,'superadmin');
  } finally {db.close();}
});

test('administrator enrollment rejects identity, role, active state, binding and username conflicts',async()=>{
  for(const conflict of [
    "UPDATE app_users SET display_name='不同的人' WHERE id=24",
    "UPDATE app_users SET active=0 WHERE id=24",
    "UPDATE app_users SET role='admin' WHERE id=24",
    "UPDATE app_users SET student_id='student-003' WHERE id=24",
    "UPDATE local_credentials SET username='yxh' WHERE app_user_id=2",
    "INSERT INTO local_credentials(app_user_id,student_id,authorized_role,username,password_hash) VALUES (24,NULL,'superadmin','custom-admin',NULL)",
  ]) {
    const {db,d1}=fixture();
    try {
      db.exec(conflict);const before=db.prepare('SELECT * FROM local_credentials WHERE app_user_id!=1').all();
      await provisionAdministratorLogins(d1);
      assert.deepEqual(db.prepare('SELECT * FROM local_credentials WHERE app_user_id!=1').all(),before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM local_login_rollouts WHERE rollout_key='administrator-logins-20260929:24'").get().n,0);
    } finally {db.close();}
  }
});

test('student credentials cannot inherit a promotion; administrator sessions reject rebinding, demotion and disable',async()=>{
  const {db,d1}=fixture();
  try {
    await provisionAdministratorLogins(d1);
    const password='FixtureAdmin26!';
    // Test-only password, never the production administrator password.
    db.prepare('UPDATE local_credentials SET password_hash=?,must_change_password=0').run(await hashPassword(password));
    const student=await loginLocally(d1,'why',password);
    db.exec("UPDATE app_users SET role='superadmin' WHERE id=2");
    assert.equal(sessionUser(db,student.token),undefined);
    await assert.rejects(loginLocally(d1,'why',password));
    await assert.rejects(issueLocalActivation(d1,1,2,'student-001'));
    const administrator=await loginLocally(d1,'yxh',password);
    assert.equal(sessionUser(db,administrator.token).id,24);
    for(const update of ["role='admin'","active=0","student_id='student-003'"]) {
      db.exec(`UPDATE app_users SET ${update} WHERE id=24`);
      assert.equal(sessionUser(db,administrator.token),undefined);
      await assert.rejects(loginLocally(d1,'yxh',password));
      db.exec("UPDATE app_users SET role='superadmin',active=1,student_id=NULL WHERE id=24");
    }
  } finally {db.close();}
});
