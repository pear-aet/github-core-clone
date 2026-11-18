// Entry wrapper: launch the statically linked Go forge binary.
// The binary is committed as ./forge (vendored source). We copy it to a
// writable temp path and exec it, so a read-only /bot mount is fine.
import { copyFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'forge');
const TMP = '/tmp/forge-bin';

copyFileSync(BIN, TMP);
chmodSync(TMP, 0o755);

const child = spawn(TMP, [], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
