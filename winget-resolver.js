const { execFile } = require('child_process');
const path = require('path').win32;

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide:true, encoding:'utf8', timeout:10000 }, (error, stdout, stderr) => {
      resolve({ ok:!error, stdout:stdout || '', error:error?.message || stderr || '' });
    });
  });
}

async function resolveWinget(env=process.env, execute=run, report=()=>{}) {
  const checked = new Set();
  async function probe(candidate) {
    if(!candidate || checked.has(candidate.toLowerCase()))return null;
    checked.add(candidate.toLowerCase());
    const result=await execute(candidate,['--version']);
    if(result.ok && /^v?\d+\.\d+/m.test(result.stdout.trim())) {
      report('已找到 winget：'+candidate+' · '+result.stdout.trim());
      return candidate;
    }
    report('winget 检测未通过：'+candidate+' · '+(result.error || '没有返回版本号'));
    return null;
  }
  const local=env.LOCALAPPDATA || (env.USERPROFILE && path.join(env.USERPROFILE,'AppData','Local'));
  const candidates=[local && path.join(local,'Microsoft','WindowsApps','winget.exe'),'winget.exe'];
  for(const candidate of candidates) { const found=await probe(candidate); if(found)return found; }
  const system=path.join(env.SystemRoot || 'C:\\Windows','System32');
  const where=await execute(path.join(system,'where.exe'),['winget.exe']);
  for(const candidate of where.stdout.split(/\r?\n/).map(v=>v.trim()).filter(Boolean)) {
    const found=await probe(candidate); if(found)return found;
  }
  const lookup=await execute(path.join(system,'WindowsPowerShell','v1.0','powershell.exe'),[
    '-NoProfile','-NonInteractive','-Command',
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Command winget.exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }; Get-AppxPackage Microsoft.DesktopAppInstaller | ForEach-Object { Join-Path $_.InstallLocation 'winget.exe' }",
  ]);
  for(const candidate of lookup.stdout.split(/\r?\n/).map(v=>v.trim()).filter(Boolean)) {
    const found=await probe(candidate); if(found)return found;
  }
  return null;
}

module.exports={resolveWinget};
