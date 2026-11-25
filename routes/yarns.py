from flask import Blueprint, jsonify, request, session
from db import ALLOWED_YARN_STATUSES, get_db_connection, login_required

yarns_bp = Blueprint("yarns", __name__, url_prefix="/api/yarns")


def serialize_yarn(row):
    keys = row.keys()
    return {
        "id": row["id"],
        "name": row["name"],
        "color_lot": row["color_lot"],
        "weight_g": row["weight_g"],
        "length_m": row["length_m"],
        "skeins": row["skeins"],
        "status": row["status"],
        "notes": row["notes"],
        "photo_data": row["photo_data"] or "",
        "brand": row["brand"] if "brand" in keys else "",
        "fiber": row["fiber"] if "fiber" in keys else "",
        "needle_size": row["needle_size"] if "needle_size" in keys else "",
        "care": row["care"] if "care" in keys else "",
        "purchase_price": row["purchase_price"] if "purchase_price" in keys else 0,
        "stash_location": row["stash_location"] if "stash_location" in keys else "",
    }


@yarns_bp.get("")
@login_required
def list_yarns():
    with get_db_connection() as conn:
        rows = conn.execute("SELECT * FROM yarns WHERE user_id = ? ORDER BY id DESC", (session["user_id"],)).fetchall()
    return jsonify({"yarns": [serialize_yarn(r) for r in rows]})


@yarns_bp.post("")
@login_required
def create_yarn():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Nazwa włóczki jest wymagana."}), 400

    status = data.get("status") if data.get("status") in ALLOWED_YARN_STATUSES else "in_stash"
    photo_data = (data.get("photo_data") or "").strip()
    if photo_data and (not photo_data.startswith("data:image/") or len(photo_data) > 600_000):
        return jsonify({"error": "Nieprawidłowe lub zbyt duże zdjęcie."}), 400

    try:
        weight_g = max(0, int(data.get("weight_g") or 0))
        length_m = max(0, int(data.get("length_m") or 0))
        skeins = max(0.0, float(data.get("skeins") if data.get("skeins") is not None else 1))
        purchase_price = max(0.0, float(data.get("purchase_price") or 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Nieprawidłowe wartości liczbowe włóczki."}), 400

    with get_db_connection() as conn:
        cursor = conn.execute(
            """
            INSERT INTO yarns (user_id, name, color_lot, weight_g, length_m, skeins, status, notes, photo_data, brand, fiber, needle_size, care, purchase_price, stash_location)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session["user_id"],
                name[:120],
                str(data.get("color_lot") or "")[:100],
                weight_g,
                length_m,
                skeins,
                status,
                str(data.get("notes") or "")[:500],
                photo_data,
                str(data.get("brand") or "")[:120],
                str(data.get("fiber") or "")[:160],
                str(data.get("needle_size") or "")[:80],
                str(data.get("care") or "")[:300],
                purchase_price,
                str(data.get("stash_location") or "")[:120],
            ),
        )
        conn.commit()
        created = conn.execute("SELECT * FROM yarns WHERE id = ? AND user_id = ?", (cursor.lastrowid, session["user_id"])).fetchone()

    return jsonify({"yarn": serialize_yarn(created)}), 201


@yarns_bp.patch("/<int:yarn_id>")
@login_required
def update_yarn(yarn_id):
    data = request.get_json(silent=True) or {}
    with get_db_connection() as conn:
        existing = conn.execute("SELECT * FROM yarns WHERE id = ? AND user_id = ?", (yarn_id, session["user_id"])).fetchone()
        if existing is None:
            return jsonify({"error": "Nie znaleziono włóczki."}), 404

        skeins = existing["skeins"]
        status = existing["status"]
        name = existing["name"]
        weight_g = existing["weight_g"]
        length_m = existing["length_m"]
        photo_data = existing["photo_data"]

        if "name" in data:
            candidate_name = str(data["name"] or "").strip()
            if not candidate_name:
                return jsonify({"error": "Nazwa włóczki nie może być pusta."}), 400
            name = candidate_name[:120]

        if "weight_g" in data:
            weight_g = max(0, int(data["weight_g"] or 0))
        if "length_m" in data:
            length_m = max(0, int(data["length_m"] or 0))
        if "skeins" in data:
            skeins = max(0.0, round(float(data["skeins"]), 2))
        if "status" in data and data["status"] in ALLOWED_YARN_STATUSES:
            status = data["status"]
        if "photo_data" in data:
            candidate_photo = str(data["photo_data"] or "").strip()
            if candidate_photo and (not candidate_photo.startswith("data:image/") or len(candidate_photo) > 600_000):
                return jsonify({"error": "Nieprawidłowe lub zbyt duże zdjęcie."}), 400
            photo_data = candidate_photo

        extra = {
            k: str(data[k])[:limit]
            for k, limit in {"brand": 120, "fiber": 160, "needle_size": 80, "care": 300, "stash_location": 120, "color_lot": 100, "notes": 500}.items()
            if k in data
        }
        if "purchase_price" in data:
            extra["purchase_price"] = max(0.0, float(data["purchase_price"]))

        assignments = ["name = ?", "weight_g = ?", "length_m = ?", "skeins = ?", "status = ?", "photo_data = ?"] + [f"{k} = ?" for k in extra]
        conn.execute(
            f"UPDATE yarns SET {', '.join(assignments)} WHERE id = ? AND user_id = ?",
            [name, weight_g, length_m, skeins, status, photo_data, *extra.values(), yarn_id, session["user_id"]],
        )
        conn.commit()
        updated = conn.execute("SELECT * FROM yarns WHERE id = ? AND user_id = ?", (yarn_id, session["user_id"])).fetchone()

    return jsonify({"yarn": serialize_yarn(updated)})


@yarns_bp.delete("/<int:yarn_id>")
@login_required
def delete_yarn(yarn_id):
    with get_db_connection() as conn:
        cursor = conn.execute("DELETE FROM yarns WHERE id = ? AND user_id = ?", (yarn_id, session["user_id"]))
        conn.commit()
    if cursor.rowcount == 0:
        return jsonify({"error": "Nie znaleziono włóczki."}), 404
    return jsonify({"deleted_id": yarn_id})