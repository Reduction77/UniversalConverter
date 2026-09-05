const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildWingetBatch, buildElevationLauncher } = require('./installer');
const { resolveWinget } = require('./winget-resolver');
const { safeOutput } = require('./safe-output');
const { OperationLock } = require('./operation-lock');
const operations=new OperationLock();
const completedOutputs=new Set();

let mainWindow = null;
let activeProcess = null;
let cancelRequested = false;

const engineDefs = {
  ffmpeg: { label: 'FFmpeg', names: ['ffmpeg.exe','ffmpeg'], winget: 'Gyan.FFmpeg' },
  imagemagick: { label: 'ImageMagick', names: ['magick.exe','magick'], winget: 'ImageMagick.ImageMagick' },
  libreoffice: { label: 'LibreOffice', names: ['soffice.exe','soffice'], winget: 'TheDocumentFoundation.LibreOffice' },
  pandoc: { label: 'Pandoc', names: ['pandoc.exe','pandoc'], winget: 'JohnMacFarlane.Pandoc' },
  calibre: { label: 'Calibre', names: ['ebook-convert.exe','ebook-convert'], winget: 'calibre.calibre' },
  '7zip': { label: '7-Zip', names: ['7z.exe','7zz.exe','7z','7zz'], winget: '7zip.7zip' },
  ghostscript: { label: 'Ghostscript', names: ['gswin64c.exe','gswin32c.exe','gs'], winget: 'ArtifexSoftware.GhostScript' },
};

const extensionCategory = {
  video: new Set(['mp4','mov','mkv','webm','avi','flv','wmv','m4v','ts','mts','m2ts']),
  audio: new Set(['mp3','flac','wav','m4a','aac','ogg','opus','wma','aiff']),
  image: new Set(['jpg','jpeg','png','webp','avif','heic','heif','tif','tiff','bmp','gif','ico']),
  document: new Set(['doc','docx','odt','rtf','xls','xlsx','ods','ppt','pptx','odp']),
  markup: new Set(['md','markdown','html','htm','txt','tex','latex','rst']),
  ebook: new Set(['epub','mobi','azw','azw3','fb2']),
  archive: new Set(['zip','7z','rar','tar','gz','bz2','xz','tgz']),
  pdf: new Set(['pdf']),
};

function userSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(userSettingsPath(), 'utf8')); }
  catch { return { engineOverrides: {} }; }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(userSettingsPath()), { recursive: true });
  fs.writeFileSync(userSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function detectCategory(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  for (const [category, extensions] of Object.entries(extensionCategory)) {
    if (extensions.has(ext)) return category;
  }
  return 'unknown';
}

function existingFile(candidate) {
  try { return candidate && fs.statSync(candidate).isFile() ? candidate : null; }
  catch { return null; }
}

function whereExecutable(names) {
  for (const name of names) {
    const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) {
      const first = result.stdout.split(/\r?\n/).map(v => v.trim()).find(Boolean);
      if (first && existingFile(first)) return first;
    }
  }
  return null;
}

function walkForName(root, names, maxDepth = 4) {
  if (!root || !fs.existsSync(root)) return null;
  const wanted = new Set(names.map(v => v.toLowerCase()));
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return full;
      if (entry.isDirectory() && depth < maxDepth && !entry.name.startsWith('.')) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return null;
}

function matchingChildDirs(root, prefixes) {
  if (!root || !fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root, { withFileTypes:true })
      .filter(entry => entry.isDirectory() && prefixes.some(prefix => entry.name.toLowerCase().startsWith(prefix.toLowerCase())))
      .map(entry => path.join(root, entry.name));
  } catch { return []; }
}

function engineSearchRoots(key) {
  const pf = process.env.ProgramFiles;
  const pfx86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  const bundled = path.join(path.dirname(process.execPath), 'tools');
  const direct = {
    ffmpeg: [local && path.join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe')],
    imagemagick: [local && path.join(local, 'Microsoft', 'WinGet', 'Links', 'magick.exe')],
    libreoffice: [pf && path.join(pf, 'LibreOffice', 'program', 'soffice.exe')],
    pandoc: [local && path.join(local, 'Pandoc', 'pandoc.exe')],
    calibre: [pf && path.join(pf, 'Calibre2', 'ebook-convert.exe')],
    '7zip': [pf && path.join(pf, '7-Zip', '7z.exe')],
    ghostscript: [],
  };
  const roots = {
    ffmpeg: [...matchingChildDirs(local && path.join(local, 'Microsoft', 'WinGet', 'Packages'), ['Gyan.FFmpeg']), bundled],
    imagemagick: [...matchingChildDirs(pf, ['ImageMagick']), bundled],
    libreoffice: [bundled],
    pandoc: [local, bundled],
    calibre: [bundled],
    '7zip': [bundled],
    ghostscript: [pf && path.join(pf, 'gs'), pfx86 && path.join(pfx86, 'gs'), bundled],
  };
  return { direct: direct[key].filter(Boolean), roots: roots[key].filter(Boolean) };
}

function detectEngine(key) {
  const settings = readSettings();
  const override = existingFile(settings.engineOverrides?.[key]);
  if (override) return override;
  const def = engineDefs[key];
  const fromPath = whereExecutable(def.names);
  if (fromPath) return fromPath;
  const search = engineSearchRoots(key);
  for (const candidate of search.direct) {
    const found = existingFile(candidate);
    if (found) return found;
  }
  for (const root of search.roots) {
    const found = walkForName(root, def.names, key === 'ffmpeg' ? 6 : 4);
    if (found) return found;
  }
  return null;
}

function detectAllEngines() {
  const result = {};
  for (const [key, def] of Object.entries(engineDefs)) {
    const executable = detectEngine(key);
    result[key] = { key, label: def.label, executable, available: Boolean(executable) };
  }
  return result;
}

async function collectFiles(inputPaths) {
  const files = [];
  const seen = new Set();
  async function addPath(input, baseDir = null) {
    let stat;
    try { stat = await fs.promises.stat(input); } catch { return; }
    if (stat.isFile()) {
      const normalized = path.resolve(input);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        files.push({
          path: normalized,
          baseDir: baseDir || path.dirname(normalized),
          name: path.basename(normalized),
          ext: path.extname(normalized).slice(1).toLowerCase(),
          category: detectCategory(normalized),
          size: stat.size,
        });
      }
      return;
    }
    if (stat.isDirectory()) {
      const root = baseDir || path.resolve(input);
      let entries = [];
      try { entries = await fs.promises.readdir(input, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) await addPath(path.join(input, entry.name), root);
      }
    }
  }
  for (const input of inputPaths || []) await addPath(input);
  return files;
}

function requiredEngine(category, target) {
  if (category === 'video' || category === 'audio') return 'ffmpeg';
  if (category === 'image' || category === 'pdf') return 'imagemagick';
  if (category === 'document') return 'libreoffice';
  if (category === 'markup') return 'pandoc';
  if (category === 'ebook') return 'calibre';
  if (category === 'archive') return '7zip';
  return null;
}

function processEnvironment(engines) {
  const dirs = Object.values(engines).filter(Boolean).map(v => path.dirname(v));
  return { ...process.env, PATH: [...new Set(dirs), process.env.PATH || ''].join(path.delimiter) };
}

function emitQueue(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('queue-event', data);
}

function emitInstall(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('install-event', data);
}

function quoteForLog(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function moveFileSync(source, destination) {
  try { fs.renameSync(source, destination); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (cancelRequested) return reject(new Error('用户取消'));
    emitQueue({ type: 'log', level: 'debug', message: `执行：${[command, ...args].map(quoteForLog).join(' ')}` });
    let output = '';
    activeProcess = spawn(command, args, {
      windowsHide: true,
      env: options.env || process.env,
      cwd: options.cwd,
    });
    const consume = (chunk) => {
      const text = chunk.toString('utf8');
      output = (output + text).slice(-12000);
      if (options.onData) options.onData(text);
    };
    activeProcess.stdout.on('data', consume);
    activeProcess.stderr.on('data', consume);
    activeProcess.on('error', (error) => { activeProcess = null; reject(error); });
    activeProcess.on('close', (code) => {
      activeProcess = null;
      if (cancelRequested) return reject(new Error('用户取消'));
      if (code === 0) resolve(output);
      else reject(new Error(output.trim().split(/\r?\n/).slice(-12).join('\n') || `转换引擎退出，代码 ${code}`));
    });
  });
}

async function probeDuration(ffmpegPath, source, env) {
  const probe = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const executable = existingFile(probe) || whereExecutable(['ffprobe.exe','ffprobe']);
  if (!executable) return 0;
  const result = spawnSync(executable, ['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',source], { encoding:'utf8', windowsHide:true, env });
  const duration = Number.parseFloat(result.stdout || '0');
  return Number.isFinite(duration) ? duration : 0;
}

function resolveOutput(item, options) {
  let parent = path.dirname(item.path);
  if (options.outputMode === 'custom' && options.outputRoot) {
    parent = options.outputRoot;
    if (options.preserveStructure) {
      const relative = path.relative(item.baseDir, path.dirname(item.path));
      if (relative && !relative.startsWith('..')) parent = path.join(parent, relative);
    }
  }
  const parsed = path.parse(item.path);
  let output = path.join(parent, `${parsed.name}.${item.target}`);
  const sameAsInput = path.resolve(output).toLowerCase() === path.resolve(item.path).toLowerCase();
  if ((options.conflict === 'rename' || sameAsInput) && fs.existsSync(output)) {
    let i = 1;
    do { output = path.join(parent, `${parsed.name} (${i++}).${item.target}`); } while (fs.existsSync(output));
  } else if (options.conflict === 'skip' && fs.existsSync(output)) {
    const error = new Error('目标文件已存在'); error.skip = true; throw error;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  return output;
}

async function convertFfmpeg(item, output, ffmpeg, options, env) {
  const args = ['-hide_banner', options.conflict === 'overwrite' ? '-y' : '-n', '-i', item.path, options.keepMetadata ? '-map_metadata' : '-map_metadata', options.keepMetadata ? '0' : '-1'];
  const audioTargets = new Set(['mp3','flac','wav','m4a','ogg','opus']);
  if (audioTargets.has(item.target)) {
    const codecs = {
      mp3: ['-vn','-c:a','libmp3lame','-q:a','2'], flac: ['-vn','-c:a','flac'], wav: ['-vn','-c:a','pcm_s16le'],
      m4a: ['-vn','-c:a','aac','-b:a','256k'], ogg: ['-vn','-c:a','libvorbis','-q:a','6'], opus: ['-vn','-c:a','libopus','-b:a','160k'],
    };
    args.push(...codecs[item.target]);
  } else {
    const quality = options.videoQuality === 'quality' ? {q:19,p:'p6'} : options.videoQuality === 'smaller' ? {q:28,p:'p5'} : {q:23,p:'p5'};
    const nvenc = options.hardwareAcceleration && ['mp4','mkv','mov'].includes(item.target);
    if (item.target === 'webm') args.push('-c:v','libvpx-vp9','-crf',String(quality.q+5),'-b:v','0','-c:a','libopus');
    else if (item.target === 'avi') args.push('-c:v','mpeg4','-q:v','4','-c:a','libmp3lame');
    else if (nvenc) args.push('-c:v','h264_nvenc','-preset',quality.p,'-cq',String(quality.q),'-b:v','0','-c:a','aac','-b:a','192k');
    else args.push('-c:v','libx264','-preset','medium','-crf',String(quality.q),'-c:a','aac','-b:a','192k');
    if (['mp4','mov'].includes(item.target)) args.push('-pix_fmt','yuv420p','-movflags','+faststart');
  }
  const duration = await probeDuration(ffmpeg, item.path, env);
  let pending = '';
  args.push('-progress','pipe:1','-nostats',output);
  await runCommand(ffmpeg, args, { env, onData: (text) => {
    pending += text;
    const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
    for (const line of lines) {
      if (duration && line.startsWith('out_time_ms=')) {
        const seconds = Number(line.slice(12)) / 1000000;
        emitQueue({ type:'progress', id:item.id, progress:Math.min(99, Math.max(1, Math.round(seconds/duration*100))) });
      }
    }
  }});
}

async function convertImage(item, output, magick, env) {
  const args = [item.path];
  if (item.target === 'jpg') args.push('-background','white','-alpha','remove','-quality','92');
  else if (['webp','avif'].includes(item.target)) args.push('-quality','88');
  args.push(output);
  await runCommand(magick, args, { env });
}

async function convertPdf(item, output, magick, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-converter-'));
  try {
    const pattern = path.join(temp, `page-%04d.${item.target}`);
    const args = ['-density','180',item.path];
    if (item.target === 'jpg') args.push('-background','white','-alpha','remove','-quality','92');
    args.push(pattern);
    await runCommand(magick, args, { env });
    const pages = fs.readdirSync(temp).filter(v => v.startsWith('page-') && v.endsWith(`.${item.target}`)).sort();
    if (!pages.length) throw new Error('PDF 没有生成可用页面');
    if (pages.length === 1) moveFileSync(path.join(temp, pages[0]), output);
    else {
      for (let i=0; i<pages.length; i++) {
        const dest = path.join(path.dirname(output), `${path.parse(output).name}_${String(i+1).padStart(3,'0')}.${item.target}`);
        moveFileSync(path.join(temp, pages[i]), dest);
      }
      emitQueue({ type:'log', level:'info', message:`PDF 已导出 ${pages.length} 个页面` });
    }
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
}

async function convertOffice(item, output, soffice, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-converter-'));
  const profile = path.join(temp, 'profile'); fs.mkdirSync(profile);
  try {
    const profileUrl = new URL(`file:///${profile.replace(/\\/g,'/')}`).href;
    await runCommand(soffice, [`-env:UserInstallation=${profileUrl}`,'--headless','--convert-to',item.target,'--outdir',temp,item.path], { env });
    const generated = fs.readdirSync(temp).find(v => v.toLowerCase().endsWith(`.${item.target}`));
    if (!generated) throw new Error('LibreOffice 未生成目标文件，可能不支持这种格式组合');
    moveFileSync(path.join(temp, generated), output);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
}

async function convertMarkup(item, output, pandoc, engines, env) {
  if (item.target !== 'pdf') {
    await runCommand(pandoc, [item.path,'-o',output,'--standalone'], { env }); return;
  }
  const soffice = engines.libreoffice;
  if (!soffice) throw new Error('Markdown/HTML 转 PDF 还需要 LibreOffice');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-converter-'));
  try {
    const intermediate = path.join(temp, `${path.parse(item.path).name}.docx`);
    await runCommand(pandoc, [item.path,'-o',intermediate,'--standalone'], { env });
    await convertOffice({ ...item, path:intermediate, target:'pdf' }, output, soffice, env);
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
}

async function convertArchive(item, output, sevenZip, env) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-converter-'));
  const content = path.join(temp, 'content'); fs.mkdirSync(content);
  try {
    await runCommand(sevenZip, ['x',item.path,`-o${content}`,'-y'], { env });
    await runCommand(sevenZip, ['a',item.target === 'zip' ? '-tzip' : '-t7z',output,path.join(content,'*')], { env });
  } finally { fs.rmSync(temp, { recursive:true, force:true }); }
}

async function convertItem(item, options, engines) {
  const key = requiredEngine(item.category, item.target);
  if (!key || !engines[key]) throw new Error(`缺少转换引擎：${engineDefs[key]?.label || key || '未知'}`);
  const output = resolveOutput(item, options);
  const env = processEnvironment(engines);
  return safeOutput(output,options.conflict,async output=>{
  if (item.category === 'video' || item.category === 'audio') await convertFfmpeg(item, output, engines.ffmpeg, options, env);
  else if (item.category === 'image') await convertImage(item, output, engines.imagemagick, env);
  else if (item.category === 'pdf') await convertPdf(item, output, engines.imagemagick, env);
  else if (item.category === 'document') await convertOffice(item, output, engines.libreoffice, env);
  else if (item.category === 'markup') await convertMarkup(item, output, engines.pandoc, engines, env);
  else if (item.category === 'ebook') await runCommand(engines.calibre, [item.path,output], { env });
  else if (item.category === 'archive') await convertArchive(item, output, engines['7zip'], env);
  },()=>cancelRequested);
}

function runElevatedWinget(keys, winget) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-converter-install-'));
  const installScript = path.join(temp, 'install-latest.cmd');
  const launcherScript = path.join(temp, 'run-as-admin.ps1');
  fs.writeFileSync(installScript, buildWingetBatch(keys, engineDefs, winget), 'utf8');
  fs.writeFileSync(launcherScript, buildElevationLauncher(), 'utf8');
  const powershell = whereExecutable(['powershell.exe']) || 'powershell.exe';
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const cleanup = () => { try { fs.rmSync(temp, { recursive:true, force:true }); } catch {} };
    activeProcess = spawn(powershell, ['-NoProfile','-ExecutionPolicy','Bypass','-File',launcherScript], {
      windowsHide:true,
      env:{ ...process.env, UC_INSTALL_SCRIPT:installScript },
    });
    const consume = chunk => { output = (output + chunk.toString('utf8')).slice(-12000); };
    activeProcess.stdout.on('data', consume);
    activeProcess.stderr.on('data', consume);
    activeProcess.on('error', error => {
      if(settled)return; settled=true;
      activeProcess = null;
      cleanup();
      reject(error);
    });
    activeProcess.on('close', code => {
      if(settled)return; settled=true;
      activeProcess = null;
      let results='';
      try{results=fs.readFileSync(path.join(temp,'results.txt'),'utf8');}catch{}
      for(const line of results.trim().split(/\r?\n/).filter(Boolean)) {
        const [id,status,exitCode]=line.split('|');
        const label=Object.values(engineDefs).find(def=>def.winget===id)?.label||id;
        const description=({installed:'安装或更新成功',current:'当前软件源没有适用更新',failed:'操作失败'})[status]||status;
        emitInstall({type:status==='failed'?'error':'info',message:label+'：'+description+'（代码 '+exitCode+'）'});
      }
      cleanup();
      if (code === 0 && results.trim()) resolve();
      else if(code===1223)reject(new Error('已取消管理员授权，未开始安装'));
      else reject(new Error(output.trim() || '安装未全部成功，请查看各引擎的结果及管理员 CMD 错误信息'));
    });
  });
}

async function runWinget(keys) {
  const winget = await resolveWinget(process.env, undefined, message => emitInstall({type:'output', message:message+'\n'}));
  if (!winget) throw new Error('未能启动 winget。已检查 WindowsApps、PATH 和应用注册路径，请查看下方检测日志；这不一定代表未安装。');
  const names = keys.map(key => engineDefs[key]?.label).filter(Boolean).join('、');
  emitInstall({ type:'start', key:keys[0], message:`即将请求管理员权限，并在 CMD 中安装最新版：${names}` });
  try {
    await runElevatedWinget(keys, winget);
    for (const key of keys) emitInstall({ type:'success', key, message:`${engineDefs[key].label} 管理员安装流程已完成` });
  } catch (error) {
    emitInstall({ type:'error', key:keys[0], message:`管理员安装失败：${error.message}` });
    throw error;
  }
  return detectAllEngines();
}

function createWindow() {
  const screenshotPath = process.env.UC_SCREENSHOT;
  mainWindow = new BrowserWindow({
    width: 1240, height: 820, minWidth: 1060, minHeight: 700,
    show: !screenshotPath,
    backgroundColor: '#f4f8fc',
    title: '万能文件转换器',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.on('close',event=>{
    if(operations.current) {
      event.preventDefault();
      dialog.showMessageBox(mainWindow,{type:'info',message:'任务尚未结束',detail:operations.current==='install'?'请等待管理员安装窗口结束后再退出。':'请先停止转换，等待队列结束后再退出。'});
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.setWindowOpenHandler(() => ({ action:'deny' }));
  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const screenshotFiles = process.env.UC_SCREENSHOT_FILES;
      if (screenshotFiles) {
        try {
          const files = JSON.parse(screenshotFiles);
          await mainWindow.webContents.executeJavaScript(`addPaths(${JSON.stringify(files)})`);
        } catch (error) { console.error(`SCREENSHOT_FILES_ERROR ${error.message}`); }
      }
      setTimeout(async () => {
      try {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(screenshotPath, image.toPNG());
        console.log(`SCREENSHOT_OK ${screenshotPath}`);
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally { app.quit(); }
      }, 900);
    });
  }
}

app.whenReady().then(async () => {
  if (!process.env.UC_FUNCTIONAL_TEST) { createWindow(); return; }
  try {
    const config = JSON.parse(fs.readFileSync(process.env.UC_FUNCTIONAL_TEST, 'utf8'));
    const detected = detectAllEngines();
    const engines = Object.fromEntries(Object.entries(detected).map(([key,value]) => [key,value.executable]));
    for (const item of config.items) {
      const output = await convertItem(item, config.options, engines);
      if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error(`没有生成有效文件：${output}`);
      console.log(`FUNCTIONAL_OK ${item.name} -> ${output}`);
    }
    app.quit();
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
    app.quit();
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
process.on('uncaughtException', error => {
  try {
    const log = path.join(app.getPath('userData'), '运行错误.log');
    fs.appendFileSync(log, `${new Date().toISOString()}\n${error.stack || error}\n\n`, 'utf8');
    dialog.showErrorBox('万能文件转换器', `程序发生错误：${error.message}\n\n日志：${log}`);
  } catch {}
});

ipcMain.handle('choose-files', async () => (await dialog.showOpenDialog(mainWindow, { properties:['openFile','multiSelections'] })).filePaths);
ipcMain.handle('choose-folder', async () => (await dialog.showOpenDialog(mainWindow, { properties:['openDirectory'] })).filePaths);
ipcMain.handle('choose-output', async () => (await dialog.showOpenDialog(mainWindow, { properties:['openDirectory','createDirectory'] })).filePaths[0] || null);
ipcMain.handle('scan-paths', (_event, paths) => collectFiles(Array.isArray(paths) ? paths : []));
ipcMain.handle('detect-engines', () => detectAllEngines());
ipcMain.handle('choose-engine', async (_event, key) => {
  if(operations.current)throw new Error('请等待当前任务结束后再修改引擎路径');
  if (!engineDefs[key]) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties:['openFile'], filters:[{ name:'可执行文件', extensions:['exe'] },{ name:'所有文件',extensions:['*'] }] });
  const selected = result.filePaths[0];
  if (selected) { const settings = readSettings(); settings.engineOverrides ||= {}; settings.engineOverrides[key] = selected; writeSettings(settings); }
  return selected || null;
});
ipcMain.handle('install-engine', (_event, key) => operations.run('install',()=>engineDefs[key] ? runWinget([key]) : detectAllEngines()));
ipcMain.handle('install-common', () => operations.run('install',()=>runWinget(['ffmpeg','imagemagick','libreoffice'])));
ipcMain.handle('cancel-conversion', () => { if(operations.current!=='convert')return false; cancelRequested = true; if (activeProcess) activeProcess.kill(); return true; });
ipcMain.handle('result-action', async (_event,{output,action})=>{
  if(!completedOutputs.has(output) || !fs.existsSync(output))throw new Error('结果文件不存在或已移动');
  if(action==='reveal'){shell.showItemInFolder(output);return;}
  if(action==='open') {
    const error=await shell.openPath(output);
    if(error)throw new Error(error);
  }
});
ipcMain.handle('export-logs',async(_event,data)=>{
  const result=await dialog.showSaveDialog(mainWindow,{defaultPath:'转换器诊断日志.txt',filters:[{name:'文本日志',extensions:['txt']}]});
  if(result.canceled || !result.filePath)return false;
  const report={version:app.getVersion(),platform:process.platform,time:new Date().toISOString(),operation:operations.current,engines:detectAllEngines(),logs:data};
  await fs.promises.writeFile(result.filePath,JSON.stringify(report,null,2),'utf8');
  return true;
});
ipcMain.handle('open-folder', async (_event, folder) => shell.openPath(folder));
ipcMain.handle('start-conversion', async (_event, payload) => operations.run('convert',async()=>{
  cancelRequested = false;
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const options = payload?.options || {};
  const detected = detectAllEngines();
  const engines = Object.fromEntries(Object.entries(detected).map(([key,value]) => [key,value.executable]));
  let success = 0, failed = 0, skipped = 0;
  for (const item of items) {
    if (cancelRequested) { emitQueue({ type:'finished', id:item.id, status:'已取消', error:'用户取消' }); skipped++; continue; }
    emitQueue({ type:'started', id:item.id });
    try {
      const output = await convertItem(item, options, engines);
      completedOutputs.add(output);
      success++; emitQueue({ type:'finished', id:item.id, status:'已完成', output, progress:100 });
      emitQueue({ type:'log', level:'success', message:`转换完成：${item.name} → ${path.basename(output)}` });
    } catch (error) {
      if (error.skip) { skipped++; emitQueue({ type:'finished', id:item.id, status:'已跳过', error:error.message }); }
      else if (cancelRequested || error.message === '用户取消') { skipped++; emitQueue({ type:'finished', id:item.id, status:'已取消', error:'用户取消' }); }
      else { failed++; emitQueue({ type:'finished', id:item.id, status:'失败', error:error.message }); emitQueue({ type:'log', level:'error', message:`${item.name}：${error.message}` }); }
    }
  }
  emitQueue({ type:'complete', success, failed, skipped });
  return { success, failed, skipped };
}));
