from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def home():
    return render_template("index.html")


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


if __name__ == "__main__":
    app.run(debug=True, port=5000)

