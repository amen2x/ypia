document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!email || !password) return;

  try {
    const res = await fetch("http://localhost:3000/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (res.ok) {
      localStorage.setItem("ypia_user", JSON.stringify(data.user));
      window.location.href = "/";
    } else {
      alert(data.error || "Invalid email or password.");
    }
  } catch (err) {
    console.error("Login request failed:", err);
    alert("Something went wrong. Please try again.");
  }
});