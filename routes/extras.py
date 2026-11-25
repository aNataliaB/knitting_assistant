import os
import sqlite3
from datetime import datetime, timezone
from io import BytesIO
from flask import Blueprint, jsonify, request, send_file, session
from db import ALLOWED_PROJECT_STATUSES, ALLOWED_YARN_STATUSES, get_db_connection, login_required

extras_bp = Blueprint("extras", __name__, url_prefix="/api")


def get_timer_for_project(project_id):
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM project_timer_state WHERE user_id=? AND project_id=?", (session["user_id"], project_id)).fetchone()
    seconds = int(row["accumulated_seconds"]) if row else 0
    if row and row["started_at"]:
        try:
            seconds += max(0, int((datetime.now(timezone.utc) - datetime.fromisoformat(row["started_at"])).total_seconds()))
        except ValueError:
            pass
    return jsonify({"seconds": seconds, "running": bool(row and row["started_at"]), "project_id": project_id})


@extras_bp.get("/timer")
@login_required
def get_timer():
    uid = session["user_id"]
    try:
        project_id = int(request.args.get("project_id", "0"))
    except ValueError:
        project_id = 0
    if not project_id:
        return jsonify({"seconds": 0, "running": False, "project_id": None})
    with get_db_connection() as conn:
        if not conn.execute("SELECT id FROM projects WHERE id=? AND user_id=?", (project_id, uid)).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
    return get_timer_for_project(project_id)


@extras_bp.post("/timer")
@login_required
def update_timer():
    data = request.get_json(silent=True) or {}
    action = data.get("action")
    uid = session["user_id"]
    try:
        project_id = int(data.get("project_id") or 0)
    except (TypeError, ValueError):
        project_id = 0
    if not project_id:
        return jsonify({"error": "Wybierz projekt przed użyciem stopera."}), 400
    with get_db_connection() as conn:
        if not conn.execute("SELECT id FROM projects WHERE id=? AND user_id=?", (project_id, uid)).fetchone():
            return jsonify({"error": "Nie znaleziono projektu."}), 404
        row = conn.execute("SELECT * FROM project_timer_state WHERE user_id=? AND project_id=?", (uid, project_id)).fetchone()
        if not row:
            conn.execute("INSERT INTO project_timer_state(user_id,project_id) VALUES(?,?)", (uid, project_id))
            row = conn.execute("SELECT * FROM project_timer_state WHERE user_id=? AND project_id=?", (uid, project_id)).fetchone()
        accumulated = int(row["accumulated_seconds"])
        started = row["started_at"]
        if action == "start":
            if not started:
                started = datetime.now(timezone.utc).isoformat()
        elif action in ("pause", "stop", "reset"):
            delta = 0
            if started:
                try:
                    delta = max(0, int((datetime.now(timezone.utc) - datetime.fromisoformat(started)).total_seconds()))
                except ValueError:
                    pass
            if delta:
                conn.execute("INSERT INTO knitting_sessions(user_id,project_id,duration_seconds) VALUES(?,?,?)", (uid, project_id, delta))
            accumulated = 0 if action == "reset" else accumulated + delta
            started = None
        else:
            return jsonify({"error": "Nieznana operacja stopera."}), 400
        conn.execute(
            "UPDATE project_timer_state SET accumulated_seconds=?, started_at=? WHERE user_id=? AND project_id=?",
            (accumulated, started, uid, project_id),
        )
        conn.commit()
    return get_timer_for_project(project_id)


@extras_bp.get("/reminders")
@login_required
def list_reminders():
    with get_db_connection() as conn:
        rows = conn.execute(
            "SELECT id,project_id,title,due_at,notes,is_done,created_at FROM reminders WHERE user_id=? ORDER BY is_done, due_at",
            (session["user_id"],),
        ).fetchall()
    return jsonify({"reminders": [dict(r) for r in rows]})


@extras_bp.post("/reminders")
@login_required
def create_reminder():
    d = request.get_json(silent=True) or {}
    title = str(d.get("title") or "").strip()[:160]
    due = str(d.get("due_at") or "").strip()
    notes = str(d.get("notes") or "")[:1000]
    pid = d.get("project_id")
    if not title or not due:
        return jsonify({"error": "Podaj tytuł i termin przypomnienia."}), 400
    try:
        datetime.fromisoformat(due.replace("Z", "+00:00"))
    except ValueError:
        return jsonify({"error": "Nieprawidłowy termin."}), 400
    with get_db_connection() as conn:
        if pid and not conn.execute("SELECT id FROM projects WHERE id=? AND user_id=?", (pid, session["user_id"])).fetchone():
            return jsonify({"error": "Nieprawidłowy projekt."}), 400
        cur = conn.execute(
            "INSERT INTO reminders(user_id,project_id,title,due_at,notes) VALUES(?,?,?,?,?)",
            (session["user_id"], pid, title, due, notes),
        )
        conn.commit()
        row = conn.execute("SELECT id,project_id,title,due_at,notes,is_done,created_at FROM reminders WHERE id=?", (cur.lastrowid,)).fetchone()
    return jsonify({"reminder": dict(row)}), 201


@extras_bp.patch("/reminders/<int:reminder_id>")
@login_required
def patch_reminder(reminder_id):
    d = request.get_json(silent=True) or {}
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM reminders WHERE id=? AND user_id=?", (reminder_id, session["user_id"])).fetchone()
        if not row:
            return jsonify({"error": "Nie znaleziono przypomnienia."}), 404
        done = int(bool(d.get("is_done", row["is_done"])))
        conn.execute("UPDATE reminders SET is_done=? WHERE id=? AND user_id=?", (done, reminder_id, session["user_id"]))
        conn.commit()
        updated = conn.execute("SELECT id,project_id,title,due_at,notes,is_done,created_at FROM reminders WHERE id=?", (reminder_id,)).fetchone()
    return jsonify({"reminder": dict(updated)})


@extras_bp.delete("/reminders/<int:reminder_id>")
@login_required
def delete_reminder(reminder_id):
    with get_db_connection() as conn:
        cur = conn.execute("DELETE FROM reminders WHERE id=? AND user_id=?", (reminder_id, session["user_id"]))
        conn.commit()
    if not cur.rowcount:
        return jsonify({"error": "Nie znaleziono przypomnienia."}), 404
    return jsonify({"deleted_id": reminder_id})


@extras_bp.get("/stats")
@login_required
def get_stats():
    uid = session["user_id"]
    with get_db_connection() as conn:
        p = conn.execute(
            "SELECT COUNT(*) total, SUM(status='completed') completed, SUM(status='in_progress') active, SUM(rows) rows FROM projects WHERE user_id=?",
            (uid,),
        ).fetchone()
        y = conn.execute(
            "SELECT COUNT(*) kinds, SUM(skeins) skeins, SUM(skeins*length_m) meters, SUM(skeins*weight_g) grams FROM yarns WHERE user_id=? AND status!='used_up'",
            (uid,),
        ).fetchone()
        t = conn.execute("SELECT COALESCE(SUM(duration_seconds),0) seconds FROM knitting_sessions WHERE user_id=?", (uid,)).fetchone()
        monthly = conn.execute(
            "SELECT substr(created_at,1,7) month, SUM(duration_seconds) seconds FROM knitting_sessions WHERE user_id=? GROUP BY substr(created_at,1,7) ORDER BY month DESC LIMIT 6",
            (uid,),
        ).fetchall()
    return jsonify({"projects": dict(p), "stash": dict(y), "seconds": t["seconds"], "monthly": [dict(r) for r in reversed(monthly)]})


@extras_bp.get("/backup")
@login_required
def export_backup():
    uid = session["user_id"]
    include_photos = request.args.get("include_photos", "1") != "0"
    with get_db_connection() as conn:
        data = {}
        for table in ("projects", "yarns", "project_history", "project_checklist", "project_subcounters", "knitting_sessions", "reminders", "project_timer_state"):
            rows = [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE user_id=?", (uid,)).fetchall()]
            if not include_photos and table in ("projects", "yarns"):
                for item in rows:
                    item["photo_data"] = ""
                    if table == "projects":
                        item["chart_data"] = ""
            data[table] = rows
    return jsonify({"application": "Asystent Dziergania", "version": 4, "exported_at": datetime.now(timezone.utc).isoformat(), "data": data})


@extras_bp.post("/backup/import")
@login_required
def import_backup():
    backup = request.get_json(silent=True) or {}
    data = backup.get("data")
    if backup.get("application") != "Asystent Dziergania" or not isinstance(data, dict):
        return jsonify({"error": "To nie jest poprawna kopia Asystenta Dziergania."}), 400
    uid = session["user_id"]
    try:
        with get_db_connection() as conn:
            project_map = {}
            yarn_map = {}
            for item in data.get("yarns", []):
                cur = conn.execute(
                    "INSERT INTO yarns(user_id,name,color_lot,weight_g,length_m,skeins,status,notes,photo_data,brand,fiber,needle_size,care,purchase_price,stash_location) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        uid,
                        str(item.get("name") or "Włóczka")[:120],
                        str(item.get("color_lot") or "")[:100],
                        max(0, int(item.get("weight_g", 0))),
                        max(0, int(item.get("length_m", 0))),
                        max(0, float(item.get("skeins", 0))),
                        item.get("status") if item.get("status") in ALLOWED_YARN_STATUSES else "in_stash",
                        str(item.get("notes") or "")[:500],
                        str(item.get("photo_data") or "")[:600000],
                        str(item.get("brand") or "")[:120],
                        str(item.get("fiber") or "")[:160],
                        str(item.get("needle_size") or "")[:80],
                        str(item.get("care") or "")[:300],
                        max(0, float(item.get("purchase_price", 0))),
                        str(item.get("stash_location") or "")[:120],
                    ),
                )
                yarn_map[item.get("id")] = cur.lastrowid

            for item in data.get("projects", []):
                cur = conn.execute(
                    "INSERT INTO projects(user_id,name,tools,rows,target_rows,secondary_rows,stitches,repeats,status,shaping_rule,notes,start_date,target_date,source_url,category,difficulty,size_label,yarn_details,yarn_id,yarn_skeins_used,gauge,dimensions,photo_data,chart_data,chart_total_rows,chart_current_row) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        uid,
                        str(item.get("name") or "Projekt")[:120],
                        str(item.get("tools") or "Brak danych")[:80],
                        max(0, int(item.get("rows", 0))),
                        max(0, int(item.get("target_rows", 0))),
                        max(0, int(item.get("secondary_rows", 0))),
                        max(0, int(item.get("stitches", 0))),
                        max(0, int(item.get("repeats", 0))),
                        item.get("status") if item.get("status") in ALLOWED_PROJECT_STATUSES else "in_progress",
                        str(item.get("shaping_rule") or "")[:200],
                        str(item.get("notes") or "")[:5000],
                        str(item.get("start_date") or "")[:10],
                        str(item.get("target_date") or "")[:10],
                        str(item.get("source_url") or "")[:1000],
                        str(item.get("category") or "")[:80],
                        str(item.get("difficulty") or "")[:40],
                        str(item.get("size_label") or "")[:100],
                        str(item.get("yarn_details") or "")[:500],
                        yarn_map.get(item.get("yarn_id")),
                        max(0, float(item.get("yarn_skeins_used", 0))),
                        str(item.get("gauge") or "")[:300],
                        str(item.get("dimensions") or "")[:300],
                        str(item.get("photo_data") or "")[:1_200_000],
                        str(item.get("chart_data") or "")[:1_500_000],
                        max(1, int(item.get("chart_total_rows", 20))),
                        max(1, int(item.get("chart_current_row", 1))),
                    ),
                )
                project_map[item.get("id")] = cur.lastrowid

            for item in data.get("project_history", []):
                pid = project_map.get(item.get("project_id"))
                if pid:
                    conn.execute("INSERT INTO project_history(user_id,project_id,rows,note) VALUES(?,?,?,?)", (uid, pid, max(0, int(item.get("rows", 0))), str(item.get("note") or "")[:1000]))
            for item in data.get("project_checklist", []):
                pid = project_map.get(item.get("project_id"))
                if pid:
                    conn.execute("INSERT INTO project_checklist(user_id,project_id,title,is_done) VALUES(?,?,?,?)", (uid, pid, str(item.get("title") or "Etap")[:180], int(bool(item.get("is_done")))))
            for item in data.get("project_subcounters", []):
                pid = project_map.get(item.get("project_id"))
                if pid:
                    conn.execute("INSERT INTO project_subcounters(user_id,project_id,name,value) VALUES(?,?,?,?)", (uid, pid, str(item.get("name") or "Licznik")[:80], max(0, int(item.get("value", 0)))))
            for item in data.get("knitting_sessions", []):
                conn.execute("INSERT INTO knitting_sessions(user_id,project_id,duration_seconds,note) VALUES(?,?,?,?)", (uid, project_map.get(item.get("project_id")), max(0, int(item.get("duration_seconds", 0))), str(item.get("note") or "")[:500]))
            for item in data.get("project_timer_state", []):
                pid = project_map.get(item.get("project_id"))
                if pid:
                    conn.execute("INSERT OR IGNORE INTO project_timer_state(user_id,project_id,accumulated_seconds,started_at) VALUES(?,?,?,?)", (uid, pid, max(0, int(item.get("accumulated_seconds", 0))), item.get("started_at")))
            for item in data.get("reminders", []):
                conn.execute("INSERT INTO reminders(user_id,project_id,title,due_at,notes,is_done) VALUES(?,?,?,?,?,?)", (uid, project_map.get(item.get("project_id")), str(item.get("title") or "Przypomnienie")[:160], str(item.get("due_at") or datetime.now(timezone.utc).isoformat()), str(item.get("notes") or "")[:1000], int(bool(item.get("is_done")))))
            conn.commit()
    except (ValueError, TypeError, sqlite3.Error) as exc:
        return jsonify({"error": f"Import przerwany: {str(exc)}"}), 400
    return jsonify({"ok": True, "imported_projects": len(data.get("projects", [])), "imported_yarns": len(data.get("yarns", []))})


@extras_bp.get("/export.pdf")
@login_required
def export_pdf():
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
    except ImportError:
        return jsonify({"error": "Brak reportlab."}), 500
    uid = session["user_id"]
    with get_db_connection() as conn:
        ps = conn.execute("SELECT name,tools,rows,target_rows,stitches,repeats,status FROM projects WHERE user_id=? ORDER BY id DESC", (uid,)).fetchall()
        ys = conn.execute("SELECT name,color_lot,weight_g,length_m,skeins,status,fiber FROM yarns WHERE user_id=? ORDER BY id DESC", (uid,)).fetchall()
        hs = conn.execute("SELECT title,due_at,is_done FROM reminders WHERE user_id=? ORDER BY due_at", (uid,)).fetchall()
    buff = BytesIO()
    c = canvas.Canvas(buff, pagesize=A4)
    width, height = A4
    y = height - 48
    font_regular = "Helvetica"
    font_bold = "Helvetica-Bold"
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
    if os.path.exists(font_path):
        pdfmetrics.registerFont(TTFont("DejaVu", font_path))
        font_regular = "DejaVu"
        font_bold = "DejaVu"

    def line(txt):
        nonlocal y
        txt = str(txt)
        if not os.path.exists(font_path):
            txt = txt.encode("cp1252", "replace").decode("cp1252")
        if y < 55:
            c.showPage()
            y = height - 48
        c.drawString(42, y, txt[:110])
        y -= 16

    c.setFont(font_bold, 16)
    line("Asystent Dziergania - raport")
    c.setFont(font_regular, 9)
    line(f"Uzytkownik: {session.get('username','')} | Data: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    y -= 8
    c.setFont(font_bold, 12)
    line("PROJEKTY")
    c.setFont(font_regular, 9)
    for r in ps:
        goal = f"/{r['target_rows']}" if r["target_rows"] else ""
        line(f"- {r['name']} | rzedow: {r['rows']}{goal} | oczek: {r['stitches']} | status: {r['status']}")
    y -= 8
    c.setFont(font_bold, 12)
    line("MAGAZYN WŁÓCZEK")
    c.setFont(font_regular, 9)
    for r in ys:
        line(f"- {r['name']} | {r['color_lot']} | {r['skeins']} motkow x {r['length_m']} m | {r['fiber']}")
    y -= 8
    c.setFont(font_bold, 12)
    line("PRZYPOMNIENIA")
    c.setFont(font_regular, 9)
    for r in hs:
        line(f"- [{'x' if r['is_done'] else ' '}] {r['title']} | {r['due_at']}")
    c.save()
    buff.seek(0)
    return send_file(buff, mimetype="application/pdf", as_attachment=True, download_name="asystent-dziergania-raport.pdf")