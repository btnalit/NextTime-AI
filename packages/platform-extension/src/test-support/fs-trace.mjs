// Test-only preload for runtime-whitelist.test.ts (`NODE_OPTIONS=--import <this file>`): appends
// every path the process asks the file system about to the file `NEXTTIME_FS_TRACE` names, one
// `<call>\t<path>` per line — before pi's own modules load, so every later import of `fs` sees the
// wrapped functions. Nothing changes what the calls do.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const target = process.env.NEXTTIME_FS_TRACE;
if (target) {
  const fd = fs.openSync(target, 'a');
  const writeSync = fs.writeSync;
  let recording = false;
  const record = (call, path) => {
    if (recording) return;
    recording = true;
    try {
      const value =
        path instanceof URL ? fileURLToPath(path) : Buffer.isBuffer(path) ? path.toString() : path;
      if (typeof value === 'string') writeSync(fd, `${call}\t${value}\n`);
    } finally {
      recording = false;
    }
  };
  const wrap = (owner, names) => {
    for (const name of names) {
      const original = owner[name];
      if (typeof original !== 'function') continue;
      const wrapped = function (path, ...rest) {
        record(name, path);
        return original.call(this, path, ...rest);
      };
      Object.assign(wrapped, original);
      owner[name] = wrapped;
    }
  };
  const calls = ['open', 'readFile', 'readdir', 'stat', 'lstat', 'access', 'realpath', 'opendir'];
  wrap(fs, [
    ...calls,
    ...calls.map((name) => `${name}Sync`),
    'exists',
    'existsSync',
    'readlink',
    'readlinkSync',
    'watch',
    'watchFile',
  ]);
  wrap(fs.promises, [...calls, 'readlink', 'watch']);
  syncBuiltinESMExports();
}
