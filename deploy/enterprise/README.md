# FoodFlow 企业版部署指南（2台服务器）

> **定位**：单个餐饮品牌，2台服务器双机负载均衡
> **适用规模**：100-200家门店
> **并发能力**：约3,000同时在线

---

## 一、架构概览

```
                    ┌─────────────┐
                    │   Nginx LB   │  负载均衡 + SSL
                    │  (可复用节点1)│
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
        ┌─────▼─────┐           ┌─────▼─────┐
        │  App Node1 │           │  App Node2 │  Node.js 应用服务器
        │  4核8GB    │           │  4核8GB    │
        │  (主节点)   │           │  (从节点)   │
        └─────┬─────┘           └─────┬─────┘
              │                         │
              └──────────┬──────────────┘
                         │
              ┌──────────▼──────────┐
              │   MySQL 高可用版     │  8核16GB 200GB SSD
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   Redis 主从版       │  4GB（共享缓存+限流）
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   NFS 共享存储        │  菜品图片上传目录
              └─────────────────────┘
```

---

## 二、服务器清单

| 角色 | 规格 | 数量 | 说明 |
|------|------|------|------|
| 应用服务器 | 4核8GB 100GB | 2台 | 主节点执行定时任务 |
| MySQL数据库 | 8核16GB 200GB SSD | 1套（高可用） | 云数据库或自建主从 |
| Redis缓存 | 4GB | 1套（主从） | 共享缓存+限流状态 |
| NFS存储 | 2核4GB 500GB | 1台 | 可复用数据库服务器 |

> **注意**：Nginx负载均衡可复用其中一台应用服务器，无需单独购买。

---

## 三、部署步骤

### 步骤1：配置NFS共享存储服务器

```bash
# 在NFS服务器上运行
sudo bash deploy/standard/cluster/setup-nfs-server.sh
```

### 步骤2：初始化数据库

```bash
# 先编辑 init-db.sh 中的数据库配置
sudo bash deploy/standard/cluster/init-db.sh
```

### 步骤3：部署主节点应用服务器

```bash
# 在第一台应用服务器上运行
sudo bash deploy/standard/cluster/deploy.sh master

# 编辑环境变量配置
sudo nano /etc/foodflow/.env
# 配置数据库、Redis、NFS挂载点等

# 重启服务
sudo systemctl restart foodflow
```

### 步骤4：部署从节点应用服务器

```bash
# 在第二台应用服务器上运行
sudo bash deploy/standard/cluster/deploy.sh slave

# 编辑环境变量配置（数据库、Redis与主节点相同）
sudo nano /etc/foodflow/.env
# 注意：从节点不需要 RUN_SCHEDULED_TASKS=true

# 重启服务
sudo systemctl restart foodflow
```

### 步骤5：配置Nginx负载均衡

```bash
# 在Nginx服务器上（可复用节点1）
sudo cp deploy/standard/cluster/nginx.conf /etc/nginx/conf.d/foodflow.conf

# 编辑配置
sudo nano /etc/nginx/conf.d/foodflow.conf
# - server_name: 修改为你的域名
# - upstream 中的服务器IP: 修改为两台应用服务器的实际IP
# - SSL证书路径: 修改为实际证书路径

# 测试并加载配置
sudo nginx -t
sudo systemctl reload nginx
```

### 步骤6：配置SSL证书（推荐）

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 四、环境变量说明

编辑 `/etc/foodflow/.env`：

| 变量 | 说明 | 主节点 | 从节点 |
|------|------|--------|--------|
| `DB_HOST` | 数据库主机 | ✅ 相同 | ✅ 相同 |
| `DB_NAME` | 数据库名 | foodflow_standard | foodflow_standard |
| `REDIS_URL` | Redis连接（必须） | ✅ 相同 | ✅ 相同 |
| `UPLOAD_DIR` | 上传目录（NFS） | /mnt/shared/uploads | /mnt/shared/uploads |
| `RUN_SCHEDULED_TASKS` | 执行定时任务 | **true** | **不设置** |
| `JWT_SECRET` | JWT密钥 | ✅ 相同 | ✅ 相同 |

> **关键**：两台节点的数据库、Redis、NFS配置必须完全相同！

---

## 五、运维命令

```bash
# 服务管理
sudo systemctl status foodflow
sudo systemctl restart foodflow
sudo journalctl -u foodflow -f

# 滚动更新应用（不中断服务）
# 1. 在主节点更新
cd /var/www/foodflow && sudo git pull && sudo npm install --production && sudo systemctl restart foodflow
# 2. 等待主节点启动后，在从节点执行相同操作

# NFS管理
df -h /mnt/shared/uploads
mountpoint /mnt/shared/uploads

# 健康检查
curl -s http://192.168.1.101:3000/health
curl -s http://192.168.1.102:3000/health
```

---

## 六、常见问题

### Q1：图片上传后404？
A：检查两台服务器的NFS是否正常挂载：`df -h /mnt/shared/uploads`

### Q2：防重复下单不生效？
A：检查 `REDIS_URL` 是否配置正确，两台服务器是否都能连接到同一个Redis。

### Q3：定时任务执行了两次？
A：检查从节点的 `/etc/foodflow/.env` 中是否设置了 `RUN_SCHEDULED_TASKS=true`，从节点不应设置此项。

### Q4：某个节点故障怎么办？
A：Nginx会自动剔除故障节点，流量自动转发到正常节点。修复后重启服务即可自动加入集群。
