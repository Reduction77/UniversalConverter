const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const categoryLabels = { video:'视频', audio:'音频', image:'图片', document:'文档', markup:'文本 / 标记', ebook:'电子书', archive:'压缩包', pdf:'PDF', unknown:'未知' };
const targets = {
  video:['mp4','mkv','mov','webm','avi','mp3','flac','wav'], audio:['mp3','flac','wav','m4a','ogg','opus'],
  image:['jpg','png','webp','avif','tiff','bmp','pdf'], markup:['pdf','docx','html','txt','md','epub'],
  ebook:['epub','mobi','azw3','pdf'], archive:['zip','7z'], pdf:['png','jpg','tiff'], unknown:[],
};
const smartPreferences = {
  video:['mp4','mkv','mov','webm'], audio:['mp3','m4a','wav','flac'], image:['jpg','png','webp'],
  document:['pdf','docx','xlsx','pptx'], markup:['pdf','docx','html','txt','epub'],
  ebook:['epub','pdf','mobi','azw3'], archive:['zip','7z'], pdf:['png','jpg','tiff'], unknown:[],
};
const engineDescriptions = {
  ffmpeg:'视频和音频转换，支持 NVIDIA NVENC', imagemagick:'JPG、PNG、HEIC、WebP、AVIF 和 PDF 页面',
  libreoffice:'Word、Excel、PPT 与 PDF/OpenDocument', pandoc:'Markdown、HTML、LaTeX、DOCX 与 EPUB',
  calibre:'EPUB、MOBI、AZW3 等电子书', '7zip':'ZIP、7Z、RAR、TAR 等压缩格式', ghostscript:'ImageMagick 处理 PDF 时使用的辅助引擎',
};
const engineOrder = ['ffmpeg','imagemagick','libreoffice','pandoc','calibre','7zip','ghostscript'];
const state = { items:[], engines:{}, logs:[], running:false, installing:false, activeIds:new Set(), finishedIds:new Set(), lastOutput:null };

function validTargets(item) {
  if (item.category !== 'document') return targets[item.category] || [];
  if (['doc','docx','odt','rtf'].includes(item.ext)) return ['pdf','docx','odt','rtf','html','txt'];
  if (['xls','xlsx','ods'].includes(item.ext)) return ['pdf','xlsx','ods','csv','html'];
  if (['ppt','pptx','odp'].includes(item.ext)) return ['pdf','pptx','odp'];
  return ['pdf'];
}

function requiredEngine(item) {
  if (['video','audio'].includes(item.category)) return 'ffmpeg';
  if (['image','pdf'].includes(item.category)) return 'imagemagick';
  if (item.category === 'document') return 'libreoffice';
  if (item.category === 'markup') return 'pandoc';
  if (item.category === 'ebook') return 'calibre';
  if (item.category === 'archive') return '7zip';
  return null;
}

function missingEngine(item) {
  const primary=requiredEngine(item);
  if(primary&&!state.engines[primary]?.available)return primary;
  if(item.category==='markup'&&item.target==='pdf'&&!state.engines.libreoffice?.available)return 'libreoffice';
  return null;
}

function normalizeFormat(format) {
  return ({ jpeg:'jpg', tif:'tiff', htm:'html', markdown:'md', azw:'azw3' })[format] || format;
}

function smartTarget(item) {
  const source = normalizeFormat(item.ext);
  const supported = validTargets(item);
  const preferences = smartPreferences[item.category] || [];
  return preferences.find(target => supported.includes(target) && normalizeFormat(target) !== source)
    || supported.find(target => normalizeFormat(target) !== source)
    || null;
}

function formatSize(bytes) {
  let value = bytes; const units = ['B','KB','MB','GB','TB']; let i=0;
  while (value >= 1024 && i < units.length-1) { value/=1024; i++; }
  return i === 0 ? `${value} B` : `${value.toFixed(1)} ${units[i]}`;
}

function baseName(filePath) { return filePath.split(/[\\/]/).pop() || filePath; }
function stem(filePath) { const name=baseName(filePath); const i=name.lastIndexOf('.'); return i>0 ? name.slice(0,i) : name; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }

function loadPreferences() {
  const pref = JSON.parse(localStorage.getItem('preferences') || '{}');
  const ids = ['outputMode','conflictSelect','videoQuality'];
  for (const id of ids) if (pref[id] && $(`#${id}`).querySelector(`option[value="${pref[id]}"]`)) $(`#${id}`).value=pref[id];
  for (const id of ['preserveStructure','hardwareAcceleration','keepMetadata','autoOpenOutput']) if (typeof pref[id] === 'boolean') $(`#${id}`).checked=pref[id];
  if (pref.outputPath) $('#outputPath').value=pref.outputPath;
  updateOutputControls();
}

function savePreferences() {
  const pref = {};
  for (const id of ['outputMode','conflictSelect','videoQuality','outputPath']) pref[id]=$(`#${id}`).value;
  for (const id of ['preserveStructure','hardwareAcceleration','keepMetadata','autoOpenOutput']) pref[id]=$(`#${id}`).checked;
  localStorage.setItem('preferences',JSON.stringify(pref));
}

function navigate(page) {
  $$('.nav').forEach(button => button.classList.toggle('active',button.dataset.page===page));
  $$('.page').forEach(section => section.classList.toggle('active',section.id===`page-${page}`));
}

function toast(message, type='') {
  const el=$('#toast'); el.textContent=message; el.className=`toast ${type}`; clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>el.classList.add('hidden'),3200);
}

function modal(title,message) { $('#modalTitle').textContent=title; $('#modalMessage').textContent=message; $('#modal').classList.remove('hidden'); }

function log(level,message) {
  state.logs.push({time:new Date().toLocaleTimeString('zh-CN',{hour12:false}),level,message:String(message).trim()});
  if (state.logs.length>1000) state.logs.shift();
  renderLogs();
}

function renderLogs() {
  const filter=$('#logFilter').value; const labels={success:'SUCCESS',info:'INFO   ',error:'ERROR  ',debug:'DEBUG  '};
  $('#logView').textContent=state.logs.filter(v=>filter==='all'||v.level===filter).map(v=>`[${v.time}] [${labels[v.level]||v.level.toUpperCase()}] ${v.message}`).join('\n');
  $('#logView').scrollTop=$('#logView').scrollHeight;
  $('#logToggle').textContent=`${$('#logPanel').classList.contains('hidden')?'运行日志':'收起日志'}${state.logs.length?` · ${state.logs.length}`:''}`;
}

function applyTargetSelection(resetStatus=true) {
  const selected=$('#targetSelect').value;
  for (const item of state.items) {
    const chosen=item.targetOverride || (selected==='auto'?smartTarget(item):selected);
    const changed=item.target!==chosen;
    item.target=validTargets(item).includes(chosen)?chosen:null;
    if(changed)item.output=null;
    const missing=item.target?missingEngine(item):null;
    item.enabled=Boolean(item.target&&!missing);
    if (resetStatus && (changed || !item.status || ['等待中','缺少引擎','不支持'].includes(item.status))) {
      item.progress=0; item.error='';
      if (!item.target) item.status='不支持';
      else if (missing) item.status='缺少引擎';
      else item.status='等待中';
    }
  }
  renderQueue();
}

function refreshTargetOptions() {
  const current=$('#targetSelect').value;
  const union=new Set(state.items.flatMap(validTargets));
  const priority=['mp4','mp3','jpg','png','pdf','docx','xlsx','pptx','webp','mkv','mov','flac','wav','html','txt','epub','mobi','azw3','zip','7z'];
  const ordered=[...union].sort((a,b)=>{const ai=priority.indexOf(a),bi=priority.indexOf(b); return (ai<0?999:ai)-(bi<0?999:bi)||a.localeCompare(b)});
  $('#targetSelect').innerHTML='<option value="auto">智能推荐</option>'+ordered.map(v=>`<option value="${v}">${v.toUpperCase()}</option>`).join('');
  if ([...$('#targetSelect').options].some(v=>v.value===current)) $('#targetSelect').value=current;
}

function outputPreview(item) { return item.target?`${stem(item.name)}.${item.target}`:'—'; }

function renderQueue() {
  $('#queueCount').textContent=`转换队列 · ${state.items.length} 个文件`;
  if (!state.items.length) $('#queueBody').innerHTML='<tr class="empty-row"><td colspan="9">暂时没有文件</td></tr>';
  else $('#queueBody').innerHTML=state.items.map((item,index)=>{
    const statusClass=item.status==='已完成'?'success':item.status==='失败'?'error':['缺少引擎','不支持'].includes(item.status)?'warn':item.status==='转换中'?'active':'';
    const output=item.output?baseName(item.output):outputPreview(item);
    const statusContent=item.status==='缺少引擎'
      ? `<button class="status-link" data-engine="${escapeHtml(missingEngine(item)||'')}" title="前往安装所需转换引擎">缺少引擎 →</button>`
      : escapeHtml(item.status||'等待中');
    return `<tr data-id="${item.id}" class="${item.selected?'selected':''}">
      <td class="check-col"><input class="row-check" type="checkbox" ${item.selected?'checked':''}></td>
      <td class="index-col">${index+1}</td>
      <td class="file-name-cell" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</td>
      <td>${categoryLabels[item.category]} · ${formatSize(item.size)}</td><td><select class="row-target" aria-label="此文件的目标格式" ${state.running?'disabled':''}><option value="">跟随批量设置</option>${validTargets(item).map(target=>`<option value="${target}" ${item.targetOverride===target?'selected':''}>${target.toUpperCase()}</option>`).join('')}</select><small class="target-hint">→ ${item.target?item.target.toUpperCase():'不适用'}</small></td>
      <td class="output-name-cell" title="${escapeHtml(item.output||output)}">${escapeHtml(output)}</td><td class="status ${statusClass}" title="${escapeHtml(item.error||'')}">${statusContent}</td>
      <td><div class="row-progress"><i style="width:${item.progress||0}%"></i></div></td>
      <td class="result-actions">${item.status==='已完成'&&item.output?'<button class="button result-action" data-action="open">打开</button> <button class="button result-action" data-action="reveal">定位</button>':item.status==='失败'?'<button class="button failure-detail">查看原因</button>':'—'}</td></tr>`;
  }).join('');
  $$('.row-check').forEach(box=>box.addEventListener('change',event=>{const item=state.items.find(v=>v.id===event.target.closest('tr').dataset.id); item.selected=event.target.checked; renderQueue();}));
  $$('.status-link').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();goToEngine(button.dataset.engine);}));
  $$('.row-target').forEach(select=>select.addEventListener('change',event=>{
    const item=state.items.find(v=>v.id===event.target.closest('tr').dataset.id);
    item.targetOverride=event.target.value||null;applyTargetSelection();
  }));
  $$('.result-action').forEach(button=>button.addEventListener('click',async()=>{
    const item=state.items.find(v=>v.id===button.closest('tr').dataset.id);
    try{await window.converterAPI.resultAction(item.output,button.dataset.action);}catch(error){modal('无法打开结果',error.message);}
  }));
  $$('.failure-detail').forEach(button=>button.addEventListener('click',()=>{
    const item=state.items.find(v=>v.id===button.closest('tr').dataset.id);
    modal('转换失败 · '+item.name,item.error||'未记录详细错误，请导出诊断日志。');
  }));
  $('#startButton').disabled=state.running||state.installing||!state.items.some(v=>v.enabled);
  $('#retryFailed').disabled=state.running||state.installing||!state.items.some(v=>v.status==='失败');
  $('#selectAll').checked=Boolean(state.items.length)&&state.items.every(v=>v.selected);
}

function goToEngine(key) {
  navigate('engines');
  requestAnimationFrame(()=>{
    const card=document.querySelector(`.engine-card[data-engine="${key}"]`);
    if(!card)return;
    card.scrollIntoView({behavior:'smooth',block:'center'});
    card.classList.add('engine-focus');
    setTimeout(()=>card.classList.remove('engine-focus'),1800);
  });
}

async function addPaths(paths) {
  if (!paths?.length||state.running) return;
  const scanned=await window.converterAPI.scanPaths(paths); const existing=new Set(state.items.map(v=>v.path.toLowerCase())); let added=0,unknown=0;
  for (const file of scanned) if (!existing.has(file.path.toLowerCase())) {
    file.id=crypto.randomUUID(); file.selected=false; file.status='等待中'; file.progress=0; file.error=''; file.output=null;
    state.items.push(file); existing.add(file.path.toLowerCase()); added++; if(file.category==='unknown') unknown++;
  }
  refreshTargetOptions(); applyTargetSelection();
  if (added) { log('info',`已添加 ${added} 个文件${unknown?`，其中 ${unknown} 个暂不支持`:''}`); toast(`已添加 ${added} 个文件`,'success'); }
}

async function detectEngines(showToast=false) {
  state.engines=await window.converterAPI.detectEngines(); renderEngines();
  for (const item of state.items) {
    if(!item.target)continue;
    const missing=missingEngine(item);
    item.enabled=!missing;
    if(['等待中','缺少引擎','不支持'].includes(item.status))item.status=missing?'缺少引擎':'等待中';
  }
  renderQueue(); if(showToast) toast('引擎检测完成','success');
}

function renderEngines() {
  const available=Object.values(state.engines).filter(v=>v.available).length;
  $('#engineCount').textContent=`已就绪 ${available} / ${engineOrder.length}`;
  $('#sidebarEngineStatus').textContent=`转换引擎　${available}/${engineOrder.length} 可用`;
  $('#engineList').innerHTML=engineOrder.map(key=>{const engine=state.engines[key]||{label:key,available:false,executable:null};return `<div class="engine-card" data-engine="${key}">
    <div class="engine-info"><div class="engine-name">${escapeHtml(engine.label)}</div><div class="engine-desc">${escapeHtml(engineDescriptions[key])}</div><div class="engine-path" title="${escapeHtml(engine.executable||'')}">${escapeHtml(engine.executable||'尚未检测到，可直接安装或手动指定路径')}</div></div>
    <span class="pill ${engine.available?'ready':'missing'}">${engine.available?'已就绪':'未找到'}</span>
    <div class="engine-buttons">${!engine.available?`<button class="button engine-install" data-key="${key}">管理员安装</button>`:''}<button class="button engine-choose" data-key="${key}">指定路径</button></div></div>`}).join('');
  $$('.engine-install').forEach(button=>button.addEventListener('click',()=>installEngines(button.dataset.key)));
  $$('.engine-choose').forEach(button=>button.addEventListener('click',async()=>{if(await window.converterAPI.chooseEngine(button.dataset.key)) await detectEngines(true);}));
  $$('.engine-install,.engine-choose').forEach(button=>button.disabled=state.running||state.installing);
}

function setInstallState(active) {
  state.installing=active; $('#installCommon').disabled=active||state.running; $('#refreshEngines').disabled=active||state.running;
  $('#installCommon').textContent=active?'等待管理员安装…':'管理员安装常用引擎';
  $$('.engine-install,.engine-choose').forEach(v=>v.disabled=active||state.running);
  $$('.engine-install').forEach(v=>v.textContent=active?'安装中…':'管理员安装');
  renderQueue();
}

async function installEngines(key=null) {
  if(state.installing||state.running)return; setInstallState(true); navigate('engines'); $('#installLog').textContent='';
  const requested=key?[key]:['ffmpeg','imagemagick','libreoffice'];
  try {
    state.engines=key?await window.converterAPI.installEngine(key):await window.converterAPI.installCommon();
    renderEngines();
    const missing=requested.filter(engineKey=>!state.engines[engineKey]?.available);
    if(missing.length) {
      const names=missing.map(engineKey=>state.engines[engineKey]?.label||engineKey).join('、');
      modal('安装完成，但仍未检测到引擎',`未检测到：${names}。请查看管理员 CMD 或运行日志中的提示，也可以使用“指定路径”。`);
      toast('部分引擎仍未检测到','error');
    } else toast('安装检查完成，引擎已就绪','success');
  }
  catch(error){ $('#installLog').textContent+=`\n[ERROR] ${error.message}`; toast(error.message,'error'); }
  finally { setInstallState(false); await detectEngines(); }
}

function optionsPayload() { return { outputMode:$('#outputMode').value,outputRoot:$('#outputPath').value,preserveStructure:$('#preserveStructure').checked,conflict:$('#conflictSelect').value,hardwareAcceleration:$('#hardwareAcceleration').checked,videoQuality:$('#videoQuality').value,keepMetadata:$('#keepMetadata').checked }; }

async function startConversion(onlyFailed=false) {
  if(state.running||state.installing)return;
  if($('#outputMode').value==='custom'&&!$('#outputPath').value){modal('请选择保存位置','当前选择了“自定义文件夹”，请先选择一个输出文件夹。');return;}
  const runnable=state.items.filter(item=>item.enabled&&(!onlyFailed||item.status==='失败'));
  if(!runnable.length){
    if(state.items.some(item=>item.target&&missingEngine(item)))modal('请先安装转换引擎','队列中有文件缺少所需引擎。点击“缺少引擎 →”即可前往安装。');
    else modal('没有可转换文件','当前队列里没有符合条件的文件。');
    return;
  }
  savePreferences(); state.running=true; state.activeIds=new Set(runnable.map(v=>v.id)); state.finishedIds.clear();
  runnable.forEach(item=>{item.status='等待中';item.progress=0;item.error='';item.output=null;}); setRunningUi(true); renderQueue(); log('info',`开始转换 ${runnable.length} 个文件`);
  try { await window.converterAPI.startConversion({items:runnable,options:optionsPayload()}); }
  catch(error){log('error',`队列异常：${error.message}`);modal('转换异常',error.message);state.running=false;setRunningUi(false);}
}

function setRunningUi(running) {
  state.running=running; $('#cancelButton').disabled=!running;
  $('#installCommon').disabled=running||state.installing;
  $('#refreshEngines').disabled=running||state.installing;
  $$('.engine-install,.engine-choose').forEach(button=>button.disabled=running||state.installing);
  ['chooseFiles','chooseFolder','targetSelect','outputMode','outputPath','chooseOutput','conflictSelect','preserveStructure','hardwareAcceleration','videoQuality','clearQueue','removeSelected'].forEach(id=>$('#'+id).disabled=running);
  renderQueue();
}

function updateOverall(activeProgress=0) {
  const total=Math.max(1,state.activeIds.size); const value=Math.min(100,Math.round((state.finishedIds.size+activeProgress/100)/total*100)); $('#overallBar').style.width=`${value}%`;
}

function updateOutputControls() {
  const custom=$('#outputMode').value==='custom'; $('#outputPath').classList.toggle('hidden',!custom); $('#chooseOutput').classList.toggle('hidden',!custom);
}

window.converterAPI.onQueueEvent(event=>{
  if(event.type==='log'){log(event.level,event.message);return;}
  const item=state.items.find(v=>v.id===event.id);
  if(event.type==='started'&&item){item.status='转换中';item.progress=1;renderQueue();}
  if(event.type==='progress'&&item){item.progress=event.progress;updateOverall(event.progress);renderQueue();}
  if(event.type==='finished'&&item){item.status=event.status;item.error=event.error||'';item.output=event.output||item.output;item.progress=event.progress||0;state.finishedIds.add(item.id);if(item.output)state.lastOutput=item.output;updateOverall();renderQueue();}
  if(event.type==='complete'){
    state.running=false;setRunningUi(false);updateOverall();const title=event.failed?'转换完成，但有失败项':'转换完成';
    modal(title,`成功 ${event.success} 个，失败 ${event.failed} 个，跳过 ${event.skipped} 个。${event.failed?'\n可打开运行日志查看原因。':''}`);
    log(event.failed?'error':'success',`任务结束：成功 ${event.success}，失败 ${event.failed}，跳过 ${event.skipped}`);
    if(state.lastOutput){$('#openLastOutput').classList.remove('hidden');if($('#autoOpenOutput').checked)window.converterAPI.openFolder(state.lastOutput.replace(/[\\/][^\\/]+$/,''));}
  }
});

window.converterAPI.onInstallEvent(event=>{
  const time=new Date().toLocaleTimeString('zh-CN',{hour12:false});
  $('#installLog').textContent+=`[${time}] ${event.message}`+(event.type==='output'?'':'\n'); $('#installLog').scrollTop=$('#installLog').scrollHeight;
});

$$('.nav').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.page)));
$('#sidebarEngineStatus').addEventListener('click',()=>navigate('engines'));
$('#chooseFiles').addEventListener('click',async()=>addPaths(await window.converterAPI.chooseFiles()));
$('#chooseFolder').addEventListener('click',async()=>addPaths(await window.converterAPI.chooseFolder()));
$('#chooseOutput').addEventListener('click',async()=>{const result=await window.converterAPI.chooseOutput();if(result){$('#outputPath').value=result;savePreferences();}});
$('#outputMode').addEventListener('change',()=>{updateOutputControls();savePreferences();});
$('#targetSelect').addEventListener('change',()=>applyTargetSelection());
$('#clearQueue').addEventListener('click',()=>{if(state.running)return;state.items=[];refreshTargetOptions();renderQueue();$('#overallBar').style.width='0';});
$('#removeSelected').addEventListener('click',()=>{if(state.running)return;state.items=state.items.filter(v=>!v.selected);refreshTargetOptions();applyTargetSelection();});
$('#selectAll').addEventListener('change',event=>{state.items.forEach(v=>v.selected=event.target.checked);renderQueue();});
$('#startButton').addEventListener('click',()=>startConversion(false));
$('#retryFailed').addEventListener('click',()=>startConversion(true));
$('#cancelButton').addEventListener('click',async()=>{await window.converterAPI.cancelConversion();$('#cancelButton').disabled=true;log('info','正在停止转换……');});
$('#logToggle').addEventListener('click',()=>{$('#logPanel').classList.toggle('hidden');renderLogs();});
$('#logFilter').addEventListener('change',renderLogs);
$('#clearLogs').addEventListener('click',()=>{state.logs=[];renderLogs();});
async function exportDiagnosticLogs() {
  try {
    const saved=await window.converterAPI.exportLogs({queue:state.logs,installation:$('#installLog').textContent});
    if(saved)toast('诊断日志已保存','success');
  } catch(error){modal('日志导出失败',error.message);}
}
$('#exportLogs').addEventListener('click',exportDiagnosticLogs);
$('#exportInstallLogs').addEventListener('click',exportDiagnosticLogs);
$('#modalClose').addEventListener('click',()=>$('#modal').classList.add('hidden'));
$('#refreshEngines').addEventListener('click',()=>detectEngines(true));
$('#installCommon').addEventListener('click',()=>installEngines());
$('#openLastOutput').addEventListener('click',()=>{if(state.lastOutput)window.converterAPI.openFolder(state.lastOutput.replace(/[\\/][^\\/]+$/,''));});
for(const id of ['conflictSelect','videoQuality','preserveStructure','hardwareAcceleration','keepMetadata','autoOpenOutput'])$(`#${id}`).addEventListener('change',savePreferences);

const dropZone=$('#dropZone');
let dragDepth=0;
function isFileDrag(event) { return [...(event.dataTransfer?.types || [])].includes('Files'); }
function clearDragState() { dragDepth=0; dropZone.classList.remove('dragging'); }

document.addEventListener('dragenter',event=>{
  if(!isFileDrag(event))return;
  event.preventDefault(); event.stopPropagation(); dragDepth++; dropZone.classList.add('dragging');
},true);
document.addEventListener('dragover',event=>{
  if(!isFileDrag(event))return;
  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect='copy'; dropZone.classList.add('dragging');
},true);
document.addEventListener('dragleave',event=>{
  if(!isFileDrag(event))return;
  event.preventDefault(); event.stopPropagation(); dragDepth=Math.max(0,dragDepth-1); if(!dragDepth)dropZone.classList.remove('dragging');
},true);
document.addEventListener('drop',event=>{
  if(!isFileDrag(event))return;
  event.preventDefault(); event.stopPropagation(); clearDragState();
  const paths=[];
  for(const file of event.dataTransfer.files){
    try { const filePath=window.converterAPI.getPathForFile(file); if(filePath)paths.push(filePath); }
    catch(error) { log('error',`读取拖入文件失败：${error.message}`); }
  }
  if(paths.length)addPaths(paths); else toast('没有读取到文件路径，请用“选择文件”重试','error');
},true);
window.addEventListener('blur',clearDragState);

const startupDialog=$('#startupCheck');
let startupBusy=false;
let startupSucceeded=false;
function renderStartupResults(pending=false,failed=false) {
  $('#startupResults').innerHTML=engineOrder.map(key=>{
    const engine=state.engines[key];
    const available=Boolean(engine?.available);
    const label=engine?.label||({ffmpeg:'FFmpeg',imagemagick:'ImageMagick',libreoffice:'LibreOffice',pandoc:'Pandoc',calibre:'Calibre','7zip':'7-Zip',ghostscript:'Ghostscript'})[key];
    return `<div class="startup-row"><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(engineDescriptions[key])}</small></div><span class="pill ${pending||failed?'':available?'ready':'missing'}" title="${escapeHtml(engine?.executable||'')}">${pending?'检测中…':failed?'未完成':available?'✓ 已就绪':'未找到'}</span></div>`;
  }).join('');
}
async function runStartupCheck() {
  if(startupBusy)return;
  startupBusy=true;startupSucceeded=false;
  $('#startupRetry').disabled=true;$('#startupManage').disabled=true;
  $('#startupSummary').textContent='正在检测转换引擎，请稍候…';
  renderStartupResults(true);
  try {
    await detectEngines();
    startupSucceeded=true;
    const ready=engineOrder.filter(key=>state.engines[key]?.available).length;
    $('#startupSummary').textContent=ready===engineOrder.length
      ?'✓ 全部 7 个转换引擎已就绪，可以开始使用。'
      :`检测完成：${ready} / 7 个已就绪，${7-ready} 个未找到。可按需要安装，不必全部安装。`;
    renderStartupResults();
    $('#startupSkip').textContent='开始使用';
    $('#startupManage').disabled=false;
    // User may dismiss while the asynchronous scan is still running.
    if(!startupDialog.open && $('#startupRemember').checked)localStorage.setItem('startupCheckAcknowledged','1');
  } catch(error) {
    $('#startupSummary').textContent='检测未完成：'+error.message+'。可重新检测或前往引擎页面手动指定路径。';
    renderStartupResults(false,true);
    $('#startupManage').disabled=false;
    log('error','启动检测失败：'+error.message);
  } finally {
    startupBusy=false;$('#startupRetry').disabled=false;
  }
}
function closeStartupCheck(manage=false) {
  if(startupSucceeded && $('#startupRemember').checked)localStorage.setItem('startupCheckAcknowledged','1');
  else localStorage.removeItem('startupCheckAcknowledged');
  startupDialog.close();
  if(manage)navigate('engines');
}
$('#startupRetry').addEventListener('click',runStartupCheck);
$('#startupSkip').addEventListener('click',()=>closeStartupCheck());
$('#startupManage').addEventListener('click',()=>closeStartupCheck(true));
startupDialog.addEventListener('cancel',event=>{event.preventDefault();closeStartupCheck();});

loadPreferences(); renderQueue(); renderLogs(); log('info','万能文件转换器已启动');
if(localStorage.getItem('startupCheckAcknowledged')!=='1') {
  startupDialog.showModal();
  runStartupCheck();
} else detectEngines().catch(error=>{log('error',error.message);toast('引擎检测失败，可在转换引擎页重新检测','error');});
