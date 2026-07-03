---
name: db-query
description: 快速连接 MySQL/OceanBase/Doris 数据库，查询表结构和数据，支持多数据库别名管理。当用户需要查看数据库表结构、查询数据、列出数据库或表、或提到数据库别名时使用。
---

# DB Query

轻量级数据库查询工具，支持 MySQL / OceanBase / Doris，通过别名快速切换数据库。

## 环境准备

首次使用需安装依赖：
```bash
pip install pymysql
```

配置文件为 `config.json`（与 SKILL.md 同级目录），参考 `config.json.example`。

## 功能命令

脚本路径：`scripts/db_query.py`（相对于本 skill 目录）

### 列出已配置的别名
```bash
python scripts/db_query.py --list-aliases
```

### 列出数据库
```bash
python scripts/db_query.py -a <别名> --list-dbs
```

### 列出表
```bash
python scripts/db_query.py -a <别名> --list-tables
python scripts/db_query.py -a <别名> -d <数据库> --list-tables
```

### 查询表结构
```bash
python scripts/db_query.py -a <别名> -t <表名>
python scripts/db_query.py -a <别名> -d <数据库> -t <表名>
```

### 查询数据
```bash
python scripts/db_query.py -a <别名> -q "SELECT * FROM table LIMIT 10"
```

## 数据库别名配置

`config.json` 采用 JSON 格式，连接和数据库的归属关系清晰可见：

```json
{
  "connections": {
    "连接名": {
      "host": "127.0.0.1",
      "port": 3306,
      "user": "root",
      "password": "xxx",
      "databases": {
        "别名": "数据库名",
        "别名2": "数据库名2"
      }
    }
  }
}
```

每个连接下可配置多个数据库别名，归属关系一目了然。示例见 `config.json.example`。

## 使用流程

1. 用户提到数据库相关需求时，先 `--list-aliases` 查看可用别名
2. 若用户未指定别名，列出别名让用户选择
3. 用别名执行查询，结果以表格形式展示
4. 若 `config.json` 不存在，提示用户参考 `config.json.example` 创建
