class OperationLock {
  current=null;
  async run(kind,task) {
    if(this.current)throw new Error('当前正在'+(this.current==='install'?'安装引擎':'转换文件')+'，请等待完成');
    this.current=kind;
    try{return await task();}finally{this.current=null;}
  }
}
module.exports={OperationLock};
