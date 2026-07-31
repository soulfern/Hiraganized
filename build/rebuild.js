const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targets = [path.join(root, 'dist'), path.join(root, 'installer', 'dist')];

function rimraf(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log('removed', path.relative(root, target));
  }
}

for (const t of targets) rimraf(t);

console.log('Building inner app (electron-builder --dir)...');
const inner = spawnSync('npx', ['electron-builder', '--dir'], { cwd: root, stdio: 'inherit', shell: true });
if (inner.status !== 0) { process.exit(inner.status || 1); }

console.log('Building outer installer...');
const outer = spawnSync('npm', ['run', 'dist'], { cwd: path.join(root, 'installer'), stdio: 'inherit', shell: true });
process.exit(outer.status || 0);