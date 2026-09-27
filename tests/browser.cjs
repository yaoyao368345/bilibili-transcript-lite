// Run: node tests/browser.cjs (install Playwright or set PLAYWRIGHT_MODULE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../bilibili-transcript.user.js'), 'utf8');
const exposed = source.replace(/\}\)\(\);\s*$/, `window.testAPI = { state, ui, createModal, renderSubtitles, searchSubtitles, loadSubtitles,
  showSettingsModal, showDownloadConfirm, showBatchDownloadModal, removeModal, resolveVideo, getCurrentVideoInfo,
  convertToTXT, convertToSRT, convertToVTT, convertToCSV, convertToXML, convertToJSON, convertToASS, convertToLRC,
  convertToMD, convertToHTML, StorageManager, subtitleCache, CONFIG, downloadVideoSubtitle, saveSubtitleToDirectory };
})();`);

(async () => {
 const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'msedge' });
 try {
 const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.route('**/*', route => route.request().isNavigationRequest()
   ? route.fulfill({contentType:'text/html', body:'<h1 class="video-title">课程标题</h1><video></video>'}) : route.abort());
 await page.goto('https://www.bilibili.com/video/BV1owrpYKEtP/?p=9');
 await page.evaluate(() => {
   window.docListeners = 0;
   window.rowListenerCounts = new WeakMap();
   const add = EventTarget.prototype.addEventListener;
   EventTarget.prototype.addEventListener = function (type, ...args) {
     if (this === document && type === 'click') window.docListeners++;
     if (type === 'click') window.rowListenerCounts.set(this, (window.rowListenerCounts.get(this) || 0) + 1);
     return add.call(this, type, ...args);
   };
   window.plays = 0;
   document.querySelector('video').play = () => { window.plays++; return Promise.resolve(); };
   window.GM_setClipboard = value => { window.clipboard = value; };
   window.requestURLs = [];
   window.requestDelay = 0;
   window.GM_xmlhttpRequest = options => {
     window.requestURLs.push(options.url);
     const url = new URL(options.url);
     let data;
     const pages = Array.from({length: 10}, (_, i) => ({page:i+1, cid:String(100+i), part:`第${i+1}课`,duration:1000}));
     pages[8].cid='27694665372'; pages[9].cid='27694665583';
     if(window.singlePage)pages.splice(1);
     if (url.pathname.includes('/view')) data={code:0,data:{bvid:'BV1owrpYKEtP',title:'课程标题',pages}};
     else if (url.pathname.includes('pagelist')) data={code:0,data:pages};
     else if (url.pathname.includes('/v2')) data={code:0,data:{subtitle:{subtitles:[
       {id:'zh',lan_doc:'中文',subtitle_url:`https://aisubtitle.hdslb.com/${url.searchParams.get('cid')}/zh`},
       {id:'en',lan_doc:'English',subtitle_url:`https://aisubtitle.hdslb.com/${url.searchParams.get('cid')}/en`}
     ]}}};
     else data={body:Array.from({length:500}, (_,i)=>({from:i*2,to:i*2+2,content:`${url.pathname} 第${i}条 ${i%10===0?'python':'字幕'} <b>literal</b>`}))};
     if(window.noSubtitles && url.pathname.includes('/v2'))data={code:0,data:{subtitle:{subtitles:[]}}};
     if(window.apiFailure && url.pathname.includes('/view'))data={code:-101,message:'login required'};
     setTimeout(()=>options.onload({responseText:JSON.stringify(data)}),window.requestDelay);
   };
 });
 await page.addScriptTag({content:exposed});
 await page.click('#bili-transcript-btn');
 await page.waitForSelector('.subtitle-item');
 assert.equal(await page.evaluate(()=>testAPI.state.currentVideo.cid),'27694665372');
 assert.equal(await page.locator('.subtitle-item b').count(),0);
 assert.equal(await page.locator('#subtitle-select').inputValue(),'0');
 await page.evaluate(()=>{window.firstRow=document.querySelector('.subtitle-item');window.firstRowText=firstRow.querySelector('.subtitle-text');});
 await page.fill('#subtitle-search','python');
 await page.waitForFunction(()=>document.querySelector('#search-status').textContent==='1/50');
 assert(await page.evaluate(()=>firstRow===document.querySelector('.subtitle-item')&&firstRowText===firstRow.querySelector('.subtitle-text')));
 assert.equal(await page.locator('mark').count(),50);
 await page.fill('#subtitle-search','');
 await page.waitForFunction(()=>document.querySelector('#search-status').textContent==='0/0');
 assert(await page.evaluate(()=>firstRow===document.querySelector('.subtitle-item')));
 await page.fill('#subtitle-search','<b>');
 await page.waitForFunction(()=>document.querySelectorAll('mark').length===500);
 assert.equal(await page.locator('.subtitle-text b').count(),0);
 await page.evaluate(()=>{
   const input=document.querySelector('#subtitle-search');
   input.dispatchEvent(new CompositionEvent('compositionstart'));
   input.value='组词';input.dispatchEvent(new Event('input'));
 });
 await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>testAPI.ui.keyword),'<b>');
 await page.evaluate(()=>document.querySelector('#subtitle-search').dispatchEvent(new CompositionEvent('compositionend')));
 await page.waitForFunction(()=>testAPI.ui.keyword==='组词');
 await page.selectOption('#video-select','9');
 await page.waitForFunction(()=>testAPI.state.currentVideo.cid==='27694665583'&&testAPI.ui.rows.length===500);
 await page.selectOption('#subtitle-select','1');
 await page.waitForFunction(()=>testAPI.state.subtitleDetails[0]?.content.includes('/en'));
 // A late language response must not overwrite a newer part or a reopened modal.
 await page.evaluate(()=>{testAPI.subtitleCache.clear();window.requestDelay=50;});
 await page.selectOption('#subtitle-select','0');
 await page.selectOption('#video-select','8');
 await page.waitForFunction(()=>testAPI.state.currentVideo.cid==='27694665372'&&testAPI.state.subtitleDetails[0]?.content.includes('27694665372'));
 await page.evaluate(()=>window.requestDelay=0);
 for(let i=0;i<20;i++) {
   await page.selectOption('#video-select',String(i%2?9:0));
   await page.waitForFunction(cid=>testAPI.state.currentVideo.cid===cid&&testAPI.ui.rows.length===500,i%2?'27694665583':'100');
 }
 assert.equal(await page.evaluate(()=>window.docListeners),0);
 assert.equal(await page.evaluate(()=>window.rowListenerCounts.get(document.querySelector('#subtitle-content'))),1);
 assert.equal(await page.evaluate(()=>window.rowListenerCounts.get(document.querySelector('.subtitle-item'))||0),0);
 await page.locator('.subtitle-item').first().click();
 assert.equal(await page.evaluate(()=>window.plays),1);
 // Settings persistence, native format radios, details and nested scroll lock.
 await page.click('[data-action="settings"]');
 assert((await page.locator('#video-details').textContent()).includes('27694665583'));
 await page.check('input[name="settings-format"][value="md"]');
 await page.click('#save-settings');
 assert.equal(await page.evaluate(()=>testAPI.StorageManager.getDownloadSettings().format),'md');
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
 await page.click('[data-action="settings"]');
 await page.click('#add-custom-ext-btn');
 await page.fill('#custom-ext-input','log');
 await page.click('#confirm-custom-ext');
 assert.equal(await page.locator('input[name="settings-format"][value="log"]').count(),1);
 await page.locator('.format-item').filter({has:page.locator('input[value="log"]')}).locator('button').click();
 assert.equal(await page.locator('input[name="settings-format"][value="log"]').count(),0);
 await page.click('#reset-settings');
 assert.equal(await page.evaluate(()=>testAPI.StorageManager.getDownloadSettings().format),'txt');
 await page.click('#close-settings-modal');
 // Capture actual single and batch download payloads without accessing network or saving browser downloads.
 await page.evaluate(()=>{
   window.exports=[];
   const original=URL.createObjectURL;
   URL.createObjectURL=blob=>{window.exports.push(blob);return original(blob);};
   HTMLAnchorElement.prototype.click=function(){window.lastFilename=this.download;};
 });
 for (const format of ['txt','md','csv','xml','html','srt','vtt','ass','lrc','json']) {
   await page.click('[data-action="download"]');
   await page.selectOption('#download-format',format);
   await page.click('#confirm-download');
  const output=await page.evaluate(async()=>({text:await window.exports.at(-1).text(),name:window.lastFilename}));
   assert(output.name.endsWith('.'+format)); assert(output.text.length>100);
   if(format==='html'){assert(output.text.includes('&lt;b&gt;'));assert(!output.text.includes('<b>literal'))}
   if(format==='json')assert.equal(JSON.parse(output.text.replace(/^\uFEFF/,'' )).length,500);
 }
 await page.click('[data-action="batch"]');
 await page.click('#deselect-all');
 await page.locator('#video-checkboxes input').nth(8).check();
 await page.locator('#video-checkboxes input').nth(9).check();
 assert.equal(await page.locator('#batch-selection-count').textContent(),'已选择 2 / 10 个视频');
 await page.evaluate(()=>{
   window.savedFolders = new Map(); window.pickerCalls=0;
   window.showDirectoryPicker = async () => {
     window.pickerCalls++;
     if(window.pickerFailure)throw new DOMException('Denied',window.pickerFailure);
     return { getDirectoryHandle: async (name,options={}) => {
       if(!window.savedFolders.has(name)) {
         if(!options.create)throw new DOMException('Missing','NotFoundError');
         const files=new Map();
         window.savedFolders.set(name,{files,getFileHandle:async(filename,opts={})=>{
           if(!files.has(filename)&&!opts.create)throw new DOMException('Missing','NotFoundError');
           return {createWritable:async()=>({write:async blob=>files.set(filename,await blob.text()),close:async()=>{},abort:async()=>{}})};
         }});
       }
       return window.savedFolders.get(name);
     }};
   };
 });
 const countBefore=await page.evaluate(()=>window.exports.length);
 await page.click('#start-batch-download');
 await page.waitForSelector('#batch-name-modal');
 assert.equal(await page.locator('#batch-folder-name').inputValue(),'');
 assert.equal(await page.evaluate(()=>window.pickerCalls),0);
 await page.click('#confirm-batch-name');
 assert.equal(await page.evaluate(()=>window.pickerCalls),0);
 await page.fill('#batch-folder-name','../错误');
 await page.click('#confirm-batch-name');
 assert.equal(await page.evaluate(()=>window.pickerCalls),0);
 await page.click('#cancel-batch-name');
 await page.waitForSelector('#batch-name-modal',{state:'detached'});
 assert.equal(await page.locator('#start-batch-download').isEnabled(),true);
 await page.click('#start-batch-download');
 await page.fill('#batch-folder-name','Linux 学习字幕');
 await page.evaluate(()=>window.pickerFailure='AbortError');
 await page.click('#confirm-batch-name');
 await page.waitForFunction(()=>document.querySelector('#batch-name-error').textContent.includes('已取消'));
 assert.equal(await page.evaluate(()=>window.savedFolders.size),0);
 await page.evaluate(()=>window.pickerFailure='NotAllowedError');
 await page.click('#confirm-batch-name');
 await page.waitForFunction(()=>document.querySelector('#batch-name-error').textContent.includes('权限'));
 await page.evaluate(()=>window.pickerFailure=null);
 await page.click('#confirm-batch-name');
 await page.waitForSelector('#batch-download-modal',{state:'detached'});
 const folder=await page.evaluate(()=>Array.from(window.savedFolders.get('Linux 学习字幕').files));
 assert.equal(folder.length,2);assert(folder.some(([name])=>name.includes('P9')));assert(folder.some(([name])=>name.includes('P10')));
 assert(folder.every(([,content])=>content.includes('python')));
 assert.equal(await page.evaluate(()=>window.exports.length),countBefore);
 await page.click('[data-action="batch"]');await page.click('#start-batch-download');
 await page.fill('#batch-folder-name','Linux 学习字幕');await page.click('#confirm-batch-name');
 await page.waitForFunction(()=>document.querySelector('#batch-name-error').textContent.includes('已存在'));
 await page.click('#cancel-batch-name');await page.click('#close-batch-modal');
 // Duplicate names receive a suffix, so previously saved content is preserved.
 await page.evaluate(async()=>{
   const folder=window.savedFolders.get('Linux 学习字幕');
   await testAPI.saveSubtitleToDirectory(folder,'first','同名.txt','text/plain');
   await testAPI.saveSubtitleToDirectory(folder,'second','同名.txt','text/plain');
 });
 assert.deepEqual(await page.evaluate(()=>{
   const files=window.savedFolders.get('Linux 学习字幕').files;return [files.get('同名.txt'),files.get('同名 (2).txt')];
 }),['first','second']);
 for(const format of ['txt','md','csv','xml','html','srt','vtt','ass','lrc','json']) {
   const output=await page.evaluate(async format=>{
     await testAPI.downloadVideoSubtitle({bvid:'BV1owrpYKEtP',cid:'27694665372'},format,testAPI.StorageManager.getDownloadSettings());
     return {text:await window.exports.at(-1).text(),name:window.lastFilename};
   },format);
   assert(output.name.includes('P9'));assert(output.name.endsWith('.'+format));
   if(format==='html')assert(output.text.includes('&lt;b&gt;'));
   if(format==='md')assert(output.text.includes('&lt;b&gt;') || output.text.includes('&lt;b>'));
 }
 // 20 close/reopen cycles must not leave row references or global listeners.
 for(let i=0;i<20;i++){
   await page.click('#close-modal');
   assert.equal(await page.evaluate(()=>testAPI.ui.rows.length),0);
   assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
   await page.click('#bili-transcript-btn');await page.waitForSelector('.subtitle-item');
 }
 assert.equal(await page.evaluate(()=>window.docListeners),0);
 // Browser timings include forced layout, not just JS element creation.
 const timings=await page.evaluate(()=>[100,500,1500,5000].map(count=>{
   const data=Array.from({length:count},(_,i)=>({from:i,to:i+1,content:`第${i}条 python <b>literal</b> 字幕文字` }));
   testAPI.state.subtitleDetails=data;
   const start=performance.now();testAPI.renderSubtitles(data);document.querySelector('#subtitle-content').offsetHeight;
   const rendered=performance.now();testAPI.searchSubtitles('python');document.querySelector('#subtitle-content').offsetHeight;
   return {count,renderMs:Math.round((rendered-start)*10)/10,searchMs:Math.round((performance.now()-rendered)*10)/10};
 }));
 console.log('Browser timings (ms):',JSON.stringify(timings));
 assert.equal(await page.locator('.subtitle-item').count(),200);
 // Full-data searches can reach the final not-yet-rendered row without losing earlier rows.
 await page.evaluate(()=>{document.querySelector('#subtitle-search').value='第4999条';testAPI.searchSubtitles('第4999条');});
 await page.waitForFunction(()=>document.querySelector('.search-selected')?.dataset.index==='4999');
 assert.equal(await page.locator('.subtitle-item').count(),5000);
 assert.equal(await page.locator('.search-match').count(),1);
 await page.evaluate(()=>{testAPI.searchSubtitles('python');testAPI.searchSubtitles('');});
 await page.waitForFunction(()=>document.querySelectorAll('mark').length===0);
 assert.equal(await page.locator('.search-match').count(),0);
 assert.equal(await page.locator('.subtitle-item').count(),5000);
 // Route changes through history are still detected by the existing 500ms poll.
 await page.evaluate(()=>history.pushState({},'', '?p=10'));
 await page.waitForFunction(()=>testAPI.state.currentVideo.cid==='27694665583'&&testAPI.state.subtitleDetails.length===500);
 const shotDir=process.env.SCREENSHOT_DIR;
 if(shotDir){fs.mkdirSync(shotDir,{recursive:true});await page.screenshot({path:path.join(shotDir,'lite-desktop.png')});}
 await page.setViewportSize({width:360,height:800});
 assert(await page.evaluate(()=>document.querySelector('.lite-main').getBoundingClientRect().right<=innerWidth));
 const footer=await page.locator('.lite-main .modal-footer').boundingBox();assert(footer.y+footer.height<=800);
 if(shotDir)await page.screenshot({path:path.join(shotDir,'lite-mobile.png')});
 await page.click('#close-modal');
 // Close while a search is pending and while API work is pending.
 await page.evaluate(()=>{window.requestDelay=80;testAPI.subtitleCache.clear();});
 await page.click('#bili-transcript-btn');await page.click('#close-modal');await page.waitForTimeout(400);
 assert.equal(await page.locator('#bili-transcript-modal').count(),0);
 assert.equal(await page.evaluate(()=>testAPI.ui.rows.length),0);
 await page.evaluate(()=>{window.requestDelay=0;window.singlePage=true;history.pushState({},'','?p=1');});
 await page.waitForTimeout(550);
 await page.click('#bili-transcript-btn');await page.waitForSelector('.subtitle-item');
 assert.equal(await page.evaluate(()=>testAPI.state.currentVideo.cid),'100');
 assert.equal(await page.locator('#video-select').isVisible(),false);
 await page.click('#close-modal');
 await page.evaluate(()=>window.noSubtitles=true);
 await page.click('#bili-transcript-btn');await page.waitForSelector('.no-subtitles');
 assert.equal(await page.evaluate(()=>testAPI.ui.rows.length),0);
 await page.click('#close-modal');
 await page.evaluate(()=>window.apiFailure=true);
 await page.click('#bili-transcript-btn');
 await page.waitForFunction(()=>document.querySelector('#subtitle-content').textContent.includes('读取分P信息失败'));
 await page.click('#close-modal');
 assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
 assert.deepEqual(errors,[]);
 console.log('PASS: P1/P9/P10 and SPA route; language/part race; 20 switches and 20 reopen cycles; delegated click; search/IME/HTML safety; settings/custom formats; 10 single + 10 batch export formats; batch selection; 5000-row distant search/cancellation; scroll restoration; 360px layout; no runtime errors.');
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
