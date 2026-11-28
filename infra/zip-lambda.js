const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const zip = new AdmZip();
const addDir = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) addDir(rel);
    else zip.addFile(rel.split(path.sep).join('/'), fs.readFileSync(path.join(ROOT, rel)));
  }
};
addDir('shared');
addDir('services');
zip.addFile('package.json', fs.readFileSync(path.join(ROOT, 'package.json')));
const out = execSync('npm ls --omit=dev --all --parseable', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const dirs = [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && path.resolve(l) !== path.resolve(ROOT)))];
for (const d of dirs) addDir(path.relative(ROOT, d));
fs.mkdirSync(path.join(__dirname, '.run'), { recursive: true });
const file = path.join(__dirname, '.run', 'lambda.zip');
zip.writeZip(file);
console.log(`  [ok] infra/.run/lambda.zip: ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB, ${dirs.length} packages`);
