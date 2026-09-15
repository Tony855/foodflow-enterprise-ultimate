# FoodFlow 企业旗舰版部署指南（多台服务器集群）

> **定位**：多商户/SaaS平台，多台应用服务器集群，可水平扩展
> **适用规模**：200+家门店，多个餐饮品牌/商户
> **并发能力**：5,000+同时在线（可水平扩展）

---

## 一、架构概览

```
                    ┌─────────────┐
                    │   Nginx LB   │  负载均衡 + SSL + WAF
                    │  4核8GB      │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
  ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
  │  App Node1 │    │  App Node2 │    │  App NodeN │  应用服务器集群
  │  8核16GB   │    │  8核16GB   │    │  8核16GB   │  （可水平扩展）
  │  (主节点)   │    │  (从节点)   │    │  (从节点)   │
  └─────┬─────┘    └─────┬─────┘    └─────┬─────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
              ┌────────────▼────────────┐
              │   MySQL 高可用集群       │  16核32GB 500GB SSD
              │   (读写分离/分库分表)     │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   Redis 集群             │  8GB+（哨兵/集群模式）
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │   对象存储 / NFS         │  菜品图片、备份文件
              └─────────────────────────┘
```

---

## 二、服务器清单

| 角色 | 规格 | 数量 | 说明 |
|------|------|------|------|
| Nginx负载均衡 | 4核8GB 40GB | 1-2台 | 建议2台做HA |
| 应用服务器 | 8核16GB 100GB | 3台起 | 可按需扩展到N台 |
| MySQL数据库 | 16核32GB 500GB SSD | 1套（高可用） | 建议云数据库企业版 |
| Redis缓存 | 8GB+ | 1套（集群/哨兵） | 共享缓存+限流+会话 |
| 对象存储/NFS | 1TB+ | 1套 | 菜品图片、备份文件 |

---

## 三、企业版特有功能

- ✅ **超级管理员后台**：统一管理所有商户、门店、用户
- ✅ **多商户隔离**：每个商户数据独立，权限严格隔离
- ✅ **商户编码自动生成**：FF+年月+序号，全局唯一
- ✅ **商户自助注册**：可配置是否开放商户自助注册
- ✅ **操作审计日志**：所有管理员操作全程记录
- ✅ **登录日志**：记录所有登录IP、地点、时间
- ✅ **自动清理日志**：可配置日志保留天数
- ✅ **全局系统设置**：超时时间、下单限制、呼叫限制等统一配置
- ✅ **全量备份/恢复**：支持所有商户数据一键备份恢复

---

## 四、部署步骤

### 步骤1：配置共享存储（NFS或对象存储）

```bash
# NFS方式
sudo bash deploy/enterprise/cluster/setup-nfs-server.sh
```

### 步骤2：初始化数据库

```bash
# 编辑 init-db.sh 中的数据库配置
sudo bash deploy/enterprise/cluster/init-db.sh
```

### 步骤3：部署主节点

```bash
sudo bash deploy/enterprise/cluster/deploy.sh master
sudo nano /etc/foodflow/.env  # 配置数据库、Redis、NFS
sudo systemctl restart foodflow
```

### 步骤4：部署从节点（可重复部署N台）

```bash
sudo bash deploy/enterprise/cluster/deploy.sh slave
sudo nano /etc/foodflow/.env  # 配置相同的数据库、Redis、NFS
sudo systemctl restart foodflow
```

### 步骤5：配置Nginx负载均衡

```bash
sudo cp deploy/enterprise/cluster/nginx.conf /etc/nginx/conf.d/foodflow.conf
sudo nano /etc/nginx/conf.d/foodflow.conf  # 修改域名、服务器IP、SSL
sudo nginx -t && sudo systemctl reload nginx
```

### 步骤6：配置SSL证书

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 五、环境变量说明

| 变量 | 说明 | 主节点 | 从节点 |
|------|------|--------|--------|
| `APP_VERSION` | 版本标识 | enterprise | enterprise |
| `DB_NAME` | 数据库名 | foodflow_enterprise | foodflow_enterprise |
| `DB_CONNECTION_LIMIT` | 连接池大小 | 100 | 100 |
| `REDIS_URL` | Redis连接（必须） | ✅ 相同 | ✅ 相同 |
| `UPLOAD_DIR` | 上传目录 | /mnt/shared/uploads | /mnt/shared/uploads |
| `RUN_SCHEDULED_TASKS` | 定时任务 | **true** | **不设置** |
| `MERCHANT_CODE_PREFIX` | 商户编码前缀 | FF | FF |
| `ALLOW_MERCHANT_REGISTRATION` | 商户自助注册 | false | false |
| `MAX_STORES_PER_MERCHANT` | 单商户最大门店数 | 0(不限) | 0(不限) |

---

## 六、水平扩展

### 添加新的应用服务器节点

```bash
# 1. 准备新服务器，运行从节点部署脚本
sudo bash deploy/enterprise/cluster/deploy.sh slave

# 2. 在Nginx配置的upstream中添加新节点
sudo nano /etc/nginx/conf.d/foodflow.conf
# upstream foodflow_enterprise {
#     server 192.168.1.101:3000 ...
#     server 192.168.1.102:3000 ...
#     server 192.168.1.103:3000 ...  # 新增
# }

# 3. 重载Nginx
sudo nginx -t && sudo systemctl reload nginx
```

### 扩容路线图

| 规模 | 应用服务器 | 数据库 | Redis |
|------|-----------|--------|-------|
| 200-300家 | 3台4核8GB | 8核16GB | 4GB |
| 300-500家 | 4台8核16GB | 16核32GB + 只读 | 8GB |
| 500-1000家 | 6-8台8核16GB | 分库分表 | 集群模式 |
| 1000+家 | K8s容器化 | 分布式数据库 | Redis Cluster |

---

## 七、运维命令

```bash
# 服务管理
sudo systemctl status foodflow
sudo systemctl restart foodflow
sudo journalctl -u foodflow -f --since "1 hour ago"

# 滚动更新（逐台重启，不中断服务）
for node in 192.168.1.101 192.168.1.102 192.168.1.103; do
    ssh $node "cd /var/www/foodflow && git pull && npm install --production && systemctl restart foodflow"
    sleep 10
done

# 健康检查
for node in 192.168.1.101 192.168.1.102 192.168.1.103; do
    echo -n "$node: "
    curl -s http://$node:3000/health
done

# 查看负载均衡状态
tail -f /var/log/nginx/access.log | awk '{print $NF}' | sort | uniq -c
```

---

## 八、安全建议

1. **数据库**：使用云数据库企业版，开启自动备份和Binlog
2. **Redis**：设置密码，禁用危险命令（FLUSHALL等）
3. **网络**：应用服务器不暴露公网，只允许Nginx访问
4. **SSH**：修改默认端口，使用密钥登录，禁用密码登录
5. **监控**：配置CPU、内存、磁盘、接口响应时间告警
6. **备份**：确认自动备份正常，定期下载备份到异地存储
