import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const outputFile = path.join(process.cwd(), '.electron-output-dir');
const outputDir = fs.existsSync(outputFile)
  ? fs.readFileSync(outputFile, 'utf8').trim()
  : 'release';

const platformFlag = process.argv.includes('--win') ? '--win' : '';

console.log(`Packaging to: ${outputDir}/\n`);

execSync(
  `npx electron-builder --config electron-builder.json -c.directories.output=${outputDir} ${platformFlag}`.trim(),
  { stdio: 'inherit', shell: true },
);
