import fs from 'node:fs';
import path from 'node:path';
import pngToIco from 'png-to-ico';

const sources = ['electron/assets/icon-square.png', 'electron/assets/icon.png'];
const pngPath = sources.find((p) => fs.existsSync(p));

if (!pngPath) {
  console.error('No icon PNG found in electron/assets/');
  process.exit(1);
}

const icoPath = path.join('electron', 'assets', 'icon.ico');
const ico = await pngToIco(pngPath);
fs.writeFileSync(icoPath, ico);
console.log(`Wrote ${icoPath} from ${pngPath}`);
