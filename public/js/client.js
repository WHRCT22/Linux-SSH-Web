// client.js

// --- (终端设置 - 无变动) ---
const term = new Terminal({
    cursorBlink: true,
    fontFamily: `'JetBrains Mono', 'Roboto Mono', 'Consolas', 'Monaco', 'Cascadia Mono', 'Microsoft YaHei Consolas', '思源黑体', 'Noto Sans Mono CJK SC', monospace`,
    fontSize: 18,
    theme: { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' }
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
setTimeout(() => fitAddon.fit(), 100);
term.focus();
window.addEventListener('resize', () => { fitAddon.fit(); });

// --- (WebSocket 通信 - 无变动，但加上了 ArrayBuffer 处理) ---
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${window.location.host}`);
ws.binaryType = 'arraybuffer'; // 重要：接收二进制数据

ws.onopen = function() {
    term.write('\x1b[32m[WebSocket] 后端Websocket已连接! 正在获取远程管道 Shell...\x1b[0m\r\n');
    const initialSize = { type: 'resize', cols: term.cols, rows: term.rows };
    ws.send(JSON.stringify(initialSize));
};
ws.onclose = function() {
    term.write('\r\n\x1b[31m[WebSocket] 连接已关闭。\x1b[0m');
};
ws.onerror = function(event) {
    console.error("WebSocket 错误: ", event);
    term.write(`\r\n\x1b[31m[WebSocket] 发生错误，请查看开发者控制台。\x1b[0m`);
};

// 终端数据发送到WebSocket
term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
    }
});

// 终端尺寸变化时发送给WebSocket
term.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
});

// --- (键盘快捷键修改: 复制变为 Ctrl+Alt+C, 粘贴保持 Ctrl+Shift+V) ---
term.onKey(async ({ key, domEvent }) => {
    // 复制 (Ctrl+Alt+C)
    if (domEvent.ctrlKey && domEvent.altKey && (domEvent.key === 'C' || domEvent.key === 'c')) {
        domEvent.preventDefault(); // 阻止浏览器默认行为
        const selection = term.getSelection();
        if (selection) {
            try {
                await navigator.clipboard.writeText(selection);
                term.write('\r\n\x1b[32m[文本已复制到剪贴板。]\x1b[0m\r\n');
            } catch (err) {
                console.error('复制文本失败: ', err);
                term.write('\r\n\x1b[31m[剪贴板复制失败，可能需要用户授权。]\x1b[0m\r\n');
            }
        }
        return;
    }
    // 粘贴 (Ctrl+Shift+V)
    if (domEvent.ctrlKey && domEvent.shiftKey && (domEvent.key === 'V' || domEvent.key === 'v')) {
        domEvent.preventDefault(); // 阻止浏览器默认行为
        try {
            const text = await navigator.clipboard.readText();
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(text);
            }
        } catch (err) {
            console.error('读取剪贴板内容失败: ', err);
            term.write('\r\n\x1b[31m[剪贴板粘贴失败，权限可能被拒绝。]\x1b[0m\r\n');
        }
        return;
    }
});

// --- (状态面板逻辑 - 无变动) ---
const statsContent = document.getElementById('stats-content');
const toggleBtn = document.getElementById('toggle-stats-btn');

toggleBtn.addEventListener('click', () => {
    statsContent.classList.toggle('hidden');
    toggleBtn.innerHTML = statsContent.classList.contains('hidden') ? '展开信息 ▼' : '收起信息 ▲';
});

function updateStatsDisplay(statsData) {
    if (statsContent) {
        statsContent.innerHTML = `
            <strong>系统:</strong> ${statsData.osName}<br>
            <strong>IP 地址:</strong> ${statsData.ip}<br>
            <strong>CPU:</strong> ${statsData.cpuCores} x ${statsData.cpuModel.split('@')[0].trim()}<br>
            <strong>内存:</strong> ${statsData.freeMem} 空闲 / ${statsData.totalMem} 总共<br>
            <strong>在线时长:</strong> ${statsData.uptime}<br>
            <strong>网络:</strong> <span class="speed-icon">↓</span> ${statsData.rxSpeed} / <span class="speed-icon">↑</span> ${statsData.txSpeed}
        `;
    }
}

// WebSocket 消息接收：处理终端输出和状态更新
ws.onmessage = function(event) {
    if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data)); // 处理二进制终端数据
        return;
    }
    try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'stats' && msg.data) {
            updateStatsDisplay(msg.data);
        }
    } catch (e) {
        // 如果不是JSON，则视为普通文本输出到终端
        term.write(event.data);
    }
};


// --- 文件浏览器逻辑 ---
const fileListEl = document.getElementById('file-list');
const currentPathEl = document.getElementById('current-path');
const fileInput = document.getElementById('file-input');
const uploadPathInput = document.getElementById('upload-path');
const uploadStatusEl = document.getElementById('upload-status');

const contextMenu = document.getElementById('context-menu');
const renameBtn = document.getElementById('rename-btn');
const deleteBtn = document.getElementById('delete-btn');

// 编辑器与上下文菜单元素
const editBtn = document.getElementById('edit-btn');
const editorModal = document.getElementById('editor-modal');
const editorFilenameEl = document.getElementById('editor-filename');
const editorTextarea = document.getElementById('editor-textarea');
const saveFileBtn = document.getElementById('save-file-btn');
const closeEditorBtn = document.getElementById('close-editor-btn');
const editorStatusEl = document.getElementById('editor-status');

// 多选相关元素和逻辑
const selectAllCheckbox = document.getElementById('select-all-checkbox');
const downloadSelectedBtn = document.getElementById('download-selected-btn');
const selectedFiles = new Set(); // 存储选中的完整路径

// 文件浏览器面板元素
const fileBrowserContainer = document.getElementById('file-browser-container');

// 新增文件操作按钮
const refreshBtn = document.getElementById('refresh-btn');
const createFolderBtn = document.getElementById('create-folder-btn');
const createFileBtn = document.getElementById('create-file-btn');

// 新增：文件浏览器展开/收起按钮
const toggleFileBrowserBtn = document.getElementById('toggle-file-browser-btn');


// Cookie 常量
const LAST_FILE_PATH_COOKIE = 'lastFilePath';
const FILE_BROWSER_COLLAPSED_COOKIE = 'fileBrowserCollapsed'; // 文件浏览器折叠状态Cookie

let currentPath = '/root'; // 默认路径，如果Cookie中没有保存，则使用此路径

// 辅助函数：格式化字节大小 (客户端本地函数)
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * 客户端侧的 POSIX 路径规范化函数。
 * 处理双斜杠、`..`、`.`等，确保路径以 `/` 开头且不以 `/` 结尾（除非是根目录）。
 * @param {string} p 原始路径字符串
 * @returns {string} 规范化后的路径
 */
function normalizePath(p) {
    if (!p) return '/';
    // 将所有反斜杠替换为正斜杠，并处理多个斜杠
    p = p.replace(/\\/g, '/').replace(/\/\/+/g, '/');
    const parts = p.split('/').filter(part => part !== ''); // 过滤空字符串

    let normalizedParts = [];
    for (const part of parts) {
        if (part === '..') {
            // 如果不是根目录的父目录，则弹出上一个部分
            if (normalizedParts.length > 0 && normalizedParts[normalizedParts.length - 1] !== '..') {
                normalizedParts.pop();
            } else if (p.startsWith('/')) {
                // 如果是绝对路径，并且已经到达根目录，不再向上
                continue;
            } else {
                // 相对路径，且已到达路径起点，保留 '..'
                normalizedParts.push(part);
            }
        } else if (part !== '.') {
            normalizedParts.push(part);
        }
    }

    // 对于绝对路径，确保以 '/' 开头
    let normalized = p.startsWith('/') ? '/' + normalizedParts.join('/') : normalizedParts.join('/');
    
    // 如果结果为空字符串，表示是根目录
    return normalized === '' ? '/' : normalized;
}

// Cookie 辅助函数
/**
 * 设置 Cookie
 * @param {string} name Cookie 名称
 * @param {string} value Cookie 值
 * @param {number} days Cookie 有效期（天）
 */
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/";
}

/**
 * 获取 Cookie
 * @param {string} name Cookie 名称
 * @returns {string|null} Cookie 值，如果不存在则返回 null
 */
function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

// 更新下载选中项按钮的禁用状态和文本
function updateDownloadSelectedButtonState() {
    downloadSelectedBtn.disabled = selectedFiles.size === 0;
    downloadSelectedBtn.textContent = `打包下载选中项 (${selectedFiles.size})`;
}

// 清除所有选中项
function clearSelection() {
    selectedFiles.clear();
    const checkboxes = fileListEl.querySelectorAll('.file-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = false;
        cb.closest('li').classList.remove('selected');
    });
    selectAllCheckbox.checked = false; // 清除全选框状态
    selectAllCheckbox.indeterminate = false; // 清除半选状态
    updateDownloadSelectedButtonState();
}

// 获取并显示文件列表
async function fetchAndDisplayFiles(pathStr) {
    fileListEl.innerHTML = '<li><i class="fas fa-spinner fa-spin fa-fw"></i> 加载中...</li>';
    clearSelection(); // 切换目录时清除选中状态
    try {
        // 确保发送给服务器的路径是规范化后的
        const normalizedPathStr = normalizePath(pathStr);
        const response = await fetch(`/api/files?path=${encodeURIComponent(normalizedPathStr)}`);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || '获取文件列表失败');
        }
        const data = await response.json();
        // 存储从服务器接收到的规范化路径
        currentPath = normalizePath(data.path);
        currentPathEl.textContent = currentPath;
        uploadPathInput.value = currentPath; // 更新上传目标路径
        setCookie(LAST_FILE_PATH_COOKIE, currentPath, 365); // 保存当前路径到 Cookie
        renderFileList(data.files);
    } catch (error) {
        fileListEl.innerHTML = `<li><i class="fas fa-exclamation-triangle fa-fw"></i> 错误: ${error.message}</li>`;
        showStatusMessage(`获取文件列表失败: ${error.message}`, 'error');
    }
}

// 检查文件是否可编辑的辅助函数
function isEditable(filename) {
    const editableExtensions = [
        '.txt', '.log', '.json', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.cnf',
        '.md', '.sh', '.bash', '.zsh', '.c', '.cpp', '.h', '.hpp', '.cs', '.java',
        '.js', '.ts', '.css', '.scss', '.html', '.htm', '.php', '.py', '.rb', '.go', // 常见文本和代码文件
        '.env', // 环境变量文件
    ];
    // 检查文件名本身是否可编辑 (如 'Dockerfile'，没有后缀名)
    const commonNoExtFiles = ['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'nginx.conf', 'apache.conf'];

    const lowerFilename = filename.toLowerCase();
    // 检查是否有后缀名，如果有则检查后缀名，如果没有则检查完整文件名
    const dotIndex = lowerFilename.lastIndexOf('.');
    if (dotIndex !== -1 && dotIndex !== 0) { // 排除 .开头的文件，如.bashrc
        const ext = lowerFilename.substring(dotIndex);
        return editableExtensions.includes(ext);
    } else {
        return commonNoExtFiles.includes(lowerFilename);
    }
}

// 修复后的 renderFileList 函数
function renderFileList(files) {
    fileListEl.innerHTML = ''; // 清空列表

    // 返回上一级目录
    if (currentPath !== '/') {
        // 使用 normalizePath 获取父目录
        const parentPath = normalizePath(currentPath + '/..');
        const li = document.createElement('li');
        li.innerHTML = `<i class="fas fa-level-up-alt fa-fw"></i> ..`;
        li.onclick = (e) => {
            if (!e.target.classList.contains('file-checkbox')) {
                fetchAndDisplayFiles(parentPath);
            }
        };
        li.classList.add('no-context', 'parent-dir-item'); // 添加标记，防止右键菜单和被全选
        fileListEl.appendChild(li);
    }

    files.forEach(file => {
        const li = document.createElement('li');
        // 确保路径拼接是正确的，防止 /root//file 这种，并进行规范化
        const fullPath = normalizePath(currentPath + '/' + file.name);

        li.dataset.path = fullPath;
        li.dataset.type = file.type;
        li.dataset.name = file.name;

        // 创建并附加复选框
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.classList.add('file-checkbox');
        checkbox.checked = selectedFiles.has(fullPath); // 保持选中状态
        if (checkbox.checked) {
            li.classList.add('selected'); // 添加选中视觉效果
        }

        checkbox.addEventListener('change', (e) => {
            e.stopPropagation(); // 阻止点击复选框时触发 li 的 onclick
            if (checkbox.checked) {
                selectedFiles.add(fullPath);
                li.classList.add('selected');
            } else {
                selectedFiles.delete(fullPath);
                li.classList.remove('selected');
            }
            // 更新全选状态：只考虑非父目录的复选框
            const allDisplayableCheckboxes = fileListEl.querySelectorAll('li:not(.parent-dir-item) .file-checkbox');
            const checkedCheckboxes = fileListEl.querySelectorAll('li:not(.parent-dir-item) .file-checkbox:checked');
            
            selectAllCheckbox.checked = allDisplayableCheckboxes.length > 0 && checkedCheckboxes.length === allDisplayableCheckboxes.length;
            selectAllCheckbox.indeterminate = checkedCheckboxes.length > 0 && checkedCheckboxes.length < allDisplayableCheckboxes.length;

            updateDownloadSelectedButtonState();
        });
        li.appendChild(checkbox);

        // 创建并附加图标
        const iconEl = document.createElement('i');
        iconEl.classList.add('fas', file.type === 'dir' ? 'fa-folder' : 'fa-file-alt', 'fa-fw');
        li.appendChild(iconEl);

        // 创建并附加文件名
        const nameSpan = document.createElement('span');
        nameSpan.classList.add('file-name');
        nameSpan.textContent = file.name;
        li.appendChild(nameSpan);

        // 创建并附加文件大小（如果适用）
        if (file.type === 'file') {
            const sizeSpan = document.createElement('span');
            sizeSpan.classList.add('file-size');
            sizeSpan.textContent = formatBytes(file.size);
            li.appendChild(sizeSpan);
        }

        // 定义点击和双击行为
        if (file.type === 'dir') {
            li.onclick = (e) => {
                if (!e.target.classList.contains('file-checkbox')) { // 避免点击复选框时触发导航
                     fetchAndDisplayFiles(fullPath);
                }
            };
            li.style.cursor = 'pointer'; // 目录可点击
        } else {
            // 文件项的点击行为
            const canBeEdited = isEditable(file.name);
            li.onclick = (e) => {
                if (e.target.classList.contains('file-checkbox')) {
                    // 如果点击的是复选框，则其自身的 change 事件会处理
                    return;
                }
                if (canBeEdited) {
                    // 可编辑文件，单击不进行任何操作，等待双击编辑
                    return;
                }
                // 不可编辑文件，单击进行下载
                // 此处保留 /api/download 用于直接下载单个文件，非ZIP
                window.location.href = `/api/download?path=${encodeURIComponent(fullPath)}`;
            };

            // 双击: 如果可编辑，则在编辑器中打开
            if (canBeEdited) {
                li.ondblclick = (e) => {
                    e.preventDefault(); // 防止双击时选中文本
                    openFileInEditor(fullPath);
                };
                 li.style.cursor = 'pointer'; // 给出不同的视觉提示
            }
        }
        fileListEl.appendChild(li);
    });

    updateDownloadSelectedButtonState(); // 最后更新一次按钮状态
}

// 全选复选框事件监听
selectAllCheckbox.addEventListener('change', () => {
    // 仅选择/取消选择非父目录的复选框
    const checkboxes = fileListEl.querySelectorAll('li:not(.parent-dir-item) .file-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = selectAllCheckbox.checked;
        const fullPath = cb.closest('li').dataset.path; // fullPath 已经是规范化后的
        if (selectAllCheckbox.checked) {
            selectedFiles.add(fullPath);
            cb.closest('li').classList.add('selected');
        } else {
            selectedFiles.delete(fullPath);
            cb.closest('li').classList.remove('selected');
        }
    });
    selectAllCheckbox.indeterminate = false; // 手动点击全选/取消全选后，清除半选状态
    updateDownloadSelectedButtonState();
});

// 打包下载选中项按钮事件监听，使用 GET 方式
downloadSelectedBtn.addEventListener('click', () => {
    if (selectedFiles.size === 0) {
        showStatusMessage('请至少选择一个文件或目录进行打包。', 'warning');
        return;
    }

    const pathsToZip = Array.from(selectedFiles);
    showStatusMessage(`正在打包 ${pathsToZip.length} 项为 ZIP...`, 'success');
    
    // 构建 GET 请求的 URL，通过重复参数传递多个路径
    const queryParams = pathsToZip.map(p => `paths=${encodeURIComponent(p)}`).join('&');
    const downloadUrl = `/api/package-download?${queryParams}`;

    // 直接设置 window.location.href 触发浏览器下载
    window.location.href = downloadUrl;

    // 对于 GET 方式的下载，我们无法直接获取下载是否成功，所以只能假设成功并清除选中状态
    clearSelection(); 
    // 状态消息会在几秒后自动消失，或者在新的页面加载时清除
});


// 上下文菜单逻辑 (用于显示/隐藏编辑按钮)
fileListEl.addEventListener('contextmenu', (e) => {
    const targetLi = e.target.closest('li');
    // 检查是否是返回上一级的条目，或者没有找到li元素
    if (!targetLi || targetLi.classList.contains('no-context')) {
        contextMenu.style.display = 'none'; // 隐藏上下文菜单
        return;
    }
    e.preventDefault(); // 阻止默认右键菜单

    contextMenu.dataset.path = targetLi.dataset.path;
    contextMenu.dataset.type = targetLi.dataset.type;
    contextMenu.dataset.name = targetLi.dataset.name;

    // 根据项目类型显示/隐藏菜单项
    const isDir = targetLi.dataset.type === 'dir';
    const canBeEdited = !isDir && isEditable(targetLi.dataset.name);


    editBtn.classList.toggle('hidden', !canBeEdited); // 可编辑文件显示，其他隐藏

    contextMenu.style.display = 'block';
    // 确保菜单不会超出屏幕边界
    let x = e.pageX;
    let y = e.pageY;
    if (x + contextMenu.offsetWidth > window.innerWidth) {
        x = window.innerWidth - contextMenu.offsetWidth - 5; // 留一点边距
    }
    if (y + contextMenu.offsetHeight > window.innerHeight) {
        y = window.innerHeight - contextMenu.offsetHeight - 5;
    }
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;
});

window.addEventListener('click', (e) => {
    // 只有当点击目标不是上下文菜单自身或其子元素时才隐藏
    if (!contextMenu.contains(e.target)) {
        contextMenu.style.display = 'none';
    }
});


// 上下文菜单操作的事件处理
renameBtn.addEventListener('click', async () => {
    const oldPath = contextMenu.dataset.path; // 已经是规范化后的路径
    const oldName = contextMenu.dataset.name;
    if (!oldPath) return;

    const newName = prompt('输入新名称:', oldName);
    if (!newName || newName.trim() === '' || newName === oldName) return;

    // 确保新名称不包含路径分隔符，防止路径穿越
    const cleanNewName = newName.split('/').pop().split('\\').pop();
    if (cleanNewName !== newName) {
        showStatusMessage('新名称不能包含路径分隔符。', 'error');
        return;
    }

    // 构建新路径并进行规范化
    const newPath = normalizePath(currentPath + '/' + cleanNewName);

    try {
        const response = await fetch('/api/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath, newPath }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        showStatusMessage(`已重命名为 ${cleanNewName}`, 'success');
        fetchAndDisplayFiles(currentPath); // 刷新当前目录
    } catch (error) {
        showStatusMessage(`重命名失败: ${error.message}`, 'error');
    }
});

deleteBtn.addEventListener('click', async () => {
    const pathToDelete = contextMenu.dataset.path; // 已经是规范化后的路径
    const typeToDelete = contextMenu.dataset.type;
    const nameToDelete = contextMenu.dataset.name;
    if (!pathToDelete) return;

    if (confirm(`您确定要删除 "${nameToDelete}" 吗?`)) {
        try {
            const response = await fetch('/api/delete', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: pathToDelete, type: typeToDelete }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);
            showStatusMessage(`已删除 "${nameToDelete}"`, 'success');
            fetchAndDisplayFiles(currentPath); // 刷新当前目录
        } catch (error) {
            showStatusMessage(`删除失败: ${error.message}`, 'error');
        }
    }
});

// 在线文件编辑器逻辑
editBtn.addEventListener('click', () => {
    const path = contextMenu.dataset.path; // 已经是规范化后的路径
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
    editorModal.dataset.filePath = filePath; // 存储规范化后的路径以便保存

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
        setTimeout(() => editorStatusEl.textContent = '', 3000); // 3秒后清除状态消息
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
    const filePath = editorModal.dataset.filePath; // 已经是规范化后的路径
    if (!filePath) return;

    const content = editorTextarea.value;
    editorStatusEl.textContent = '保存中...';
    editorStatusEl.style.color = '#ffcc00';
    saveFileBtn.disabled = true; // 保存时禁用按钮

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
        setTimeout(() => editorStatusEl.textContent = '', 3000); // 3秒后清除状态消息
    } catch (error) {
        editorStatusEl.textContent = `保存失败: ${error.message}`;
        editorStatusEl.style.color = '#ff4444';
    } finally {
        saveFileBtn.disabled = false; // 恢复按钮
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
        if ((e.ctrlKey || e.metaKey) && e.key === 's') { // Ctrl+S 或 Cmd+S
            e.preventDefault();
            saveFile();
        }
    }
});

// --- 上传逻辑 ---
async function handleUpload() {
    if (fileInput.files.length === 0) {
        showStatusMessage('请先选择一个文件。', 'warning');
        return;
    }
    const formData = new FormData(document.getElementById('upload-form'));
    // 确保上传路径也是规范化后的
    const uploadDestinationPath = normalizePath(uploadPathInput.value);
    formData.set('path', uploadDestinationPath); // 更新表单数据中的路径

    showStatusMessage('上传中...', 'success');
    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '上传失败');
        showStatusMessage('上传成功!', 'success');
        fileInput.value = ''; // 清空文件选择
        fetchAndDisplayFiles(currentPath); // 刷新文件列表
    } catch (error) {
        showStatusMessage(`错误: ${error.message}`, 'error');
    }
}
fileInput.addEventListener('change', handleUpload);

// 新增：刷新按钮事件监听
refreshBtn.addEventListener('click', () => {
    showStatusMessage('正在刷新文件列表...', 'info');
    fetchAndDisplayFiles(currentPath);
});

// 新增：创建文件夹按钮事件监听
createFolderBtn.addEventListener('click', async () => {
    const folderName = prompt('请输入新文件夹名称:');
    if (!folderName || folderName.trim() === '') {
        showStatusMessage('文件夹名称不能为空。', 'warning');
        return;
    }
    // 简单校验，防止用户输入路径分隔符，实际安全由服务器端 normalizePath 保证
    if (folderName.includes('/') || folderName.includes('\\')) {
        showStatusMessage('文件夹名称不能包含路径分隔符。', 'error');
        return;
    }

    const newFolderPath = normalizePath(currentPath + '/' + folderName);

    showStatusMessage('正在创建文件夹...', 'success');
    try {
        const response = await fetch('/api/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: newFolderPath }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        showStatusMessage(`文件夹 "${folderName}" 创建成功!`, 'success');
        fetchAndDisplayFiles(currentPath); // 刷新文件列表
    } catch (error) {
        showStatusMessage(`创建文件夹失败: ${error.message}`, 'error');
    }
});

// 新增：创建文件按钮事件监听
createFileBtn.addEventListener('click', async () => {
    const fileName = prompt('请输入新文件名称:');
    if (!fileName || fileName.trim() === '') {
        showStatusMessage('文件名称不能为空。', 'warning');
        return;
    }
    // 简单校验，防止用户输入路径分隔符，实际安全由服务器端 normalizePath 保证
    if (fileName.includes('/') || fileName.includes('\\')) {
        showStatusMessage('文件名称不能包含路径分隔符。', 'error');
        return;
    }

    const newFilePath = normalizePath(currentPath + '/' + fileName);

    showStatusMessage('正在创建文件...', 'success');
    try {
        const response = await fetch('/api/touch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: newFilePath }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        showStatusMessage(`文件 "${fileName}" 创建成功!`, 'success');
        fetchAndDisplayFiles(currentPath); // 刷新文件列表
    } catch (error) {
        showStatusMessage(`创建文件失败: ${error.message}`, 'error');
    }
});

// 辅助函数：显示状态消息
function showStatusMessage(message, type = 'success') {
    uploadStatusEl.textContent = message;
    if (type === 'success') {
        uploadStatusEl.style.color = '#00ff00';
    } else if (type === 'error') {
        uploadStatusEl.style.color = '#ff4444';
    } else if (type === 'warning') {
        uploadStatusEl.style.color = '#ffcc00';
    } else if (type === 'info') { // 新增信息类型
        uploadStatusEl.style.color = '#85c1e9';
    }
    // 非错误消息在几秒后自动消失
    if (type !== 'error') {
        setTimeout(() => (uploadStatusEl.textContent = ''), 4000);
    }
}

// === 文件浏览器展开/收起逻辑 ===
let isFileBrowserCollapsed = true; // 默认是收起状态

function updateFileBrowserState() {
    if (isFileBrowserCollapsed) {
        fileBrowserContainer.classList.add('collapsed');
        fileBrowserContainer.classList.remove('visible');
    } else {
        fileBrowserContainer.classList.remove('collapsed');
        fileBrowserContainer.classList.add('visible');
    }
    // 保存状态到 Cookie
    setCookie(FILE_BROWSER_COLLAPSED_COOKIE, isFileBrowserCollapsed, 365);
    // 延迟调用 fitAddon.fit() 以适应 CSS 动画
    // 使用 requestAnimationFrame 配合 setTimeout 确保在下一帧更新后调用 fitAddon
    requestAnimationFrame(() => {
        setTimeout(() => fitAddon.fit(), 350); // 350ms 略大于 CSS transition 的 300ms
    });
}

toggleFileBrowserBtn.addEventListener('click', () => {
    isFileBrowserCollapsed = !isFileBrowserCollapsed;
    updateFileBrowserState();
});

// 页面初始加载
document.addEventListener('DOMContentLoaded', () => {
    // 检查并恢复文件浏览器折叠状态
    const savedCollapsedState = getCookie(FILE_BROWSER_COLLAPSED_COOKIE);
    if (savedCollapsedState !== null) {
        isFileBrowserCollapsed = (savedCollapsedState === 'true');
    } else {
        isFileBrowserCollapsed = true; // 默认首次加载是收起
    }
    updateFileBrowserState(); // 应用初始状态

    // 加载上次的文件路径
    const savedPath = getCookie(LAST_FILE_PATH_COOKIE);
    // 使用规范化路径作为初始加载路径，如果Cookie中没有则使用默认值
    currentPath = savedPath ? normalizePath(savedPath) : normalizePath('/root');
    fetchAndDisplayFiles(currentPath);


    // 检查剪贴板读取权限，提高用户体验
    navigator.permissions.query({ name: 'clipboard-read' }).then(result => {
        if (result.state == 'granted' || result.state == 'prompt') {
            console.log('剪贴板读取权限可用。');
        } else {
            console.warn('剪贴板读取权限被拒绝或不可用。复制粘贴可能受限。');
        }
    }).catch(e => {
        console.warn('浏览器不支持 Permissions API 或读取剪贴板权限，复制粘贴功能可能受限。', e);
    });
});