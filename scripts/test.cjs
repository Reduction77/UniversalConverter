const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const integration=process.argv.includes('--integration');
const names=fs.readdirSync(path.join(root,'tests')).filter(name=>name.endsWith('.js') && (integration ? name==='conversion-integration.test.js' : name!=='conversion-integration.test.js')).sort();
for(const name of names) {
  const result=spawnSync(process.execPath,[path.join(root,'tests',name)],{stdio:'inherit',cwd:root});
  if(result.error)console.error(result.error);
  if(result.status!==0)process.exit(result.status||1);
}
console.log('All selected tests passed.');
