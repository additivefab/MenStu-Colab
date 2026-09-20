import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmedRoster } from '../lib/confirmed-roster.ts';
import { studentLoginName, studentLoginNames, uniqueLoginNames } from '../lib/student-login-names.ts';

test('every confirmed student has a unique stable lowercase login independent of account creation order', () => {
  assert.equal(studentLoginNames.size,confirmedRoster.length);
  const names=confirmedRoster.map(s=>studentLoginName(s.id));
  assert.equal(new Set(names).size,names.length);
  assert.ok(names.every(n=>/^[a-z][a-z0-9]*$/.test(n)));
  assert.equal(studentLoginName('student-001'),'why');
  assert.equal(studentLoginName('student-003'),'cc');
  assert.equal(studentLoginName('student-004'),'hyf');
  assert.equal(studentLoginName('student-005'),'mjur');
  assert.equal(studentLoginName('student-006'),'abbasi');
});

test('duplicate initials receive deterministic suffixes without taking another reserved login', () => {
  const result=uniqueLoginNames([['one','why'],['two','why'],['three','why2'],['four','why']]);
  assert.deepEqual([...result.values()],['why','why3','why2','why4']);
  assert.throws(()=>uniqueLoginNames([['one','why'],['one','hyf']]));
});
