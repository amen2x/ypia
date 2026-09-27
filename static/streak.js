// Weekly check-in streak on the family member's page (index.html).
// Check on your parent at least once a week to keep the streak going.
(function () {
  const API = "";
  const box = document.getElementById("streakBox");
  if (!box) return;

  const user = JSON.parse(localStorage.getItem("ypia_user") || "{}");
  if (!user.id || user.role === "parent") {
    box.hidden = true;
    return;
  }

  const countEl = document.getElementById("streakCount");
  const messageEl = document.getElementById("streakMessage");
  const labelEl = document.getElementById("streakLabel");
  const button = document.getElementById("streakButton");

  // The parent's name, once the page has loaded it (falls back to "your parent").
  function parentName() {
    const name = document.getElementById("parent-name")?.textContent.trim();
    return name || "your parent";
  }

  function weeks(n) {
    return n === 1 ? "1 week" : `${n} weeks`;
  }

  let lastStatus = null;

  function show(status) {
    lastStatus = status;
    const name = parentName();
    countEl.textContent = status.streak;
    labelEl.textContent = status.streak === 1 ? "week in a row" : "weeks in a row";
    button.hidden = false;

    if (status.checkedInThisWeek) {
      messageEl.textContent = `You checked on ${name} this week. Your streak is ${weeks(status.streak)}. See you next week!`;
      button.textContent = "Checked in this week";
      button.disabled = true;
    } else {
      if (status.streak > 0) {
        messageEl.textContent = `Check on ${name} this week to keep your ${weeks(status.streak)} streak going.`;
      } else if (status.lastCheckin) {
        messageEl.textContent = `Your streak ended. Check on ${name} this week to start a new one.`;
      } else {
        messageEl.textContent = `Check on ${name} once a week to build a streak.`;
      }
      button.textContent = `I checked on ${name}`;
      button.disabled = false;
    }
  }

  async function call(path, options) {
    const response = await fetch(`${API}${path}`, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  }

  async function load() {
    try {
      show(await call(`/api/streak?userId=${encodeURIComponent(user.id)}`));
    } catch (error) {
      messageEl.textContent = error.message;
    }
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Saving...";
    try {
      show(await call("/api/streak/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      }));
    } catch (error) {
      messageEl.textContent = error.message;
      button.disabled = false;
      button.textContent = `I checked on ${parentName()}`;
    }
  });

  // The parent's name loads a moment later, so redo the text when it changes.
  const nameEl = document.getElementById("parent-name");
  if (nameEl) {
    new MutationObserver(() => { if (lastStatus) show(lastStatus); })
      .observe(nameEl, { childList: true, characterData: true, subtree: true });
  }

  load();
})();