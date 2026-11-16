'use strict';
// Child process for the secret-store concurrency test: writes `count` distinct
// secrets into the shared store under `prefix`, exactly as the app would.
const [userData, prefix, count] = process.argv.slice(2);
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: {
    app: { getPath: () => userData },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + s),
      decryptString: (b) => b.toString().slice(4)
    }
  }
};
const loadTs = require('../load-ts.cjs');
const integrations = loadTs('src/main/integrations.ts');
let failed = 0;
for (let i = 0; i < Number(count); i++) {
  const r = integrations.setSecret(`${prefix}:${i}`, `value-${prefix}-${i}`);
  if (!r.ok) { failed++; console.error(r.error); }
}
process.exit(failed ? 2 : 0);
