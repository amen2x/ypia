document.getElementById("signupParentForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    role: "parent",
    fullName: document.getElementById("fullName").value.trim(),
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value,
  };

  try {
    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      window.location.href = "/login";
    } else {
      alert(data.error || "Signup failed.");
    }
  } catch (err) {
    console.error("Signup request failed:", err);
    alert("Something went wrong. Please try again.");
  }
});