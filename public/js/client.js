// public/js/client.js (包含所有新功能 + 文件编辑器 + 中文注释)

// --- (终端设置无变动) ---
const term = new Terminal({ cursorBlink: true, fontFamily: 'Monospace', fontSize: 16, theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' } });
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
setTimeout(() => fitAddon.fit(), 100);
term.focus();
window.addEventListener('resize', () => { fitAddon.fit(); });

// --- (WebSocket 通信无变动) ---
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${window.location.host}`);
ws.binaryType = 'arraybuffer';
ws.onopen = function() { term.write('\x1b[32m[WebSocket] 后端Websocket已连接! 正在获取远程管道 Shell...\x1b[0m\r\n'); const initialSize = { type: 'resize', cols: term.cols, rows: term.rows }; ws.send(JSON.stringify(initialSize)); };
ws.onclose = function() { term.write('\r\n\x1b[31m[WebSocket] 连接已关闭。\x1b[0m'); };
ws.onerror = function(event) { console.error("WebSocket 错误: ", event); term.write(`\r\n\x1b[31m[WebSocket] 发生错误，请查看开发者控制台。\x1b[0m`); };
term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
term.onKey(async ({ key, domEvent }) => { if (domEvent.ctrlKey && domEvent.shiftKey && (domEvent.key === 'C' || domEvent.key === 'c')) { domEvent.preventDefault(); const selection = term.getSelection(); if (selection) { try { await navigator.clipboard.writeText(selection); } catch (err) { console.error('复制文本失败: ', err); term.write('\r\n\x1b[31m[剪贴板复制失败。]\x1b[0m\r\n'); } } return; } if (domEvent.ctrlKey && domEvent.shiftKey && (domEvent.key === 'V' || domEvent.key === 'v')) { domEvent.preventDefault(); try { const text = await navigator.clipboard.readText(); if (ws.readyState === WebSocket.OPEN) { ws.send(text); } } catch (err) { console.error('读取剪贴板内容失败: ', err); term.write('\r\n\x1b[31m[剪贴板粘贴失败，权限可能被拒绝。]\x1b[0m\r\n'); } return; } });

// --- (状态面板逻辑无变动) ---
const statsContent = document.getElementById('stats-content');
const toggleBtn = document.getElementById('toggle-stats-btn');
toggleBtn.addEventListener('click', () => { statsContent.classList.toggle('hidden'); toggleBtn.innerHTML = statsContent.classList.contains('hidden') ? '展开信息 ▼' : '收起信息 ▲'; });
function updateStatsDisplay(statsData) { if (statsContent) { statsContent.innerHTML = `<strong>系统:</strong> ${statsData.osName}<br><strong>IP 地址:</strong> ${statsData.ip}<br><strong>CPU:</strong> ${statsData.cpuCores} x ${statsData.cpuModel.split('@')[0].trim()}<br><strong>内存:</strong> ${statsData.freeMem} 空闲 / ${statsData.totalMem} 总共<br><strong>在线时长:</strong> ${statsData.uptime}<br><strong>网络:</strong> <span class="speed-icon">↓</span> ${statsData.rxSpeed} / <span class="speed-icon">↑</span> ${statsData.txSpeed}`; } }
ws.onmessage = function(event) { if (event.data instanceof ArrayBuffer) { term.write(new Uint8Array(event.data)); return; } try { const msg = JSON.parse(event.data); if (msg.type === 'stats' && msg.data) updateStatsDisplay(msg.data); } catch (e) { term.write(event.data); } };


// --- 文件浏览器逻辑 ---
const fileListEl = document.getElementById('file-list');
const currentPathEl = document.getElementById('current-path');
const fileInput = document.getElementById('file-input');
const uploadPathInput = document.getElementById('upload-path');
const uploadStatusEl = document.getElementById('upload-status');
let currentPath = '/root'; // 默认起始路径

const contextMenu = document.getElementById('context-menu');
const renameBtn = document.getElementById('rename-btn');
const deleteBtn = document.getElementById('delete-btn');
const packageBtn = document.getElementById('package-btn');

// ===【【【 新增: 编辑器与上下文菜单元素 】】】===
const editBtn = document.getElementById('edit-btn');
const editorModal = document.getElementById('editor-modal');
const editorFilenameEl = document.getElementById('editor-filename');
const editorTextarea = document.getElementById('editor-textarea');
const saveFileBtn = document.getElementById('save-file-btn');
const closeEditorBtn = document.getElementById('close-editor-btn');
const editorStatusEl = document.getElementById('editor-status');


async function fetchAndDisplayFiles(pathStr) {
    fileListEl.innerHTML = '<li><i class="fas fa-spinner fa-spin fa-fw"></i> 加载中...</li>';
    try {
        const response = await fetch(`/api/files?path=${encodeURIComponent(pathStr)}`);
        if (!response.ok) { const err = await response.json(); throw new Error(err.error || '获取文件列表失败'); }
        const data = await response.json();
        currentPath = data.path;
        currentPathEl.textContent = currentPath;
        uploadPathInput.value = currentPath;
        renderFileList(data.files);
    } catch (error) {
        fileListEl.innerHTML = `<li><i class="fas fa-exclamation-triangle fa-fw"></i> 错误: ${error.message}</li>`;
    }
}

// ===【【【 新增: 检查文件是否可编辑的辅助函数 】】】===
function isEditable(filename) {
    const editableExtensions = [
        '.txt', '.log', '.json', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.cnf',
        '.md', '.sh', '.bash', '.zsh', '.c', '.cpp', '.h', '.hpp', '.cs', '.java',
        '.js', '.ts', '.css', '.scss', '.html', '.htm', '.php', '.py', '.rb', '.go', 'dockerfile', '.env'
    ];
    const lowerFilename = filename.toLowerCase();
    // 检查文件名本身是否可编辑 (如 'Dockerfile') 或是否具有可编辑的扩展名
    return editableExtensions.some(ext => lowerFilename.endsWith(ext)) || editableExtensions.includes(lowerFilename);
}

// ===【【【 修改: renderFileList 函数，为编辑器添加 ondblclick 事件 】】】===
function renderFileList(files) {
    fileListEl.innerHTML = '';
    if (currentPath !== '/') {
        const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
        const li = document.createElement('li');
        li.innerHTML = `<i class="fas fa-level-up-alt fa-fw"></i> ..`;
        li.onclick = () => fetchAndDisplayFiles(parentPath);
        li.classList.add('no-context');
        fileListEl.appendChild(li);
    }
    files.forEach(file => {
        const li = document.createElement('li');
        const icon = file.type === 'dir' ? 'fa-folder' : 'fa-file-alt';
        const size = file.type === 'file' ? formatBytes(file.size) : '';
        const fullPath = (currentPath === '/' ? '' : currentPath) + '/' + file.name;
        li.dataset.path = fullPath;
        li.dataset.type = file.type;
        li.dataset.name = file.name;
        li.innerHTML = `<i class="fas ${icon} fa-fw"></i><span class="file-name">${file.name}</span><span class="file-size">${size}</span>`;

        if (file.type === 'dir') {
            li.onclick = () => fetchAndDisplayFiles(fullPath);
        } else {
            // 单击: 下载
            li.onclick = () => { window.location.href = `/api/download?path=${encodeURIComponent(fullPath)}`; };
            
            // 双击: 如果可编辑，则在编辑器中打开
            if (isEditable(file.name)) {
                li.ondblclick = (e) => {
                    e.preventDefault(); // 防止双击时选中文本
                    openFileInEditor(fullPath);
                };
                 li.style.cursor = 'cell'; // 给出不同的视觉提示
            }
        }
        fileListEl.appendChild(li);
    });
}

// ===【【【 修改: 上下文菜单逻辑 (用于显示/隐藏编辑按钮) 】】】===
fileListEl.addEventListener('contextmenu', (e) => {
    const targetLi = e.target.closest('li');
    if (!targetLi || targetLi.classList.contains('no-context')) return;
    e.preventDefault();

    contextMenu.dataset.path = targetLi.dataset.path;
    contextMenu.dataset.type = targetLi.dataset.type;
    contextMenu.dataset.name = targetLi.dataset.name;
    
    // 根据项目类型显示/隐藏菜单项
    const isDir = targetLi.dataset.type === 'dir';
    const canBeEdited = !isDir && isEditable(targetLi.dataset.name);

    packageBtn.classList.toggle('hidden', !isDir);
    editBtn.classList.toggle('hidden', !canBeEdited);

    contextMenu.style.display = 'block';
    contextMenu.style.left = `${e.pageX}px`;
    contextMenu.style.top = `${e.pageY}px`;
});

window.addEventListener('click', () => { contextMenu.style.display = 'none'; });

// 上下文菜单操作的事件处理
renameBtn.addEventListener('click', async () => { const oldPath = contextMenu.dataset.path; const oldName = contextMenu.dataset.name; if (!oldPath) return; const newName = prompt('输入新名称:', oldName); if (!newName || newName === oldName) return; const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/'; const newPath = (parentDir === '/' ? '' : parentDir) + '/' + newName; try { const response = await fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPath, newPath }), }); const result = await response.json(); if (!response.ok) throw new Error(result.error); showStatusMessage(`已重命名为 ${newName}`, 'success'); fetchAndDisplayFiles(currentPath); } catch (error) { showStatusMessage(`重命名失败: ${error.message}`, 'error'); } });
deleteBtn.addEventListener('click', async () => { const pathToDelete = contextMenu.dataset.path; const typeToDelete = contextMenu.dataset.type; const nameToDelete = contextMenu.dataset.name; if (!pathToDelete) return; if (confirm(`您确定要删除 "${nameToDelete}" 吗?`)) { try { const response = await fetch('/api/delete', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pathToDelete, type: typeToDelete }), }); const result = await response.json(); if (!response.ok) throw new Error(result.error); showStatusMessage(`已删除 "${nameToDelete}"`, 'success'); fetchAndDisplayFiles(currentPath); } catch (error) { showStatusMessage(`删除失败: ${error.message}`, 'error'); } } });
packageBtn.addEventListener('click', () => { const pathToPackage = contextMenu.dataset.path; const nameToPackage = contextMenu.dataset.name; if (!pathToPackage) return; showStatusMessage(`正在打包 "${nameToPackage}"...`, 'success'); window.location.href = `/api/package-download?path=${encodeURIComponent(pathToPackage)}`; });

// ===【【【 新增: 在线文件编辑器逻辑 】】】===
editBtn.addEventListener('click', () => {
    const path = contextMenu.dataset.path;
    if (path) {
        openFileInEditor(path);
    }
});

async function openFileInEditor(filePath) {
    editorStatusEl.textContent = '加载中...';
    editorStatusEl.style.color = '#ccc';
    editorModal.style.display = 'flex';
    editorTextarea.value = '';
    editorFilenameEl.textContent = filePath.split('/').pop();
    editorModal.dataset.filePath = filePath; // 存储路径以便保存

    try {
        const response = await fetch(`/api/file-content?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || '加载文件失败');
        }
        const content = await response.text();
        editorTextarea.value = content;
        editorTextarea.focus();
        editorStatusEl.textContent = '加载成功。';
        setTimeout(() => editorStatusEl.textContent = '', 3000);
    } catch (error) {
        editorStatusEl.textContent = `错误: ${error.message}`;
        editorStatusEl.style.color = '#ff4444';
    }
}

function closeEditor() {
    editorModal.style.display = 'none';
    editorTextarea.value = '';
    editorFilenameEl.textContent = '';
    delete editorModal.dataset.filePath;
    term.focus(); // 将焦点返回到终端
}

async function saveFile() {
    const filePath = editorModal.dataset.filePath;
    if (!filePath) return;

    const content = editorTextarea.value;
    editorStatusEl.textContent = '保存中...';
    editorStatusEl.style.color = '#ffcc00';
    saveFileBtn.disabled = true;

    try {
        const response = await fetch('/api/save-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content: content }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        
        editorStatusEl.textContent = '保存成功!';
        editorStatusEl.style.color = '#00ff00';
        setTimeout(() => editorStatusEl.textContent = '', 3000);
    } catch (error) {
        editorStatusEl.textContent = `保存失败: ${error.message}`;
        editorStatusEl.style.color = '#ff4444';
    } finally {
        saveFileBtn.disabled = false;
    }
}

// 编辑器的事件监听
saveFileBtn.addEventListener('click', saveFile);
closeEditorBtn.addEventListener('click', closeEditor);
editorModal.addEventListener('click', (e) => {
    if (e.target === editorModal) { // 点击背景遮罩
        closeEditor();
    }
});
// 编辑器的键盘快捷键
window.addEventListener('keydown', (e) => {
    if (editorModal.style.display === 'flex') {
        if (e.key === 'Escape') {
            closeEditor();
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveFile();
        }
    }
});

// --- 上传逻辑 ---
async function handleUpload() { if (fileInput.files.length === 0) { showStatusMessage('请先选择一个文件。', 'warning'); return; } const formData = new FormData(document.getElementById('upload-form')); showStatusMessage('上传中...', 'success'); try { const response = await fetch('/api/upload', { method: 'POST', body: formData }); const result = await response.json(); if (!response.ok) throw new Error(result.error || '上传失败'); showStatusMessage('上传成功!', 'success'); fileInput.value = ''; fetchAndDisplayFiles(currentPath); } catch (error) { showStatusMessage(`错误: ${error.message}`, 'error'); } }
fileInput.addEventListener('change', handleUpload);
function showStatusMessage(message, type = 'success') { uploadStatusEl.textContent = message; if (type === 'success') { uploadStatusEl.style.color = '#00ff00'; } else if (type === 'error') { uploadStatusEl.style.color = '#ff4444'; } else if (type === 'warning') { uploadStatusEl.style.color = '#ffcc00'; } if (type !== 'error') { setTimeout(() => (uploadStatusEl.textContent = ''), 4000); } }
function formatBytes(bytes) { if (bytes === 0) return '0 B'; const k = 1024; const sizes = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]; }

// 页面初始加载
document.addEventListener('DOMContentLoaded', () => {
    fetchAndDisplayFiles(currentPath);
    navigator.permissions.query({ name: 'clipboard-read' }).then(result => { if (result.state == 'granted' || result.state == 'prompt') { console.log('剪贴板读取权限可用。'); } });
});