import { runLiveValidation } from './validation';
runLiveValidation(true).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error instanceof Error ? error.message : 'Read recovery failed.'); process.exitCode = 1; });
