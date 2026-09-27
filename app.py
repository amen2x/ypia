from urllib.request import Request, urlopen
from urllib.error import HTTPError
from flask import Flask, render_template, request, Response

app = Flask(__name__)


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/parent")
def parent_home():
    return render_template("parent.html")


@app.route("/login")
def login():
    return render_template("login.html")


@app.route("/signup")
def signup_choice():
    return render_template("signup.html")


@app.route("/signup/parent")
def signup_parent():
    return render_template("signup/parent.html")


@app.route("/signup/child")
def signup_child():
    return render_template("signup/child.html")


@app.route("/api/<path:subpath>", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
def proxy_api(subpath):
    backend_url = f"http://localhost:3000/api/{subpath}"
    if request.query_string:
        backend_url = f"{backend_url}?{request.query_string.decode('utf-8')}"

    headers = {k: v for k, v in request.headers if k.lower() not in ["host", "content-length"]}
    data = request.get_data() if request.method in ["POST", "PUT", "PATCH"] else None

    req = Request(backend_url, data=data, headers=headers, method=request.method)
    try:
        with urlopen(req) as resp:
            return Response(resp.read(), status=resp.status, headers=dict(resp.headers))
    except HTTPError as e:
        return Response(e.read(), status=e.code, headers=dict(e.headers))
    except Exception as e:
        return {"error": f"Backend proxy error: {str(e)}"}, 503


if __name__ == "__main__":
    app.run(debug=True, port=5000)

