from flask import Blueprint, jsonify, request, session
from db import ALLOWED_PROJECT_STATUSES, get_db_connection, login_required

projects_bp = Blueprint("projects", __name__, url_prefix="/api/projects")

PROJECT_TEXT_FIELDS = {
    "name": (120, True),
    "tools": (80, False),
    "shaping_rule": (200, False),
    "notes": (5000, False),
    "start_date": (10, False),
    "target_date": (10, False),
    "source_url": (1000, False),
    "category": (80, False),
    "difficulty": (40, False),
    "size_label": (100, False),
    "yarn_details": (500, False),
    "gauge": (300, False),
    "dimensions": (300, False),
    "photo_data": (1_200_000, False),
    "chart_data": (1_500_000, False),
}


def serialize_project(row):
    keys = row.keys()
    return {
        "id": row["id"],
        "name": row["name"],
        "tools": row["tools"],
        "rows": row["rows"],
        "target_rows": row["target_rows"] if "target_rows" in keys else 0,
        "secondary_rows": row["secondary_rows"] if "secondary_rows" in keys else 0,
        "stitches": row["stitches"],
        "repeats": row["repeats"],
        "status": row["status"],
        "shaping_rule": row["shaping_rule"],
        "notes": row["notes"],
        "updated_at": row["updated_at"],
        "start_date": row["start_date"] if "start_date" in keys else "",
        "target_date": row["target_date"] if "target_date" in keys else "",
        "source_url": row["source_url"] if "source_url" in keys else "",
        "category": row["category"] if "category" in keys else "",
        "difficulty": row["difficulty"] if "difficulty" in keys else "",
        "size_label": row["size_label"] if "size_label" in keys else "",
        "yarn_details": row["yarn_details"] if "yarn_details" in keys else "",
        "yarn_id": row["yarn_id"] if "yarn_id" in keys else None,
        "yarn_skeins_used": row["yarn_skeins_used"] if "yarn_skeins_used" in keys else 0,
        "gauge": row["gauge"] if "gauge" in keys else "",
        "dimensions": row["dimensions"] if "dimensions" in keys else "",
        "photo_data": row["photo_data"] if "photo_data" in keys else "",
        "chart_data": row["chart_data"] if "chart_data" in keys else "",
        "chart_total_rows": row["chart_total_rows"] if "chart_total_rows" in keys else 20,
        "chart_current_row": row["chart_current_row"] if "chart_current_row" in keys else 1,
    }


def clean_project_payload(data, existing=None):
    values = {}
    for field, (limit, required) in PROJECT_TEXT_FIELDS.items():
        if field not in data and existing is not None:
            values[field] = existing[field]
            continue
        value = str(data.get(field) or "").strip()
        if required and not value:
            raise ValueError("Nazwa projektu jest wymagana.")
        values[field] = value[:limit]
    if not values["tools"]:
        values["tools"] = "Brak danych"
    if values["source_url"] and not values["source_url"].startswith(("https://", "http://")):
        raise ValueError("Link do wzoru musi zaczynać się od http:// lub https://.")
    return values


def apply_yarn_reservation(conn, user_id, yarn_id, skeins_delta, set_in_use=False):
    if not yarn_id:
        return
    yarn = conn.execute("SELECT * FROM yarns WHERE id=? AND user_id=?", (yarn_id, user_id)).fetchone()
    if not yarn:
        return
    new_skeins = max(0.0, round(float(yarn["skeins"]) - float(skeins_delta), 2))
    new_status = "used_up" if new_skeins == 0 else ("in_use" if set_in_use and yarn["status"] == "in_stash" else yarn["status"])
    conn.execute(
        "UPDATE yarns SET skeins=?, status=? WHERE id=? AND user_id=?",
        (new_skeins, new_status, yarn_id, user_id),
    )


@projects_bp.get("")
@login_required
def list_projects():
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM projects WHERE user_id=? ORDER BY id DESC", (session["user_id"],)).fetchall()
    return jsonify({"projects": [serialize_project(r) for r in rows]})


@projects_bp.post("")
@login_required
def create_project():
    data = request.get_json(silent=True) or {}
    try:
        values = clean_project_payload(data)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    status = data.get("status", "in_progress")
    if status not in ALLOWED_PROJECT_STATUSES:
        return jsonify({"error": "Nieprawidłowy status projektu."}), 400

    try:
        yarn_id = int(data["yarn_id"]) if data.get("yarn_id") else None
        yarn_skeins_used = max(0.0, round(float(data.get("yarn_skeins_used") or 0), 2))
        target_rows = max(0, int(data.get("target_rows") or 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Nieprawidłowe dane liczbowe projektu."}), 400

    deduct_from_stash = bool(data.get("deduct_from_stash"))

    with get_db_connection() as conn:
        if yarn_id and not conn.execute("SELECT 1 FROM yarns WHERE id=? AND user_id=?", (yarn_id, session["user_id"])).fetchone():
            yarn_id = None
        values["status"] = status
        values["yarn_id"] = yarn_id
        values["yarn_skeins_used"] = yarn_skeins_used
        values["target_rows"] = target_rows
        fields = list(values)
        sql = f"INSERT INTO projects(user_id,{','.join(fields)}) VALUES(?,{','.join(['?']*len(fields))})"
        cursor = conn.execute(sql, [session["user_id"]] + [values[k] for k in fields])
        if yarn_id and deduct_from_stash and yarn_skeins_used > 0:
            apply_yarn_reservation(conn, session["user_id"], yarn_id, yarn_skeins_used, set_in_use=(status == "in_progress"))
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (cursor.lastrowid, session["user_id"])).fetchone()
    return jsonify({"project": serialize_project(row)}), 201


@projects_bp.post("/<int:project_id>/duplicate")
@login_required
def duplicate_project(project_id):
    uid = session["user_id"]
    with get_db_connection() as conn:
        src = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (project_id, uid)).fetchone()
        if not src:
            return jsonify({"error": "Nie znaleziono projektu."}), 404

        new_name = f"{src['name']} (kopia)"[:120]
        cur = conn.execute(
            """
            INSERT INTO projects(
                user_id, name, tools, rows, target_rows, secondary_rows, stitches, repeats,
                status, shaping_rule, notes, category, difficulty, size_label,
                yarn_details, yarn_id, yarn_skeins_used, gauge, dimensions, photo_data,
                chart_data, chart_total_rows, chart_current_row
            )
            VALUES(?,?,?,0,?,0,0,0,'in_progress',?,?,?,?,?,?,?,?,?,?,?,?,?,1)
            """,
            (
                uid,
                new_name,
                src["tools"],
                src["target_rows"],
                src["shaping_rule"],
                src["notes"],
                src["category"],
                src["difficulty"],
                src["size_label"],
                src["yarn_details"],
                src["yarn_id"],
                src["yarn_skeins_used"],
                src["gauge"],
                src["dimensions"],
                src["photo_data"],
                src["chart_data"],
                src["chart_total_rows"],
            ),
        )
        new_pid = cur.lastrowid

        checklist_rows = conn.execute(
            "SELECT title FROM project_checklist WHERE project_id=? AND user_id=? ORDER BY id ASC",
            (project_id, uid),
        ).fetchall()
        for item in checklist_rows:
            conn.execute(
                "INSERT INTO project_checklist(user_id, project_id, title, is_done) VALUES(?,?,?,0)",
                (uid, new_pid, item["title"]),
            )

        subcounters = conn.execute(
            "SELECT name FROM project_subcounters WHERE project_id=? AND user_id=? ORDER BY id ASC",
            (project_id, uid),
        ).fetchall()
        for sc in subcounters:
            conn.execute(
                "INSERT INTO project_subcounters(user_id, project_id, name, value) VALUES(?,?,?,0)",
                (uid, new_pid, sc["name"]),
            )

        conn.commit()
        created = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (new_pid, uid)).fetchone()

    return jsonify({"project": serialize_project(created)}), 201


@projects_bp.patch("/<int:project_id>")
@login_required
def update_project(project_id):
    data = request.get_json(silent=True) or {}
    with get_db_connection() as conn:
        existing = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone()
        if existing is None:
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        try:
            values = clean_project_payload(data, existing)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        int_limits = {
            "rows": 0,
            "target_rows": 0,
            "secondary_rows": 0,
            "stitches": 0,
            "repeats": 0,
            "chart_total_rows": 1,
            "chart_current_row": 1,
        }
        for field, minimum in int_limits.items():
            if field in data:
                try:
                    values[field] = max(minimum, int(data[field]))
                except (TypeError, ValueError):
                    return jsonify({"error": f"Nieprawidłowa wartość: {field}."}), 400
            else:
                values[field] = existing[field] if field in existing.keys() else minimum

        if "yarn_id" in data:
            try:
                candidate_yarn = int(data["yarn_id"]) if data["yarn_id"] else None
            except (TypeError, ValueError):
                return jsonify({"error": "Nieprawidłowe ID włóczki."}), 400
            if candidate_yarn and not conn.execute("SELECT 1 FROM yarns WHERE id=? AND user_id=?", (candidate_yarn, session["user_id"])).fetchone():
                candidate_yarn = None
            values["yarn_id"] = candidate_yarn
        else:
            values["yarn_id"] = existing["yarn_id"]

        if "yarn_skeins_used" in data:
            try:
                values["yarn_skeins_used"] = max(0.0, round(float(data["yarn_skeins_used"] or 0), 2))
            except (TypeError, ValueError):
                return jsonify({"error": "Nieprawidłowa liczba motków."}), 400
        else:
            values["yarn_skeins_used"] = existing["yarn_skeins_used"]

        status = data.get("status", existing["status"])
        if status not in ALLOWED_PROJECT_STATUSES:
            return jsonify({"error": "Nieprawidłowy status projektu."}), 400
        values["status"] = status

        if bool(data.get("deduct_from_stash")) and values["yarn_id"] and values["yarn_skeins_used"] > 0:
            apply_yarn_reservation(conn, session["user_id"], values["yarn_id"], values["yarn_skeins_used"], set_in_use=(status == "in_progress"))

        assignments = ",".join(f"{k}=?" for k in values)
        conn.execute(
            f"UPDATE projects SET {assignments}, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?",
            [values[k] for k in values] + [project_id, session["user_id"]],
        )
        conn.commit()
        row = conn.execute("SELECT * FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone()
    return jsonify({"project": serialize_project(row)})


@projects_bp.delete("/<int:project_id>")
@login_required
def delete_project(project_id):
    with get_db_connection() as conn:
        cursor = conn.execute("DELETE FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"]))
        conn.commit()
    if cursor.rowcount == 0:
        return jsonify({"error": "Nie znaleziono projektu."}), 404
    return jsonify({"deleted_id": project_id})


# --- WIELE MINI-LICZNIKÓW W PROJEKCIE ---

@projects_bp.get("/<int:project_id>/subcounters")
@login_required
def list_subcounters(project_id):
    with get_db_connection() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        rows = conn.execute(
            "SELECT id, name, value FROM project_subcounters WHERE project_id=? AND user_id=? ORDER BY id ASC",
            (project_id, session["user_id"]),
        ).fetchall()
    return jsonify({"subcounters": [dict(r) for r in rows]})


@projects_bp.post("/<int:project_id>/subcounters")
@login_required
def create_subcounter(project_id):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name") or "").strip()[:80]
    if not name:
        return jsonify({"error": "Podaj nazwę mini-licznika (np. Lewy rękaw)."}), 400
    with get_db_connection() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        cur = conn.execute(
            "INSERT INTO project_subcounters(user_id, project_id, name, value) VALUES(?,?,?,0)",
            (session["user_id"], project_id, name),
        )
        conn.commit()
        row = conn.execute("SELECT id, name, value FROM project_subcounters WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"subcounter": dict(row)}), 201


@projects_bp.patch("/<int:project_id>/subcounters/<int:sub_id>")
@login_required
def update_subcounter(project_id, sub_id):
    data = request.get_json(silent=True) or {}
    try:
        value = max(0, int(data.get("value", 0)))
    except (TypeError, ValueError):
        return jsonify({"error": "Nieprawidłowa wartość licznika."}), 400
    with get_db_connection() as conn:
        cur = conn.execute(
            "UPDATE project_subcounters SET value=? WHERE id=? AND project_id=? AND user_id=?",
            (value, sub_id, project_id, session["user_id"]),
        )
        conn.commit()
        if not cur.rowcount:
            return jsonify({"error": "Nie znaleziono mini-licznika."}), 404
        row = conn.execute("SELECT id, name, value FROM project_subcounters WHERE id=?", (sub_id,)).fetchone()
    return jsonify({"subcounter": dict(row)})


@projects_bp.delete("/<int:project_id>/subcounters/<int:sub_id>")
@login_required
def delete_subcounter(project_id, sub_id):
    with get_db_connection() as conn:
        cur = conn.execute(
            "DELETE FROM project_subcounters WHERE id=? AND project_id=? AND user_id=?",
            (sub_id, project_id, session["user_id"]),
        )
        conn.commit()
    if not cur.rowcount:
        return jsonify({"error": "Nie znaleziono mini-licznika."}), 404
    return jsonify({"deleted_id": sub_id})


# --- CHECKLISTA PROJEKTU ---

@projects_bp.get("/<int:project_id>/checklist")
@login_required
def list_project_checklist(project_id):
    with get_db_connection() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        rows = conn.execute(
            "SELECT id, title, is_done, created_at FROM project_checklist WHERE project_id=? AND user_id=? ORDER BY is_done ASC, id ASC",
            (project_id, session["user_id"]),
        ).fetchall()
    return jsonify({"items": [dict(r) for r in rows]})


@projects_bp.post("/<int:project_id>/checklist")
@login_required
def add_project_checklist_item(project_id):
    data = request.get_json(silent=True) or {}
    title = str(data.get("title") or "").strip()[:180]
    if not title:
        return jsonify({"error": "Wpisz nazwę etapu."}), 400
    with get_db_connection() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        cur = conn.execute(
            "INSERT INTO project_checklist(user_id, project_id, title, is_done) VALUES(?,?,?,0)",
            (session["user_id"], project_id, title),
        )
        conn.commit()
        row = conn.execute("SELECT id, title, is_done, created_at FROM project_checklist WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"item": dict(row)}), 201


@projects_bp.patch("/<int:project_id>/checklist/<int:item_id>")
@login_required
def toggle_project_checklist_item(project_id, item_id):
    data = request.get_json(silent=True) or {}
    with get_db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM project_checklist WHERE id=? AND project_id=? AND user_id=?",
            (item_id, project_id, session["user_id"]),
        ).fetchone()
        if not row:
            return jsonify({"error": "Nie znaleziono elementu."}), 404
        is_done = int(bool(data.get("is_done", not row["is_done"])))
        conn.execute("UPDATE project_checklist SET is_done=? WHERE id=? AND user_id=?", (is_done, item_id, session["user_id"]))
        conn.commit()
        updated = conn.execute("SELECT id, title, is_done, created_at FROM project_checklist WHERE id=?", (item_id,)).fetchone()
    return jsonify({"item": dict(updated)})


@projects_bp.delete("/<int:project_id>/checklist/<int:item_id>")
@login_required
def delete_project_checklist_item(project_id, item_id):
    with get_db_connection() as conn:
        cur = conn.execute(
            "DELETE FROM project_checklist WHERE id=? AND project_id=? AND user_id=?",
            (item_id, project_id, session["user_id"]),
        )
        conn.commit()
    if not cur.rowcount:
        return jsonify({"error": "Nie znaleziono elementu."}), 404
    return jsonify({"deleted_id": item_id})


# --- DZIENNIK POSTĘPÓW ---

@projects_bp.get("/<int:project_id>/history")
@login_required
def get_project_history(project_id):
    with get_db_connection() as conn:
        if not conn.execute("SELECT id FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        rows = conn.execute(
            "SELECT id, rows, note, created_at FROM project_history WHERE project_id=? AND user_id=? ORDER BY id DESC LIMIT 200",
            (project_id, session["user_id"]),
        ).fetchall()
    return jsonify({"history": [dict(r) for r in rows]})


@projects_bp.post("/<int:project_id>/history")
@login_required
def add_project_history(project_id):
    data = request.get_json(silent=True) or {}
    note = str(data.get("note") or "")[:1000]
    with get_db_connection() as conn:
        project = conn.execute("SELECT rows FROM projects WHERE id=? AND user_id=?", (project_id, session["user_id"])).fetchone()
        if not project:
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        cursor = conn.execute(
            "INSERT INTO project_history(user_id,project_id,rows,note) VALUES(?,?,?,?)",
            (session["user_id"], project_id, project["rows"], note),
        )
        conn.commit()
        row = conn.execute("SELECT id,rows,note,created_at FROM project_history WHERE id=?", (cursor.lastrowid,)).fetchone()
    return jsonify({"entry": dict(row)}), 201