const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../renderer.js'),'utf8');
const code=source.slice(source.indexOf("const startupDialog="),source.lastIndexOf('loadPreferences();'));
async function test(fail=false) {
  const els={};
  const storage=new Map();
  const $=id=>els[id] ||= {checked:true,open:true,addEventListener(){},close(){this.open=false;}};
  const ctx={$ ,localStorage:{setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    engineOrder:['ffmpeg','pandoc'],engineDescriptions:{ffmpeg:'音视频',pandoc:'文档'},
    state:{engines:{}},escapeHtml:String,log(){},navigate(){},
    detectEngines:async()=>{if(fail)throw Error('test failure');ctx.state.engines={ffmpeg:{available:true,label:'FFmpeg'},pandoc:{available:false,label:'Pandoc'}};}
  };
  vm.createContext(ctx);vm.runInContext(code,ctx);
  await vm.runInContext('runStartupCheck()',ctx);
  assert.equal($('#startupRetry').disabled,false);
  assert($('#startupSummary').textContent.includes(fail?'检测未完成':'检测完成'));
  if(!fail) {
    assert($('#startupResults').innerHTML.includes('✓ 已就绪'));
    assert($('#startupResults').innerHTML.includes('未找到'));
  }
  vm.runInContext('closeStartupCheck()',ctx);
  assert.equal(storage.has('startupCheckAcknowledged'),!fail);
}
(async()=>{await test();await test(true);console.log('PASS startup report, retry enabled, dismiss persistence and failure recovery');})().catch(e=>{console.error(e);process.exitCode=1;});
