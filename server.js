// server.js (已修复 POSIX 问题 + 新功能 + 文件编辑器 + 中文注释 + HTTP基础验证)

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const multer = require('multer');
// ===【【【 新增: 引入基础验证库 】】】===
const basicAuth = require('express-basic-auth');

// --- (工具函数和 InteractiveSSH 类无变动) ---
function formatBytes(bytes) { if (bytes === 0 || isNaN(bytes)) return '0 Bytes'; const k = 1024; const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]; }
function formatUptime(seconds) { const d = Math.floor(seconds / (3600*24)); const h = Math.floor(seconds % (3600*24) / 3600); const m = Math.floor(seconds % 3600 / 60); const s = Math.floor(seconds % 60); return `${d}天 ${h}小时 ${m}分钟 ${s}秒`; }
async function executeRemoteCommand(sshConn, command) { return new Promise((resolve, reject) => { let output = ''; let stderr_out = ''; sshConn.exec(command, (err, stream) => { if (err) return reject(err); stream.on('data', (data) => output += data.toString()).on('close', (code) => { if (code !== 0) { return reject(new Error(`命令执行失败，退出码 ${code}: ${stderr_out}`)); } resolve(output.trim()); }).stderr.on('data', (data) => { stderr_out += data.toString(); }); }); }); }
async function getRemoteStats(sshConn) { const commands = { ip: "hostname -I | awk '{print $1}'", cpuModel: "lscpu | grep 'Model name:' | sed 's/Model name:[ \t]*//'", cpuCores: "nproc", uptime: "cat /proc/uptime | awk '{print $1}'", memInfo: "cat /proc/meminfo", osInfo: "cat /etc/os-release", netInterface: "ip route get 1.1.1.1 | grep -oP 'dev \\K\\w+'", netDev: "cat /proc/net/dev" }; const [ip, cpuModel, cpuCores, uptime, memInfo, osInfo, netInterface, netDev] = await Promise.all(Object.values(commands).map(cmd => executeRemoteCommand(sshConn, cmd).catch(e => ''))); const memTotalLine = memInfo.split('\n').find(line => line.startsWith('MemTotal:')); const memAvailableLine = memInfo.split('\n').find(line => line.startsWith('MemAvailable:')); const totalMem = parseInt(memTotalLine.split(/\s+/)[1], 10) * 1024; const freeMem = parseInt(memAvailableLine.split(/\s+/)[1], 10) * 1024; const osNameLine = osInfo.split('\n').find(line => line.startsWith('PRETTY_NAME=')); const osName = osNameLine ? osNameLine.split('=')[1].replace(/"/g, '') : 'N/A'; let rx_bytes = 0, tx_bytes = 0; if (netInterface && netDev) { const netLine = netDev.split('\n').find(line => line.trim().startsWith(netInterface + ':')); if (netLine) { const stats = netLine.trim().split(/\s+/); rx_bytes = parseInt(stats[1], 10); tx_bytes = parseInt(stats[9], 10); } } return { ip: ip || 'N/A', osName, cpuModel: cpuModel || 'N/A', cpuCores: parseInt(cpuCores, 10) || 'N/A', uptime: formatUptime(parseFloat(uptime)), totalMem: formatBytes(totalMem), freeMem: formatBytes(freeMem), rx_bytes, tx_bytes, timestamp: Date.now() }; }
class InteractiveSSH extends EventEmitter { constructor(config) { super(); this.config = config; this.conn = new Client(); } connect() { this.conn.on('ready', () => { this.emit('ready'); this.conn.shell({ term: 'xterm-256color' }, (err, stream) => { if (err) { return this.emit('error', err); } this.emit('shell', stream); stream.on('close', () => this.conn.end()); }); }).on('close', () => { this.emit('close'); }).on('error', (err) => { this.emit('error', err); }).connect(this.config); } disconnect() { this.conn.end(); } }

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ dest: 'uploads/' }); // 文件上传的临时目录

// ===【【【 新增: HTTP 基础验证配置 】】】===
app.use(basicAuth({
    users: { 'whrstudio': '2477135976whr' },
    challenge: true, // 这会使浏览器弹出登录框
    realm: 'WebTop Login', // 弹框上显示的领域名
}));
// ===【【【 新增结束 】】】===

app.use(express.json());

const PORT = 3000;
const sshConfig = {
    host: '45.205.28.94', port: 22, username: 'root', password: 'vaxwKAEG7344',
};

// 全局共享的SSH客户端，用于文件操作
let sharedSshClient = new Client();
let sftp = null;
sharedSshClient.on('ready', () => { console.log('[SSH-全局] 全局 SSH 连接已就绪。'); sharedSshClient.sftp((err, sftpInstance) => { if (err) { console.error('[SFTP] 创建 SFTP 会话时出错:', err); return; } console.log('[SFTP] 全局 SFTP 会话已就绪。'); sftp = sftpInstance; sftp.on('end', () => { console.log('[SFTP] 会话已结束。'); sftp = null; }); }); }).on('error', (err) => { console.error('[SSH-全局] 全局 SSH 连接错误:', err.message); sftp = null; }).on('close', () => { console.log('[SSH-全局] 全局 SSH 连接已关闭。将在5秒后尝试重新连接...'); sftp = null; setTimeout(() => sharedSshClient.connect(sshConfig), 5000); }).connect(sshConfig);

// --- 文件管理 API 接口 ---
app.get('/api/files', (req, res) => { if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' }); const remotePath = req.query.path || '.'; sftp.readdir(remotePath, (err, list) => { if (err) return res.status(400).json({ error: err.message, path: remotePath }); const files = list.map(item => ({ name: item.filename, type: item.attrs.isDirectory() ? 'dir' : 'file', size: item.attrs.size, modified: item.attrs.mtime * 1000, })).sort((a, b) => { if (a.type === 'dir' && b.type === 'file') return -1; if (a.type === 'file' && b.type === 'dir') return 1; return a.name.localeCompare(b.name); }); res.json({ path: remotePath, files }); }); });
app.get('/api/download', (req, res) => { if (!sftp) return res.status(503).send('SFTP 服务不可用'); const remotePath = req.query.path; if (!remotePath) return res.status(400).send('必须提供文件路径'); sftp.stat(remotePath, (err, stats) => { if (err) return res.status(404).send('文件未找到或访问被拒绝。'); if (stats.isDirectory()) return res.status(400).send('无法下载目录。'); res.setHeader('Content-Disposition', `attachment; filename="${path.basename(remotePath)}"`); res.setHeader('Content-Length', stats.size); const readStream = sftp.createReadStream(remotePath); readStream.pipe(res); readStream.on('error', (streamErr) => { console.error('文件流错误:', streamErr); if (!res.headersSent) { res.status(500).send('传输文件时出错'); } }); }); });
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    if (!req.file) return res.status(400).json({ error: '没有文件被上传。' });
    const localPath = req.file.path;
    const originalFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const cleanFilename = originalFilename.split(/[\\\/]/).pop();
    const remotePath = path.posix.join(req.body.path, cleanFilename);
    console.log(`[上传] 尝试上传文件到: ${remotePath}`);
    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on('close', () => {
        fs.unlink(localPath, (err) => { if(err) console.error(`[上传清理] 删除临时文件 ${localPath} 失败:`, err) });
        res.json({ success: true, message: `文件已上传至 ${remotePath}` });
    });
    writeStream.on('error', (err) => {
        fs.unlink(localPath, () => {});
        res.status(500).json({ error: `上传失败: ${err.message}` });
    });
    readStream.pipe(writeStream);
});
app.post('/api/rename', (req, res) => { if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' }); const { oldPath, newPath } = req.body; if (!oldPath || !newPath) { return res.status(400).json({ error: '必须提供旧路径和新路径。' }); } sftp.rename(oldPath, newPath, (err) => { if (err) { console.error(`[SFTP 重命名错误] 从 ${oldPath} 到 ${newPath}:`, err); return res.status(500).json({ error: `无法重命名: ${err.message}` }); } res.json({ success: true, message: `已重命名为 ${newPath}` }); }); });
app.delete('/api/delete', (req, res) => { if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' }); const { path: delPath, type } = req.body; if (!delPath || !type) { return res.status(400).json({ error: '必须提供路径和类型。' }); } const operation = type === 'dir' ? 'rmdir' : 'unlink'; sftp[operation](delPath, (err) => { if (err) { console.error(`[SFTP 删除错误] 操作对象 ${delPath}:`, err); if (err.code === 4 && type === 'dir') { return res.status(400).json({ error: '目录不为空，无法删除。' }); } return res.status(500).json({ error: `删除失败: ${err.message}` }); } res.json({ success: true, message: `已成功删除 ${delPath}` }); }); });
app.get('/api/package-download', async (req, res) => { if (!sharedSshClient || !sftp) { return res.status(503).send('SSH/SFTP 连接不可用。'); } const remoteDirPath = req.query.path; if (!remoteDirPath) { return res.status(400).send('必须提供目录路径。'); } const parentDir = path.posix.dirname(remoteDirPath); const dirToArchive = path.posix.basename(remoteDirPath); const archiveFileName = `${dirToArchive}.tar.gz`; const tempRemotePath = `/tmp/webtop-download-${Date.now()}-${Math.random().toString(36).substring(2)}.tar.gz`; const tarCommand = `tar -czf "${tempRemotePath}" -C "${parentDir}" "${dirToArchive}"`; const cleanup = () => { console.log(`[清理] 正在删除临时压缩包: ${tempRemotePath}`); executeRemoteCommand(sharedSshClient, `rm -f "${tempRemotePath}"`).catch(err => { console.error(`[清理失败] 无法删除 ${tempRemotePath}:`, err.message); }); }; try { console.log(`[打包] 正在执行: ${tarCommand}`); await executeRemoteCommand(sharedSshClient, tarCommand); console.log(`[打包] 压缩包已创建于 ${tempRemotePath}`); sftp.stat(tempRemotePath, (statErr, stats) => { if (statErr) { console.error('[SFTP 状态错误]', statErr); cleanup(); return res.status(500).send('无法获取临时压缩包的状态。'); } res.setHeader('Content-Disposition', `attachment; filename="${archiveFileName}"`); res.setHeader('Content-Type', 'application/gzip'); res.setHeader('Content-Length', stats.size); const readStream = sftp.createReadStream(tempRemotePath); res.on('finish', cleanup); req.on('close', () => { if (!res.finished) { console.log('[连接] 客户端提前关闭了连接，执行清理。'); cleanup(); } }); readStream.on('error', (streamErr) => { console.error('[SFTP 流错误]', streamErr); cleanup(); if (!res.headersSent) { res.status(500).send('传输压缩文件时出错'); } }); readStream.pipe(res); }); } catch (err) { console.error(`[打包错误] 为 ${remoteDirPath} 创建压缩包失败:`, err.message); cleanup(); res.status(500).send(`目录打包失败。请确保远程服务器上已安装 'tar' 命令。`); } });
app.get('/api/file-content', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    const remotePath = req.query.path;
    if (!remotePath) return res.status(400).json({ error: '必须提供文件路径' });
    const readStream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
    let fileContent = '';
    readStream.on('data', (chunk) => { fileContent += chunk; });
    readStream.on('end', () => { res.type('text/plain; charset=utf-8').send(fileContent); });
    readStream.on('error', (err) => { console.error(`[SFTP 读取错误] 文件: ${remotePath}:`, err); res.status(500).json({ error: `读取文件失败: ${err.message}` }); });
});
app.post('/api/save-file', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    const { path: remotePath, content } = req.body;
    if (!remotePath || content === undefined) { return res.status(400).json({ error: '必须提供文件路径和内容。' }); }
    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on('close', () => { res.json({ success: true, message: `文件已成功保存至 ${remotePath}` }); });
    writeStream.on('error', (err) => { console.error(`[SFTP 写入错误] 文件: ${remotePath}:`, err); res.status(500).json({ error: `保存文件失败: ${err.message}` }); });
    writeStream.end(Buffer.from(content, 'utf8'));
});

// --- (静态文件服务和 WebSocket 逻辑无变动) ---
app.use(express.static(path.join(__dirname, 'public')));
wss.on('connection', (ws, req) => { 
    // WebSocket 连接升级请求不经过 Express 中间件，因此不需要单独处理验证
    // 但如果需要，可以在这里检查 req.headers.authorization
    console.log('[WebSocket] 客户端已连接，用于终端会话。'); 
    let statsInterval; 
    let lastStats = null; 
    const sshClient = new InteractiveSSH(sshConfig); 
    sshClient.on('shell', (shellStream) => { console.log('[SSH -> WebSocket] Shell 已准备好，可用于终端。'); shellStream.on('data', (data) => ws.send(data)); ws.on('message', (data) => { try { const parsedMsg = JSON.parse(data.toString()); if (parsedMsg.type === 'resize') { shellStream.setWindow(parsedMsg.rows, parsedMsg.cols); return; } } catch (e) { /* 不是 JSON 数据，直接写入 shell */ } shellStream.write(data); }); statsInterval = setInterval(async () => { try { const currentStats = await getRemoteStats(sshClient.conn); let rxSpeed = 0, txSpeed = 0; if (lastStats) { const timeDiff = (currentStats.timestamp - lastStats.timestamp) / 1000; if (timeDiff > 0) { rxSpeed = (currentStats.rx_bytes - lastStats.rx_bytes) / timeDiff; txSpeed = (currentStats.tx_bytes - lastStats.tx_bytes) / timeDiff; } } const statsForClient = { ...currentStats, rxSpeed: `${formatBytes(rxSpeed)}/s`, txSpeed: `${formatBytes(txSpeed)}/s` }; lastStats = currentStats; if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'stats', data: statsForClient })); } catch (error) { console.error('[状态错误] ', error.message); lastStats = null; } }, 2000); shellStream.on('close', () => { ws.close(); }); }); 
    sshClient.on('error', (err) => { if (ws.readyState === ws.OPEN) ws.send(`\x1b[31m[SSH 连接错误: ${err.message}]\x1b[0m\r\n`); ws.close(); }); 
    ws.on('close', () => { console.log('[WebSocket -> SSH] 客户端断开连接，关闭终端 SSH 连接。'); if (statsInterval) { clearInterval(statsInterval); } sshClient.disconnect(); }); 
    sshClient.connect(); 
});

server.listen(PORT, () => console.log(`服务器正在 http://localhost:${PORT} 上运行`));