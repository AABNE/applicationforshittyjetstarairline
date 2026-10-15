// Discord component interaction endpoint for vJetstar recruitment decisions.
// Configure this URL in Discord Developer Portal as the Interactions Endpoint URL.
// Required Cloudflare Pages env vars/secrets:
//   DISCORD_BOT_TOKEN      — bot token
//   DISCORD_USER_ID        — your Discord user ID (recruitment admin)
//   DISCORD_PUBLIC_KEY     — application public key from Discord Developer Portal
//   DISCORD_GUILD_ID       — your server (guild) ID
//   ROLE_NO_APPLICATION_ID — "No Application Yet" role ID
//   ROLE_ACCEPTED_ID       — "Accepted" role ID
//   ROLE_PILOT_ID          — "Pilot" role ID
//
// IMPORTANT: Discord gives an interaction only 3 seconds to be answered, otherwise the
// user sees "The application didn't respond in time". So every handler below answers
// IMMEDIATELY (type 7 = update the message) and does the slow Discord API work afterwards
// in waitUntil(), then edits the original message with the real result.

const API = "https://discord.com/api/v10";
const USER_AGENT = "vJetstarPilotApplications (Cloudflare Pages)";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

const ephemeral = content => json({ type: 4, data: { content, flags: 64 } });

function fromHex(hex) {
  if (typeof hex !== "string" || !/^(?:[0-9a-fA-F]{2})+$/.test(hex)) throw new Error("Invalid hex");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function verifyDiscordRequest(request, rawBody, publicKey) {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;
  // Reject old requests to reduce replay risk.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  let keyBytes, sigBytes;
  try {
    keyBytes = fromHex(publicKey.trim());
    sigBytes = fromHex(signature);
  } catch {
    return false;
  }
  const signed = new TextEncoder().encode(timestamp + rawBody);

  // Workers runtimes expose Ed25519 under either name depending on compatibility date.
  for (const name of ["Ed25519", "NODE-ED25519"]) {
    try {
      const algo = name === "Ed25519" ? { name } : { name, namedCurve: name };
      const key = await crypto.subtle.importKey("raw", keyBytes, algo, false, ["verify"]);
      return await crypto.subtle.verify(name === "Ed25519" ? { name } : name, key, sigBytes, signed);
    } catch {
      // try the next algorithm name
    }
  }
  return false;
}

// Bot-authenticated Discord API call. Retries once on a 429 rate limit.
async function discordApi(env, path, options = {}, retried = false) {
  const headers = {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "User-Agent": USER_AGENT,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };
  const response = await fetch(`${API}${path}`, { ...options, headers });
  if (response.status === 429 && !retried) {
    const wait = Math.min(Number((await response.json().catch(() => ({}))).retry_after) || 1, 5);
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    return discordApi(env, path, options, true);
  }
  return response;
}

// Edit the message the button was clicked on (interaction webhooks need no bot auth).
function editOriginal(interaction, data) {
  return fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ ...data, allowed_mentions: { parse: [] } })
  });
}

// Rebuild button rows, optionally disabling every button.
function buildRows(rows, disabled) {
  return (rows || []).map(row => ({
    type: 1,
    components: (row.components || []).map(button => ({
      type: 2,
      style: button.style,
      label: button.label,
      custom_id: button.custom_id,
      ...(button.emoji ? { emoji: button.emoji } : {}),
      disabled
    }))
  }));
}

// Swap roles on a guild member. Returns a list of human-readable failures (empty = all good).
async function swapRoles(env, memberId, { remove = [], add = [] } = {}) {
  if (!env.DISCORD_GUILD_ID) return ["DISCORD_GUILD_ID is not set"];
  const base = `/guilds/${env.DISCORD_GUILD_ID}/members/${memberId}/roles`;
  const jobs = [
    ...remove.filter(Boolean).map(id => ({ id, method: "DELETE", verb: "remove" })),
    ...add.filter(Boolean).map(id => ({ id, method: "PUT", verb: "add" }))
  ];
  if (!jobs.length) return ["role IDs are not configured"];

  const failures = [];
  await Promise.all(jobs.map(async job => {
    try {
      const response = await discordApi(env, `${base}/${job.id}`, { method: job.method });
      if (response.ok) return;
      if (response.status === 404) failures.push("member is not in the server yet");
      else if (response.status === 403) failures.push("bot lacks Manage Roles or its role is below the target role");
      else failures.push(`could not ${job.verb} role (HTTP ${response.status})`);
    } catch {
      failures.push(`could not ${job.verb} role (network error)`);
    }
  }));
  return [...new Set(failures)];
}

// ── Background work: "I've read #whats-next" ────────────────────────────────────
async function finishOnboarding(env, interaction, applicantId, originalRows) {
  let failures;
  try {
    failures = await swapRoles(env, applicantId, {
      remove: [env.ROLE_ACCEPTED_ID],
      add: [env.ROLE_PILOT_ID]
    });
  } catch {
    failures = ["unexpected error"];
  }

  if (failures.length) {
    // Put the button back so they can try again.
    await editOriginal(interaction, {
      content: `⚠️ We couldn't give you the Pilot role (${failures.join("; ")}). Make sure you've joined the vJetstar Discord server, then press the button again.`,
      components: buildRows(originalRows, false)
    }).catch(() => {});
    return;
  }

  await editOriginal(interaction, {
    content: "✅ You've been added as a **vJetstar Pilot**. Welcome to the team — see you in the skies! 🛫",
    components: []
  }).catch(() => {});
}

// ── Background work: Accept / Decline ───────────────────────────────────────────
async function finishDecision(env, interaction, { decision, applicantId, oldContent, originalRows }) {
  const label = decision === "accept" ? "ACCEPTED" : "DECLINED";

  const dmText = decision === "accept"
    ? [
        "🎉 Congratulations — your **vJetstar pilot application has been accepted!**",
        "",
        "Head to **#❔︱whats-next** in our Discord server to find out everything you need to do next.",
        "",
        "Once you've had a read through, hit the button below and you'll be granted your Pilot role automatically."
      ].join("\n")
    : "Thank you for applying to vJetstar. Unfortunately, your pilot application has been **declined** at this time.";

  const dmComponents = decision === "accept"
    ? [{
        type: 1,
        components: [{
          type: 2,
          style: 3,
          label: "✅ I've read #whats-next — make me a Pilot!",
          custom_id: `vjetstar:onboarded:${applicantId}`
        }]
      }]
    : [];

  // Restore the buttons so the admin can retry if delivery fails.
  const fail = async reason => {
    await editOriginal(interaction, {
      content: `${oldContent}\n\n⚠️ **${label} was NOT sent:** ${reason} You can press a button to try again.`,
      components: buildRows(originalRows, false)
    }).catch(() => {});
  };

  try {
    const dmChannelResponse = await discordApi(env, "/users/@me/channels", {
      method: "POST",
      body: JSON.stringify({ recipient_id: applicantId })
    });
    if (!dmChannelResponse.ok) {
      return fail("couldn't open a DM with the applicant (their privacy settings may block the bot).");
    }
    const dmChannel = await dmChannelResponse.json();

    const dmResponse = await discordApi(env, `/channels/${dmChannel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: dmText, components: dmComponents, allowed_mentions: { parse: [] } })
    });
    if (!dmResponse.ok) {
      return fail("Discord rejected the DM to the applicant.");
    }

    // Swap roles on accept: remove "No Application Yet", add "Accepted".
    let roleNote = "";
    if (decision === "accept") {
      const failures = await swapRoles(env, applicantId, {
        remove: [env.ROLE_NO_APPLICATION_ID],
        add: [env.ROLE_ACCEPTED_ID]
      }).catch(() => ["unexpected error"]);
      if (failures.length) roleNote = `\n⚠️ DM sent, but roles were not updated: ${failures.join("; ")}.`;
    }

    await editOriginal(interaction, {
      content: `${oldContent}\n\n**Decision: ${label}**${roleNote}`,
      components: buildRows(originalRows, true)
    });
  } catch {
    await fail("an unexpected error occurred.");
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DISCORD_PUBLIC_KEY || !env.DISCORD_BOT_TOKEN || !env.DISCORD_USER_ID) {
    return json({ error: "Discord interactions are not configured." }, 503);
  }

  const rawBody = await request.text();
  if (!(await verifyDiscordRequest(request, rawBody, env.DISCORD_PUBLIC_KEY))) {
    return json({ error: "Invalid Discord request signature." }, 401);
  }

  let interaction;
  try { interaction = JSON.parse(rawBody); }
  catch { return json({ error: "Invalid JSON." }, 400); }

  // Discord verifies the endpoint using a PING interaction.
  if (interaction.type === 1) return json({ type: 1 });

  // Only handle button clicks.
  if (interaction.type !== 3) return ephemeral("Unsupported interaction.");

  const customId = String(interaction.data?.custom_id || "");
  const clickerId = String(interaction.member?.user?.id || interaction.user?.id || "");
  const originalRows = interaction.message?.components || [];

  // ── "I've read #whats-next" button clicked by the applicant themselves ──────
  const readMatch = /^vjetstar:onboarded:([0-9]{17,20})$/.exec(customId);
  if (readMatch) {
    const applicantId = readMatch[1];

    // Only the applicant themselves can click this button.
    if (clickerId !== applicantId) return ephemeral("This button is only for the applicant.");

    waitUntil(finishOnboarding(env, interaction, applicantId, originalRows));
    return json({
      type: 7,
      data: { content: "⏳ Adding your **Pilot** role…", components: [], allowed_mentions: { parse: [] } }
    });
  }

  // ── Accept / Decline buttons (recruitment admin only) ────────────────────────
  const match = /^vjetstar:(accept|decline):([0-9]{17,20})$/.exec(customId);
  if (!match) return ephemeral("This application button is invalid.");

  if (clickerId !== String(env.DISCORD_USER_ID)) {
    return ephemeral("Only the vJetstar recruitment administrator can decide applications.");
  }

  const decision = match[1];
  const applicantId = match[2];
  const oldContent = String(interaction.message?.content || "**vJetstar pilot application**");

  waitUntil(finishDecision(env, interaction, { decision, applicantId, oldContent, originalRows }));

  // Answer instantly: lock the buttons (prevents double-clicks) while the work happens.
  return json({
    type: 7,
    data: {
      content: `${oldContent}\n\n⏳ **Sending ${decision === "accept" ? "acceptance" : "decline"}…**`,
      components: buildRows(originalRows, true),
      allowed_mentions: { parse: [] }
    }
  });
}
