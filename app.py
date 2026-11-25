import os
from flask import Flask, send_from_directory
from db import init_db
from routes.auth import auth_bp
from routes.projects import projects_bp
from routes.yarns import yarns_bp
from routes.extras import extras_bp

app = Flask(__name__, static_folder="static", static_url_path="")
app.secret_key = os.environ.get("SECRET_KEY", "zmien-ten-klucz-na-losowy-w-produkcji-987654321")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("COOKIE_SECURE", "0") == "1"
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024

app.register_blueprint(auth_bp)
app.register_blueprint(projects_bp)
app.register_blueprint(yarns_bp)
app.register_blueprint(extras_bp)


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


init_db()

if __name__ == "__main__":
    app.run(debug=False, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "5000")))