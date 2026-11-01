import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { digest, hashPassword } from '../lib/local-password.ts';
import { applyD1Migrations } from './database-fixture.mjs';

test('v23 upgrade: administrators keep privileges, need no password change, and support persona, password change/reset/disable', {timeout:120000},async()=>{
  const root=fileURLToPath(new URL('../dist/server/',import.meta.url));
  const files=(await readdir(root,{recursive:true})).filter(f=>f.endsWith('.js'));
  let outbound=0;
  const mf=new Miniflare({
    modules:['index.js',...files.filter(f=>f!=='index.js')].map(path=>({type:'ESModule',path:root+path})),
    modulesRoot:root,compatibilityDate:'2026-05-22',compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'administrator-login-test'},r2Buckets:['FILES'],
    outboundService:()=>{outbound++;return new Response('Disabled in tests',{status:502});},
  });
  try {
    const db=await mf.getD1Database('DB');
    const migrationDir=new URL('../drizzle/',import.meta.url);
    for(const name of (await readdir(migrationDir)).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n<'0024_').sort()){
      const sql=await readFile(new URL(name,migrationDir),'utf8');
      for(const statement of sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
    }
    // New repository tables are deployment-owned; keep schema version 23 so
    // this fixture still exercises the credentials runtime upgrade path.
    await applyD1Migrations(mf,{from:'0025_'});
    await db.prepare(`INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES
      ('student-002','佘阳','博士',2023,'实验'),('student-001','原学生','博士',2024,'实验')`).run();
    await db.prepare(`INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES
      (1,'ou_fixture_sy','佘阳','superadmin','student-002'),(24,'ou_fixture_yxh','于兴华','superadmin',NULL),
      (2,'ou_fixture_student','原学生','student','student-001')`).run();
    const password='FixtureAdmin26!';
    const hash=await hashPassword(password);
    await db.prepare("INSERT INTO local_credentials(app_user_id,student_id,username,password_hash) VALUES (2,'student-001','why',?)").bind(hash).run();
    await db.prepare("INSERT INTO app_sessions(token_hash,app_user_id,expires_at,auth_method,local_credential_version,local_student_id) VALUES (?,2,datetime('now','+1 day'),'local',1,'student-001')").bind(digest('existing-student-session')).run();
    const origin='http://localhost';
    const send=(path,body,cookie='',extra={})=>mf.dispatchFetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,cookie,'cf-connecting-ip':'127.0.0.3',...extra},body:JSON.stringify(body)});
    const get=(path,cookie='')=>mf.dispatchFetch(origin+path,{headers:{cookie}});
    const cookieOf=r=>r.headers.getSetCookie().find(c=>c.startsWith('tanyan_session=')).split(';')[0];
    // A real HTTP request upgrades the schema and provisions only the existing administrators.
    const oldSession=await get('/api/auth/session','tanyan_session=existing-student-session');
    assert.equal(oldSession.status,200,await oldSession.clone().text());
    assert.equal((await oldSession.json()).user.id,2);
    assert.equal((await db.prepare('SELECT version FROM app_schema_meta').first()).version,25);
    const before=(await db.prepare('SELECT * FROM app_users').all()).results;
    const admins=(await db.prepare('SELECT * FROM local_credentials WHERE app_user_id IN (1,24)').all()).results;
    assert.equal(admins.length,2);
    assert.ok(admins.every(c=>c.authorized_role==='superadmin'&&c.must_change_password===0));
    assert.notEqual(admins[0].password_hash,admins[1].password_hash);
    // Replace only the isolated test DB's admin hashes; production passwords never enter fixtures.
    await db.prepare('UPDATE local_credentials SET password_hash=? WHERE app_user_id IN (1,24)').bind(hash).run();
    const cookies={};
    for(const [id,username,studentId] of [[1,'sy','student-002'],[24,'yxh',null]]){
      const login=await send('/api/auth/local/login',{username,password});
      assert.equal(login.status,200,await login.clone().text());
      const cookie=cookieOf(login);cookies[username]=cookie;
      const session=await get('/api/auth/session',cookie);
      assert.equal(session.status,200,await session.clone().text());
      const identity=(await session.json()).user;
      assert.equal(identity.id,id);assert.equal(identity.role,'superadmin');assert.equal(identity.primaryRole,'superadmin');
      assert.equal(identity.studentId,studentId);
      const dashboard=await get('/api/dashboard',cookie);
      assert.equal(dashboard.status,200,await dashboard.clone().text());
      assert.equal((await dashboard.json()).students.length,2);
      assert.equal((await get('/api/users',cookie)).status,200);
      const settings=await get('/api/auth/local/password',cookie);
      assert.deepEqual(await settings.json(),{username,enabled:true});
    }
    const switched=await send('/api/auth/persona',{persona:'student'},cookies.sy);
    assert.equal(switched.status,200);
    const studentPersona=cookies.sy+'; tanyan_persona=student';
    const ownDashboard=await get('/api/dashboard',studentPersona);
    const own=await ownDashboard.json();
    assert.equal(own.viewer.primaryRole,'superadmin');
    assert.deepEqual(own.students.map(s=>s.id),['student-002']);
    assert.equal((await get('/api/users',studentPersona)).status,403);
    assert.equal((await send('/api/auth/persona',{persona:'management'},studentPersona)).status,200);
    assert.equal((await send('/api/auth/persona',{persona:'student'},cookies.yxh)).status,403);
    const newPassword='ChangedAdmin26!';
    assert.equal((await send('/api/auth/local/password',{currentPassword:password,newPassword},cookies.yxh,{origin:'https://evil.example'})).status,403);
    const changed=await send('/api/auth/local/password',{currentPassword:password,newPassword,userId:1},cookies.yxh);
    assert.equal(changed.status,200,await changed.clone().text());
    assert.equal((await get('/api/auth/session',cookies.yxh)).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'yxh',password})).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'sy',password})).status,200);
    const relogin=await send('/api/auth/local/login',{username:'yxh',password:newPassword});
    assert.equal(relogin.status,200);
    const reset=await send('/api/admin/local-accounts',{action:'issue',userId:24,studentId:null},cookies.sy);
    assert.equal(reset.status,200,await reset.clone().text());
    assert.equal((await get('/api/auth/session',cookieOf(relogin))).status,401);
    const invite=await reset.json();assert.equal(invite.username,'yxh');
    const token=new URLSearchParams(new URL(invite.activationUrl).hash.slice(1)).get('token');
    const activation=await send('/api/auth/local/activate',{token,password:newPassword});
    assert.equal(activation.status,200,await activation.clone().text());
    const activated=await send('/api/auth/local/login',{username:'yxh',password:newPassword});assert.equal(activated.status,200);
    const disabled=await send('/api/admin/local-accounts',{action:'disable',userId:24,studentId:null},cookies.sy);
    assert.equal(disabled.status,200,await disabled.clone().text());
    assert.equal((await get('/api/auth/session',cookieOf(activated))).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'yxh',password:newPassword})).status,401);
    await db.prepare("UPDATE app_users SET role='superadmin' WHERE id=2").run();
    assert.equal((await get('/api/users','tanyan_session=existing-student-session')).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'why',password})).status,401);
    assert.equal((await send('/api/admin/local-accounts',{action:'issue',userId:2,studentId:'student-001'},cookies.sy)).status,409);
    const after=(await db.prepare('SELECT * FROM app_users WHERE id IN (1,24)').all()).results;
    for(const a of after){const b=before.find(u=>u.id===a.id);assert.equal(a.role,b.role);assert.equal(a.student_id,b.student_id);assert.equal(a.feishu_open_id,b.feishu_open_id);}
    assert.equal(outbound,0);
  } finally {await mf.dispose();}
});
