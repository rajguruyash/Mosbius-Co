'use strict';
// Child process for the atomic-file tests. Modes:
//   write  <file> <letter> <times>   rewrite the file with 200k copies of one letter
//   count  <file> <lock> <times>     increment a counter in <file> under the lock
//   hold   <lock>                    take the lock, say "held", then never let go
const [mode, file, a, b] = process.argv.slice(2);
const loadTs = require('../load-ts.cjs');
const { writeFileAtomic, withFileLock } = loadTs('src/main/atomicFile.ts');
const fs = require('node:fs');
if (mode === 'write') {
  const body = a.repeat(200000);
  for (let i = 0; i < Number(b); i++) writeFileAtomic(file, body);
} else if (mode === 'count') {
  for (let i = 0; i < Number(b); i++) {
    withFileLock(a, () => {
      const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
      writeFileAtomic(file, String(n + 1));
    }, { timeoutMs: 20000 });
  }
}
else if (mode === 'hold') {
  // The parent kills this process while it holds the lock: a crash or a forced
  // termination (SIGKILL on POSIX, TerminateProcess on Windows).
  withFileLock(file, () => {
    process.stdout.write('held\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  }, { timeoutMs: 20000 });
}
