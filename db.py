import os
import sqlite3
from functools import wraps
from flask import jsonify, session

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
DB_PATH = os.path.join(BASE_DIR, "database.db")

ALLOWED_PROJECT_STATUSES = {"in_progress", "paused", "completed"}
ALLOWED_YARN_STATUSES = {"in_stash", "in_use", "used_up"}


def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Wymagane zalogowanie."}), 401
        return f(*args, **kwargs)
    return decorated_function


def ensure_schema_columns(conn):
    project_cols = {
        row["name"] for row in conn.execute("PRAGMA table_info(projects)").fetchall()
    }
    for column, definition in {
        "stitches": "INTEGER NOT NULL DEFAULT 0",
        "status": "TEXT NOT NULL DEFAULT 'in_progress'",
        "shaping_rule": "TEXT NOT NULL DEFAULT ''",
        "secondary_rows": "INTEGER NOT NULL DEFAULT 0",
        "target_rows": "INTEGER NOT NULL DEFAULT 0",
        "chart_data": "TEXT NOT NULL DEFAULT ''",
        "chart_total_rows": "INTEGER NOT NULL DEFAULT 20",
        "chart_current_row": "INTEGER NOT NULL DEFAULT 1",
        "start_date": "TEXT NOT NULL DEFAULT ''",
        "target_date": "TEXT NOT NULL DEFAULT ''",
        "source_url": "TEXT NOT NULL DEFAULT ''",
        "category": "TEXT NOT NULL DEFAULT ''",
        "difficulty": "TEXT NOT NULL DEFAULT ''",
        "size_label": "TEXT NOT NULL DEFAULT ''",
        "yarn_details": "TEXT NOT NULL DEFAULT ''",
        "yarn_id": "INTEGER",
        "yarn_skeins_used": "REAL NOT NULL DEFAULT 0",
        "gauge": "TEXT NOT NULL DEFAULT ''",
        "dimensions": "TEXT NOT NULL DEFAULT ''",
        "photo_data": "TEXT NOT NULL DEFAULT ''",
    }.items():
        if column not in project_cols:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {column} {definition};")

    yarn_cols = {
        row["name"] for row in conn.execute("PRAGMA table_info(yarns)").fetchall()
    }
    for column, definition in {
        "photo_data": "TEXT NOT NULL DEFAULT ''",
        "brand": "TEXT NOT NULL DEFAULT ''",
        "fiber": "TEXT NOT NULL DEFAULT ''",
        "needle_size": "TEXT NOT NULL DEFAULT ''",
        "care": "TEXT NOT NULL DEFAULT ''",
        "purchase_price": "REAL NOT NULL DEFAULT 0",
        "stash_location": "TEXT NOT NULL DEFAULT ''",
    }.items():
        if column not in yarn_cols:
            conn.execute(f"ALTER TABLE yarns ADD COLUMN {column} {definition};")


def init_db():
    with get_db_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                tools TEXT NOT NULL DEFAULT 'Brak danych',
                rows INTEGER NOT NULL DEFAULT 0 CHECK (rows >= 0),
                target_rows INTEGER NOT NULL DEFAULT 0 CHECK (target_rows >= 0),
                secondary_rows INTEGER NOT NULL DEFAULT 0 CHECK (secondary_rows >= 0),
                stitches INTEGER NOT NULL DEFAULT 0 CHECK (stitches >= 0),
                repeats INTEGER NOT NULL DEFAULT 0 CHECK (repeats >= 0),
                status TEXT NOT NULL DEFAULT 'in_progress',
                shaping_rule TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT '',
                chart_data TEXT NOT NULL DEFAULT '',
                chart_total_rows INTEGER NOT NULL DEFAULT 20,
                chart_current_row INTEGER NOT NULL DEFAULT 1,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_subcounters (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                value INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
                FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS yarns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                color_lot TEXT NOT NULL DEFAULT '',
                weight_g INTEGER NOT NULL DEFAULT 100 CHECK (weight_g >= 0),
                length_m INTEGER NOT NULL DEFAULT 200 CHECK (length_m >= 0),
                skeins REAL NOT NULL DEFAULT 1 CHECK (skeins >= 0),
                status TEXT NOT NULL DEFAULT 'in_stash',
                notes TEXT NOT NULL DEFAULT '',
                photo_data TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER NOT NULL,
                rows INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_checklist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                is_done INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knitting_timer_state (
                user_id INTEGER PRIMARY KEY,
                project_id INTEGER,
                accumulated_seconds INTEGER NOT NULL DEFAULT 0,
                started_at TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS project_timer_state (
                user_id INTEGER NOT NULL,
                project_id INTEGER NOT NULL,
                accumulated_seconds INTEGER NOT NULL DEFAULT 0,
                started_at TEXT,
                PRIMARY KEY(user_id, project_id),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS knitting_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER,
                duration_seconds INTEGER NOT NULL DEFAULT 0,
                note TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS reminders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                project_id INTEGER,
                title TEXT NOT NULL,
                due_at TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT '',
                is_done INTEGER NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_history_user_project ON project_history(user_id, project_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_checklist_user_project ON project_checklist(user_id, project_id);
            CREATE INDEX IF NOT EXISTS idx_subcounters_user_project ON project_subcounters(user_id, project_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON knitting_sessions(user_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_reminders_user_due ON reminders(user_id, due_at);
            CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
            CREATE INDEX IF NOT EXISTS idx_yarns_user_id ON yarns(user_id);
            """
        )
        ensure_schema_columns(conn)
        conn.commit()