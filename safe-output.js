const fs=require('fs');
const path=require('path');

async function safeOutput(destination, policy, produce, cancelled=()=>false) {
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const staging=fs.mkdtempSync(path.join(path.dirname(destination),'.converter-'));
  try {
    const staged=path.join(staging,path.basename(destination));
    await produce(staged);
    const names=fs.readdirSync(staging);
    if(!names.length)throw new Error('转换未生成文件');
    for(const name of names) {
      const stat=fs.lstatSync(path.join(staging,name));
      if(!stat.isFile() || stat.size===0)throw new Error('转换生成了空文件或异常输出');
    }
    if(cancelled())throw new Error('用户取消');
    const multiple=names.length!==1 || names[0]!==path.basename(destination);
    let target=multiple ? path.join(path.dirname(destination),path.parse(destination).name+'_pages') : destination;
    // Multi-output results never replace an existing directory.
    if(multiple || policy==='rename') {
      const original=target;
      for(let n=1;fs.existsSync(target);n++) {
        const parsed=path.parse(original);
        target=multiple ? original+' ('+n+')' : path.join(parsed.dir,parsed.name+' ('+n+')'+parsed.ext);
      }
    } else if(policy==='skip' && fs.existsSync(target)) {
      const error=new Error('目标文件已存在');error.skip=true;throw error;
    }
    if(multiple) {
      fs.renameSync(staging,target);
      return target;
    }
    if(policy==='overwrite') {
      // Same-filesystem rename replaces the target only after output is complete.
      fs.renameSync(staged,target);
    } else {
      // Exclusive publication: a newly appearing file must never be overwritten.
      fs.linkSync(staged,target);
    }
    return target;
  } finally {
    fs.rmSync(staging,{recursive:true,force:true});
  }
}
module.exports={safeOutput};
