const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const targets = [path.join(root, 'dist'), path.join(root, 'installer', 'dist')];

for (const t of targets) {
  if (fs.existsSync(t)) {
    fs.rmSync(t, { recursive: true, force: true });
    console.log('removed', path.relative(root, t));
  }
}