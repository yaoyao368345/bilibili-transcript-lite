// ==UserScript==
// @name         B站字幕提取器
// @namespace    https://blog.qitongtingyu.online/
// @version      1.2.0
// @description  从B站视频页面提取字幕文本，支持单个视频/分P视频下载，多种字幕导出格式，提供字幕搜索快速定位功能
// @author       栖桐听雨
// @match        https://www.bilibili.com/video/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.bilibili.com
// @connect      aisubtitle.hdslb.com
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    let loadGeneration = 0;
    const pagesByBvid = new Map();

    const CONFIG = {
        CACHE_MAX_SIZE: 50,
        CACHE_MAX_AGE: 3600000,
        REQUEST_TIMEOUT: 10000,
        REQUEST_RETRIES: 2,
        REQUEST_RETRY_DELAY: 1000,

        STORAGE_KEYS: {
            CUSTOM_EXTENSIONS: 'bili_transcript_custom_extensions',
            DOWNLOAD_SETTINGS: 'bili_transcript_download_settings'
        },

        PRESET_EXTENSIONS: [
            { name: 'TXT', value: 'txt', mimeType: 'text/plain' },
            { name: 'MD', value: 'md', mimeType: 'text/markdown' },
            { name: 'CSV', value: 'csv', mimeType: 'text/csv' },
            { name: 'XML', value: 'xml', mimeType: 'application/xml' },
            { name: 'HTML', value: 'html', mimeType: 'text/html' },
            { name: 'SRT', value: 'srt', mimeType: 'text/x-subrip' },
            { name: 'VTT', value: 'vtt', mimeType: 'text/vtt' },
            { name: 'ASS', value: 'ass', mimeType: 'text/x-ass' },
            { name: 'LRC', value: 'lrc', mimeType: 'text/lrc' },
            { name: 'JSON', value: 'json', mimeType: 'application/json' }
        ],

        DEFAULT_DOWNLOAD_SETTINGS: {
            format: 'txt',
            downloadMethod: 'direct',
            includeBV: true,
            includeTimestamp: false,
            includeDuration: false,
            includeSubtitleTime: true
        }
    };

    const ErrorTypes = {
        NETWORK_ERROR: 'NETWORK_ERROR',
        API_ERROR: 'API_ERROR',
        AUTH_ERROR: 'AUTH_ERROR',
        PARSE_ERROR: 'PARSE_ERROR',
        VALIDATION_ERROR: 'VALIDATION_ERROR',
        UNKNOWN_ERROR: 'UNKNOWN_ERROR'
    };

    class SubtitleError extends Error {
        constructor(type, message, originalError = null) {
            super(message);
            this.type = type;
            this.originalError = originalError;
        }
    }

    // 存储管理模块
    const StorageManager = {
        getCustomExtensions() {
            try {
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.CUSTOM_EXTENSIONS);
                return saved ? JSON.parse(saved) : [];
            } catch (error) {
                console.error('加载自定义扩展名失败:', error);
                return [];
            }
        },

        saveCustomExtensions(extensions) {
            try {
                localStorage.setItem(CONFIG.STORAGE_KEYS.CUSTOM_EXTENSIONS, JSON.stringify(extensions));
            } catch (error) {
                console.error('保存自定义扩展名失败:', error);
            }
        },

        getDownloadSettings() {
            try {
                const saved = localStorage.getItem(CONFIG.STORAGE_KEYS.DOWNLOAD_SETTINGS);
                return { ...CONFIG.DEFAULT_DOWNLOAD_SETTINGS, ...(saved ? JSON.parse(saved) : {}) };
            } catch (error) {
                console.error('加载下载设置失败:', error);
                return { ...CONFIG.DEFAULT_DOWNLOAD_SETTINGS };
            }
        },

        saveDownloadSettings(settings) {
            try {
                localStorage.setItem(CONFIG.STORAGE_KEYS.DOWNLOAD_SETTINGS, JSON.stringify(settings));
            } catch (error) {
                console.error('保存下载设置失败:', error);
            }
        }
    };

    let state = {
        currentVideo: { bvid: '', cid: '', title: '', duration: 0 },
        videoList: [],
        videoListType: 'single',
        subtitleList: [],
        subtitleDetails: [],
        searchResults: [],
        currentSearchIndex: -1
    };

    let savedOverflow = null;
    function disableScroll() {
        if (savedOverflow) return;
        savedOverflow = [document.documentElement, document.body].map(element => ({
            element, value: element.style.getPropertyValue('overflow'), priority: element.style.getPropertyPriority('overflow')
        }));
        savedOverflow.forEach(({element}) => element.style.setProperty('overflow', 'hidden', 'important'));
    }
    function enableScroll() {
        if (document.querySelector('.bili-transcript-modal') || !savedOverflow) return;
        savedOverflow.forEach(({element, value, priority}) => {
            if (value) element.style.setProperty('overflow', value, priority);
            else element.style.removeProperty('overflow');
        });
        savedOverflow = null;
    }

    class SubtitleCache {
        constructor(maxSize = CONFIG.CACHE_MAX_SIZE, maxAge = CONFIG.CACHE_MAX_AGE) {
            this.cache = new Map();
            this.maxSize = maxSize;
            this.maxAge = maxAge;
        }

        generateKey(bvid, cid, subtitleId) {
            return `${bvid}_${cid}_${subtitleId}`;
        }

        get(bvid, cid, subtitleId) {
            const key = this.generateKey(bvid, cid, subtitleId);
            const item = this.cache.get(key);
            if (!item) return null;
            if (Date.now() - item.timestamp > this.maxAge) {
                this.cache.delete(key);
                return null;
            }
            return item.data;
        }

        set(bvid, cid, subtitleId, data) {
            const key = this.generateKey(bvid, cid, subtitleId);
            if (this.cache.size >= this.maxSize) {
                const firstKey = this.cache.keys().next().value;
                this.cache.delete(firstKey);
            }
            this.cache.set(key, { data: data, timestamp: Date.now() });
        }

        clear(bvid, cid) {
            if (bvid && cid) {
                const prefix = `${bvid}_${cid}_`;
                for (const key of this.cache.keys()) {
                    if (key.startsWith(prefix)) {
                        this.cache.delete(key);
                    }
                }
            } else {
                this.cache.clear();
            }
        }
    }

    const subtitleCache = new SubtitleCache();

    class RequestDeduplicator {
        constructor() {
            this.pendingRequests = new Map();
        }

        async request(key, requestFn) {
            if (this.pendingRequests.has(key)) {
                return this.pendingRequests.get(key);
            }
            const promise = requestFn().finally(() => {
                this.pendingRequests.delete(key);
            });
            this.pendingRequests.set(key, promise);
            return promise;
        }
    }

    const deduplicator = new RequestDeduplicator();

    function showToast(message, type = 'info', duration = 3000) {
        document.querySelector('.bili-transcript-toast')?.remove();
        const toast = document.createElement('div');
        toast.className = 'bili-transcript-toast';
        toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
        const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ⓘ' };
        toast.textContent = `${icons[type] || icons.info} ${message}`;
        document.body.append(toast);
        setTimeout(() => toast.remove(), duration);
    }

    function sanitizeInput(input) {
        if (typeof input !== 'string') return '';
        return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;');
    }

    function escapeCSV(value) {
        if (typeof value !== 'string') return '';
        return value.includes(',') || value.includes('"') || value.includes('\n')
            ? '"' + value.replace(/"/g, '""') + '"'
            : value;
    }

    function getCookies() {
        return Object.fromEntries(
            document.cookie.split(';').map(c => c.trim().split('=')).filter(([k, v]) => k && v)
        );
    }

    function getHeaders() {
        const cookies = getCookies();
        const cookieString = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        return {
            'Referer': 'https://www.bilibili.com',
            'User-Agent': navigator.userAgent,
            'Cookie': cookieString.trim()
        };
    }

    async function request(url, options = {}) {
        const { timeout = CONFIG.REQUEST_TIMEOUT, retries = CONFIG.REQUEST_RETRIES, retryDelay = CONFIG.REQUEST_RETRY_DELAY, raw = false } = options;

        return new Promise((resolve, reject) => {
            let attempts = 0;

            function attempt() {
                attempts++;
                const timer = setTimeout(() => {
                    attempts <= retries ? setTimeout(attempt, retryDelay) : reject(new SubtitleError(ErrorTypes.NETWORK_ERROR, '请求超时'));
                }, timeout);

                GM_xmlhttpRequest({
                    method: options.method || 'GET',
                    url: url,
                    headers: options.headers || getHeaders(),
                    timeout: timeout,
                    onload: (response) => {
                        clearTimeout(timer);
                        if (raw) return resolve(response.responseText);
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.code === 0) {
                                resolve(data);
                            } else if (data.code === -101) {
                                reject(new SubtitleError(ErrorTypes.AUTH_ERROR, '请重新登录B站'));
                            } else if (data.code === -404) {
                                reject(new SubtitleError(ErrorTypes.API_ERROR, '请求的资源不存在'));
                            } else {
                                reject(new SubtitleError(ErrorTypes.API_ERROR, data.message || 'API请求失败'));
                            }
                        } catch (e) {
                            reject(new SubtitleError(ErrorTypes.PARSE_ERROR, '响应数据格式错误', e));
                        }
                    },
                    onerror: (error) => {
                        clearTimeout(timer);
                        attempts <= retries ? setTimeout(attempt, retryDelay) : reject(new SubtitleError(ErrorTypes.NETWORK_ERROR, '网络请求失败', error));
                    },
                    ontimeout: () => {
                        clearTimeout(timer);
                        attempts <= retries ? setTimeout(attempt, retryDelay) : reject(new SubtitleError(ErrorTypes.NETWORK_ERROR, '请求超时'));
                    }
                });
            }

            attempt();
        });
    }

    async function getVideoInfo(bvid) {
        try {
            return await request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
        } catch (error) {
            const data = pageWindow.__INITIAL_STATE__?.videoData;
            if (data?.bvid === bvid && data?.pages?.length) return { data };
            throw error;
        }
    }

    async function getVideoPages(bvid) {
        try {
            const response = await request(`https://api.bilibili.com/x/player/pagelist?bvid=${bvid}`);
            return response.data || [];
        } catch (error) {
            return [];
        }
    }

    async function fetchSubtitles(bvid, cid, forceRefresh = false) {
        const timestamp = Date.now();
        const url = forceRefresh
            ? `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}&_=${timestamp}`
            : `https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`;

        const key = `subtitles_${bvid}_${cid}_${forceRefresh ? timestamp : ''}`;
        return deduplicator.request(key, async () => {
            const response = await request(url, {
                headers: {
                    'Referer': `https://www.bilibili.com/video/${bvid}/`,
                    'Origin': 'https://www.bilibili.com',
                    'Accept': 'application/json, text/plain, */*'
                }
            });
            return response.data?.subtitle?.subtitles?.map(s => parseSubtitleItem(s)) || [];
        });
    }

    async function fetchSubtitlesFromWebInterface(bvid, cid) {
        try {
            const response = await request(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`);
            return response.data?.subtitle?.subtitles?.map(s => parseSubtitleItem(s)) || [];
        } catch (error) {
            console.error('备用接口获取字幕失败:', error);
            return [];
        }
    }

    function parseSubtitleItem(subtitle) {
        return {
            id: subtitle.id,
            lan: subtitle.lan_doc || subtitle.lan,
            url: subtitle.subtitle_url || subtitle.url || subtitle.content_url || subtitle.caption_url || ''
        };
    }

    async function getSubtitleContent(url, bvid, cid, subtitleId) {
        const cached = subtitleCache.get(bvid, cid, subtitleId);
        if (cached) return cached;
        if (!url) return [];

        const fullUrl = url.startsWith('//') ? `https:${url}` : url;
        try {
            const response = await request(fullUrl, { raw: true });
            const data = JSON.parse(response);
            const content = data.body || [];
            if (content.length > 0) subtitleCache.set(bvid, cid, subtitleId, content);
            return content;
        } catch (error) {
            console.error('获取字幕内容失败:', error);
            return [];
        }
    }

    function parseTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 1000);
        return { h, m, s, ms };
    }

    function formatTime(seconds, format = 'srt') {
        const { h, m, s, ms } = parseTime(seconds);
        if (format === 'srt') {
            return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
        } else if (format === 'ass') {
            return `${h.toString().padStart(1, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
        } else if (format === 'lrc') {
            return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${Math.floor(ms / 10).toString().padStart(2, '0')}`;
        }
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    // 格式转换函数
    function convertToMD(content, includeTime = false) {
        const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/([\\`*_{}\[\]()#+.!|~-])/g, '\\$1');
        return content.map(item => `${includeTime ? formatTime(item.from, 'srt') + ' ' : ''}${escape(item.content)}`).join('  \n');
    }

    function convertToHTML(content, includeTime = false) {
        return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>字幕</title><body>' +
            content.map(item => `<p>${includeTime ? formatTime(item.from, 'srt') + ' ' : ''}${sanitizeInput(item.content)}</p>`).join('\n') + '</body></html>';
    }

    function convertToSRT(content) {
        return content.map((item, index) => {
            const from = formatTime(item.from, 'srt');
            const to = formatTime(item.to, 'srt');
            return `${index + 1}\n${from} --> ${to}\n${item.content}\n`;
        }).join('\n');
    }

    function convertToTXT(content, includeTime = false) {
        return content.map(item => includeTime ? `${formatTime(item.from, 'srt')} ${item.content}` : item.content).join('\n');
    }

    function formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return h > 0 ? `${h}-${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}` : `${m}-${String(s).padStart(2, '0')}`;
    }

    function convertToJSON(content) {
        return JSON.stringify(content, null, 2);
    }

    function convertToVTT(content) {
        let vtt = 'WEBVTT\n\n';
        content.forEach((item, index) => {
            const from = formatTime(item.from, 'srt').replace(',', '.');
            const to = formatTime(item.to, 'srt').replace(',', '.');
            vtt += `${index + 1}\n${from} --> ${to}\n${item.content}\n\n`;
        });
        return vtt;
    }

    function convertToCSV(content) {
        let csv = '序号,开始时间,结束时间,字幕内容\n';
        content.forEach((item, index) => {
            const from = formatTime(item.from, 'srt');
            const to = formatTime(item.to, 'srt');
            csv += `${index + 1},${escapeCSV(from)},${escapeCSV(to)},${escapeCSV(item.content)}\n`;
        });
        return csv;
    }

    function convertToXML(content) {
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<subtitles>\n';
        content.forEach((item, index) => {
            const from = formatTime(item.from, 'srt');
            const to = formatTime(item.to, 'srt');
            xml += `  <subtitle id="${index + 1}" start="${from}" end="${to}">${sanitizeInput(item.content)}</subtitle>\n`;
        });
        xml += '</subtitles>';
        return xml;
    }

    function convertToASS(content, title = 'B站字幕') {
        let ass = `[Script Info]
Title: ${title}
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
Timer: 100.0000

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,微软雅黑,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
        content.forEach(item => {
            const from = formatTime(item.from, 'ass');
            const to = formatTime(item.to, 'ass');
            ass += `Dialogue: 0,${from},${to},Default,,0,0,0,,${item.content}\n`;
        });
        return ass;
    }

    function convertToLRC(content) {
        return content.map(item => `[${formatTime(item.from, 'lrc')}]${item.content}\n`).join('');
    }

    function downloadFile(content, filename, mimeType = 'text/plain') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast(`字幕文件 "${filename.split('/').pop()}" 下载完成！`, 'success');
    }

    async function copyToClipboard(text) {
        try {
            await GM_setClipboard(text);
            showToast('复制成功', 'success');
        } catch (error) {
            console.error('复制失败:', error);
            showToast('复制失败', 'error');
        }
    }

    function getCurrentVideoInfo() {
        const url = new URL(window.location.href);
        const bvid = url.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)?.[1] || '';
        const value = Number(url.searchParams.get('p') || 1);
        const page = Number.isSafeInteger(value) && value > 0 ? value : 1;
        const titleEl = document.querySelector('.video-title') || document.querySelector('h1');
        // Resolve CID from the requested page, never from a potentially stale player.
        return { bvid, page, cid: '', title: titleEl?.textContent.trim() || '', duration: 0 };
    }

    async function resolveVideo(video) {
        const info = await getVideoInfo(video.bvid);
        const pages = info.data?.pages?.length ? info.data.pages : await getVideoPages(video.bvid);
        pagesByBvid.set(video.bvid, pages);
        const part = video.cid
            ? pages.find(p => String(p.cid) === String(video.cid))
            : pages.find(p => Number(p.page) === (video.page || 1));
        if (!part?.cid) throw new Error('无法确定所选分P的CID，请刷新后重试');
        return { ...video, cid: String(part.cid), page: Number(part.page),
            title: pages.length > 1 ? `${info.data?.title || video.title} - P${part.page} ${part.part || ''}` : info.data?.title || video.title,
            duration: Number(part.duration) || 0 };
    }

    function getVideoList() {
        const bvid = state.currentVideo.bvid;
        const pages = pagesByBvid.get(bvid);
        if (pages?.length > 1) return pages.map(p => ({ bvid, cid: String(p.cid),
            page: Number(p.page), title: `P${p.page} ${p.part || ''}`, duration: Number(p.duration) || 0 }));
        const result = [];
        const videoPodBody = document.querySelector('.video-pod__body');

        if (videoPodBody) {
            videoPodBody.querySelectorAll('.video-pod__item, .pod-item').forEach((item, index) => {
                const link = item.querySelector('a');
                const titleEl = item.querySelector('.title .title-txt') || item.querySelector('.video-title');
                const dataKey = item.getAttribute('data-key');
                let bvid = '';

                if (link) {
                    const bvidMatch = link.getAttribute('href')?.match(/BV[a-zA-Z0-9]+/);
                    bvid = bvidMatch ? bvidMatch[0] : '';
                }
                if (!bvid && dataKey) {
                    const bvidMatch = dataKey.match(/BV[a-zA-Z0-9]+/);
                    bvid = bvidMatch ? bvidMatch[0] : '';
                }

                const title = titleEl ? titleEl.textContent.trim() : `视频 ${index + 1}`;
                if (bvid) result.push({ bvid, title, cid: '' });
            });
        }

        if (result.length === 0) {
            const playerPages = pageWindow.__INITIAL_STATE__?.videoData?.bvid === state.currentVideo.bvid ? pageWindow.__INITIAL_STATE__.videoData.pages : [];
            if (Array.isArray(playerPages) && playerPages.length > 0) {
                playerPages.forEach((page, index) => {
                    result.push({
                        bvid: state.currentVideo.bvid,
                        cid: page.cid?.toString() || '',
                        title: page.part || `P${index + 1}`
                    });
                });
            }
        }

        return result;
    }

    async function getVideoCID(bvid, page = 1) {
        try {
            const videoInfo = await getVideoInfo(bvid);
            const pages = videoInfo.data?.pages || await getVideoPages(bvid);
            return String(pages.find(p => Number(p.page) === page)?.cid || '');
        } catch (error) {
            console.error('获取CID失败:', error);
            return '';
        }
    }

    function sortSubtitles(subtitles) {
        return [...subtitles].filter(s => s.url?.trim()).sort((a, b) => {
            const aIsSummary = a.lan.includes('摘要');
            const bIsSummary = b.lan.includes('摘要');
            const aIsAI = a.lan.includes('AI');
            const bIsAI = b.lan.includes('AI');
            const aIsChinese = a.lan.includes('中文');
            const bIsChinese = b.lan.includes('中文');

            if (aIsSummary !== bIsSummary) return aIsSummary ? 1 : -1;
            if (aIsAI !== bIsAI) return aIsAI ? 1 : -1;
            if (aIsChinese !== bIsChinese) return aIsChinese ? -1 : 1;
            return 0;
        });
    }

    function isSubtitleMismatch(content, videoDuration) {
        if (content.length === 0 || videoDuration === 0) return false;
        const lastSubtitle = content[content.length - 1];
        const subtitleDuration = lastSubtitle.end || lastSubtitle.to || 0;
        const durationRatio = subtitleDuration / videoDuration;
        return durationRatio < 0.5 || durationRatio > 1.5;
    }

    // Subtitle rendering and search. Each modal owns one abortable event scope.
    const ui = { controller: null, timer: null, rows: [], texts: [], keyword: '', selected: null,
        matches: new Set(), revision: 0, navigation: 0, scrollFrame: null, more: null };

    function clearSubtitleView() {
        clearTimeout(ui.timer);
        cancelAnimationFrame(ui.scrollFrame);
        ui.scrollFrame = null;
        ++ui.revision;
        ++ui.navigation;
        ui.matches = new Set();
        ui.more = null;
        ui.rows = [];
        ui.texts = [];
        ui.keyword = '';
        ui.selected = null;
        state.searchResults = [];
        state.currentSearchIndex = -1;
        const input = document.getElementById('subtitle-search');
        if (input) input.value = '';
        updateSearchStatus();
    }

    function searchSubtitles(keyword) {
        const query = keyword.trim().toLowerCase();
        if (query === ui.keyword) return;
        ui.keyword = query;
        ++ui.revision;
        ++ui.navigation;
        state.searchResults = [];
        ui.texts.forEach((text, index) => {
            if (query && text.includes(query)) state.searchResults.push(index);
        });
        state.currentSearchIndex = state.searchResults.length ? 0 : -1;
        ui.matches = new Set(state.searchResults);
        renderSubtitlesWithHighlight(query);
        updateSearchStatus();
        if (state.searchResults.length) scrollToSearchResult(0);
    }

    function updateRowHighlight(row, index, keyword) {
            const matched = ui.matches.has(index);
            row.classList.toggle('search-match', matched);
            const text = row.querySelector('.subtitle-text');
            const nextHighlight = matched ? keyword : '';
            if (text.dataset.highlight === nextHighlight) return;
            text.dataset.highlight = nextHighlight;
            const original = String(state.subtitleDetails[index].content);
            const fragment = document.createDocumentFragment();
            let offset = 0;
            // Literal search: subtitle text is never interpreted as HTML or a regexp.
            while (nextHighlight) {
                const position = ui.texts[index].indexOf(nextHighlight, offset);
                if (position < 0) break;
                fragment.append(document.createTextNode(original.slice(offset, position)));
                const mark = document.createElement('mark');
                mark.textContent = original.slice(position, position + nextHighlight.length);
                fragment.append(mark);
                offset = position + nextHighlight.length;
            }
            fragment.append(document.createTextNode(original.slice(offset)));
            text.replaceChildren(fragment);
    }

    async function renderSubtitlesWithHighlight(keyword) {
        // Yield between batches even after the user has scrolled through a very long list.
        const revision = ui.revision;
        ui.selected?.classList.remove('search-selected');
        ui.selected = null;
        for (let start = 0; start < ui.rows.length; start += 200) {
            if (revision !== ui.revision) return;
            for (let index = start; index < Math.min(start + 200, ui.rows.length); index++) {
                updateRowHighlight(ui.rows[index], index, keyword);
            }
            if (start + 200 < ui.rows.length) await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    function updateSearchStatus() {
        const status = document.getElementById('search-status');
        if (status) status.textContent = state.searchResults.length
            ? `${state.currentSearchIndex + 1}/${state.searchResults.length}` : '0/0';
    }

    async function scrollToSearchResult(index) {
        const rowIndex = state.searchResults[index];
        if (!Number.isInteger(rowIndex)) return;
        const navigation = ++ui.navigation;
        // Search indexes all data; load distant matches incrementally without one long task.
        while (rowIndex >= ui.rows.length) {
            appendSubtitleBatch();
            await new Promise(resolve => setTimeout(resolve, 0));
            if (navigation !== ui.navigation) return;
        }
        const row = ui.rows[rowIndex];
        if (!row) return;
        ui.selected?.classList.remove('search-selected');
        ui.selected = row;
        row.classList.add('search-selected');
        const container = document.getElementById('subtitle-content');
        container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top
            - container.clientHeight / 2 + row.offsetHeight / 2;
        const video = document.querySelector('video');
        const time = Number(row.dataset.time);
        if (video && Number.isFinite(time)) video.currentTime = time;
    }

    function nextSearchResult() {
        if (!state.searchResults.length) return;
        state.currentSearchIndex = (state.currentSearchIndex + 1) % state.searchResults.length;
        updateSearchStatus();
        scrollToSearchResult(state.currentSearchIndex);
    }

    function prevSearchResult() {
        if (!state.searchResults.length) return;
        state.currentSearchIndex = (state.currentSearchIndex - 1 + state.searchResults.length) % state.searchResults.length;
        updateSearchStatus();
        scrollToSearchResult(state.currentSearchIndex);
    }


    async function loadSubtitles(retryCount = 0) {
        const generation = ++loadGeneration;
        clearSubtitleView();
        state.subtitleDetails = [];
        state.subtitleList = [];
        showSubtitlesSelector([]);
        const target = document.getElementById('subtitle-content');
        if (target) target.textContent = '加载中…';
        const isStale = () => generation !== loadGeneration;
        try {
            const resolved = await resolveVideo({ ...state.currentVideo });
            if (isStale()) return;
            state.currentVideo = resolved;
            initVideoList();
            showVideoListSelector();
            updateVideoInfo();
        } catch (error) {
            if (!isStale()) {
                if (target) target.textContent = '读取分P信息失败，请重新选择视频或重新打开窗口。';
                showToast(error.message || '读取分P信息失败', 'error');
            }
            return;
        }
        state.subtitleDetails = [];
        state.subtitleList = [];
        state.searchResults = [];
        state.currentSearchIndex = -1;

        let { bvid, cid } = state.currentVideo;
        if (!bvid) {
            showToast('无法获取视频信息', 'error');
            return;
        }

        if (!cid) {
            cid = await getVideoCID(bvid);
            if (!cid) {
                showToast('无法获取视频信息', 'error');
                return;
            }
            state.currentVideo.cid = cid;
        }

        showToast('正在加载字幕...', 'info');

        try {
            if (retryCount > 0) subtitleCache.clear(bvid, cid);

            let subtitles;
            try { subtitles = await fetchSubtitles(bvid, cid, retryCount > 0); }
            catch { subtitles = await fetchSubtitlesFromWebInterface(bvid, cid); }
            if (isStale()) return;
            if (subtitles.length === 0) subtitles = await fetchSubtitlesFromWebInterface(bvid, cid);

            if (isStale()) return;
            const videoDuration = state.currentVideo.duration;

            updateVideoInfo();

            if (subtitles.length === 0) {
                showNoSubtitles();
                return;
            }

            state.subtitleList = subtitles;
            showVideoListSelector();
            // Keep language selection disabled until automatic selection completes.

            const sortedSubtitles = sortSubtitles(subtitles);
            let selectedSubtitle = null;
            let content = [];

            for (const subtitle of sortedSubtitles) {
                const subtitleContent = await getSubtitleContent(subtitle.url, bvid, cid, subtitle.id);
                if (isStale()) return;
                if (subtitleContent.length === 0) continue;

                const lastSubtitle = subtitleContent[subtitleContent.length - 1];
                const subtitleDuration = lastSubtitle.end || lastSubtitle.to || 0;
                const durationRatio = videoDuration > 0 ? subtitleDuration / videoDuration : 0;

                if (videoDuration > 0 && durationRatio >= 0.5 && durationRatio <= 1.5) {
                    selectedSubtitle = subtitle;
                    content = subtitleContent;
                    break;
                }

                if (videoDuration === 0 && !selectedSubtitle) {
                    selectedSubtitle = subtitle;
                    content = subtitleContent;
                    break;
                }
            }

            if (!selectedSubtitle && sortedSubtitles.length > 0) {
                selectedSubtitle = sortedSubtitles[0];
                content = await getSubtitleContent(selectedSubtitle.url, bvid, cid, selectedSubtitle.id);
            }

            if (isStale()) return;
            if (!selectedSubtitle) {
                showToast('无法获取字幕内容', 'error');
                return;
            }

            if (isSubtitleMismatch(content, videoDuration) && retryCount < 3) {
                showToast(`字幕不匹配，正在重试 (${retryCount + 1}/3)...`, 'warning');
                await new Promise(resolve => setTimeout(resolve, 1000));
                if (isStale()) return;
                return loadSubtitles(retryCount + 1);
            }

            if (isSubtitleMismatch(content, videoDuration) && retryCount >= 3) {
                showToast('警告：字幕与视频时长可能不匹配', 'warning');
            }

            state.subtitleDetails = content;
            showSubtitlesSelector(subtitles, selectedSubtitle.id);
            renderSubtitles(content);
            updateVideoInfo();
            showToast('字幕加载完成', 'success');

        } catch (error) {
            if (isStale()) return;
            console.error('加载字幕失败:', error);
            if (target) target.textContent = '字幕加载失败，请重新选择视频或重新打开窗口。';
            showToast('加载字幕失败', 'error');
        }
    }

    function showNoSubtitles() {
        const container = document.getElementById('subtitle-content');
        if (!container) return;

        container.innerHTML = `
            <div class="no-subtitles">
                <div class="no-subtitles-icon">📭</div>
                <h3>未找到字幕</h3>
                <p>当前视频没有可用的字幕</p>
                <ul class="no-subtitles-tips">
                    <li>视频未上传字幕</li>
                    <li>需要登录才能查看字幕</li>
                    <li>字幕正在生成中</li>
                </ul>
            </div>
        `;
    }

    // Native selectors: update options, keep their event handlers on the modal.
    function showVideoListSelector() {
        const select = document.getElementById('video-select');
        if (!select) return;
        const list = state.videoList;
        select.replaceChildren(...list.map((video, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = video.title;
            option.selected = video.bvid === state.currentVideo.bvid && String(video.cid) === String(state.currentVideo.cid);
            return option;
        }));
        select.parentElement.hidden = list.length <= 1;
        document.getElementById('batch-download').disabled = list.length === 0;
    }

    function showSubtitlesSelector(subtitles, selectedId) {
        const select = document.getElementById('subtitle-select');
        if (!select) return;
        select.replaceChildren(...subtitles.map((subtitle, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = subtitle.lan + (subtitle.url ? '' : '（不可用）');
            option.disabled = !subtitle.url;
            option.selected = String(subtitle.id) === String(selectedId);
            return option;
        }));
        select.disabled = !subtitles.some(subtitle => subtitle.url);
    }

    function renderSubtitles(content) {
        clearSubtitleView();
        const container = document.getElementById('subtitle-content');
        if (!container) return;
        if (!content?.length) { showNoSubtitles(); return; }
        ui.texts = content.map(item => String(item.content).toLowerCase());
        container.replaceChildren();
        ui.more = document.createElement('button');
        ui.more.type = 'button';
        ui.more.className = 'subtitle-more';
        ui.more.dataset.loadMore = 'true';
        container.append(ui.more);
        appendSubtitleBatch(content.length <= 500 ? content.length : 200);
    }

    function appendSubtitleBatch(count = 200) {
        const container = document.getElementById('subtitle-content');
        if (!container || !ui.more) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(ui.rows.length + count, state.subtitleDetails.length);
        for (let index = ui.rows.length; index < end; index++) {
            const item = state.subtitleDetails[index];
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'subtitle-item';
            row.dataset.index = index;
            row.dataset.time = item.from;
            const time = document.createElement('span');
            time.className = 'subtitle-time';
            time.textContent = formatTime(item.from).split(',')[0].replace(/^00:/, '');
            const text = document.createElement('span');
            text.className = 'subtitle-text';
            text.dataset.highlight = '';
            text.textContent = item.content;
            row.append(time, text);
            updateRowHighlight(row, index, ui.keyword);
            ui.rows.push(row);
            fragment.append(row);
        }
        container.insertBefore(fragment, ui.more);
        ui.more.hidden = ui.rows.length >= state.subtitleDetails.length;
        ui.more.textContent = `已加载 ${ui.rows.length} / ${state.subtitleDetails.length} 条 · 加载更多`;
    }

    function updateVideoInfo() {
        const title = document.getElementById('video-title');
        if (title) title.textContent = state.currentVideo.title || '读取视频信息…';
        const details = document.getElementById('video-details');
        if (details) details.textContent = `BV：${state.currentVideo.bvid || '未知'}\nCID：${state.currentVideo.cid || '未知'}\n时长：${formatTime(state.currentVideo.duration || 0)}`;
    }

    function createModal() {
        removeModal('bili-transcript-modal');
        state.currentVideo = getCurrentVideoInfo();
        disableScroll();
        const modal = document.createElement('div');
        modal.id = 'bili-transcript-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="modal-overlay"></div>
            <section class="modal-content lite-main" role="dialog" aria-modal="true" aria-label="字幕提取器">
                <header class="modal-header"><h2>字幕提取器 Lite</h2><button id="close-modal" class="close-btn" aria-label="关闭">×</button></header>
                <div class="lite-controls">
                    <div id="video-title">读取视频信息…</div>
                    <div class="lite-selectors">
                        <label hidden>视频分 P<select id="video-select" aria-label="视频分 P"></select></label>
                        <label>字幕语言<select id="subtitle-select" aria-label="字幕语言" disabled></select></label>
                    </div>
                    <div class="search-container"><input id="subtitle-search" type="search" placeholder="搜索字幕…" aria-label="搜索字幕">
                        <button data-action="prev" aria-label="上一条匹配">↑</button><span id="search-status" aria-live="polite">0/0</span><button data-action="next" aria-label="下一条匹配">↓</button>
                    </div>
                </div>
                <div id="subtitle-content" class="subtitle-content" aria-label="字幕列表">加载中…</div>
                <footer class="modal-footer"><button data-action="settings" class="btn-secondary">设置</button><div class="footer-actions">
                    <button data-action="copy" class="btn-secondary">复制</button><button data-action="download" class="btn-primary">下载</button><button id="batch-download" data-action="batch" class="btn-secondary">批量</button>
                </div></footer>
            </section>`;
        document.body.appendChild(modal);
        setupModalClose(modal, 'close-modal', 'modal-overlay');
        ui.controller = new AbortController();
        const options = { signal: ui.controller.signal };
        const input = modal.querySelector('#subtitle-search');
        let composing = false;
        const scheduleSearch = () => {
            clearTimeout(ui.timer);
            if (composing) return;
            const value = input.value;
            ui.timer = setTimeout(() => searchSubtitles(value), 200);
        };
        input.addEventListener('compositionstart', () => { composing = true; clearTimeout(ui.timer); }, options);
        input.addEventListener('compositionend', () => { composing = false; scheduleSearch(); }, options);
        input.addEventListener('input', scheduleSearch, options);
        input.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || composing || event.isComposing) return;
            event.preventDefault();
            clearTimeout(ui.timer);
            if (input.value.trim().toLowerCase() !== ui.keyword) searchSubtitles(input.value);
            else event.shiftKey ? prevSearchResult() : nextSearchResult();
        }, options);
        modal.querySelector('#subtitle-content').addEventListener('click', event => {
            if (event.target.closest('[data-load-more]')) { appendSubtitleBatch(); return; }
            const row = event.target.closest('.subtitle-item');
            if (!row || !event.currentTarget.contains(row)) return;
            const video = document.querySelector('video');
            const time = Number(row.dataset.time);
            if (video && Number.isFinite(time)) {
                video.currentTime = time;
                video.play()?.catch(() => {});
            }
        }, options);
        modal.querySelector('#subtitle-content').addEventListener('scroll', event => {
            const container = event.currentTarget;
            if (ui.scrollFrame !== null) return;
            ui.scrollFrame = requestAnimationFrame(() => {
                ui.scrollFrame = null;
                if (container.scrollHeight - container.scrollTop - container.clientHeight < 150) appendSubtitleBatch();
            });
        }, { ...options, passive: true });
        modal.addEventListener('click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'settings') showSettingsModal();
            if (action === 'copy') copyToClipboard(convertToTXT(state.subtitleDetails));
            if (action === 'download') showDownloadConfirm(state.subtitleDetails, state.subtitleDetails);
            if (action === 'batch') showBatchDownloadModal();
            if (action === 'prev' || action === 'next') {
                clearTimeout(ui.timer);
                if (input.value.trim().toLowerCase() !== ui.keyword) searchSubtitles(input.value);
                else action === 'prev' ? prevSearchResult() : nextSearchResult();
            }
        }, options);
        modal.querySelector('#video-select').addEventListener('change', event => {
            const video = state.videoList[Number(event.target.value)];
            if (!video) return;
            state.currentVideo = { ...video, page: video.page || 1 };
            loadSubtitles();
        }, options);
        modal.querySelector('#subtitle-select').addEventListener('change', async event => {
            const subtitle = state.subtitleList[Number(event.target.value)];
            if (!subtitle?.url) return;
            const generation = ++loadGeneration;
            const { bvid, cid } = state.currentVideo;
            clearSubtitleView();
            state.subtitleDetails = [];
            modal.querySelector('#subtitle-content').textContent = '加载中…';
            try {
                const content = await getSubtitleContent(subtitle.url, bvid, cid, subtitle.id);
                if (generation !== loadGeneration || !modal.isConnected) return;
                state.subtitleDetails = content;
                renderSubtitles(content);
            } catch (error) {
                if (generation !== loadGeneration || !modal.isConnected) return;
                modal.querySelector('#subtitle-content').textContent = '字幕加载失败，请重新选择语言重试。';
                showToast('字幕加载失败', 'error');
            }
        }, options);
        input.focus();
        loadSubtitles();
    }

    // Modal lifetime: removed controls cannot keep global listeners or pending searches.
    function removeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;
        modal.onLiteClose?.();
        if (modalId === 'bili-transcript-modal') {
            ++loadGeneration;
            ui.controller?.abort();
            ui.controller = null;
            clearSubtitleView();
        }
        modal.remove();
        enableScroll();
    }

    function setupModalClose(modal, closeBtnId, overlayId) {
        const surface = modal.querySelector('.modal-content');
        surface?.setAttribute('role', 'dialog');
        surface?.setAttribute('aria-modal', 'true');
        surface?.setAttribute('aria-label', modal.querySelector('h2')?.textContent.trim() || '字幕工具');
        modal.querySelector(`#${closeBtnId}`)?.setAttribute('aria-label', '关闭');
        const close = () => removeModal(modal.id);
        modal.querySelector(`#${closeBtnId}`)?.addEventListener('click', close);
        modal.querySelector(`#${overlayId}`)?.addEventListener('click', close);
        modal.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.stopPropagation(); close(); }
        });
    }


    function showDownloadConfirm(content, originalData) {
        removeModal('bili-transcript-download-modal');
        disableScroll();

        const settings = StorageManager.getDownloadSettings();
        const title = state.currentVideo.title.replace(/[\\/:*?"<>|]/g, '_') || 'subtitle';
        const bvid = state.currentVideo.bvid;
        const duration = state.currentVideo.duration;

        const modal = document.createElement('div');
        modal.id = 'bili-transcript-download-modal';
        modal.className = 'bili-transcript-modal';

        const downloadMethods = [
            { value: 'direct', name: '直接下载' },
            { value: 'newtab', name: '新标签页打开' }
        ];

        modal.innerHTML = `
            <div class="modal-overlay" id="download-overlay"></div>
            <div class="modal-content download-modal">
                <div class="modal-header">
                    <h2> 下载字幕</h2>
                    <button id="close-download-modal" class="close-btn">×</button>
                </div>
                <div class="modal-body">
                    <div class="download-section">
                        <label class="download-label">文件名:</label>
                        <input type="text" id="download-filename" value="${sanitizeInput(title)}" class="download-input">
                    </div>
                    <div class="download-section">
                        <label class="download-label">输出格式:</label>
                        <select id="download-format" aria-label="输出格式">${[...CONFIG.PRESET_EXTENSIONS, ...StorageManager.getCustomExtensions()].map(ext => `<option value="${sanitizeInput(ext.value)}" ${ext.value === settings.format ? 'selected' : ''}>${sanitizeInput(ext.name)}</option>`).join('')}</select>
                    </div>
                    <div class="download-section">
                        <label class="download-label">下载方式:</label>
                        <div class="download-methods">
                            ${downloadMethods.map(method =>
            `<label class="download-method-label">
                                    <input type="radio" name="download-method" value="${method.value}" ${settings.downloadMethod === method.value ? 'checked' : ''}>
                                    <span>${method.name}</span>
                                </label>`
        ).join('')}
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="download-settings-btn" class="btn-secondary"> 设置</button>
                    <button id="confirm-download" class="btn-primary"> 确认</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-download-modal', 'download-overlay');

        const filenameInput = document.getElementById('download-filename');
        const downloadBtn = document.getElementById('confirm-download');

        const updateFilename = () => {
            let baseName = title;
            if (settings.includeBV && bvid) baseName = `${title}_${bvid}`;
            if (settings.includeTimestamp) {
                const now = new Date();
                const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
                baseName = `${baseName}_${timestamp}`;
            }
            if (settings.includeDuration && duration > 0) {
                const durationStr = formatDuration(duration);
                baseName = `${baseName}_${durationStr}`;
            }
            filenameInput.value = `${baseName}.${settings.format}`;
        };

        document.querySelectorAll('input[name="download-method"]').forEach(radio => {
            radio.addEventListener('change', () => {
                settings.downloadMethod = radio.value;
                StorageManager.saveDownloadSettings(settings);
                downloadBtn.textContent = radio.value === 'direct' ? '下载' : '打开';
            });
        });

        document.getElementById('download-settings-btn').addEventListener('click', () => {
            removeModal(modal.id);
            showSettingsModal();
        });

        downloadBtn.addEventListener('click', () => {
            const format = settings.format;
            const allExtensions = [
                ...CONFIG.PRESET_EXTENSIONS,
                ...StorageManager.getCustomExtensions()
            ];
            const matchedExt = allExtensions.find(ext => ext.value === format);
            const mimeType = matchedExt ? matchedExt.mimeType : 'text/plain';
            const filename = filenameInput.value || `${title}.${format}`;

            let convertedContent;
            switch (format) {
                case 'json': convertedContent = convertToJSON(originalData); break;
                case 'srt': convertedContent = convertToSRT(content); break;
                case 'vtt': convertedContent = convertToVTT(content); break;
                case 'csv': convertedContent = convertToCSV(content); break;
                case 'xml': convertedContent = convertToXML(content); break;
                case 'ass': convertedContent = convertToASS(content, state.currentVideo.title); break;
                case 'lrc': convertedContent = convertToLRC(content); break;
                case 'html': convertedContent = convertToHTML(content, settings.includeSubtitleTime); break;
                case 'md': convertedContent = convertToMD(content, settings.includeSubtitleTime); break;
                default:
                    convertedContent = convertToTXT(content, settings.includeSubtitleTime);
            }

            const downloadMethod = document.querySelector('input[name="download-method"]:checked').value;
            removeModal(modal.id);
            handleDownload(convertedContent, filename, mimeType, downloadMethod);
        });

        modal.querySelector('#download-format').addEventListener('change', event => {
            settings.format = event.target.value;
            updateFilename();
        });
        updateFilename();
    }

    function handleDownload(content, filename, mimeType, method) {
        switch (method) {
            case 'direct':
                downloadFile(content, filename, mimeType);
                break;
            case 'newtab':
                const blob = new Blob(['\uFEFF' + content], { type: `${mimeType};charset=UTF-8` });
                const url = URL.createObjectURL(blob);
                window.open(url, '_blank');
                setTimeout(() => URL.revokeObjectURL(url), 100);
                showToast('已在新标签页打开', 'success');
                break;
        }
    }

    function createCustomExtensionDialog(onSuccess) {
        removeModal('custom-extension-modal');
        disableScroll();
        const modal = document.createElement('div');
        modal.id = 'custom-extension-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="custom-ext-overlay"></div>
            <div class="modal-content custom-ext-modal">
                <div class="modal-header">
                    <h2> 添加自定义扩展名</h2>
                    <button id="close-custom-ext-modal" class="close-btn">×</button>
                </div>
                <div class="modal-body">
                    <div class="custom-ext-section">
                        <label class="custom-ext-label">扩展名:</label>
                        <input type="text" id="custom-ext-input" placeholder="输入扩展名（不含点，如：txt、md）" class="custom-ext-input">
                    </div>
                    <div class="custom-ext-section">
                        <label class="custom-ext-label">MIME 类型:</label>
                        <input type="text" id="custom-mime-input" placeholder="输入 MIME 类型（如：text/plain）" class="custom-ext-input">
                        <p class="mime-hint">常用 MIME 类型参考：text/plain, text/markdown, text/html, application/json</p>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="cancel-custom-ext" class="btn-secondary">取消</button>
                    <button id="confirm-custom-ext" class="btn-primary">添加</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const closeModal = () => {
            removeModal(modal.id);
            enableScroll();
        };

        document.getElementById('close-custom-ext-modal').addEventListener('click', closeModal);
        document.getElementById('custom-ext-overlay').addEventListener('click', closeModal);
        document.getElementById('cancel-custom-ext').addEventListener('click', closeModal);

        document.getElementById('confirm-custom-ext').addEventListener('click', () => {
            const extInput = document.getElementById('custom-ext-input');
            const mimeInput = document.getElementById('custom-mime-input');
            const value = extInput.value.trim().toLowerCase();
            const mimeType = mimeInput.value.trim() || 'text/plain';

            if (!value) {
                showToast('请输入扩展名', 'warning');
                return;
            }

            addCustomExtension({ name: value.toUpperCase(), value, mimeType });
            closeModal();
            onSuccess({ value, name: value.toUpperCase() });
        });
    }

    function addCustomExtension(ext) {
        const extensions = StorageManager.getCustomExtensions();
        if (!extensions.find(e => e.value === ext.value)) {
            extensions.push(ext);
            StorageManager.saveCustomExtensions(extensions);
        }
    }

    function showSettingsModal() {
        removeModal('bili-transcript-settings-modal');
        disableScroll();

        const settings = StorageManager.getDownloadSettings();
        const customExtensions = StorageManager.getCustomExtensions();

        const modal = document.createElement('div');
        modal.id = 'bili-transcript-settings-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="settings-overlay"></div>
            <div class="modal-content settings-modal">
                <div class="modal-header">
                    <h2> 下载设置</h2>
                    <button id="close-settings-modal" class="close-btn">×</button>
                </div>
                <div class="modal-body">
                    <details class="settings-section"><summary>详细信息</summary><div id="video-details"></div></details>
                    <div class="settings-section">
                        <div class="settings-header">
                            <h3>输出格式</h3>
                            <button id="add-custom-ext-btn" class="btn-small">添加</button>
                        </div>
                        <div id="format-list" class="format-list">
                            ${CONFIG.PRESET_EXTENSIONS.map(ext => `
                                <label class="format-item" data-value="${ext.value}" data-default="true" data-mime="${ext.mimeType}">
                                    <input type="radio" name="settings-format" value="${sanitizeInput(ext.value)}" ${settings.format === ext.value ? 'checked' : ''}><span class="format-name">${sanitizeInput(ext.name)}</span>
                                </label>
                            `).join('')}
                            ${customExtensions.map((ext, index) => `
                                <label class="format-item" data-value="${ext.value}" data-custom="true" data-index="${index}" data-mime="${ext.mimeType}">
                                    <input type="radio" name="settings-format" value="${sanitizeInput(ext.value)}" ${settings.format === ext.value ? 'checked' : ''}><span class="format-name">${sanitizeInput(ext.name)}</span>
                                    <button class="remove-ext-btn">删除</button>
                                </label>
                            `).join('')}
                        </div>
                    </div>
                    <div class="settings-section">
                        <h3>默认下载方式</h3>
                        <div class="download-methods">
                            <label class="download-method-label">
                                <input type="radio" name="default-method" value="direct" ${settings.downloadMethod === 'direct' ? 'checked' : ''}>
                                <span>直接下载</span>
                            </label>
                            <label class="download-method-label">
                                <input type="radio" name="default-method" value="newtab" ${settings.downloadMethod === 'newtab' ? 'checked' : ''}>
                                <span>新标签页打开</span>
                            </label>
                        </div>
                    </div>
                    <div class="settings-section">
                        <h3>字幕内容设置</h3>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-subtitle-time" ${settings.includeSubtitleTime ? 'checked' : ''}>
                            <span>包含字幕时间</span>
                        </label>
                    </div>
                    <div class="settings-section">
                        <h3>文件名设置</h3>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-bv" ${settings.includeBV ? 'checked' : ''}>
                            <span>文件名包含BV号</span>
                        </label>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-timestamp" ${settings.includeTimestamp ? 'checked' : ''}>
                            <span>文件名包含当前时间</span>
                        </label>
                        <label class="settings-checkbox">
                            <input type="checkbox" id="settings-include-duration" ${settings.includeDuration ? 'checked' : ''}>
                            <span>文件名包含视频时长</span>
                        </label>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="reset-settings" class="btn-secondary">恢复默认</button>
                    <button id="save-settings" class="btn-primary">保存</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-settings-modal', 'settings-overlay');
        updateVideoInfo();

        modal.querySelector('#format-list').addEventListener('change', event => {
            if (event.target.name === 'settings-format') settings.format = event.target.value;
        });

        document.querySelectorAll('.format-item .remove-ext-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const item = btn.closest('.format-item');
                const index = parseInt(item.getAttribute('data-index'));
                const extensions = StorageManager.getCustomExtensions();
                const removedValue = extensions[index].value;

                extensions.splice(index, 1);
                StorageManager.saveCustomExtensions(extensions);

                if (settings.format === removedValue) {
                    settings.format = 'txt';
                    StorageManager.saveDownloadSettings(settings);
                }

                removeModal(modal.id);
                showSettingsModal();
            });
        });

        document.querySelectorAll('input[name="default-method"]').forEach(radio => {
            radio.addEventListener('change', () => {
                settings.downloadMethod = radio.value;
            });
        });

        document.getElementById('settings-include-bv').addEventListener('change', () => {
            settings.includeBV = document.getElementById('settings-include-bv').checked;
        });

        document.getElementById('settings-include-subtitle-time').addEventListener('change', () => {
            settings.includeSubtitleTime = document.getElementById('settings-include-subtitle-time').checked;
        });

        document.getElementById('settings-include-timestamp').addEventListener('change', () => {
            settings.includeTimestamp = document.getElementById('settings-include-timestamp').checked;
        });

        document.getElementById('settings-include-duration').addEventListener('change', () => {
            settings.includeDuration = document.getElementById('settings-include-duration').checked;
        });

        document.getElementById('add-custom-ext-btn').addEventListener('click', () => {
            createCustomExtensionDialog(() => {
                removeModal(modal.id);
                showSettingsModal();
            });
        });

        document.getElementById('reset-settings').addEventListener('click', () => {
            Object.assign(settings, CONFIG.DEFAULT_DOWNLOAD_SETTINGS);
            StorageManager.saveDownloadSettings(settings);
            StorageManager.saveCustomExtensions([]);
            removeModal(modal.id);
            showSettingsModal();
            showToast('已恢复默认设置', 'success');
        });

        document.getElementById('save-settings').addEventListener('click', () => {
            StorageManager.saveDownloadSettings(settings);
            removeModal(modal.id);
            showToast('设置已保存', 'success');
        });
    }

    // Ask for a name only after video selection; the directory picker runs in the
    // confirm button's user activation, before any network awaits.
    function chooseBatchDirectory() {
        return new Promise(resolve => {
            removeModal('batch-name-modal');
            disableScroll();
            const modal = document.createElement('div');
            modal.id = 'batch-name-modal';
            modal.className = 'bili-transcript-modal';
            modal.innerHTML = `
                <div class="modal-overlay" id="batch-name-overlay"></div>
                <section class="modal-content">
                    <header class="modal-header"><h2>命名下载文件夹</h2><button id="close-batch-name" class="close-btn">×</button></header>
                    <form id="batch-name-form">
                        <div class="modal-body">
                            <label class="download-label" for="batch-folder-name">文件夹名称</label>
                            <input id="batch-folder-name" type="text" required maxlength="100" autocomplete="off" placeholder="例如：Linux 驱动学习字幕">
                            <p>点击确定后选择保存位置，字幕将保存到其中的新文件夹。</p>
                            <p id="batch-name-error" role="alert"></p>
                        </div>
                        <footer class="modal-footer"><button type="button" id="cancel-batch-name">取消</button><button type="submit" id="confirm-batch-name" class="btn-primary">确定</button></footer>
                    </form>
                </section>`;
            document.body.append(modal);
            let settled = false;
            modal.onLiteClose = () => { if (!settled) { settled = true; resolve(null); } };
            setupModalClose(modal, 'close-batch-name', 'batch-name-overlay');
            modal.querySelector('#cancel-batch-name').onclick = () => removeModal(modal.id);
            const input = modal.querySelector('#batch-folder-name');
            const error = modal.querySelector('#batch-name-error');
            const button = modal.querySelector('#confirm-batch-name');
            input.focus();
            modal.querySelector('form').addEventListener('submit', async event => {
                event.preventDefault();
                if (button.disabled || settled) return;
                const name = input.value.trim();
                if (!name || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || /[. ]$/.test(name)
                    || /^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
                    error.textContent = '请输入有效名称，不含路径符号、保留名称或末尾句点。';
                    input.focus();
                    return;
                }
                const owner = typeof window.showDirectoryPicker === 'function' ? window : pageWindow;
                if (typeof owner.showDirectoryPicker !== 'function') {
                    error.textContent = '当前浏览器不支持直接保存文件夹，请使用支持此功能的 Chrome 或 Edge。';
                    return;
                }
                button.disabled = true;
                error.textContent = '';
                try {
                    const parent = await owner.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads', id: 'bili-transcript-batch' });
                    if (settled || !modal.isConnected) return;
                    try {
                        await parent.getDirectoryHandle(name);
                        throw new Error('同名文件夹已存在，请换一个名称，避免覆盖原有文件。');
                    } catch (existing) {
                        if (existing.name !== 'NotFoundError') throw existing;
                    }
                    if (settled || !modal.isConnected) return;
                    const directory = await parent.getDirectoryHandle(name, { create: true });
                    if (settled || !modal.isConnected) return;
                    settled = true;
                    removeModal(modal.id);
                    resolve({ directory, name });
                } catch (failure) {
                    if (settled) return;
                    error.textContent = failure.name === 'AbortError' ? '已取消选择保存位置，可以重试或取消。'
                        : failure.name === 'NotAllowedError' || failure.name === 'SecurityError'
                            ? '未获得目录写入权限，请重新选择并允许写入。' : failure.message || '无法创建文件夹，请重试。';
                } finally { button.disabled = false; }
            });
        });
    }

    async function saveSubtitleToDirectory(directory, content, filename, mimeType) {
        // One filename component only, including for custom extensions. Never overwrite.
        const safe = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
        const dot = safe.lastIndexOf('.');
        const stem = (dot > 0 ? safe.slice(0, dot) : safe).slice(0, 160) || 'subtitle';
        const extension = dot > 0 ? safe.slice(dot, dot + 30) : '';
        const base = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem) ? '_' + stem : stem;
        for (let index = 0; index < 10000; index++) {
            const name = `${base}${index ? ` (${index + 1})` : ''}${extension}`;
            try { await directory.getFileHandle(name); continue; }
            catch (error) { if (error.name !== 'NotFoundError') throw error; }
            const file = await directory.getFileHandle(name, { create: true });
            const stream = await file.createWritable();
            try {
                await stream.write(new Blob([content], { type: mimeType }));
                await stream.close();
                return;
            } catch (error) {
                await stream.abort().catch(() => {});
                throw error;
            }
        }
        throw new Error('同名文件过多，无法保存。');
    }

    function showBatchDownloadModal() {
        removeModal('batch-download-modal');
        disableScroll();

        let videoList = state.videoList;
        if (!videoList?.length) {
            videoList = [{
                bvid: state.currentVideo.bvid,
                cid: state.currentVideo.cid,
                title: state.currentVideo.title
            }];
        }

        const modal = document.createElement('div');
        modal.id = 'batch-download-modal';
        modal.className = 'bili-transcript-modal';
        modal.innerHTML = `
            <div class="modal-overlay" id="batch-overlay"></div>
            <div class="modal-content batch-modal">
                <div class="modal-header">
                    <h2> 批量下载字幕</h2>
                    <button id="close-batch-modal" class="close-btn">×</button>
                </div>
                <div class="modal-body">
                    <div class="batch-section">
                        <div class="batch-header">
                            <h3>选择视频 (${videoList.length}个)</h3>
                            <div class="batch-actions">
                                <button id="select-all" class="btn-small">全选</button>
                                <button id="deselect-all" class="btn-small">取消全选</button>
                            </div>
                        </div>
                        <div id="video-checkboxes" class="checkbox-list"></div>
                        <div id="batch-selection-count" aria-live="polite"></div>
                    </div>
                    <div class="batch-section">
                        <h3>字幕语言</h3>
                        <select id="batch-language" aria-label="字幕语言"><option value="auto">自动选择</option></select>
                    </div>
                    <div class="batch-section">
                        <h3>输出格式</h3>
                        <div style="padding: 12px 14px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; font-size: 14px; color: var(--text-secondary);">
                            当前设置: <span style="color: var(--text-primary); font-weight: 500;">${StorageManager.getDownloadSettings().format.toUpperCase()}</span>
                            <span style="margin-left: 8px; font-size: 12px; color: var(--text-muted);">(可在设置中修改)</span>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button id="start-batch-download" class="btn-primary"> 开始下载</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        setupModalClose(modal, 'close-batch-modal', 'batch-overlay');



        const videoCheckboxes = document.getElementById('video-checkboxes');
        if (videoList.length === 0) {
            videoCheckboxes.innerHTML = `<p style="color: var(--text-muted); text-align: center;">暂无可选视频</p>`;
        } else {
            videoList.forEach((video, index) => {
                const checkbox = document.createElement('label');
                checkbox.className = 'checkbox-item';
                const title = video.title || '未知标题';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.value = video.bvid;
                input.dataset.cid = video.cid || '';
                input.checked = true;
                const titleSpan = document.createElement('span');
                titleSpan.className = 'batch-video-title';
                titleSpan.textContent = `${index + 1}. ${title}`;
                const status = document.createElement('span');
                status.className = 'batch-selection-state';
                status.setAttribute('aria-hidden', 'true');
                checkbox.append(input, titleSpan, status);
                videoCheckboxes.appendChild(checkbox);
            });
        }

        const updateBatchSelection = () => {
            const inputs = Array.from(videoCheckboxes.querySelectorAll('input'));
            inputs.forEach(input => {
                input.parentElement.querySelector('.batch-selection-state').textContent = input.checked ? '已选' : '未选';
            });
            document.getElementById('batch-selection-count').textContent = `已选择 ${inputs.filter(input => input.checked).length} / ${inputs.length} 个视频`;
        };
        videoCheckboxes.addEventListener('change', updateBatchSelection);
        updateBatchSelection();

        document.getElementById('select-all').addEventListener('click', () => {
            document.querySelectorAll('#video-checkboxes input').forEach(cb => cb.checked = true);
            updateBatchSelection();
        });

        document.getElementById('deselect-all').addEventListener('click', () => {
            document.querySelectorAll('#video-checkboxes input').forEach(cb => cb.checked = false);
            updateBatchSelection();
        });

        document.getElementById('start-batch-download').addEventListener('click', batchDownloadSubtitles);

        async function batchDownloadSubtitles() {
            const selectedVideos = Array.from(document.querySelectorAll('#video-checkboxes input:checked'))
                .map(cb => ({
                    bvid: cb.value,
                    cid: cb.getAttribute('data-cid') || ''
                }));

            const settings = StorageManager.getDownloadSettings();
            const format = settings.format;

            if (selectedVideos.length === 0) {
                showToast('请选择至少一个视频', 'warning');
                return;
            }

            const startButton = modal.querySelector('#start-batch-download');
            if (startButton.disabled) return;
            startButton.disabled = true;
            const destination = await chooseBatchDirectory();
            if (!destination || !modal.isConnected) {
                startButton.disabled = false;
                return;
            }
            let completed = 0;
            showToast(`开始下载 ${selectedVideos.length} 个视频的字幕...`, 'info');

            for (const video of selectedVideos) {
                try {
                    if (await downloadVideoSubtitle(video, format, settings, (content, filename, mimeType) =>
                        saveSubtitleToDirectory(destination.directory, content, filename, mimeType))) completed++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                    console.error(`下载 ${video.bvid} 字幕失败:`, error);
                }
            }

            showToast(`已保存到「${destination.name}」：${completed}/${selectedVideos.length}；未完成 ${selectedVideos.length - completed} 个`, completed === selectedVideos.length ? 'success' : 'warning', 6000);
            // A closed old batch must never close a newly opened selection dialog.
            if (document.getElementById(modal.id) === modal) removeModal(modal.id);
        }
    }

    async function downloadVideoSubtitle(video, format, settings, saveFile = downloadFile) {
        let cid = video.cid;
        if (!cid) cid = await getVideoCID(video.bvid);
        if (!cid) return;

        let subtitles = await fetchSubtitles(video.bvid, cid);
        if (subtitles.length === 0) return;

        const selectedSubtitle = subtitles.find(s => !s.lan.includes('摘要') && !s.lan.includes('AI') && s.lan.includes('中文')) || subtitles[0];
        if (!selectedSubtitle.url) return;

        const content = await getSubtitleContent(selectedSubtitle.url, video.bvid, cid, selectedSubtitle.id);
        if (content.length === 0) return;

        const videoInfo = await getVideoInfo(video.bvid);
        const part = videoInfo.data?.pages?.find(p => String(p.cid) === String(cid));
        const title = part && videoInfo.data.pages.length > 1
            ? `${videoInfo.data.title} - P${part.page} ${part.part || ''}` : videoInfo.data?.title || video.bvid;
        const duration = part?.duration || videoInfo.data?.duration || 0;

        let filename = title.replace(/[\\/:*?"<>|]/g, '_');
        if (settings.includeBV && video.bvid) filename = `${filename}_${video.bvid}`;
        if (settings.includeTimestamp) {
            const now = new Date();
            const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
            filename = `${filename}_${timestamp}`;
        }
        if (settings.includeDuration && duration > 0) {
            const durationStr = formatDuration(duration);
            filename = `${filename}_${durationStr}`;
        }

        let convertedContent;
        let mimeType = 'text/plain';

        switch (format) {
            case 'md': convertedContent = convertToMD(content, settings.includeSubtitleTime); mimeType = 'text/markdown'; break;
            case 'html': convertedContent = convertToHTML(content, settings.includeSubtitleTime); mimeType = 'text/html'; break;
            case 'srt': convertedContent = convertToSRT(content); mimeType = 'text/x-subrip'; break;
            case 'vtt': convertedContent = convertToVTT(content); mimeType = 'text/vtt'; break;
            case 'json': convertedContent = convertToJSON(content); mimeType = 'application/json'; break;
            case 'csv': convertedContent = convertToCSV(content); mimeType = 'text/csv'; break;
            case 'xml': convertedContent = convertToXML(content); mimeType = 'application/xml'; break;
            case 'ass': convertedContent = convertToASS(content, title); mimeType = 'text/x-ass'; break;
            case 'lrc': convertedContent = convertToLRC(content); mimeType = 'text/lrc'; break;
            default: convertedContent = convertToTXT(content, settings.includeSubtitleTime);
        }

        await saveFile(convertedContent, `${filename}.${format}`, mimeType);
        return true;
    }

    function createFloatButton() {
        removeModal('bili-transcript-btn');

        const btn = document.createElement('button');
        btn.id = 'bili-transcript-btn';
        btn.className = 'bili-transcript-btn';
        btn.textContent = '字幕';
        btn.title = '提取字幕';
        btn.addEventListener('click', createModal);
        document.body.appendChild(btn);
    }

    function initVideoList() {
        const videos = getVideoList();
        if (videos.length > 1) {
            state.videoList = videos;
            state.videoListType = 'collection';
        } else if (videos.length === 1) {
            state.videoList = videos;
            state.videoListType = 'single';
        } else {
            state.videoList = [];
            state.videoListType = 'single';
        }
    }

    function init() {
        state.currentVideo = getCurrentVideoInfo();
        initVideoList();
        injectStyles();
        createFloatButton();
        let lastRoute = `${location.pathname}${location.search}`;
        setInterval(() => {
            const route = `${location.pathname}${location.search}`;
            if (route === lastRoute) return;
            lastRoute = route;
            ++loadGeneration;
            state.currentVideo = getCurrentVideoInfo();
            state.subtitleDetails = [];
            state.subtitleList = [];
            initVideoList();
            if (document.getElementById('bili-transcript-modal')) {
                const content = document.getElementById('subtitle-content');
                if (content) content.textContent = '正在加载当前分P字幕…';
                loadSubtitles();
            }
        }, 500);
    }

    // Scoped Lite UI stylesheet.
    function injectStyles() {
        if (document.getElementById('bili-transcript-lite-style')) return;
        const style = document.createElement('style');
        style.id = 'bili-transcript-lite-style';
        style.textContent = `
/* All UI styles are scoped; never override Bilibili's :root or generic controls. */
.bili-transcript-modal, .bili-transcript-toast, .bili-transcript-btn {
    --primary: #79442b; --primary-dark: #60341f;
    --bg-primary: #fffdfb; --bg-white: #fffdfb; --bg-secondary: #fff8ef;
    --bg-surface: #fff0dc; --bg-hover: #f9e4c8; --bg-selected: #fff0dc;
    --text-primary: #352a25; --text-secondary: #65554b; --text-muted: #65554b;
    --border: #d6c7bb;
    font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif;
    color: var(--text-primary); color-scheme: light;
}
.bili-transcript-modal { position: fixed; inset: 0; z-index: 10002; display: flex; align-items: center; justify-content: center; }
.bili-transcript-modal *, .bili-transcript-modal *::before, .bili-transcript-modal *::after { box-sizing: border-box; }
.bili-transcript-modal [hidden] { display: none !important; }
.bili-transcript-modal .modal-overlay { position: absolute; inset: 0; background: rgba(0,0,0,.35); }
.bili-transcript-modal .modal-content { position: relative; width: min(640px,92vw); max-height: 88vh; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-primary); box-shadow: 0 8px 24px rgba(0,0,0,.16); display: flex; flex-direction: column; overflow: hidden; }
.bili-transcript-modal .modal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 18px; background: #ead9cc; flex-shrink: 0; }
.bili-transcript-modal h2 { font-size: 17px; margin: 0; color: var(--text-primary); }
.bili-transcript-modal h3 { font-size: 14px; margin: 0 0 10px; color: var(--text-primary); }
.bili-transcript-modal button { font: inherit; color: var(--text-primary); background: var(--bg-white); border: 1px solid var(--border); border-radius: 6px; padding: 7px 12px; cursor: pointer; }
.bili-transcript-modal button:hover { background: var(--bg-hover); border-color: var(--primary); }
.bili-transcript-modal button:disabled { opacity: .55; cursor: default; }
.bili-transcript-modal :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.bili-transcript-modal .btn-primary { background: var(--primary); color: #fff; border-color: var(--primary); }
.bili-transcript-modal .btn-primary:hover { background: var(--primary-dark); }
.bili-transcript-modal .close-btn { padding: 0; width: 34px; height: 34px; font-size: 22px; }
.bili-transcript-modal .modal-body { padding: 18px; overflow-y: auto; min-height: 0; }
.bili-transcript-modal .modal-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--border); flex-shrink: 0; }
.bili-transcript-modal .footer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.bili-transcript-modal input:not([type=checkbox]):not([type=radio]), .bili-transcript-modal select { font: inherit; color: var(--text-primary); background: var(--bg-white); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; width: 100%; min-width: 0; }
.bili-transcript-modal input[type=checkbox], .bili-transcript-modal input[type=radio] { accent-color: var(--primary); width: 18px; height: 18px; flex-shrink: 0; }
.bili-transcript-modal .lite-main { width: min(720px,92vw); height: min(760px,88vh); }
.bili-transcript-modal .lite-main .modal-footer { justify-content: space-between; }
.bili-transcript-modal .lite-controls { padding: 14px 18px 10px; flex-shrink: 0; }
.bili-transcript-modal #video-title { font-weight: 600; margin-bottom: 10px; overflow-wrap: anywhere; max-height: 4.5em; overflow-y: auto; }
.bili-transcript-modal .lite-selectors { display: flex; gap: 10px; margin-bottom: 10px; }
.bili-transcript-modal .lite-selectors label { flex: 1; min-width: 0; font-size: 12px; color: var(--text-secondary); }
.bili-transcript-modal .lite-selectors select { margin-top: 3px; font-size: 14px; }
.bili-transcript-modal .search-container { display: flex; align-items: center; gap: 6px; }
.bili-transcript-modal #subtitle-search { flex: 1; }
.bili-transcript-modal #search-status { font-size: 12px; min-width: 42px; text-align: center; white-space: nowrap; }
.bili-transcript-modal .subtitle-content { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 18px; border-top: 1px solid var(--border); }
.bili-transcript-modal .subtitle-item { display: flex; align-items: baseline; gap: 14px; width: 100%; text-align: left; border: 0; border-bottom: 1px solid #eee3d8; border-radius: 0; padding: 9px 8px; background: transparent; }
.bili-transcript-modal .subtitle-time { color: var(--text-secondary); font-size: 12px; min-width: 48px; font-variant-numeric: tabular-nums; flex-shrink: 0; }
.bili-transcript-modal .subtitle-text { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.bili-transcript-modal .subtitle-item.search-match { background: #fff0dc; }
.bili-transcript-modal .subtitle-item.search-selected { background: #f9e4c8; box-shadow: inset 3px 0 var(--primary); }
.bili-transcript-modal mark { color: #352a25; background: #f6cf8a; }
.bili-transcript-modal .no-subtitles { padding: 24px 8px; text-align: center; }
.bili-transcript-modal .no-subtitles ul { text-align: left; display: inline-block; }
.bili-transcript-modal .settings-section, .bili-transcript-modal .download-section, .bili-transcript-modal .batch-section { margin-bottom: 20px; }
.bili-transcript-modal .settings-header, .bili-transcript-modal .batch-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.bili-transcript-modal .settings-header h3, .bili-transcript-modal .batch-header h3 { margin: 0; }
.bili-transcript-modal .batch-actions { display: flex; gap: 8px; }
.bili-transcript-modal .format-list { display: flex; flex-wrap: wrap; gap: 8px; }
.bili-transcript-modal .format-item { display: flex; align-items: center; gap: 6px; padding: 8px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
.bili-transcript-modal .format-item:has(input:checked) { background: var(--bg-selected); border-color: var(--primary); }
.bili-transcript-modal .remove-ext-btn { padding: 2px 6px; font-size: 12px; }
.bili-transcript-modal .download-methods { display: flex; flex-wrap: wrap; gap: 12px; }
.bili-transcript-modal .download-method-label, .bili-transcript-modal .settings-checkbox { display: flex; align-items: center; gap: 8px; padding: 8px 0; cursor: pointer; }
.bili-transcript-modal .download-label, .bili-transcript-modal .custom-ext-label { display: block; margin-bottom: 6px; }
.bili-transcript-modal .custom-ext-section { margin-bottom: 12px; }
.bili-transcript-modal #video-details { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 8px; }
.bili-transcript-modal summary { cursor: pointer; }
.bili-transcript-modal .checkbox-list { max-height: 290px; overflow-y: auto; background: #fff8ef; border: 1px solid var(--border); border-radius: 8px; padding: 8px; display: grid; gap: 8px; scrollbar-color: #94735d #fff8ef; }
.bili-transcript-modal .checkbox-item { display: flex; align-items: center; gap: 11px; color: var(--text-primary); background: #fffdfb; border: 1px solid var(--border); border-radius: 8px; padding: 12px; min-height: 52px; cursor: pointer; }
.bili-transcript-modal .checkbox-item:has(input:checked) { background: #fff0dc; border-color: var(--primary); box-shadow: inset 3px 0 var(--primary); }
.bili-transcript-modal .checkbox-item:hover { background: #f9e4c8; border-color: var(--primary); }
.bili-transcript-modal .batch-video-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.bili-transcript-modal .batch-selection-state { color: var(--text-secondary); font-size: 12px; flex-shrink: 0; }
.bili-transcript-modal #batch-selection-count { margin-top: 8px; color: var(--text-secondary); font-size: 13px; }
.bili-transcript-btn { position: fixed; right: 24px; bottom: 80px; z-index: 10001; border: 1px solid #79442b; background: #fff0dc; padding: 10px 14px; border-radius: 8px; cursor: pointer; }
.bili-transcript-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 10006; max-width: 90vw; padding: 10px 16px; border: 1px solid #94735d; border-radius: 6px; background: #fff0dc; animation: lite-fade .12s; }
@keyframes lite-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .bili-transcript-toast { animation: none; } }
@media (max-width:480px) {
    .bili-transcript-modal .lite-selectors { flex-direction: column; gap: 6px; }
    .bili-transcript-modal .modal-header, .bili-transcript-modal .modal-footer { padding: 10px 12px; }
    .bili-transcript-modal .lite-controls { padding: 10px 12px; }
    .bili-transcript-modal .subtitle-content { padding: 6px; }
    .bili-transcript-modal .batch-selection-state { display: none; }
    .bili-transcript-modal button { padding: 7px 9px; }
}
        `;
        document.head.appendChild(style);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
