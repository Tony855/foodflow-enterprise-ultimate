#!/bin/bash
# ============================================================
# FoodFlow 标准版 - 数据库初始化脚本
# ============================================================
set -e

DB_HOST="mysql-internal.example.com"
DB_PORT="3306"
DB_ROOT_USER="root"
DB_ROOT_PASS="YourRootPassword"
DB_NAME="foodflow_enterprise"
DB_USER="foodflow"
DB_PASS="YourStrongPasswordHere"

echo "初始化标准版数据库..."

mysql -h$DB_HOST -P$DB_PORT -u$DB_ROOT_USER -p$DB_ROOT_PASS <<EOF
CREATE DATABASE IF NOT EXISTS $DB_NAME DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'%' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'%';
FLUSH PRIVILEGES;
EOF

cd /var/www/foodflow
DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_PASSWORD=$DB_PASS DB_NAME=$DB_NAME INIT_ONLY=true node server.js || true

echo "标准版数据库初始化完成！"
