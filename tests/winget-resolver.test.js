const assert=require('node:assert/strict');
const {resolveWinget}=require('../winget-resolver');
async function test() {
  const env={LOCALAPPDATA:'C:\\Users\\测试 User\\AppData\\Local',SystemRoot:'C:\\Windows'};
  const alias=env.LOCALAPPDATA+'\\Microsoft\\WindowsApps\\winget.exe';
  const fail={ok:false,stdout:'',error:'ENOENT'};
  assert.equal(await resolveWinget(env,async(file)=>file===alias?{ok:true,stdout:'v1.29.250'}:fail),alias);
  assert.equal(await resolveWinget(env,async(file)=>file==='winget.exe'?{ok:true,stdout:'v1.29.250'}:fail),'winget.exe');
  const registered='C:\\Program Files\\WindowsApps\\AppInstaller\\winget.exe';
  assert.equal(await resolveWinget(env,async(file)=>{
    if(file.endsWith('powershell.exe'))return {ok:true,stdout:registered};
    if(file===registered)return {ok:true,stdout:'v1.29.250'};
    return fail;
  }),registered);
  assert.equal(await resolveWinget(env,async()=>fail),null);
  assert.equal(await resolveWinget(env,async()=>({ok:true,stdout:'not a version'})),null);
  console.log('PASS: alias without stat, stale PATH, registered path, missing and invalid executable');
}
test().catch(error=>{console.error(error);process.exitCode=1;});
