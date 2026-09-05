const fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm'),assert=require('assert');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
const nativeRequire=require('module').createRequire(path.join(root,'main.js'));
async function test() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'converter-integration-'));
  try {
    const input=path.join(dir,'tone.wav');
    const generated=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.15',input]);
    assert.equal(generated.status,0,'FFmpeg fixture creation');
    const ctx={require:name=>name==='electron'?{
      app:{whenReady:()=>({then(){}}),on(){},getPath:()=>dir},
      ipcMain:{handle(){}},dialog:{},shell:{},BrowserWindow:{},
    }:nativeRequire(name),process:{platform:process.platform,env:process.env,on(){}},console,Buffer,setTimeout,URL,__dirname:root};
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(root,'main.js'),'utf8'),ctx);
    ctx.item={path:input,baseDir:dir,category:'audio',target:'mp3',name:'tone.wav'};
    ctx.options={conflict:'overwrite'};
    ctx.engines={ffmpeg:spawnSync(process.platform==='win32'?'where.exe':'which',['ffmpeg'],{encoding:'utf8'}).stdout.trim().split(/\r?\n/)[0]};
    const output=await vm.runInContext('convertItem(item,options,engines)',ctx);
    assert(fs.statSync(output).size>0);assert(fs.existsSync(input));
    const probe=spawnSync('ffprobe',['-v','error','-show_entries','stream=codec_name','-of','csv=p=0',output],{encoding:'utf8'});
    assert.equal(probe.status,0);assert(probe.stdout.includes('mp3'));
    console.log('PASS real WAV → MP3 through staged conversion and ffprobe verification');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test().catch(e=>{console.error(e);process.exitCode=1;});
