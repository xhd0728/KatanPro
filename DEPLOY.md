# 部署到 Linux 服务器的 0.0.0.0:52001

以下以有 SSH 权限、使用 systemd 的 Linux 服务器为例。把 `DEPLOY_USER@SERVER_IP` 换成实际 SSH 用户和公网 IP。服务器先安装 Node.js 22 或更新版本与 npm；可先运行 `node --version`、`npm --version` 确认。

## 1. 建目录并传文件

在**新服务器**上运行：

```bash
sudo mkdir -p /opt/catan
sudo chown "$(id -un):$(id -gn)" /opt/catan
```

在**这台开发电脑**上运行：

```bash
cd /path/to/KatanPro
tar --exclude=node_modules --exclude=artifacts --exclude=ai.config.local.js --exclude=REVIEW.md --exclude=.env --exclude=.git -czf /tmp/catan-release.tgz .
scp /tmp/catan-release.tgz DEPLOY_USER@SERVER_IP:/tmp/
scp .env DEPLOY_USER@SERVER_IP:/opt/catan/
```

`.env` 包含 AI 服务密钥，源码包已排除它；单独通过 SSH 传输。若本地还没有 `.env`，先复制 `.env.example` 并填写配置。在**新服务器**继续：

```bash
tar -xzf /tmp/catan-release.tgz -C /opt/catan
chmod 600 /opt/catan/.env
cd /opt/catan
npm ci --omit=dev
```

项目由 `server.js` 同时提供页面与 WebSocket，毋须单独构建前端。AI 配置在服务端默认读取，网页无需填写。

## 2. 验证监听地址和端口

在服务器运行：

```bash
cd /opt/catan
HOST=0.0.0.0 PORT=52001 npm start
```

保持该终端运行，另开 SSH 终端检查：

```bash
ss -lntp | grep ':52001'
curl http://127.0.0.1:52001/api/rooms
```

应看到 `0.0.0.0:52001`；初次运行时房间列表通常是 `[]`。确认后用 `Ctrl+C` 停掉前台进程，再配置常驻服务。

## 3. 用 systemd 常驻运行

在服务器执行下方命令。它会填入当前 SSH 用户名与 `node` 的实际路径：

```bash
sudo tee /etc/systemd/system/catan.service >/dev/null <<EOF
[Unit]
Description=Catan game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=/opt/catan
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=52001
ExecStart=$(command -v node) /opt/catan/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now catan
sudo systemctl status catan --no-pager
```

看日志：`sudo journalctl -u catan -f`。更新代码后重新传输、运行 `npm ci --omit=dev`，再执行 `sudo systemctl restart catan`。

## 4. 开放外部访问

在云平台的安全组或防火墙中放行入站 **TCP 52001**。如果服务器使用 UFW，还需运行：

```bash
sudo ufw allow 52001/tcp
```

然后在手机或另一台电脑打开 `http://SERVER_IP:52001/`。`0.0.0.0` 是服务器监听所有 IPv4 网卡的地址，不是浏览器应访问的地址。房间和对局目前只在内存中，重启服务会清空它们。
