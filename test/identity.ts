// Resolve the installed identity from the package being tested.
const manifest = require('../../package.json');
export const extensionId: string = `${manifest.publisher}.${manifest.name}`;
