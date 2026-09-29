import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initialStudentLoginStatements } from '../lib/initial-student-logins.ts';
import { confirmedRoster } from '../lib/confirmed-roster.ts';
import { hashPassword, verifyPassword } from '../lib/local-password.ts';

const directory=new URL('../drizzle/',import.meta.url);
const names=(await readdir(directory)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort();
const rollout=await readFile(new URL('0023_initial_student_password.sql',directory),'utf8');
const provisioning=initialStudentLoginStatements.join(';\n')+';';
const pairs=[...provisioning.matchAll(/WHERE u.id=(\d+) AND u.student_id='([^']+)'/g)].map(m=>[Number(m[1]),m[2]]);

test('deployment initializes exactly the 22 verified original students with distinct hashes and preserves identities and history',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const name of names.filter(n=>n<'0023_')) db.exec(await readFile(new URL(name,directory),'utf8'));
 for(const s of confirmedRoster) db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES (?,?,?,?,'实验')").run(s.id,s.name,s.degree,s.gradeYear);
 for(const [id,studentId] of pairs) db.prepare("INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES (?,?,'原学生','student',?)").run(id,`original-${id}`,studentId);
 db.exec("INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES (1,'admin-1','管理者','superadmin','student-002'),(24,'admin-2','另一管理者','superadmin',NULL);");
 db.exec("INSERT INTO progress_entries(student_id,kind,title,submitted_by_user_id) VALUES ('student-001','实验','历史数据',2)");
 const users=db.prepare('SELECT * FROM app_users').all();
 const history=db.prepare('SELECT * FROM progress_entries').all();
 db.exec(rollout);
 for(const name of names.filter(n=>n>='0024_')) db.exec(await readFile(new URL(name,directory),'utf8'));
 db.exec(provisioning);
 const credentials=db.prepare('SELECT * FROM local_credentials').all();
 assert.equal(credentials.length,22);
 assert.equal(new Set(credentials.map(c=>c.password_hash)).size,22);
 for(const c of credentials) {
  assert.equal(c.must_change_password,1);
  assert.equal(await verifyPassword('123456789',c.password_hash),true);
 }
 assert.deepEqual(db.prepare('SELECT * FROM app_users').all(),users);
 assert.deepEqual(db.prepare('SELECT * FROM progress_entries').all(),history);
 assert.equal(db.prepare('SELECT count(*) AS n FROM local_credentials WHERE app_user_id IN (1,24)').get().n,0);
 assert.equal(db.prepare('SELECT version FROM app_schema_meta').get().version,24);
 // Replaying only the initialization statements cannot reset a personal password or re-enable a disabled account.
 const personal=await hashPassword('An individually chosen password!');
 db.prepare('UPDATE local_credentials SET password_hash=?,must_change_password=0,version=2 WHERE app_user_id=2').run(personal);
 db.exec('UPDATE local_credentials SET password_hash=NULL,must_change_password=0,version=2 WHERE app_user_id=3');
 const before=db.prepare('SELECT * FROM local_credentials').all();
 db.exec(provisioning);
 assert.deepEqual(db.prepare('SELECT * FROM local_credentials').all(),before);
 db.exec('DELETE FROM local_credentials WHERE app_user_id=2');
 db.exec(provisioning);
 assert.equal(db.prepare('SELECT count(*) AS n FROM local_credentials WHERE app_user_id=2').get().n,0);
 db.close();
});

test('deployment skips inactive, elevated and mismatched bindings without creating users by name',async()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('PRAGMA foreign_keys=ON');
 for(const name of names.filter(n=>n<'0023_')) db.exec(await readFile(new URL(name,directory),'utf8'));
 for(const s of confirmedRoster) db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES (?,?,?,?,'实验')").run(s.id,s.name,s.degree,s.gradeYear);
 db.exec(`INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id,active) VALUES
 (2,'inactive','温浩钰','student','student-001',0),
 (3,'elevated','邵华阳','admin','student-010',1),
 (4,'rebound','张新茹','student','student-005',1),
 (5,'inactive-student','李小博','student','student-025',1);
 UPDATE students SET active=0 WHERE id='student-025';`);
 db.exec(rollout);
 for(const name of names.filter(n=>n>='0024_')) db.exec(await readFile(new URL(name,directory),'utf8'));
 db.exec(provisioning);
 assert.equal(db.prepare('SELECT count(*) AS n FROM local_credentials').get().n,0);
 assert.equal(db.prepare('SELECT count(*) AS n FROM app_users').get().n,4);
 db.close();
});
