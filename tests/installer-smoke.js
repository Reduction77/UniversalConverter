const assert = require('assert');
const { buildWingetBatch, buildElevationLauncher } = require('../installer');

const definitions = {
  ffmpeg:{ label:'FFmpeg', winget:'Gyan.FFmpeg' },
  imagemagick:{ label:'ImageMagick', winget:'ImageMagick.ImageMagick' },
};
const batch = buildWingetBatch(['ffmpeg','imagemagick'], definitions, 'C:\\Program Files\\WindowsApps\\winget.exe');
const launcher = buildElevationLauncher();

assert.match(batch, /source update/);
assert.match(batch, /install --id "%~2"/);
assert.match(batch, /Gyan\.FFmpeg/);
assert.match(batch, /ImageMagick\.ImageMagick/);
assert.match(batch, /UC_FAILED/);
assert.match(batch, /results.txt/);
assert.match(batch, /set "UC_CODE=%errorlevel%"/);
assert.match(batch, /goto current/);
assert.match(batch, /goto installed/);
assert.match(launcher, /1223/);
assert.match(launcher, /-Verb RunAs/);
assert.match(launcher, /-Wait -PassThru/);

console.log('INSTALLER_SMOKE_OK elevated CMD, source update, upgrade/install latest');
