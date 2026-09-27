// Independent ZIP reader verifies names, CRCs, data, duplicate paths and UTF-8 flags.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), vm=require('node:vm');
const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../bilibili-transcript.user.js'),'utf8');
const names=['isValidBatchFolderName','batchFilename','buildBatchZip'];
const code=names.map(name=>source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`,'m'))[0]).join('\n');
const context=vm.createContext({TextEncoder,Blob,setTimeout});vm.runInContext(code,context);
(async()=>{
 const files=[{filename:'P9 中文😀.txt',content:'中文内容\n第二行 & < > 😀'},
   {filename:'P9 中文😀.txt',content:'duplicate'}, {filename:'../bad\\name.txt',content:'safe'},
   {filename:'empty.txt',content:''}, {filename:'ABC.txt',content:'upper'}, {filename:'abc.txt',content:'lower'}];
 for(const ext of ['txt','md','csv','xml','html','srt','vtt','ass','lrc','json'])files.push({filename:`格式.${ext}`,content:`${ext}\r\n原文`});
 context.files=files;
 const zip=await vm.runInContext("buildBatchZip('课程资料',files)",context);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-zip-test-'));
 const file=path.join(dir,'test.zip');
 try {
   fs.writeFileSync(file,Buffer.from(await zip.arrayBuffer()));
   execFileSync(process.env.PYTHON || 'python',['-c',[
     'import sys, zipfile',
     'with zipfile.ZipFile(sys.argv[1]) as z:',
     ' assert z.testzip() is None',
     ' names=z.namelist()',
     " assert len(names)==17 and names[0]=='课程资料/'",
     " assert all(n.startswith('课程资料/') for n in names)",
     " assert all('..' not in n.split('/') and '\\\\' not in n for n in names)",
     " assert z.read('课程资料/P9 中文😀.txt').decode('utf-8')=='中文内容\\n第二行 & < > 😀'",
     " assert z.read('课程资料/P9 中文😀 (2).txt')==b'duplicate'",
     " assert z.read('课程资料/empty.txt')==b''",
     " assert z.read('课程资料/abc (2).txt')==b'lower'",
     ' assert all(i.flag_bits & 0x800 for i in z.infolist())',
     " for ext in ['txt','md','csv','xml','html','srt','vtt','ass','lrc','json']:",
     "  assert z.read('课程资料/格式.'+ext).decode('utf-8')==ext+'\\r\\n原文'"
   ].join('\n'),file],{stdio:'pipe'});
 } finally {fs.unlinkSync(file);fs.rmdirSync(dir);}
 for(const folder of ['../bad','..','CON','bad/name','bad.']) {
   context.folder=folder;await assert.rejects(vm.runInContext('buildBatchZip(folder,files)',context));
 }
 console.log('PASS: Python zipfile reads all 17 entries; CRC32, UTF-8/Chinese/emoji, content bytes, duplicate names, empty files, path safety and 10 extensions.');
})().catch(error=>{console.error(error);process.exitCode=1;});
