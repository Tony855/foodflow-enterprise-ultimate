# FoodFlow QR Ordering System - Installation Guide

## 目录
1. [系统要求](#1-系统要求)
2. [Windows 安装步骤](#2-windows-安装步骤)
3. [Linux / Debian 安装步骤](#3-linux--debian-安装步骤)
4. [一键安装脚本（推荐 Linux）](#4-一键安装脚本推荐-linux)
5. [手动安装步骤（通用）](#5-手动安装步骤通用)
6. [配置说明](#6-配置说明)
7. [启动与访问](#7-启动与访问)
8. [默认账号与初始数据](#8-默认账号与初始数据)
9. [打印机配置](#9-打印机配置)
10. [常见问题排查](#10-常见问题排查)

---

## 1. 系统要求

### 最低配置
- **操作系统**: Windows 10/11、Debian 11+、Ubuntu 20.04+、CentOS 8+
- **Node.js**: v20.0 或更高版本
- **数据库**: MySQL 8.0+ 或 MariaDB 10.5+
- **内存**: 512MB 以上（推荐 1GB）
- **磁盘**: 500MB 可用空间

### 推荐配置
- Node.js v20 LTS
- MySQL 8.4 或 MariaDB 11.x
- 内存 2GB 以上
- 固定 IP 地址（局域网内访问）

---

## 2. Windows 安装步骤

### 2.1 安装 Node.js

1. 访问 [Node.js 官网](https://nodejs.org/)
2. 下载 **LTS 版本**（推荐 v20.x）
3. 运行安装程序，一路下一步即可
4. 验证安装：
   ```cmd
   node --version
   npm --version
   ```
   应显示 v20.x.x 和对应的 npm 版本。

### 2.2 安装 MySQL

#### 方式一：MySQL 官方安装包（推荐）

1. 访问 [MySQL 下载页](https://dev.mysql.com/downloads/mysql/)
2. 下载 **MySQL Installer for Windows**
3. 运行安装程序，选择 **Server only** 或 **Developer Default**
4. 安装过程中设置 root 密码（请牢记此密码）
5. 安装完成后，MySQL 服务会自动启动

#### 方式二：使用 XAMPP（更简单）

1. 访问 [XAMPP 官网](https://www.apachefriends.org/)
2. 下载并安装 XAMPP
3. 打开 XAMPP Control Panel，启动 MySQL
4. XAMPP 的 MySQL 默认 root 密码为空

### 2.3 验证 MySQL 运行

```cmd
mysql -u root -p
```
输入密码后能进入 MySQL 命令行即表示成功。

### 2.4 下载项目代码

```cmd
cd C:\Users\你的用户名\Downloads
git clone https://github.com/Tony855/foodflow.git
cd foodflow
```

如果没有安装 Git，可以直接从 GitHub 下载 ZIP 包并解压。

### 2.5 配置环境变量

复制配置模板：
```cmd
copy .env.example .env
```

编辑 `.env` 文件（用记事本或 VS Code 打开）：
```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_DATABASE=ordering_system
DB_PORT=3306
```

> **注意**: 如果 MySQL 使用非默认端口（如 3307），请修改 `DB_PORT`。

### 2.6 安装依赖

```cmd
npm install
```

### 2.7 初始化数据库

```cmd
node server.js --init-only
```

看到以下输出表示成功：
```
数据库不存在，尝试创建...
首次安装：已初始化 45 道菜品
数据库初始化完成
```

### 2.8 启动服务器

```cmd
node server.js
```

看到以下输出表示启动成功：
```
后端服务已启动: http://localhost:3000
数据库: MySQL (ordering_system)
```

### 2.9 访问系统

打开浏览器访问：
- 顾客点餐: http://localhost:3000/
- 管理后台: http://localhost:3000/login
- 服务员端: http://localhost:3000/waiter
- 后厨显示: http://localhost:3000/kitchen

### 2.10 设置开机自启（可选）

使用 [pm2](https://pm2.keymetrics.io/) 进程管理器：

```cmd
npm install -g pm2
pm2 start server.js --name foodflow
pm2 save
pm2 startup
```

---

## 3. Linux / Debian 安装步骤

### 3.1 更新系统

```bash
sudo apt update
sudo apt upgrade -y
```

### 3.2 安装 Node.js

#### 方式一：使用 NodeSource 仓库（推荐）

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

#### 方式二：使用系统包管理器

```bash
sudo apt install -y nodejs npm
```

> **注意**: Debian 12 之前的版本 apt 中的 Node.js 可能版本过低，建议使用方式一。

验证安装：
```bash
node --version  # 应显示 v20.x.x
npm --version
```

### 3.3 安装 MySQL / MariaDB

#### Debian / Ubuntu：

```bash
sudo apt install -y mariadb-server
sudo systemctl start mariadb
sudo systemctl enable mariadb
```

#### 设置 root 密码：

```bash
sudo mysql_secure_installation
```

按照提示设置 root 密码，其他选项按 Y 即可。

或者手动设置：
```bash
sudo mariadb -u root
```
进入 MySQL 后执行：
```sql
ALTER USER 'root'@'localhost' IDENTIFIED BY '你的密码';
FLUSH PRIVILEGES;
EXIT;
```

### 3.4 下载项目代码

```bash
cd /opt
sudo git clone https://github.com/Tony855/foodflow.git
cd foodflow
sudo chown -R $USER:$USER /opt/foodflow
```

### 3.5 配置环境变量

```bash
cp .env.example .env
nano .env
```

修改内容：
```
PORT=3000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_DATABASE=ordering_system
DB_PORT=3306
```

按 `Ctrl+O` 保存，`Ctrl+X` 退出。

### 3.6 安装依赖

```bash
npm install
```

### 3.7 初始化数据库

```bash
node server.js --init-only
```

### 3.8 启动服务器

#### 前台启动（测试用）：
```bash
node server.js
```

#### 后台启动（生产用）：
```bash
nohup node server.js > server.log 2>&1 &
```

#### 使用 systemd 服务（推荐，开机自启）：

创建服务文件：
```bash
sudo nano /etc/systemd/system/foodflow.service
```

写入以下内容（修改路径和用户）：
```ini
[Unit]
Description=FoodFlow QR Ordering System
After=network.target mariadb.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/foodflow
EnvironmentFile=/opt/foodflow/.env
ExecStart=/usr/bin/node /opt/foodflow/server.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：
```bash
sudo systemctl daemon-reload
sudo systemctl start foodflow
sudo systemctl enable foodflow
```

查看状态：
```bash
sudo systemctl status foodflow
```

查看日志：
```bash
sudo journalctl -u foodflow -f
```

### 3.9 配置防火墙

```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

### 3.10 访问系统

获取服务器 IP：
```bash
hostname -I
```

在局域网内其他设备的浏览器中访问：
- 顾客点餐: `http://服务器IP:3000/`
- 管理后台: `http://服务器IP:3000/login`

---

## 4. 一键安装脚本（推荐 Linux）

项目提供了一键安装脚本，自动完成 Node.js、MySQL、依赖安装和服务配置。

### 使用方法

```bash
# 下载项目
git clone https://github.com/Tony855/foodflow.git
cd foodflow

# 运行一键安装（需要 root 权限）
sudo bash onekey-install.sh
```

### 脚本自动完成

1. ✅ 安装 Node.js v20+（如未安装）
2. ✅ 安装 MySQL/MariaDB（如未安装）
3. ✅ 自动生成数据库 root 密码
4. ✅ 创建数据库 `ordering_system`
5. ✅ 安装 Node.js 依赖
6. ✅ 初始化数据库表和初始数据
7. ✅ 配置 systemd 服务并开机自启
8. ✅ 启动服务

### 安装完成后

脚本会输出访问地址和默认密码：
```
✅ 安装完成。
👉 顾客点餐页：http://你的服务器IP
👉 后台管理：http://你的服务器IP/login
👉 默认后台密码：admin123
👉 数据库 root 密码已保存至：/root/.mysql_root_password
```

### 服务管理命令

```bash
# 查看状态
sudo systemctl status foodflow

# 重启服务
sudo systemctl restart foodflow

# 停止服务
sudo systemctl stop foodflow

# 查看日志
sudo journalctl -u foodflow -f
```

---

## 5. 手动安装步骤（通用）

适用于所有支持 Node.js 和 MySQL 的系统。

### 步骤 1：安装 Node.js
确保 Node.js 版本 >= 20.0

### 步骤 2：安装并启动 MySQL/MariaDB
确保 MySQL 服务正在运行，记录 root 密码。

### 步骤 3：下载代码
```bash
git clone https://github.com/Tony855/foodflow.git
cd foodflow
```

### 步骤 4：配置 .env
```bash
cp .env.example .env
# 编辑 .env，填入数据库密码
```

### 步骤 5：安装依赖
```bash
npm install
```

### 步骤 6：初始化数据库
```bash
node server.js --init-only
```

### 步骤 7：启动服务
```bash
node server.js
```

---

## 6. 配置说明

### .env 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务器监听端口 | `3000` |
| `DB_HOST` | 数据库主机地址 | `localhost` |
| `DB_USER` | 数据库用户名 | `root` |
| `DB_PASSWORD` | 数据库密码 | （必填） |
| `DB_DATABASE` | 数据库名称 | `ordering_system` |
| `DB_PORT` | 数据库端口 | `3306` |

### 数据库字符集

系统默认使用 `utf8mb4` 字符集，支持中文、emoji 等所有 Unicode 字符。
- 数据库：`CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
- 所有表：`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
- 连接池：`charset: 'utf8mb4'`

### 初始化数据说明

首次安装时自动初始化以下数据（**仅首次安装执行，重启不覆盖**）：

- **菜品**: 45 道烧腊菜品，8 个分类
  - 招牌烧腊（13道）、烧腊饭（6道）、烧腊加料（4道）
  - 饮料（3道）、快餐（3道）、卤菜（3道）
  - 早茶（10道）、面食（3道）
- **菜品默认状态**: 全部下架（active=0），需管理员手动上架
- **货币**: 5 种
  - USD 美元（默认货币，汇率 1.0）
  - CNY 人民币（汇率 7.0）
  - KHR 柬埔寨瑞尔（汇率 4000）
  - THB 泰铢（汇率 32.0）
  - VND 越南盾（汇率 25000）
- **双货币显示**: 默认启用，第二货币为柬埔寨瑞尔（KHR）
- **桌台**: 12 个桌台（A01-A04, B01-B04, C01-C04）
- **管理员**: 密码 `admin123`

---

## 7. 启动与访问

### 启动命令

```bash
# 前台启动（可看到日志，Ctrl+C 停止）
node server.js

# 后台启动
nohup node server.js > server.log 2>&1 &

# 使用 pm2（推荐）
pm2 start server.js --name foodflow
```

### 页面地址

| 页面 | 地址 | 说明 |
|------|------|------|
| 顾客点餐 | `/` 或 `/index.html` | 扫码进入，无需登录 |
| 统一登录 | `/login` | 管理员/服务员登录入口 |
| 管理后台 | `/admin` | 需管理员登录 |
| 服务员端 | `/waiter` | 需服务员登录 |
| 后厨显示 | `/kitchen` | 后厨订单显示 |

### 局域网访问

1. 确保服务器防火墙开放了对应端口
2. 查看服务器 IP：
   - Windows: `ipconfig`
   - Linux: `hostname -I`
3. 其他设备访问 `http://服务器IP:端口号`

### 生成桌台二维码

1. 登录管理后台
2. 进入「桌台管理」
3. 点击桌台的「二维码」按钮
4. 下载并打印二维码，贴在对应桌台上

---

## 8. 默认账号与初始数据

### 管理员账号
- **登录方式**: 密码登录
- **默认密码**: `admin123`
- **后台密钥**: `admin-key-2026`（API 调用使用）
- **首次登录后请立即修改密码**

### 服务员账号
系统初始没有服务员账号，需管理员在后台创建：
1. 登录管理后台
2. 进入「服务员管理」
3. 点击「添加服务员」
4. 填写账号、密码、姓名、所属店铺

### 菜品上架
首次安装所有菜品默认为下架状态，需手动上架：
1. 登录管理后台
2. 进入「菜品管理」
3. 选择要上架的菜品，点击「上架」按钮
4. 或批量选择后点击「批量上架」

---

## 9. 打印机配置

### 支持的打印机品牌
- 通用 ESC/POS
- EPSON 爱普生
- Star 斯大
- Bixolon 毕索龙
- 佳博 (Gprinter)
- 芯烨 (Xprinter)
- 容大 (Rongta)
- 弘印 (Hoin)

### 支持的纸宽
- 58mm（小票打印机）
- 80mm（标准小票打印机）

### 添加打印机步骤

1. 确保打印机与服务器在同一局域网
2. 登录管理后台 → 打印机管理
3. 点击「添加打印机」
4. 填写信息：
   - 打印机名称（如：前台小票机）
   - 打印机类型（前台/后厨）
   - IP 地址（如：192.168.1.100）
   - 端口（默认 9100）
   - 纸宽（58mm 或 80mm）
   - 品牌
5. 点击「测试打印」验证连接
6. 保存配置

### 打印机网络设置
大多数网络打印机默认使用 **9100 端口**（RAW 协议）。
- 请确保打印机的 IP 地址固定（在路由器中绑定 MAC 地址）
- 确保服务器能 ping 通打印机 IP
- 确保防火墙未阻止 9100 端口

---

## 10. 常见问题排查

### Q1: 启动时报错 `ECONNREFUSED 127.0.0.1:3306`

**原因**: MySQL 服务未启动或端口不对。

**解决**:
```bash
# Windows
net start MySQL84  # 服务名可能不同

# Linux
sudo systemctl start mariadb
# 或
sudo systemctl start mysql
```

检查端口：
```bash
# Windows
netstat -an | findstr 3306

# Linux
sudo netstat -tlnp | grep 3306
```

### Q2: 报错 `Access denied for user 'root'@'localhost'`

**原因**: 数据库密码错误。

**解决**:
1. 确认 `.env` 中的 `DB_PASSWORD` 与实际 MySQL root 密码一致
2. 重置 MySQL root 密码：
   ```bash
   # Linux
   sudo mysqld_safe --skip-grant-tables &
   mysql -u root
   ```
   ```sql
   FLUSH PRIVILEGES;
   ALTER USER 'root'@'localhost' IDENTIFIED BY '新密码';
   FLUSH PRIVILEGES;
   EXIT;
   ```

### Q3: 中文显示乱码

**原因**: 数据库字符集不是 utf8mb4。

**解决**:
1. 检查数据库字符集：
   ```sql
   SHOW VARIABLES LIKE 'character_set%';
   ```
2. 修改数据库字符集：
   ```sql
   ALTER DATABASE ordering_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```
3. 系统连接池已默认配置 `charset: 'utf8mb4'`，无需修改代码。

### Q4: 页面空白或加载失败

**原因**: 端口被占用或服务器未启动。

**解决**:
1. 检查服务器是否运行：
   ```bash
   curl http://localhost:3000/api/health
   ```
2. 检查端口是否被占用：
   ```bash
   # Windows
   netstat -ano | findstr 3000
   
   # Linux
   sudo lsof -i :3000
   ```
3. 修改 `.env` 中的 `PORT` 为其他端口（如 8080）

### Q5: 局域网其他设备无法访问

**原因**: 防火墙未开放端口。

**解决**:
```bash
# Windows (以管理员身份运行)
netsh advfirewall firewall add rule name="foodflow" dir=in action=allow protocol=TCP localport=3000

# Linux (ufw)
sudo ufw allow 3000/tcp

# Linux (firewalld)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### Q6: 菜品不显示

**原因**: 首次安装所有菜品默认为下架状态。

**解决**:
1. 登录管理后台
2. 进入「菜品管理」
3. 选择菜品并点击「上架」

### Q7: 打印机无法连接

**原因**: 网络不通或 IP/端口错误。

**排查**:
1. 在服务器上 ping 打印机 IP：
   ```bash
   ping 打印机IP
   ```
2. 测试端口连通性：
   ```bash
   # Linux
   telnet 打印机IP 9100
   # 或
   nc -zv 打印机IP 9100
   ```
3. 确认打印机品牌和纸宽设置正确
4. 在管理后台点击「测试打印」

### Q8: 如何修改管理员密码

1. 登录管理后台
2. 进入「设置」→「修改密码」
3. 输入旧密码和新密码
4. 点击保存

### Q9: 如何备份数据

**自动备份**: 系统每天自动备份到 `backups/` 目录。

**手动备份**:
1. 登录管理后台 → 设置 → 数据备份
2. 点击「立即备份」
3. 或使用命令行：
   ```bash
   mysqldump -u root -p ordering_system > backup.sql
   ```

### Q10: 如何恢复数据

```bash
mysql -u root -p ordering_system < backup.sql
```

---

## 技术支持

- GitHub 仓库: https://github.com/Tony855/foodflow
- 提交 Issue: https://github.com/Tony855/foodflow/issues

---

*文档版本: v1.0 | 更新日期: 2026-09-10*
