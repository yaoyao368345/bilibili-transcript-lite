const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const current = fs.readFileSync(path.join(root,'bilibili-transcript.user.js'),'utf8').replace(/\r\n/g,'\n');
const baseline = execFileSync('git',['show','v1.0.2:bilibili-transcript.user.js'],{cwd:root,encoding:'utf8'}).replace(/\r\n/g,'\n');
function getFunction(source,name){
 const match = source.match(new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`,'m'));
 assert(match,`Missing function ${name}`);return match[0];
}
const preserved=['request','getVideoInfo','getVideoPages','resolveVideo','fetchSubtitles','fetchSubtitlesFromWebInterface','getSubtitleContent','sortSubtitles','isSubtitleMismatch','handleDownload',
 'convertToTXT','convertToSRT','convertToVTT','convertToCSV','convertToXML','convertToASS','convertToLRC','convertToJSON'];
for(const name of preserved)assert.equal(getFunction(current,name),getFunction(baseline,name),`${name} changed`);
const converters=['parseTime','formatTime','sanitizeInput','escapeCSV','convertToTXT','convertToSRT','convertToVTT','convertToCSV','convertToXML','convertToASS','convertToLRC','convertToJSON','convertToMD','convertToHTML'];
// CSV helper name follows the userscript, discover it from the conversion block.
const available=converters.filter(name=>current.includes(`function ${name}(`));
const context=vm.createContext({});
vm.runInContext(available.map(name=>getFunction(current,name)).join('\n'),context);
context.data=[{from:1.25,to:3.5,content:'中文 <b>& "quoted", [x]*'}, {from:3661,to:3662,content:'第二行'}];
for(const name of ['convertToTXT','convertToSRT','convertToVTT','convertToCSV','convertToXML','convertToASS','convertToLRC','convertToJSON','convertToMD','convertToHTML']) {
 const result=vm.runInContext(`${name}(data)`,context);assert.equal(typeof result,'string');assert(result.includes('中文'));
}
assert(!/backdrop-filter|transition:\s*all|translateX\(4px\)|custom-select/.test(current));
assert(!/^:root\s*\{/m.test(current));
console.log(`PASS: ${preserved.length} protected business functions unchanged; 10 converters return output; removed costly CSS and custom dropdown implementation.`);
