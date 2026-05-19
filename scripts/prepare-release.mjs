import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const releaseDir = path.join(process.cwd(), 'release');
const outputFile = path.join(process.cwd(), '.electron-output-dir');

function stopWindowsApp() {
  const names = ['Bamo Router.exe', 'electron.exe'];
  for (const name of names) {
    try {
      execSync(`taskkill /IM "${name}" /F`, { stdio: 'ignore' });
      console.log(`Stopped ${name}`);
    } catch {
      // not running
    }
  }
}

function tryRemove(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 800 });
}

function tryRename(dir) {
  const stale = path.join(process.cwd(), `release.stale.${Date.now()}`);
  fs.renameSync(dir, stale);
  console.log(`Renamed locked release/ → ${path.basename(stale)}/`);
  console.log('Delete that folder later after a reboot, or when nothing locks it.');
}

let outputDir = 'release';

if (process.platform === 'win32') {
  stopWindowsApp();
}

if (fs.existsSync(releaseDir)) {
  try {
    tryRemove(releaseDir);
    console.log('Removed release/');
  } catch {
    try {
      tryRename(releaseDir);
    } catch {
      outputDir = 'release-build';
      console.warn('\nrelease/ is locked (app.asar in use).');
      console.warn(`Building into ${outputDir}/ instead.\n`);
      console.warn('To free the old folder, run:  .\\scripts\\force-clean-release.ps1');
      console.warn('Or reboot, then:  Remove-Item -Recurse -Force .\\release\n');
    }
  }
}

fs.writeFileSync(outputFile, outputDir, 'utf8');
