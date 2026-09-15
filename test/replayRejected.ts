import { replayRejections } from '../src/agent/rejections';
const file = process.argv[2];
if (!file) { console.error('Usage: node dist/test/replayRejected.js <rejected-responses.jsonl>'); process.exitCode = 1; }
else replayRejections(file).then(result => console.log(JSON.stringify(result, null, 2))).catch(() => { console.error('Could not replay the diagnostic file: invalid, oversized or unreadable log. No actions executed.'); process.exitCode = 1; });
