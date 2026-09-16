import { acquireRepositoryLease } from '../../src/state/lease';

void acquireRepositoryLease(process.argv[2]).then(() => process.send?.('ready'));
