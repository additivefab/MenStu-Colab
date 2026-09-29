import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { confirmedRoster } from '../lib/confirmed-roster.ts';
import { digest } from '../lib/local-password.ts';

test('local-only students: automatic provisioning, forced password change, scoped history, no Feishu identity or messages', {timeout:120000}, async () => {
  const root=fileURLToPath(new URL('../dist/server/',import.meta.url));
  const files=(await readdir(root,{recursive:true})).filter(f=>f.endsWith('.js'));
  let outbound=0;
  const mf=new Miniflare({
    modules:['index.js',...files.filter(f=>f!=='index.js')].map(path=>({type:'ESModule',path:root+path})),
    modulesRoot:root, compatibilityDate:'2026-05-22', compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'local-only-students-test'},r2Buckets:['FILES'],
    bindings:{FEISHU_APP_ID:'cli_test_local_only',FEISHU_APP_SECRET:'test-fixture-secret'},
    outboundService:()=>{outbound++;return new Response('External requests disabled',{status:502});},
  });
  try {
    const db=await mf.getD1Database('DB');
    const migrationDir=new URL('../drizzle/',import.meta.url);
    for (const name of (await readdir(migrationDir)).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort()) {
      const sql=await readFile(new URL(name,migrationDir),'utf8');
      // Fixtures apply schema before the first HTTP request so runtime provisioning sees the roster.
      for (const statement of sql.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }
    for (const s of confirmedRoster) await db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES (?,?,?,?,'实验')")
      .bind(s.id,s.name,s.degree,s.gradeYear).run();
    await db.prepare("INSERT INTO app_users(id,feishu_open_id,display_name,role) VALUES (1,'ou_test_admin_123','测试管理员','superadmin')").run();
    await db.prepare("INSERT INTO app_sessions(token_hash,app_user_id,expires_at) VALUES (?,1,datetime('now','+1 day'))").bind(digest('local-only-admin')).run();
    for (const id of ['student-005','student-006']) {
      await db.prepare("INSERT INTO progress_entries(student_id,kind,title,submitted_by_user_id) VALUES (?,'实验',?,1)").bind(id,`原档案-${id}`).run();
    }
    await db.prepare("INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,submitted_by_user_id) SELECT id,1,'{}',1 FROM progress_entries").run();
    const origin='http://localhost';
    const send=(path,body,cookie='')=>mf.dispatchFetch(origin+path,{method:'POST',headers:{'content-type':'application/json',origin,cookie,'cf-connecting-ip':'127.0.0.2'},body:JSON.stringify(body)});
    const cookieOf=response=>response.headers.getSetCookie().find(c=>c.startsWith('tanyan_session=')).split(';')[0];
    const get=(path,cookie)=>mf.dispatchFetch(origin+path,{headers:{cookie}});
    for (const [id,username,password] of [['student-005','mjur','Jalil26!'],['student-006','abbasi','Abbasi26']]) {
      const first=await send('/api/auth/local/login',{username,password:'123456789'});
      assert.equal(first.status,200,await first.clone().text());
      const initialCookie=cookieOf(first);
      const restricted=await get('/api/dashboard',initialCookie);
      assert.equal(restricted.status,403);
      assert.equal((await restricted.json()).code,'PASSWORD_CHANGE_REQUIRED');
      const settings=await get('/api/auth/local/password',initialCookie);
      assert.deepEqual(await settings.json(),{username,enabled:true});
      const changed=await send('/api/auth/local/password',{currentPassword:'123456789',newPassword:password},initialCookie);
      assert.equal(changed.status,200,await changed.clone().text());
      assert.equal((await get('/api/auth/session',initialCookie)).status,401);
      assert.equal((await send('/api/auth/local/login',{username,password:'123456789'})).status,401);
      const login=await send('/api/auth/local/login',{username,password});
      assert.equal(login.status,200,await login.clone().text());
      const cookie=cookieOf(login);
      const dashboard=await get('/api/dashboard',cookie);
      assert.equal(dashboard.status,200,await dashboard.clone().text());
      const data=await dashboard.json();
      assert.equal(data.viewer.studentId,id);
      assert.deepEqual(data.students.map(s=>s.id),[id]);
      assert.ok(JSON.stringify(data).includes(`原档案-${id}`));
      assert.equal((await get('/api/users',cookie)).status,403);
      const reminder=await send('/api/feishu/reminders',{studentId:id},'tanyan_session=local-only-admin');
      assert.equal(reminder.status,409,await reminder.clone().text());
      assert.match((await reminder.json()).error,/尚未绑定飞书账号/);
    }
    const verification=await send('/api/admin/student-access',{
      contacts:confirmedRoster.map(s=>({studentId:s.id,kind:'email',value:`${s.id}@example.com`})),
    },'tanyan_session=local-only-admin');
    assert.equal(verification.status,409,await verification.clone().text());
    assert.match((await verification.json()).error,/Muhammad Jalil Ur Rehman.*尚未完成身份核验/);
    const access=await get('/api/admin/student-access','tanyan_session=local-only-admin');
    for (const student of (await access.json()).students.filter(s=>['student-005','student-006'].includes(s.id))) {
      assert.equal(student.status,'conflict');
      assert.equal(student.verified,false);
    }
    for (const table of ['notification_deliveries','student_feishu_identity_bindings','student_identity_binding_batches']) {
      assert.equal((await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n,0);
    }
    assert.equal((await db.prepare('SELECT count(*) AS n FROM app_users').first()).n,3);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM local_credentials').first()).n,2);
    assert.equal((await db.prepare('SELECT version FROM app_schema_meta').first()).version,24);
    assert.equal(outbound,0);
  } finally { await mf.dispose(); }
});
