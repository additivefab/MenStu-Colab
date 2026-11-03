import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { digest } from '../lib/local-password.ts';
import { applyD1Migrations } from './database-fixture.mjs';

// Run the built production Worker against an isolated in-memory D1, without Feishu credentials.
test('Workers HTTP flow: original account -> activation -> login -> scoped data -> reset', {timeout:120000}, async () => {
  const root=fileURLToPath(new URL('../dist/server/', import.meta.url));
  const files=(await readdir(root,{recursive:true})).filter(f=>f.endsWith('.js'));
  const mf = new Miniflare({
    modules: ['index.js',...files.filter(f=>f!=='index.js')].map(path=>({type:'ESModule',path:root+path})),
    modulesRoot: root,
    compatibilityDate:'2026-05-22', compatibilityFlags:['nodejs_compat'],
    d1Databases:{DB:'local-auth-test'},
    r2Buckets:['FILES'],
  });
  try {
    const origin='http://localhost';
    const send=(path,body,cookie='', extra={}) => mf.dispatchFetch(origin+path,{
      method:'POST',headers:{'content-type':'application/json',origin,cookie,'cf-connecting-ip':'127.0.0.1',...extra},body:JSON.stringify(body),
    });
    await applyD1Migrations(mf);
    await mf.dispatchFetch(origin+'/api/health/ready'); // Exercise version checks and runtime provisioning after deployment migrations.
    const db=await mf.getD1Database('DB');
    assert.equal((await db.prepare('SELECT version FROM app_schema_meta').first()).version,27);
    await db.prepare("INSERT INTO students(id,display_name,degree,grade_year,stage) VALUES ('student-001','测试学生一','博士',2024,'实验'),('student-002','测试学生二','硕士',2025,'实验')").run();
    await db.prepare("INSERT INTO app_users(id,feishu_open_id,display_name,role,student_id) VALUES (1,'old-feishu-id','测试学生一','student','student-001'),(2,'other-feishu-id','测试学生二','student','student-002'),(3,'superadmin-test','测试超管','superadmin',NULL)").run();
    await db.prepare("INSERT INTO app_sessions(token_hash,app_user_id,expires_at) VALUES (?,3,datetime('now','+1 day'))").bind(digest('admin-test-session')).run();
    await db.prepare("INSERT INTO progress_entries(student_id,kind,title,submitted_by_user_id) VALUES ('student-001','实验','保留的历史进展',1),('student-002','实验','其他学生的进展',2)").run();
    await db.prepare("INSERT INTO progress_revisions(progress_entry_id,revision_number,snapshot_json,submitted_by_user_id) SELECT id,1,'{}',submitted_by_user_id FROM progress_entries").run();
    const admin='tanyan_session=admin-test-session';
    const body={action:'issue',userId:1,studentId:'student-001'};
    assert.equal((await send('/api/admin/local-accounts',body)).status,401);
    assert.equal((await send('/api/admin/local-accounts',body,admin,{origin:'https://evil.example'})).status,403);
    const issued=await send('/api/admin/local-accounts',body,admin);
    assert.equal(issued.status,200,await issued.clone().text());
    assert.match(issued.headers.get('cache-control'),/no-store/);
    const invitation=await issued.json();
    assert.equal(invitation.username,'why');
    const token=new URLSearchParams(new URL(invitation.activationUrl).hash.slice(1)).get('token');
    assert.ok(token);
    const page=await mf.dispatchFetch(origin+'/activate');
    assert.equal(page.status,200);
    assert.match(await page.text(),/设置独立登录密码/);
    const password='Study26!';
    const tooShort=await send('/api/auth/local/activate',{token,password:'Study26'});
    assert.equal(tooShort.status,400);
    assert.match((await tooShort.json()).error,/8–128/);
    const sharedPassword=await send('/api/auth/local/activate',{token,password:'123456789'});
    assert.equal(sharedPassword.status,400);
    assert.match((await sharedPassword.json()).error,/统一初始密码/);
    const activation=await send('/api/auth/local/activate',{token,password});
    assert.equal(activation.status,200,await activation.clone().text());
    assert.equal((await send('/api/auth/local/activate',{token,password})).status,400);
    assert.equal((await send('/api/auth/local/login',{username:'why',password:'incorrect long password'})).status,401);
    const login=await send('/api/auth/local/login',{username:'why',password});
    assert.equal(login.status,200,await login.clone().text());
    const setCookies=login.headers.getSetCookie();
    assert.ok(setCookies.some(c=>c.includes('HttpOnly')&&c.includes('Secure')&&c.includes('SameSite=Lax')));
    const studentCookie=setCookies.find(c=>c.startsWith('tanyan_session=')).split(';')[0];
    const session=await mf.dispatchFetch(origin+'/api/auth/session',{headers:{cookie:studentCookie}});
    assert.equal(session.status,200);
    const identity=await session.json();
    assert.equal(identity.feishuConfigured,false);
    assert.equal(identity.user.id,1);
    assert.equal(identity.user.studentId,'student-001');
    const dashboard=await mf.dispatchFetch(origin+'/api/dashboard',{headers:{cookie:studentCookie}});
    assert.equal(dashboard.status,200,await dashboard.clone().text());
    const data=await dashboard.json();
    assert.equal(data.viewer.id,1);
    assert.equal(data.students.length,1);
    assert.equal(data.students[0].id,'student-001');
    assert.ok(JSON.stringify(data).includes('保留的历史进展'));
    assert.ok(!JSON.stringify(data).includes('其他学生的进展'));
    assert.equal((await send('/api/admin/local-accounts',body,studentCookie)).status,403);
    assert.equal((await mf.dispatchFetch(origin+'/api/users',{headers:{cookie:studentCookie}})).status,403);
    assert.equal((await send('/api/auth/persona',{persona:'management'},studentCookie)).status,403);
    const accounts=await mf.dispatchFetch(origin+'/api/users',{headers:{cookie:admin}});
    const accountBody=await accounts.text();
    assert.ok(!accountBody.includes('password_hash')&&!accountBody.includes('activation_hash'));
    assert.equal(JSON.parse(accountBody).users.find(u=>u.id===1).local_account.status,'active');
    const passwordStatus=await mf.dispatchFetch(origin+'/api/auth/local/password',{headers:{cookie:studentCookie}});
    assert.deepEqual(await passwordStatus.json(),{username:'why',enabled:true});
    assert.equal((await send('/api/auth/local/password',{currentPassword:password,newPassword:'Updated research password 2026!'})).status,401);
    assert.equal((await send('/api/auth/local/password',{currentPassword:password,newPassword:'Updated research password 2026!'},studentCookie,{origin:'https://evil.example'})).status,403);
    assert.equal((await send('/api/auth/local/password',{currentPassword:'incorrect long password',newPassword:'Updated research password 2026!'},studentCookie)).status,400);
    assert.equal((await send('/api/auth/local/password',{currentPassword:password,newPassword:'123456789'},studentCookie)).status,400);
    const changed=await send('/api/auth/local/password',{userId:2,currentPassword:password,newPassword:'Updated research password 2026!'},studentCookie);
    assert.equal(changed.status,200,await changed.clone().text());
    assert.ok(changed.headers.getSetCookie().some(c=>c.startsWith('tanyan_session=')&&c.includes('Max-Age=0')));
    assert.equal((await mf.dispatchFetch(origin+'/api/auth/session',{headers:{cookie:studentCookie}})).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'why',password})).status,401);
    assert.equal((await db.prepare('SELECT count(*) AS n FROM local_credentials WHERE app_user_id=2').first()).n,0);
    assert.equal((await send('/api/auth/local/login',{username:'WHY',password:'Updated research password 2026!'})).status,200);
    // Shared initial passwords grant only access to the password-change flow.
    const initialBody={action:'initialize',userId:2,studentId:'student-002'};
    assert.equal((await send('/api/admin/local-accounts',initialBody)).status,401);
    assert.equal((await send('/api/admin/local-accounts',{...initialBody,userId:3},admin)).status,409);
    const initialized=await send('/api/admin/local-accounts',initialBody,admin);
    assert.equal(initialized.status,200,await initialized.clone().text());
    assert.equal((await send('/api/admin/local-accounts',initialBody,admin)).status,409);
    const initialLogin=await send('/api/auth/local/login',{username:'sy',password:'123456789'});
    assert.equal(initialLogin.status,200,await initialLogin.clone().text());
    const initialCookie=initialLogin.headers.getSetCookie().find(c=>c.startsWith('tanyan_session=')).split(';')[0];
    for (const path of ['/api/auth/session','/api/dashboard','/api/meeting-requests','/api/users']) {
      const restricted=await mf.dispatchFetch(origin+path,{headers:{cookie:initialCookie}});
      assert.equal(restricted.status,403,`${path}: ${await restricted.clone().text()}`);
      assert.equal((await restricted.json()).code,'PASSWORD_CHANGE_REQUIRED');
    }
    assert.equal((await send('/api/auth/persona',{persona:'student'},initialCookie)).status,401);
    assert.equal((await mf.dispatchFetch(origin+'/api/auth/local/password',{headers:{cookie:initialCookie}})).status,200);
    const newPersonal='MyStudy8';
    assert.equal((await send('/api/auth/local/password',{currentPassword:'incorrect',newPassword:newPersonal},initialCookie)).status,400);
    const shortChange=await send('/api/auth/local/password',{currentPassword:'123456789',newPassword:'MyStudy'},initialCookie);
    assert.equal(shortChange.status,400);
    assert.match((await shortChange.json()).error,/8–128/);
    const sharedChange=await send('/api/auth/local/password',{currentPassword:'123456789',newPassword:'123456789'},initialCookie);
    assert.equal(sharedChange.status,400);
    assert.match((await sharedChange.json()).error,/统一初始密码/);
    const initialChanged=await send('/api/auth/local/password',{currentPassword:'123456789',newPassword:newPersonal},initialCookie);
    assert.equal(initialChanged.status,200,await initialChanged.clone().text());
    assert.equal((await mf.dispatchFetch(origin+'/api/dashboard',{headers:{cookie:initialCookie}})).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'sy',password:'123456789'})).status,401);
    const personalLogin=await send('/api/auth/local/login',{username:'sy',password:newPersonal});
    assert.equal(personalLogin.status,200);
    const personalCookie=personalLogin.headers.getSetCookie().find(c=>c.startsWith('tanyan_session=')).split(';')[0];
    const personalDashboard=await mf.dispatchFetch(origin+'/api/dashboard',{headers:{cookie:personalCookie}});
    assert.equal(personalDashboard.status,200);
    assert.equal((await personalDashboard.json()).viewer.id,2);
    const reset=await send('/api/admin/local-accounts',body,admin);
    assert.equal(reset.status,200);
    assert.equal((await mf.dispatchFetch(origin+'/api/auth/session',{headers:{cookie:studentCookie}})).status,401);
    assert.equal((await send('/api/auth/local/login',{username:'why',password})).status,401);
  } finally { await mf.dispose(); }
});
