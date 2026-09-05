import {packager} from '@electron/packager';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const root=fileURLToPath(new URL('../',import.meta.url));
const outputs=await packager({
  dir:root,name:'万能文件转换器',platform:'win32',arch:'x64',
  out:path.join(root,'dist'),overwrite:true,asar:true,prune:true,
  icon:path.join(root,'assets','icon.ico'),
  win32metadata:{CompanyName:'ZhuZhuBaiBai',FileDescription:'万能文件转换器'},
  ignore:[/^\/(dist|release|tests|docs|scripts|\.git|\.github)(\/|$)/,/^\/\.(gitignore|gitattributes)$/,/^\/(README\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md)$/],
});
for(const output of outputs) {
  await fs.mkdir(path.join(output,'tools'),{recursive:true});
  await fs.copyFile(path.join(root,'tools','README.txt'),path.join(output,'tools','README.txt'));
  await fs.copyFile(path.join(root,'docs','使用说明.txt'),path.join(output,'使用说明.txt'));
  // Keep application and Electron licenses separately in the portable distribution.
  await fs.copyFile(path.join(root,'LICENSE'),path.join(output,'LICENSE.application.txt'));
  console.log('Windows portable directory:',output);
}
