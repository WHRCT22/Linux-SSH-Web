// server.js (已修复 POSIX 问题 + 新功能 + 文件编辑器 + 中文注释 + HTTP基础验证)

const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const multer = require('multer');
const basicAuth = require('express-basic-auth'); // 引入基础验证库

// --- 工具函数 ---
function formatBytes(bytes) {
    if (bytes === 0 || isNaN(bytes)) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
    if (isNaN(seconds) || seconds < 0) return 'N/A';
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor((seconds % (3600 * 24)) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}天 ${h}小时 ${m}分钟 ${s}秒`;
}

// 辅助函数：在远程SSH连接上执行命令
async function executeRemoteCommand(sshConn, command) {
    return new Promise((resolve, reject) => {
        let output = '';
        let stderr_out = '';
        sshConn.exec(command, { pty: true }, (err, stream) => {
            if (err) return reject(err);
            stream.on('data', (data) => output += data.toString())
                  .on('close', (code) => {
                      if (code !== 0) {
                          // 如果命令失败，尝试打印stderr输出
                          return reject(new Error(`命令执行失败，退出码 ${code}: ${stderr_out || '(无stderr输出)'}`));
                      }
                      resolve(output.trim());
                  })
                  .stderr.on('data', (data) => {
                      stderr_out += data.toString();
                  });
        });
    });
}

/**
 * 获取远程服务器统计信息
 * @param {Client} sshConn - ssh2 Client 连接实例
 * @returns {Promise<Object>} - 包含系统统计信息的对象
 */
async function getRemoteStats(sshConn) {
    const commands = {
        ip: "hostname -I | awk '{print $1}'",
        cpuModel: "lscpu | grep 'Model name:' | sed 's/Model name:[ \\t]*//'",
        cpuCores: "nproc",
        uptime: "cat /proc/uptime | awk '{print $1}'",
        memInfo: "cat /proc/meminfo",
        osInfo: "cat /etc/os-release",
        netInterface: "ip route get 1.1.1.1 | grep -oP 'dev \\K\\w+'", // 获取默认网络接口名
        netDev: "cat /proc/net/dev" // 获取网络设备统计信息
    };

    // 并行执行所有命令，如果命令失败则返回空字符串，确保后续处理不会因为undefined而崩溃
    const [ip, cpuModel, cpuCores, uptime, memInfo, osInfo, netInterface, netDev] =
        await Promise.all(Object.values(commands).map(cmd => executeRemoteCommand(sshConn, cmd).catch(e => {
            // console.error(`[getRemoteStats] 命令 '${cmd}' 执行失败: ${e.message}`); // 调试用
            return ''; // 返回空字符串而不是抛出错误
        })));

    let totalMem = 0;
    let freeMem = 0;

    // 内存信息解析 - 增加undefined检查
    const memTotalLine = memInfo.split('\n').find(line => line.startsWith('MemTotal:'));
    const memAvailableLine = memInfo.split('\n').find(line => line.startsWith('MemAvailable:'));

    if (memTotalLine) {
        // 确保 `split` 后的数组有足够多的元素，并使用 `|| 0` 处理 `NaN`
        totalMem = parseInt(memTotalLine.split(/\s+/)[1], 10) * 1024 || 0;
    }
    if (memAvailableLine) {
        freeMem = parseInt(memAvailableLine.split(/\s+/)[1], 10) * 1024 || 0;
    }

    // 操作系统信息解析
    const osNameLine = osInfo.split('\n').find(line => line.startsWith('PRETTY_NAME='));
    const osName = osNameLine ? osNameLine.split('=')[1].replace(/"/g, '') : 'N/A';

    let rx_bytes = 0;
    let tx_bytes = 0;

    // 网络流量信息解析
    if (netInterface && netDev) {
        const netLine = netDev.split('\n').find(line => line.trim().startsWith(netInterface + ':'));
        if (netLine) {
            const stats = netLine.trim().split(/\s+/);
            // 确保 stats 数组有足够的元素，使用 `|| 0` 处理 `NaN`
            rx_bytes = parseInt(stats[1], 10) || 0;
            tx_bytes = parseInt(stats[9], 10) || 0;
        }
    }

    return {
        ip: ip || 'N/A', // 如果IP为空，显示N/A
        osName,
        cpuModel: cpuModel || 'N/A',
        cpuCores: parseInt(cpuCores, 10) || 'N/A', // 确保为数字或N/A
        uptime: formatUptime(parseFloat(uptime) || 0), // 确保为数字或0
        totalMem: formatBytes(totalMem),
        freeMem: formatBytes(freeMem),
        rx_bytes,
        tx_bytes,
        timestamp: Date.now()
    };
}

// InteractiveSSH 类保持不变，因为它处理的是 WebSocket 与 SSH Shell 的交互，不涉及 stats 收集
class InteractiveSSH extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.conn = new Client();
    }

    connect() {
        this.conn.on('ready', () => {
            this.emit('ready');
            this.conn.shell({ term: 'xterm-256color' }, (err, stream) => {
                if (err) {
                    return this.emit('error', err);
                }
                this.emit('shell', stream);
                stream.on('close', () => this.conn.end());
            });
        }).on('close', () => {
            this.emit('close');
        }).on('error', (err) => {
            this.emit('error', err);
        }).connect(this.config);
    }

    disconnect() {
        this.conn.end();
    }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const upload = multer({ dest: 'uploads/' }); // 文件上传的临时目录

// HTTP 基础验证配置
app.use(basicAuth({
    users: { 'whrstudio': '2477135976whr' }, // 替换为你的实际用户名和密码
    challenge: true, // 这会使浏览器弹出登录框
    realm: 'WebTop Login', // 弹框上显示的领域名
}));

app.use(express.json());

const PORT = 3001;
const sshConfig = {
    host: '127.0.0.1',
    port: 22,
    username: 'root',
    password: '2477135976whr', // 替换为你的实际SSH配置
};

// 全局共享的SSH客户端，用于文件操作
let sharedSshClient = new Client();
let sftp = null;

// SSH 连接和 SFTP 会话管理
const connectSharedSsh = () => {
    console.log('[SSH-全局] 正在尝试连接全局 SSH...');
    sharedSshClient.connect(sshConfig);
};

sharedSshClient.on('ready', () => {
    console.log('[SSH-全局] 全局 SSH 连接已就绪。');
    sharedSshClient.sftp((err, sftpInstance) => {
        if (err) {
            console.error('[SFTP] 创建 SFTP 会话时出错:', err);
            sftp = null;
            return;
        }
        console.log('[SFTP] 全局 SFTP 会话已就绪。');
        sftp = sftpInstance;
        sftp.on('end', () => {
            console.log('[SFTP] SFTP 会话已结束。');
            sftp = null;
        });
    });
}).on('error', (err) => {
    console.error('[SSH-全局] 全局 SSH 连接错误:', err.message);
    sftp = null; // 清除SFTP实例
    // 自动重连逻辑，避免无限重连，可添加指数退避
    console.log('[SSH-全局] 将在5秒后尝试重新连接...');
    setTimeout(connectSharedSsh, 5000);
}).on('close', () => {
    console.log('[SSH-全局] 全局 SSH 连接已关闭。');
    sftp = null; // 清除SFTP实例
    // 自动重连逻辑
    console.log('[SSH-全局] 将在5秒后尝试重新连接...');
    setTimeout(connectSharedSsh, 5000);
});

// 首次连接
connectSharedSsh();

// --- 文件管理 API 接口 ---
app.get('/api/files', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });

    // 规范化远程路径：处理双斜杠、`.`、`..`等
    let remotePath = req.query.path || '.';
    remotePath = path.posix.normalize(remotePath);

    sftp.readdir(remotePath, async (err, list) => { // 将回调函数标记为 async
        if (err) {
            // 返回错误时也使用规范化后的路径
            return res.status(400).json({ error: err.message, path: remotePath });
        }

        // 使用 Promise.all 处理异步的 stat 或 readlink 操作
        const filesPromises = list.map(async (item) => {
            let type = 'file'; // 默认类型为文件
            let size = item.attrs.size;
            let modified = item.attrs.mtime * 1000;
            let symlinkTarget = undefined; // 存储符号链接的目标路径

            // 获取完整的项目路径，用于 stat 和 readlink
            const fullItemPath = path.posix.join(remotePath, item.filename);

            if (item.attrs.isSymbolicLink()) {
                // 如果是符号链接，需要进一步检查它指向什么
                try {
                    // 尝试获取符号链接的目标属性（会跟随链接）
                    const targetStats = await new Promise((resolve, reject) => {
                        sftp.stat(fullItemPath, (statErr, s) => {
                            if (statErr) {
                                // 如果stat失败（例如，链接指向一个不存在的文件或目录，或者权限问题）
                                console.warn(`[SFTP] Could not stat symlink target for ${fullItemPath}: ${statErr.message}`);
                                return resolve(null); // 返回null表示链接目标不可达/不存在
                            }
                            resolve(s);
                        });
                    });

                    // 获取符号链接的实际目标路径（不跟随链接）
                    symlinkTarget = await new Promise((resolve, reject) => {
                        sftp.readlink(fullItemPath, (readlinkErr, target) => {
                            if (readlinkErr) {
                                console.warn(`[SFTP] Could not readlink for ${fullItemPath}: ${readlinkErr.message}`);
                                return resolve('unknown (readlink error)');
                            }
                            resolve(target);
                        });
                    }).catch(e => `unknown (readlink failed: ${e.message})`); // 捕获readlink本身的错误

                    if (targetStats) {
                        // 如果目标可达
                        if (targetStats.isDirectory()) {
                            type = 'symlink_dir'; // 符号链接到目录
                        } else {
                            type = 'symlink_file'; // 符号链接到文件
                        }
                        // 对于符号链接，通常会报告其目标的大小和修改时间
                        size = targetStats.size;
                        modified = targetStats.mtime * 1000;
                    } else {
                        // 链接目标不可达或不存在（断开的链接）
                        type = 'symlink_broken';
                    }
                } catch (e) {
                    // 如果在处理符号链接时发生其他错误
                    console.error(`[SFTP] Error processing symlink ${fullItemPath}: ${e.message}`);
                    type = 'symlink_broken';
                    symlinkTarget = `error (${e.message})`;
                }
            } else if (item.attrs.isDirectory()) {
                type = 'dir'; // 普通目录
            }
            // else 默认 type 仍为 'file'

            return {
                name: item.filename,
                type: type,
                size: size,
                modified: modified,
                symlinkTarget: symlinkTarget // 添加符号链接目标，前端可显示
            };
        });

        // 等待所有异步操作完成
        const files = (await Promise.all(filesPromises)).sort((a, b) => {
            // 改进排序逻辑：
            // 1. 目录 ('dir') 优先
            // 2. 符号链接到目录 ('symlink_dir') 其次
            // 3. 文件 ('file')
            // 4. 符号链接到文件 ('symlink_file')
            // 5. 断开的符号链接 ('symlink_broken') 最后
            // 6. 同类型按名称排序

            const typeOrder = { 'dir': 0, 'symlink_dir': 1, 'file': 2, 'symlink_file': 3, 'symlink_broken': 4 };

            if (typeOrder[a.type] !== typeOrder[b.type]) {
                return typeOrder[a.type] - typeOrder[b.type];
            }
            // 类型相同则按名称排序
            return a.name.localeCompare(b.name);
        });
        // 返回规范化后的路径给客户端
        res.json({ path: remotePath, files });
    });
});

// GET /api/download (保持不变，用于单个文件的直接下载，非ZIP)
// SFTP createReadStream 通常会自动跟随符号链接，因此无需修改
app.get('/api/download', (req, res) => {
    if (!sftp) return res.status(503).send('SFTP 服务不可用');
    let remotePath = req.query.path;
    if (!remotePath) return res.status(400).send('必须提供文件路径');

    // 规范化路径
    remotePath = path.posix.normalize(remotePath);

    sftp.stat(remotePath, (err, stats) => { // sftp.stat 默认会跟随符号链接
        if (err) {
            console.error(`[SFTP 下载] 状态错误: ${err.message}, Path: ${remotePath}`);
            return res.status(404).send('文件未找到或访问被拒绝。');
        }
        if (stats.isDirectory()) { // 如果stat后发现是目录（包括跟随链接后的目录），则不让下载
            return res.status(400).send('无法直接下载目录，请使用打包下载功能。');
        }

        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(remotePath)}"`);
        res.setHeader('Content-Length', stats.size);

        const readStream = sftp.createReadStream(remotePath);
        readStream.pipe(res);

        readStream.on('error', (streamErr) => {
            console.error('文件流错误:', streamErr);
            if (!res.headersSent) {
                res.status(500).send('传输文件时出错');
            }
        });
    });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    if (!req.file) return res.status(400).json({ error: '没有文件被上传。' });

    const localPath = req.file.path;
    // 使用 Buffer.from 和 toString 确保文件名编码正确，处理中文名
    const originalFilename = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const cleanFilename = originalFilename.split(/[\\\/]/).pop(); // 提取文件名，防止路径穿越

    // 规范化上传目标目录
    const remoteDirPath = path.posix.normalize(req.body.path);
    const remotePath = path.posix.join(remoteDirPath, cleanFilename);

    console.log(`[上传] 尝试上传文件到: ${remotePath}`);

    const readStream = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath); // createWriteStream 也会跟随链接

    writeStream.on('close', () => {
        fs.unlink(localPath, (err) => { // 删除临时上传文件
            if (err) console.error(`[上传清理] 删除临时文件 ${localPath} 失败:`, err)
        });
        res.json({ success: true, message: `文件已上传至 ${remotePath}` });
    });

    writeStream.on('error', (err) => {
        fs.unlink(localPath, () => {}); // 出现错误也要尝试删除临时文件
        res.status(500).json({ error: `上传失败: ${err.message}` });
    });

    readStream.pipe(writeStream);
});

app.post('/api/rename', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    let { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
        return res.status(400).json({ error: '必须提供旧路径和新路径。' });
    }

    // 规范化路径
    oldPath = path.posix.normalize(oldPath);
    newPath = path.posix.normalize(newPath);

    // sftp.rename 默认会跟随链接
    sftp.rename(oldPath, newPath, (err) => {
        if (err) {
            console.error(`[SFTP 重命名错误] 从 ${oldPath} 到 ${newPath}:`, err);
            return res.status(500).json({ error: `无法重命名: ${err.message}` });
        }
        res.json({ success: true, message: `已重命名为 ${newPath}` });
    });
});

app.delete('/api/delete', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    let { path: delPath, type } = req.body;
    if (!delPath || !type) {
        return res.status(400).json({ error: '必须提供路径和类型。' });
    }

    // 规范化路径
    delPath = path.posix.normalize(delPath);

    // 对于符号链接，无论是指向文件还是目录，都应该使用 unlink 来删除链接本身。
    // 如果想要删除链接目标（即真正的文件或目录），则需要先 resolve 链接。
    // 这里的逻辑是删除链接本身，如果想删除目标，前端需要单独处理。
    const operation = (type === 'dir' || type === 'symlink_dir') ? 'rmdir' : 'unlink'; // 保持原样，如果前端传 'dir' 且是符号链接，rmdir 可能会失败
    // 优化：对于任何类型的符号链接，都应该使用 unlink 来删除符号链接本身
    let actualOperation = 'unlink'; // 默认删除文件或符号链接
    if (type === 'dir') { // 只有在明确是“真”目录时才使用 rmdir
        actualOperation = 'rmdir';
    }

    sftp[actualOperation](delPath, (err) => {
        if (err) {
            console.error(`[SFTP 删除错误] 操作对象 ${delPath}:`, err);
            // 目录不为空的错误码通常是 4 (SSH_FX_BAD_MESSAGE) 或者其他类型
            // 对于 rmdir，如果目录不为空，会报错。对于符号链接，如果用 rmdir 会报错 "Not a directory"
            if (err.code === 4 && type === 'dir' && actualOperation === 'rmdir') {
                return res.status(400).json({ error: '目录不为空，无法删除。' });
            }
            // 如果是符号链接，但前端请求删除类型是 'dir'，且尝试用 rmdir 导致失败
            // 客户端需要知道如何处理符号链接的删除，通常是 unlink 链接本身
            if (err.message.includes("Not a directory") && (type === 'symlink_dir' || type === 'symlink_file')) {
                 return res.status(400).json({ error: `无法删除符号链接，请使用 "文件" 类型删除（unlink 操作）。${err.message}` });
            }
            return res.status(500).json({ error: `删除失败: ${err.message}` });
        }
        res.json({ success: true, message: `已成功删除 ${delPath}` });
    });
});

// 统一的打包下载接口 (现在使用 GET 请求，支持单文件/目录和多选，输出 ZIP 格式)
// 参数示例:
// - 单个文件/目录: /api/package-download?paths=/path/to/file.txt
// - 多个文件/目录: /api/package-download?paths=/path/to/file1&paths=/path/to/dir2
app.get('/api/package-download', async (req, res) => {
    if (!sharedSshClient || !sftp) {
        return res.status(503).send('SSH/SFTP 连接不可用。');
    }

    // 接收参数：req.query.paths 将自动是数组（如果重复）或字符串（如果单个）
    let itemPaths = req.query.paths;
    if (!itemPaths) {
        return res.status(400).send('必须提供要打包的文件或目录路径列表。');
    }
    // 确保 itemPaths 是一个数组
    if (!Array.isArray(itemPaths)) {
        itemPaths = [itemPaths];
    }

    // 规范化所有传入路径
    itemPaths = itemPaths.map(p => path.posix.normalize(p));

    if (itemPaths.length === 0) {
        return res.status(400).send('没有有效的文件或目录进行打包。');
    }

    // 生成唯一的临时文件名
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 8);
    const tempZipPath = `/tmp/webtop-archive-${timestamp}-${randomId}.zip`;

    let outputZipFileName;
    if (itemPaths.length === 1) {
        // 如果只有一个路径，使用该路径的文件/目录名作为压缩包名
        const baseName = path.posix.basename(itemPaths[0]);
        outputZipFileName = `${baseName}.zip`;
    } else {
        // 如果有多个路径，使用通用时间戳作为压缩包名
        outputZipFileName = `webtop_archive_${timestamp}.zip`;
    }

    const cleanup = async () => {
        console.log(`[清理] 正在删除临时ZIP包: ${tempZipPath}`);
        try {
            await executeRemoteCommand(sharedSshClient, `rm -f "${tempZipPath}"`);
        } catch (err) {
            console.error(`[清理失败] 无法删除临时ZIP文件: ${err.message}`);
        }
    };

    try {
        // 1. 确定所有待打包项的最深共同父目录
        let commonBaseDir = '';

        if (itemPaths.length > 0) {
            commonBaseDir = itemPaths[0]; // 从第一个路径开始

            // 如果第一个路径是文件或符号链接，将其父目录作为起始commonBaseDir
            // stat 会跟随符号链接
            try {
                const stats = await new Promise((resolve, reject) => sftp.stat(commonBaseDir, (err, s) => err ? reject(err) : resolve(s)));
                if (!stats.isDirectory()) {
                    commonBaseDir = path.posix.dirname(commonBaseDir);
                }
            } catch (statErr) {
                // 如果路径不存在，或者stat失败，为了安全，假定它是文件或无效路径，取其父目录
                commonBaseDir = path.posix.dirname(commonBaseDir);
            }

            // 遍历所有路径，找到最长的共同前缀
            for (let i = 1; i < itemPaths.length; i++) {
                let currentPathForComparison = itemPaths[i];
                // 确保 commonBaseDir 包含 currentPathForComparison，如果不包含，则向上移动 commonBaseDir
                // 持续向上移动直到 commonBaseDir 成为 currentPathForComparison 的父目录或根目录
                while (commonBaseDir !== path.posix.sep && !currentPathForComparison.startsWith(commonBaseDir + path.posix.sep)) {
                    commonBaseDir = path.posix.dirname(commonBaseDir);
                }
                if (commonBaseDir === path.posix.sep) break; // 如果已经到根目录，就停止
            }
        }

        // 确保 commonBaseDir 是一个规范的绝对路径，如果为空，则默认为根目录
        if (!commonBaseDir || commonBaseDir === '.') {
            commonBaseDir = path.posix.sep;
        } else {
            commonBaseDir = path.posix.normalize(commonBaseDir); // 最终规范化
        }

        console.log(`[ZIP] 计算得到共同父目录: ${commonBaseDir}`);

        // 2. 将所有待打包路径转换为相对于共同根目录的路径
        const relativePaths = itemPaths.map(absolutePath => {
            let relPath = path.posix.relative(commonBaseDir, absolutePath);
            // 关键修复：如果相对路径为空，意味着该项就是 commonBaseDir 本身，
            // 此时应使用 '.' 来表示当前目录的内容。
            if (relPath === '') {
                // 如果是目录，表示打包目录自身，则使用 '.'
                return '.';
            }
            return relPath;
        });

        const validRelativePaths = relativePaths.filter(p => p !== ''); // 过滤掉可能的空路径

        if (validRelativePaths.length === 0) {
            cleanup(); // 没有有效的文件可打包
            return res.status(400).send('没有找到有效的文件或目录进行打包。');
        }

        // 3. 构建 zip 命令，在执行前改变目录
        // cd "/path/to/common/dir" && zip -r -q "/tmp/archive.zip" "file1" "dir2" "."
        const quotedRelativePaths = validRelativePaths.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');

        // 最终的命令字符串
        const zipCommand = `cd "${commonBaseDir}" && zip -r -q "${tempZipPath}" ${quotedRelativePaths}`;
        console.log(`[ZIP] 正在执行: ${zipCommand}`);

        // 执行 zip 命令
        await executeRemoteCommand(sharedSshClient, zipCommand);
        console.log(`[ZIP] 压缩包已创建于 ${tempZipPath}`);

        // 4. 获取ZIP文件大小并发送给客户端
        sftp.stat(tempZipPath, (statErr, stats) => {
            if (statErr) {
                console.error('[SFTP 状态错误]', statErr);
                cleanup();
                return res.status(500).send('无法获取临时ZIP压缩包的状态。');
            }

            res.setHeader('Content-Disposition', `attachment; filename="${outputZipFileName}"`);
            res.setHeader('Content-Type', 'application/zip'); // 始终发送 application/zip
            res.setHeader('Content-Length', stats.size);

            const readStream = sftp.createReadStream(tempZipPath);
            res.on('finish', cleanup); // 传输完成后删除临时文件
            req.on('close', () => { // 客户端断开连接时也删除
                if (!res.finished) {
                    console.log('[连接] 客户端提前关闭了ZIP下载连接，执行清理。');
                    cleanup();
                }
            });

            readStream.on('error', (streamErr) => {
                console.error('[SFTP 流错误]', streamErr);
                cleanup();
                if (!res.headersSent) {
                    res.status(500).send('传输ZIP文件时出错');
                }
            });
            readStream.pipe(res);
        });

    } catch (err) {
        console.error(`[ZIP 错误] 创建或传输ZIP压缩包失败:`, err.message);
        cleanup(); // 无论成功失败，都尝试清理
        res.status(500).send(`打包失败。请确保远程服务器上已安装 'zip' 命令，且文件路径有效。错误: ${err.message}`);
    }
});


app.get('/api/file-content', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    let remotePath = req.query.path;
    if (!remotePath) return res.status(400).json({ error: '必须提供文件路径' });

    // 规范化路径
    remotePath = path.posix.normalize(remotePath);

    // sftp.createReadStream 默认会跟随符号链接
    const readStream = sftp.createReadStream(remotePath, { encoding: 'utf8' });
    let fileContent = '';
    readStream.on('data', (chunk) => { fileContent += chunk; });
    readStream.on('end', () => { res.type('text/plain; charset=utf-8').send(fileContent); });
    readStream.on('error', (err) => { console.error(`[SFTP 读取错误] 文件: ${remotePath}:`, err); res.status(500).json({ error: `读取文件失败: ${err.message}` }); });
});

app.post('/api/save-file', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    let { path: remotePath, content } = req.body;
    if (!remotePath || content === undefined) { return res.status(400).json({ error: '必须提供文件路径和内容。' }); }

    // 规范化路径
    remotePath = path.posix.normalize(remotePath);

    // sftp.createWriteStream 默认会跟随符号链接
    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on('close', () => { res.json({ success: true, message: `文件已成功保存至 ${remotePath}` }); });
    writeStream.on('error', (err) => { console.error(`[SFTP 写入错误] 文件: ${remotePath}:`, err); res.status(500).json({ error: `保存文件失败: ${err.message}` }); });
    writeStream.end(Buffer.from(content, 'utf8'));
});

// 新增：创建目录 API 接口
app.post('/api/mkdir', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    let { path: dirPath } = req.body;
    if (!dirPath) {
        return res.status(400).json({ error: '必须提供要创建的目录路径。' });
    }

    // 规范化路径
    dirPath = path.posix.normalize(dirPath);

    sftp.mkdir(dirPath, (err) => {
        if (err) {
            console.error(`[SFTP 创建目录错误] 路径: ${dirPath}:`, err);
            return res.status(500).json({ error: `创建目录失败: ${err.message}` });
        }
        res.json({ success: true, message: `目录 "${dirPath}" 已成功创建。` });
    });
});

// 新增：创建空文件 API 接口
app.post('/api/touch', (req, res) => {
    if (!sftp) return res.status(503).json({ error: 'SFTP 服务不可用' });
    let { path: filePath, content = '' } = req.body; // 允许提供初始内容，默认为空
    if (!filePath) {
        return res.status(400).json({ error: '必须提供要创建的文件路径。' });
    }

    // 规范化路径
    filePath = path.posix.normalize(filePath);

    // 使用 createWriteStream 创建文件并立即关闭（如果内容为空）或写入内容
    // sftp.createWriteStream 默认会跟随符号链接
    const writeStream = sftp.createWriteStream(filePath);
    writeStream.on('close', () => {
        res.json({ success: true, message: `文件 "${filePath}" 已成功创建。` });
    });
    writeStream.on('error', (err) => {
        console.error(`[SFTP 创建文件错误] 路径: ${filePath}:`, err);
        res.status(500).json({ error: `创建文件失败: ${err.message}` });
    });
    // 写入内容并结束流
    writeStream.end(Buffer.from(content, 'utf8'));
});


// --- (静态文件服务和 WebSocket 逻辑) ---
app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws, req) => {
    // WebSocket 连接升级请求不经过 Express 中间件，因此不需要单独处理验证
    // 但如果需要，可以在这里检查 req.headers.authorization
    console.log('[WebSocket] 客户端已连接，用于终端会话。');
    let statsInterval;
    let lastStats = null;
    const sshClient = new InteractiveSSH(sshConfig);

    sshClient.on('shell', (shellStream) => {
        console.log('[SSH -> WebSocket] Shell 已准备好，可用于终端。');
        shellStream.on('data', (data) => ws.send(data));

        ws.on('message', (data) => {
            try {
                const parsedMsg = JSON.parse(data.toString());
                if (parsedMsg.type === 'resize') {
                    shellStream.setWindow(parsedMsg.rows, parsedMsg.cols);
                    return;
                }
            } catch (e) {
                /* 不是 JSON 数据，直接写入 shell */
            }
            shellStream.write(data);
        });

        // 启动状态监控
        statsInterval = setInterval(async () => {
            try {
                const currentStats = await getRemoteStats(sshClient.conn);
                let rxSpeed = 0, txSpeed = 0;
                if (lastStats) {
                    const timeDiff = (currentStats.timestamp - lastStats.timestamp) / 1000;
                    if (timeDiff > 0) {
                        rxSpeed = (currentStats.rx_bytes - lastStats.rx_bytes) / timeDiff;
                        txSpeed = (currentStats.tx_bytes - lastStats.tx_bytes) / timeDiff;
                    }
                }
                const statsForClient = {
                    ...currentStats,
                    rxSpeed: `${formatBytes(rxSpeed)}/s`,
                    txSpeed: `${formatBytes(txSpeed)}/s`
                };
                lastStats = currentStats; // 更新上一次的统计数据
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'stats', data: statsForClient }));
                }
            } catch (error) {
                console.error('[状态错误] ', error.message);
                lastStats = null; // 出现错误时重置lastStats，防止下次计算速度出错
            }
            // 确保sshClient.conn存在且可用，避免在连接中断后重复报错
            if (!sshClient.conn || sshClient.conn._state !== 'ready') {
                console.warn('[状态监控] SSH连接不再就绪，停止状态监控。');
                clearInterval(statsInterval);
            }
        }, 2000); // 每2秒发送一次状态

        shellStream.on('close', () => {
            ws.close();
        });
    });

    sshClient.on('error', (err) => {
        if (ws.readyState === ws.OPEN) ws.send(`\x1b[31m[SSH 连接错误: ${err.message}]\x1b[0m\r\n`);
        ws.close();
    });

    ws.on('close', () => {
        console.log('[WebSocket -> SSH] 客户端断开连接，关闭终端 SSH 连接。');
        if (statsInterval) {
            clearInterval(statsInterval); // 清除定时器
        }
        sshClient.disconnect();
    });

    sshClient.connect(); // 启动 SSH 连接
});

server.listen(PORT, () => console.log(`服务器正在 http://localhost:${PORT} 上运行`));
