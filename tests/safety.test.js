const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path'),os=require('os');
const {safeOutput}=require('../safe-output');
const {OperationLock}=require('../operation-lock');
async function test() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'converter-safety-test-'));
  try {
    const target=path.join(dir,'中文 result.txt');
    fs.writeFileSync(target,'original');
    await assert.rejects(safeOutput(target,'overwrite',async out=>{fs.writeFileSync(out,'partial');throw Error('engine failed');}));
    assert.equal(fs.readFileSync(target,'utf8'),'original');
    await assert.rejects(safeOutput(target,'overwrite',async out=>fs.writeFileSync(out,'')));
    assert.equal(fs.readFileSync(target,'utf8'),'original');
    await assert.rejects(safeOutput(target,'overwrite',async out=>fs.writeFileSync(out,'complete'),()=>true));
    assert.equal(fs.readFileSync(target,'utf8'),'original');
    await assert.rejects(safeOutput(target,'skip',async out=>fs.writeFileSync(out,'new')),e=>e.skip);
    const renamed=await safeOutput(target,'rename',async out=>fs.writeFileSync(out,'new'));
    assert.notEqual(renamed,target);assert.equal(fs.readFileSync(target,'utf8'),'original');
    await safeOutput(target,'overwrite',async out=>fs.writeFileSync(out,'complete'));
    assert.equal(fs.readFileSync(target,'utf8'),'complete');
    const folder=await safeOutput(path.join(dir,'book.png'),'overwrite',async out=>{
      fs.writeFileSync(path.join(path.dirname(out),'page-001.png'),'one');
      fs.writeFileSync(path.join(path.dirname(out),'page-002.png'),'two');
    });
    assert(fs.statSync(folder).isDirectory());assert.equal(fs.readdirSync(folder).length,2);
    assert(!fs.readdirSync(dir).some(x=>x.startsWith('.converter-')));
    const lock=new OperationLock();let finish;
    const first=lock.run('install',()=>new Promise(resolve=>finish=resolve));
    await assert.rejects(lock.run('convert',async()=>{}));
    finish();await first;assert.equal(lock.current,null);
    await assert.rejects(lock.run('convert',async()=>{throw Error('failed');}));
    assert.equal(lock.current,null);
    console.log('PASS output preservation: engine failure, empty file, cancel, skip, rename, overwrite, multi-page; operation exclusion and unlock');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test().catch(e=>{console.error(e);process.exitCode=1;});
