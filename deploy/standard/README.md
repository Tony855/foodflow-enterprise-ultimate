# FoodFlow 标准版部署指南（单台部署）

> **定位**：单个餐饮品牌，所有服务在一台服务器
> **适用规模**：1-50家门店
> **并发能力**：约500同时在线

---

## 一、服务器配置要求

| 配置项 | 最低配置 | 推荐配置 |
|--------|---------|---------|
| CPU | 2核 | 4核 |
| 内存 | 4GB | 8GB |
| 硬盘 | 50GB SSD | 100GB SSD |
| 带宽 | 5Mbps | 10Mbps |
| 系统 | Debian 11+ / Ubuntu 20.04+ | Debian 12 / Ubuntu 22.04 |

---

## 二、架构图

```
┌─────────────────────────────────────────┐
│            单台服务器                     │
│                                         │
│  ┌─────────┐    ┌──────────────────┐  │
│  │  Nginx  │───▶│  Node.js 应用     │  │
│  │  (SSL)  │    │  (端口3000)       │  │
│  └─────────┘    └────────┬─────────┘  │
│                           │             │
│              ┌────────────┴──────────┐  │
│              │                       │  │
│        ┌─────▼─────┐          ┌────▼─────┐│
│        │  MariaDB   │          │   Redis   ││
│        │ (兼容MySQL) │          │  (缓存)   ││
│        └───────────┘          └──────────┘│
│                                         │
│  上传目录：/var/www/foodflow/uploads/   │
└─────────────────────────────────────────┘
```

---

## 三、快速部署

### 方式一：一键安装脚本（推荐）

```bash
# 1. 下载代码
git clone https://github.com/Tony855/foodflow-standard.git
cd foodflow-standard

# 2. 运行一键安装脚本，选择"标准版 - 单台部署"
sudo bash install.sh
```

### 方式二：手动部署脚本

```bash
sudo bash deploy/standard/deploy.sh
```

### 方式三：手动部署

详见 `deploy/standard/deploy.sh` 脚本中的步骤。

---

## 四、环境变量说明

编辑 `/etc/foodflow/.env`：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 应用端口 | 3000 |
| `DB_HOST` | 数据库主机 | 127.0.0.1 |
| `DB_PORT` | 数据库端口 | 3306 |
| `DB_NAME` | 数据库名 | foodflow_standard |
| `DB_USER` | 数据库用户 | foodflow |
| `DB_PASSWORD` | 数据库密码 | （需修改） |
| `DB_CONNECTION_LIMIT` | 连接池大小 | 50 |
| `REDIS_URL` | Redis连接（可选） | 不配置则用内存 |
| `UPLOAD_DIR` | 上传目录 | /var/www/foodflow/uploads |
| `RUN_SCHEDULED_TASKS` | 执行定时任务 | true |
| `QR_DOMAIN` | 二维码域名 | （需修改） |
| `JWT_SECRET` | JWT密钥 | （需修改为随机字符串） |

> **注意**：Redis是可选的，不配置 `REDIS_URL` 时系统自动使用内存Map，功能完全正常。

---

## 五、运维命令

```bash
# 服务管理
sudo systemctl status foodflow    # 查看状态
sudo systemctl restart foodflow   # 重启服务
sudo systemctl stop foodflow      # 停止服务

# 查看日志
sudo journalctl -u foodflow -f           # 实时日志
sudo journalctl -u foodflow -n 100       # 最近100行日志

# 应用更新
cd /var/www/foodflow
sudo git pull origin main
sudo npm install --production
sudo systemctl restart foodflow

# Nginx管理
sudo nginx -t                    # 测试配置
sudo systemctl reload nginx      # 重载配置
sudo tail -f /var/log/nginx/access.log   # 访问日志
sudo tail -f /var/log/nginx/error.log    # 错误日志

# 数据库管理（MariaDB，命令与MySQL完全兼容）
sudo mysql -u root -p           # 登录数据库
sudo mysqldump foodflow_standard > backup.sql  # 备份数据库

# Redis管理
redis-cli ping                   # 测试连接
redis-cli info memory            # 查看内存使用
```

---

## 六、常见问题

### Q1：访问页面显示502 Bad Gateway？
A：Node.js应用未启动，检查：
```bash
sudo systemctl status foodflow
sudo journalctl -u foodflow -n 50
```

### Q2：图片上传后不显示？
A：检查上传目录权限：
```bash
ls -la /var/www/foodflow/uploads/
sudo chown -R www-data:www-data /var/www/foodflow/uploads
```

### Q3：如何修改数据库密码？
A：编辑 `/etc/foodflow/.env` 中的 `DB_PASSWORD`，然后重启：
```bash
sudo systemctl restart foodflow
```

### Q4：如何备份数据？
A：系统自动备份（每5分钟检查一次），备份文件在 `/var/www/foodflow/backups/`。
手动备份：
```bash
sudo mysqldump foodflow_standard > /var/www/foodflow/backups/manual_$(date +%Y%m%d).sql
```

### Q5：如何查看版本？
```bash
cd /var/www/foodflow
git log --oneline -1
```

---

## 七、安全建议

1. **修改默认密码**：数据库root密码、应用数据库密码、JWT密钥
2. **配置防火墙**：只开放 80、443 端口，SSH改为非默认端口
3. **启用SSL**：使用 Let's Encrypt 免费证书
4. **定期备份**：确认自动备份正常，定期下载备份到异地
5. **系统更新**：定期运行 `apt-get update && apt-get upgrade`

---

## 八、升级到企业版

当业务增长需要更高可用性时，可以升级到企业版（2台服务器部署）：

1. 准备第二台应用服务器
2. 准备独立的MySQL和Redis服务器
3. 准备NFS共享存储
4. 迁移数据库和上传文件
5. 部署2台应用服务器节点
6. 配置Nginx负载均衡
7. 切换DNS，下线旧服务器

详见 `deploy/enterprise/README.md`
