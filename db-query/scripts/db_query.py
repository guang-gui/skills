#!/usr/bin/env python3
"""轻量级数据库查询工具 - 支持 MySQL / OceanBase / Doris，通过别名快速切换"""

import argparse
import json
import sys
from pathlib import Path

try:
    import pymysql
except ImportError:
    print("错误: 缺少 pymysql，请执行 pip install pymysql")
    sys.exit(1)


def load_config(config_path):
    """加载 JSON 配置文件，返回 {别名: {conn, database}}"""
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    aliases = {}
    for conn_name, conn_cfg in data.get("connections", {}).items():
        conn_info = {
            "host": conn_cfg.get("host", "127.0.0.1"),
            "port": conn_cfg.get("port", 3306),
            "user": conn_cfg.get("user", "root"),
            "password": conn_cfg.get("password", ""),
        }
        for alias, db_name in conn_cfg.get("databases", {}).items():
            alias_lower = alias.lower()
            if alias_lower in aliases:
                print(f"警告: 别名 '{alias_lower}' 重复，已被覆盖")
            aliases[alias_lower] = {
                "conn_name": conn_name,
                "conn": conn_info,
                "database": db_name,
            }
    return aliases


def get_connection(conn_cfg, database=None):
    """根据连接配置创建数据库连接"""
    return pymysql.connect(
        host=conn_cfg["host"],
        port=int(conn_cfg["port"]),
        user=conn_cfg["user"],
        password=conn_cfg["password"],
        database=database,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10,
    )


def format_table(rows, max_col_width=60):
    """格式化表格输出"""
    if not rows:
        print("(无数据)")
        return
    headers = list(rows[0].keys())
    # 计算列宽
    widths = {h: len(str(h)) for h in headers}
    for row in rows:
        for h in headers:
            val = str(row[h]) if row[h] is not None else "NULL"
            if len(val) > max_col_width:
                val = val[:max_col_width - 3] + "..."
            widths[h] = max(widths[h], len(val))
    # 打印表头
    header_line = " | ".join(str(h).ljust(widths[h]) for h in headers)
    sep_line = "-+-".join("-" * widths[h] for h in headers)
    print(header_line)
    print(sep_line)
    # 打印数据
    for row in rows:
        line = " | ".join(
            (str(row[h]) if row[h] is not None else "NULL")[:max_col_width].ljust(widths[h])
            for h in headers
        )
        print(line)
    print(f"\n共 {len(rows)} 行")


def cmd_list_aliases(aliases):
    """列出所有已配置的别名"""
    if not aliases:
        print("未配置任何数据库别名，请创建 config.json 并参考 config.json.example")
        return
    print("已配置的数据库别名:\n")
    # 按连接名分组
    by_conn = {}
    for name, cfg in sorted(aliases.items()):
        by_conn.setdefault(cfg["conn_name"], []).append((name, cfg))
    for conn_name, items in sorted(by_conn.items()):
        first = items[0][1]["conn"]
        print(f"  [{conn_name}] {first.get('user','?')}@{first.get('host','?')}:{first.get('port','3306')}")
        for name, cfg in items:
            print(f"    {name:20s} -> {cfg['database']}")
        print()


def cmd_list_dbs(conn):
    """列出所有数据库"""
    with conn.cursor() as cur:
        cur.execute("SHOW DATABASES")
        rows = cur.fetchall()
    dbs = [list(r.values())[0] for r in rows]
    for db in dbs:
        print(f"  {db}")
    print(f"\n共 {len(dbs)} 个数据库")


def cmd_list_tables(conn):
    """列出当前数据库所有表"""
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES")
        rows = cur.fetchall()
    tables = [list(r.values())[0] for r in rows]
    for t in tables:
        print(f"  {t}")
    print(f"\n共 {len(tables)} 张表")


def cmd_describe(conn, table):
    """查询表结构"""
    with conn.cursor() as cur:
        cur.execute(f"DESCRIBE `{table}`")
        rows = cur.fetchall()
    format_table(rows)


def cmd_query(conn, sql):
    """执行查询 SQL"""
    with conn.cursor() as cur:
        cur.execute(sql)
        rows = cur.fetchall()
    format_table(rows)


def main():
    parser = argparse.ArgumentParser(description="数据库查询工具")
    parser.add_argument("-a", "--alias", help="数据库别名")
    parser.add_argument("-d", "--database", help="指定数据库（覆盖默认）")
    parser.add_argument("-t", "--table", help="查询表结构")
    parser.add_argument("-q", "--query", help="执行 SQL 查询")
    parser.add_argument("--list-aliases", action="store_true", help="列出所有别名")
    parser.add_argument("--list-dbs", action="store_true", help="列出所有数据库")
    parser.add_argument("--list-tables", action="store_true", help="列出所有表")
    parser.add_argument("--config", help="config.json 文件路径")
    args = parser.parse_args()

    # 加载 config.json
    if args.config:
        config_path = args.config
    else:
        config_path = str(Path(__file__).resolve().parent.parent / "config.json")

    try:
        aliases = load_config(config_path)
    except FileNotFoundError:
        print(f"配置文件不存在: {config_path}")
        print("请复制 config.json.example 为 config.json 并填入实际配置")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"配置文件 JSON 格式错误: {e}")
        sys.exit(1)

    # 列出别名不需要连接
    if args.list_aliases:
        cmd_list_aliases(aliases)
        return

    # 其他操作需要别名
    if not args.alias:
        print("错误: 请使用 -a 指定别名，或使用 --list-aliases 查看可用别名")
        cmd_list_aliases(aliases)
        sys.exit(1)

    alias_key = args.alias.lower()
    if alias_key not in aliases:
        print(f"错误: 未找到别名 '{args.alias}'，可用别名:")
        cmd_list_aliases(aliases)
        sys.exit(1)

    alias_cfg = aliases[alias_key]
    conn_cfg = alias_cfg["conn"]
    db = args.database or alias_cfg["database"]

    # list-dbs 不需要指定数据库
    if args.list_dbs:
        conn = get_connection(conn_cfg)
        try:
            cmd_list_dbs(conn)
        finally:
            conn.close()
        return

    # 其他操作需要数据库连接
    conn = get_connection(conn_cfg, database=db)
    try:
        if args.list_tables:
            cmd_list_tables(conn)
        elif args.table:
            cmd_describe(conn, args.table)
        elif args.query:
            cmd_query(conn, args.query)
        else:
            print("请指定操作: --list-tables / -t <表名> / -q <SQL>")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
