#!/usr/bin/env python3
"""
Test Vanna AI - Phase 1: PostgreSQL + Vanna API
Usage: python test-vanna.py
"""

import sys
sys.stdout.reconfigure(encoding='utf-8')

import psycopg2
from vanna.remote import VannaDefault

DB = {
    "host": "103.118.28.2",
    "port": 5432,
    "database": "chatdb",
    "user": "postgres",
    "password": "AppraisalQuail1Agent",
}

# Vanna API key
VANNA_KEY = "26ceda0772674efd8febd212d44cf6c7"


def get_user_tables():
    """Lay tat ca user tables tu database"""
    conn = psycopg2.connect(**DB)
    cur = conn.cursor()

    # Tables
    cur.execute("""
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name
    """)
    tables = cur.fetchall()

    # Columns
    cur.execute("""
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name, ordinal_position
    """)
    columns = cur.fetchall()

    # Foreign keys
    cur.execute("""
        SELECT
            tc.table_schema, tc.table_name, kcu.column_name,
            ccu.table_schema AS foreign_table_schema,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema')
    """)
    fks = cur.fetchall()

    cur.close()
    conn.close()
    return tables, columns, fks


def build_ddl(tables, columns, fks):
    """Build DDL statements for Vanna training"""
    # Group columns by table
    col_map = {}
    for schema, table, col, dtype in columns:
        key = f"{schema}.{table}"
        if key not in col_map:
            col_map[key] = []
        col_map[key].append(f"  {col} {dtype}")

    # Group FKs by table
    fk_map = {}
    for schema, table, col, fschema, ftable, fcol in fks:
        key = f"{schema}.{table}"
        if key not in fk_map:
            fk_map[key] = []
        fk_map[key].append(f"  FK: {col} -> {fschema}.{ftable}.{fcol}")

    lines = []
    for schema, table in tables:
        key = f"{schema}.{table}"
        lines.append(f"CREATE TABLE {schema}.{table} (")

        if key in fk_map:
            lines.extend(fk_map[key])
        if key in col_map:
            lines.extend(col_map[key])

        lines.append(");")
        lines.append("")

    return "\n".join(lines)


def main():
    print("=" * 60)
    print("[GO] Vanna AI Test - Phase 1: PostgreSQL + Vanna")
    print("=" * 60)

    # Init Vanna
    print("[OK] Initializing Vanna with model 'chinook'...")
    vn = VannaDefault(model='chinook', api_key=VANNA_KEY)
    print("[OK] Vanna initialized!")

    # Get schema
    print("\n[SCHEMA] Fetching database schema...")
    tables, columns, fks = get_user_tables()
    print(f"[OK] Found {len(tables)} tables")

    current = ""
    for schema, table in tables:
        if schema != current:
            print(f"\n  [{schema}]")
            current = schema
        print(f"    - {table}")

    # Build DDL
    print("\n[DDL] Building DDL statements...")
    ddl = build_ddl(tables, columns, fks)
    print(f"[OK] DDL built ({len(ddl)} chars)")
    print("\n--- DDL Preview ---")
    print(ddl[:1000])
    if len(ddl) > 1000:
        print(f"... ({len(ddl)-1000} more chars)")

    # Train DDL
    print("\n[TRAIN] Training DDL...")
    try:
        vn.train(ddl=ddl)
        print("[OK] DDL trained!")
    except Exception as e:
        print(f"[WARN] DDL train error: {e}")

    # Train VI -> SQL examples
    print("\n[TRAIN] Training VI -> SQL examples...")
    examples = [
        # Fire
        ("co bao nhieu diem chay hom nay",
         "SELECT COUNT(*) FROM fire.fire_points WHERE DATE(created_at) = CURRENT_DATE"),
        ("diem chay theo ngay",
         "SELECT DATE(created_at) AS ngay, COUNT(*) FROM fire.fire_points WHERE created_at >= CURRENT_DATE - INTERVAL '7 days' GROUP BY 1 ORDER BY 1"),
        ("xa nao co nhieu diem chay nhat",
         "SELECT commune_name, COUNT(*) FROM fire.fire_points GROUP BY commune_name ORDER BY COUNT(*) DESC LIMIT 20"),
        # Cay keo
        ("dien tich cay keo theo tung xa",
         "SELECT c.name AS ten_xa, SUM(p.area) AS tong FROM core.plot p JOIN core.commune c ON p.commune_code = c.commune_code WHERE p.tree_spec_code ILIKE 'KEA%' GROUP BY c.name ORDER BY SUM DESC LIMIT 20"),
        ("tong dien tich cay keo",
         "SELECT SUM(area) FROM core.plot WHERE tree_spec_code ILIKE 'KEA%'"),
        # Camera
        ("camera nao phat hien chay nhieu nhat",
         "SELECT camera_id, COUNT(*) FROM camera.data_log GROUP BY camera_id ORDER BY COUNT(*) DESC LIMIT 10"),
        # Chatbot
        ("nguoi dung chat nhieu nhat",
         "SELECT user_name, SUM(message_count) FROM chatbot.chatbot_conversations GROUP BY user_name ORDER BY SUM DESC LIMIT 10"),
    ]

    for q, sql in examples:
        try:
            vn.train(question=q, sql=sql)
            print(f"  [OK] {q[:60]}")
        except Exception as e:
            print(f"  [WARN] {q[:40]}: {e}")

    # Documentation
    try:
        vn.train(documentation="Schema fire chua thong tin diem chay (fire_points). Schema core chua thong tin dat dai va cay (plot, commune). Schema camera chua thong tin camera va phat hien. Schema chatbot chua thong tin nguoi dung va cuoc tro chuyen.")
        print("  [OK] Documentation trained")
    except Exception as e:
        print(f"  [WARN] Doc error: {e}")

    # Test questions
    print("\n" + "=" * 60)
    print("[TEST] Testing VI -> SQL generation")
    print("=" * 60)

    questions = [
        "co bao nhieu diem chay hom nay",
        "dien tich cay keo theo tung xa",
        "camera nao phat hien chay nhieu nhat",
        "xa nao co nhieu diem chay nhat trong tuan nay",
    ]

    for q in questions:
        print(f"\n[ASK] Q: {q}")
        print("-" * 60)
        try:
            sql = vn.generate_sql(q)
            print(f"[OK] SQL:\n{sql}")
        except Exception as e:
            print(f"[X] Error: {e}")

    print("\n[OK] Test complete!")


if __name__ == "__main__":
    main()
