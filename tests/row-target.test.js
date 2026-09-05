const vm=require('node:vm'),fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../renderer.js'),'utf8');
const pure=source.slice(0,source.indexOf('function formatSize'));
const apply=source.slice(source.indexOf('function applyTargetSelection'),source.indexOf('function refreshTargetOptions'));
const context={document:{querySelector:()=>({value:'auto'})},renderQueue(){},result:null};
vm.createContext(context);
vm.runInContext(pure+'\n'+apply+`
state.engines={ffmpeg:{available:true}};
state.items=[{category:'audio',ext:'wav',targetOverride:'flac',target:'flac',status:'已完成',output:'result.flac'},{category:'audio',ext:'mp3'}];
applyTargetSelection();
result=state.items;
`,context);
assert.equal(context.result[0].target,'flac');
assert.equal(context.result[0].status,'已完成');
assert.equal(context.result[0].output,'result.flac');
assert.equal(context.result[1].target,'m4a');
console.log('PASS per-row override and existing result survive queue additions');
