import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTests, completeObservation, TestObservation } from '../src/validation/testBaseline';

function observation(results: string[], messages: string[] = results.map(r => r === 'Failed' ? 'assertion failed' : '')): TestObservation {
  const cases = results.map((result, i) => ({ path: 'tests/Value.Tests.ps1', name: `suite.case${i}`, result, message: messages[i] }));
  const failed = cases.filter(c => c.result === 'Failed');
  return { round: 1, version: '5.7.1', hashes: { 'tests/Value.Tests.ps1': 'unchanged' }, result: { total: cases.length, passed: results.filter(r => r === 'Passed').length, failed: failed.length, skipped: results.filter(r => r === 'Skipped').length, result: failed.length ? 'Failed' : 'Passed', cases, failures: failed.map(c => ({ path: c.path, name: c.name, message: c.message })), containerErrors: [] } };
}
test('test observations distinguish repeated, newly failing, changed and resolved failures', () => {
  const baseline = observation(['Failed','Passed','Failed','Failed']);
  const current = observation(['Failed','Failed','Failed','Passed'], ['assertion failed','new issue','different issue','']);
  assert.equal(completeObservation(baseline), true);
  const result = compareTests(current, baseline);
  assert.deepEqual(result.failures.map(f => f.origin), ['preexisting','newly failing since baseline','changed failure since baseline']);
  assert.deepEqual(result.comparison.resolved, [{ path: 'tests/Value.Tests.ps1', name: 'suite.case3' }]);
  assert.equal(result.comparison.baselineRound, 1);
  assert.match(result.comparison.note, /possible regressions/);
});
test('incomplete, ambiguous and incompatible observations cannot establish failure origin', () => {
  const current = observation(['Failed']);
  for (const mutate of [
    (b: TestObservation) => { b.result.cases = undefined; },
    (b: TestObservation) => { b.result.total = 201; },
    (b: TestObservation) => { b.result.cases!.push(b.result.cases![0]); b.result.total++; b.result.failed++; },
    (b: TestObservation) => { b.result.containerErrors.push('setup failed'); },
    (b: TestObservation) => { b.result.cases![0].result = 'Skipped'; b.result.skipped = 1; },
    (b: TestObservation) => { b.version = '4.10.1'; },
    (b: TestObservation) => { b.hashes['tests/Other.Tests.ps1'] = 'new selection'; },
    (b: TestObservation) => { b.hashes['tests/Value.Tests.ps1'] = 'edited test'; },
    (b: TestObservation) => { b.result.cases![0].name = 'different case'; },
    (b: TestObservation) => { b.result.cases![0].path = ''; },
    (b: TestObservation) => { b.result.cases![0].message = ''; }
  ]) {
    const baseline = observation(['Failed']); mutate(baseline);
    assert.equal(compareTests(current, baseline).failures[0].origin, 'unknown');
    assert.deepEqual(compareTests(current, baseline).comparison.resolved, []);
  }
  assert.equal(compareTests(current).failures[0].origin, 'unknown');
  assert.equal(compareTests(current, undefined, true).failures[0].origin, 'observed before edits');
});
