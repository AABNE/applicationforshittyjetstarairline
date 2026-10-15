const form = document.querySelector("#apply-form");
const noVatsim = document.querySelector("#no-vatsim");
const cid = document.querySelector("#cid");
const submit = document.querySelector("#submit");
const notice = document.querySelector("#notice");
const discordUsername = document.querySelector("#discord-username");
const discordPreview = document.querySelector("#discord-preview");
const discordAvatar = document.querySelector("#discord-avatar");
const discordName = document.querySelector("#discord-preview-name");
const discordTag = document.querySelector("#discord-preview-tag");
const discordError = document.querySelector("#discord-error");

let verifiedDiscordId = "";
let lookupTimer;

function showNotice(message, type) {
  notice.textContent = message;
  notice.className = `notice show ${type}`;
}

noVatsim.addEventListener("change", () => {
  cid.disabled = noVatsim.checked;
  cid.required = !noVatsim.checked;
  cid.value = noVatsim.checked ? "" : cid.value;
  cid.placeholder = noVatsim.checked ? "Not required" : "Enter your VATSIM CID";
});
cid.required = true;

discordUsername.addEventListener("input", () => {
  clearTimeout(lookupTimer);
  verifiedDiscordId = "";
  discordPreview.hidden = true;
  discordError.textContent = "";

  const value = discordUsername.value.trim();
  // Accept username (2-32 chars, alphanumeric/dots/underscores/hyphens) or numeric ID
  const isId = /^[0-9]{17,20}$/.test(value);
  const isUsername = /^[a-zA-Z0-9._-]{2,32}$/.test(value);

  if (!value) return;
  if (!isId && !isUsername) {
    discordError.textContent = "Enter your Discord username (e.g. aussieavia) or numeric user ID.";
    return;
  }

  discordError.textContent = "Looking up Discord account…";
  lookupTimer = setTimeout(async () => {
    try {
      const param = isId ? `id=${encodeURIComponent(value)}` : `username=${encodeURIComponent(value.toLowerCase())}`;
      const response = await fetch(`/api/discord-user?${param}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Account lookup failed.");
      if (discordUsername.value.trim() !== value) return;

      discordAvatar.src = result.avatar;
      discordName.textContent = result.globalName;
      discordTag.textContent = `@${result.username}`;
      discordPreview.hidden = false;
      discordError.textContent = "";
      verifiedDiscordId = result.id;
    } catch (error) {
      if (discordUsername.value.trim() === value) {
        discordError.textContent = error.message || "Discord account lookup failed.";
        verifiedDiscordId = "";
        discordPreview.hidden = true;
      }
    }
  }, 450);
});

form.addEventListener("submit", async event => {
  event.preventDefault();
  notice.className = "notice";

  if (!verifiedDiscordId) {
    showNotice("Please enter your Discord username and wait for the account preview.", "err");
    return;
  }

  const data = new FormData(form);
  const aircraft = data.getAll("aircraft");
  if (!aircraft.length) {
    showNotice("Please select at least one preferred aircraft.", "err");
    return;
  }

  if (!noVatsim.checked && !/^[0-9]{1,12}$/.test(cid.value.trim())) {
    showNotice("Enter your VATSIM CID or tick the box if you do not have one.", "err");
    return;
  }

  submit.disabled = true;
  submit.querySelector("span").textContent = "Submitting…";

  try {
    const response = await fetch("/api/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: String(data.get("username") || "").trim(),
        discordId: verifiedDiscordId,
        cid: noVatsim.checked ? null : cid.value.trim(),
        noVatsim: noVatsim.checked,
        aircraft,
        email: String(data.get("email") || "").trim(),
        website: String(data.get("website") || "")
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Could not submit your application.");

    form.reset();
    verifiedDiscordId = "";
    discordPreview.hidden = true;
    cid.disabled = false;
    cid.required = true;
    cid.placeholder = "Enter your VATSIM CID";
    showNotice("Application submitted! Check #❔︱whats-next in our Discord server for information on what happens next.", "ok");
  } catch (error) {
    showNotice(error.message || "Something went wrong. Please try again.", "err");
  } finally {
    submit.disabled = false;
    submit.querySelector("span").textContent = "Submit application";
  }
});
