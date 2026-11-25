import sqlite3
from flask import Blueprint, jsonify, request, session
from werkzeug.security import check_password_hash, generate_password_hash
from db import get_db_connection, login_required

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")


@auth_bp.post("/register")
def register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if len(username) < 3 or len(username) > 30:
        return jsonify({"error": "Login musi mieć od 3 do 30 znaków."}), 400
    if len(password) < 6:
        return jsonify({"error": "Hasło musi mieć co najmniej 6 znaków."}), 400

    password_hash = generate_password_hash(password)
    try:
        with get_db_connection() as conn:
            cursor = conn.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, password_hash),
            )
            conn.commit()
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError:
        return jsonify({"error": "Taki login jest już zajęty."}), 409

    session.clear()
    session["user_id"] = user_id
    session["username"] = username
    return jsonify({"user": {"id": user_id, "username": username}}), 201


@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password:
        return jsonify({"error": "Podaj login i hasło."}), 400

    with get_db_connection() as conn:
        user = conn.execute(
            "SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE",
            (username,),
        ).fetchone()

    if user is None or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Nieprawidłowy login lub hasło."}), 401

    session.clear()
    session["user_id"] = user["id"]
    session["username"] = user["username"]
    return jsonify({"user": {"id": user["id"], "username": user["username"]}})


@auth_bp.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.get("/me")
def me():
    if "user_id" not in session:
        return jsonify({"user": None})
    return jsonify({"user": {"id": session["user_id"], "username": session["username"]}})


@auth_bp.post("/change-password")
@login_required
def change_password():
    data = request.get_json(silent=True) or {}
    current_password = data.get("current_password") or ""
    new_password = data.get("new_password") or ""

    if len(new_password) < 6:
        return jsonify({"error": "Nowe hasło musi mieć co najmniej 6 znaków."}), 400

    uid = session["user_id"]
    with get_db_connection() as conn:
        user = conn.execute("SELECT password_hash FROM users WHERE id=?", (uid,)).fetchone()
        if not user or not check_password_hash(user["password_hash"], current_password):
            return jsonify({"error": "Obecne hasło jest nieprawidłowe."}), 401

        conn.execute(
            "UPDATE users SET password_hash=? WHERE id=?",
            (generate_password_hash(new_password), uid),
        )
        conn.commit()

    return jsonify({"ok": True})


@auth_bp.delete("/account")
@login_required
def delete_account():
    data = request.get_json(silent=True) or {}
    password = data.get("password") or ""
    uid = session["user_id"]

    with get_db_connection() as conn:
        user = conn.execute("SELECT password_hash FROM users WHERE id=?", (uid,)).fetchone()
        if not user or not check_password_hash(user["password_hash"], password):
            return jsonify({"error": "Podaj poprawne hasło, aby usunąć konto."}), 401
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
        conn.commit()

    session.clear()
    return jsonify({"ok": True})