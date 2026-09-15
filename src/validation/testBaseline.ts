import { z } from 'zod';

const failure = z.object({ name: z.string().nullable(), message: z.string().nullable(), path: z.string().optional() });
const testCase = z.object({ path: z.string(), name: z.string(), result: z.string(), message: z.string() });
export const testResults = z.object({ total: z.number().int().nonnegative(), passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), result: z.string(), failures: z.array(failure).max(20), containerErrors: z.array(z.string()).max(10), cases: z.array(testCase).max(200).optional() });
export type TestResults = z.infer<typeof testResults>;
export interface TestObservation { round: number; version: string; hashes: Record<string, string>; result: TestResults }
const key = (test: { path?: string; name: string | null }) => JSON.stringify([test.path, test.name]);
export function completeObservation(observation: TestObservation): boolean {
  const r = observation.result; const cases = r.cases;
  return !!cases && r.total > 0 && cases.length === r.total && !r.containerErrors.length &&
    cases.every(c => !!c.name && Object.hasOwn(observation.hashes, c.path) && ['Passed','Failed'].includes(c.result) && (c.result !== 'Failed' || !!c.message.trim())) &&
    new Set(cases.map(key)).size === cases.length &&
    cases.filter(c => c.result === 'Passed').length === r.passed && cases.filter(c => c.result === 'Failed').length === r.failed &&
    r.passed + r.failed === r.total && r.skipped === 0 && r.result === (r.failed ? 'Failed' : 'Passed');
}
export function compareTests(current: TestObservation, baseline?: TestObservation, startingState = false) {
  const comparable = !!baseline && completeObservation(baseline) && completeObservation(current) && baseline.version === current.version &&
    JSON.stringify(Object.keys(baseline.hashes).sort()) === JSON.stringify(Object.keys(current.hashes).sort());
  const oldCases = new Map(baseline?.result.cases?.map(c => [key(c), c]));
  const currentCases = new Map(current.result.cases?.map(c => [key(c), c]));
  const unchanged = (file: string) => baseline?.hashes[file] === current.hashes[file];
  const failures = current.result.failures.map(f => {
    const previous = oldCases.get(key(f)); const now = currentCases.get(key(f));
    let origin = startingState ? 'observed before edits' : 'unknown';
    if (!startingState && comparable && f.path && unchanged(f.path) && previous && now?.result === 'Failed' && now.message === f.message) {
      origin = previous.result === 'Passed' ? 'newly failing since baseline' : previous.message === f.message ? 'preexisting' : 'changed failure since baseline';
    }
    return { ...f, origin };
  });
  const resolved = comparable ? (baseline!.result.cases ?? []).filter(c => c.result === 'Failed' && unchanged(c.path) && currentCases.get(key(c))?.result === 'Passed').map(c => ({ path: c.path, name: c.name })).slice(0, 20) : [];
  return { ...current.result, failures, comparison: {
    baselineRound: baseline?.round ?? null, resolved,
    note: startingState ? 'Observed against unchanged task-start files before edits.' : comparable ? 'Compared with approved pre-edit observations. New failures are possible regressions; external state and flaky tests can also change results. Changed test files and unmatched tests have unknown origin.' : 'Unknown origin: no complete comparable pre-edit observation. Skips, duplicate identities, truncation, version changes or container failures prevent comparison.'
  } };
}
