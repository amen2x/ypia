document.getElementById("signupChildForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const payload = {
    role: "child",
    fullName: document.getElementById("fullName").value.trim(),
    email: document.getElementById("email").value.trim(),
    password: document.getElementById("password").value,
    parentEmail: document.getElementById("parentEmail").value.trim(),
    relationship: document.getElementById("relationship").value,
  };

  try {
    const res = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (res.ok) {
      alert("Account created. Your request to link with that parent is pending approval.");
      window.location.href = "/login";
    } else {
      alert(data.error || "Signup failed.");
    }
  } catch (err) {
    console.error("Signup request failed:", err);
    alert("Something went wrong. Please try again.");
  }
});