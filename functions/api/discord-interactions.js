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

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
});

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
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromHex(publicKey), { name: "Ed25519" }, false, ["verify"]);
    const signed = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, fromHex(signature), signed);
  } catch {
    return false;
  }
}

async function discordApi(env, path, options = {}) {
  return fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)",
      ...(options.headers || {})
    }
  });
}

async function swapRoles(env, memberId, { remove = [], add = [] } = {}) {
  if (!env.DISCORD_GUILD_ID) return;
  const base = `/guilds/${env.DISCORD_GUILD_ID}/members/${memberId}/roles`;
  await Promise.all([
    ...remove.filter(Boolean).map(roleId => discordApi(env, `${base}/${roleId}`, { method: "DELETE", headers: { "Content-Type": undefined } })),
    ...add.filter(Boolean).map(roleId => discordApi(env, `${base}/${roleId}`, { method: "PUT" }))
  ]);
}

async function editOriginalResponse(applicationId, interactionToken, data) {
  return fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
    },
    body: JSON.stringify(data)
  });
}

// NOTE: We receive the full context object so we can call context.waitUntil()
// This lets us return a response to Discord immediately (within 3s) and do
// the actual API work (DMs, role swaps) in the background.
export async function onRequestPost(context) {
  const { request, env } = context;

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

  // Discord PING verification — must respond synchronously
  if (interaction.type === 1) return json({ type: 1 });

  // Only handle button clicks (type 3)
  if (interaction.type !== 3) return json({ type: 4, data: { content: "Unsupported interaction.", flags: 64 } });

  const customId = String(interaction.data?.custom_id || "");
  const applicationId = interaction.application_id;
  const interactionToken = interaction.token;

  // ── "I've read #whats-next" button (clicked by applicant) ───────────────────
  const readMatch = /^vjetstar:onboarded:([0-9]{17,20})$/.exec(customId);
  if (readMatch) {
    const applicantId = readMatch[1];
    const clickerId = String(interaction.member?.user?.id || interaction.user?.id || "");

    if (clickerId !== applicantId) {
      return json({ type: 4, data: { content: "This button is only for the applicant.", flags: 64 } });
    }

    // Respond immediately with deferred update (type 6), do work in background
    context.waitUntil((async () => {
      try {
        await swapRoles(env, applicantId, {
          remove: [env.ROLE_ACCEPTED_ID],
          add: [env.ROLE_PILOT_ID]
        });
      } catch { /* role swap is best-effort */ }

      await editOriginalResponse(applicationId, interactionToken, {
        content: "✅ You've been added as a **vJetstar Pilot**. Welcome to the team — see you in the skies! 🛫",
        components: [],
        allowed_mentions: { parse: [] }
      });
    })());

    return json({ type: 6 });
  }

  // ── Accept / Decline buttons (recruitment admin only) ───────────────────────
  const match = /^vjetstar:(accept|decline):([0-9]{17,20})$/.exec(customId);
  if (!match) return json({ type: 4, data: { content: "This application button is invalid.", flags: 64 } });

  const actorId = String(interaction.member?.user?.id || interaction.user?.id || "");
  if (actorId !== String(env.DISCORD_USER_ID)) {
    return json({ type: 4, data: { content: "Only the vJetstar recruitment administrator can decide applications.", flags: 64 } });
  }

  const decision = match[1];
  const applicantId = match[2];
  const decisionLabel = decision === "accept" ? "accepted" : "declined";

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

  // Snapshot the message content/components now before going async
  const originalContent = String(interaction.message?.content || "**vJetstar pilot application**");
  const originalComponents = interaction.message?.components || [];

  // Respond to Discord immediately (type 6 = deferred update), do everything in background
  context.waitUntil((async () => {
    try {
      // Open DM channel with applicant
      const dmChannelRes = await discordApi(env, "/users/@me/channels", {
        method: "POST",
        body: JSON.stringify({ recipient_id: applicantId })
      });

      if (!dmChannelRes.ok) {
        await editOriginalResponse(applicationId, interactionToken, {
          content: originalContent + "\n\n⚠️ **Could not open a DM with the applicant.** Their privacy settings may block the bot.",
          components: originalComponents,
          allowed_mentions: { parse: [] }
        });
        return;
      }

      const dmChannel = await dmChannelRes.json();
      const dmRes = await discordApi(env, `/channels/${dmChannel.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: dmText, components: dmComponents, allowed_mentions: { parse: [] } })
      });

      if (!dmRes.ok) {
        await editOriginalResponse(applicationId, interactionToken, {
          content: originalContent + "\n\n⚠️ **Could not deliver the decision DM.** Try again.",
          components: originalComponents,
          allowed_mentions: { parse: [] }
        });
        return;
      }

      // Swap roles on accept
      if (decision === "accept") {
        try {
          await swapRoles(env, applicantId, {
            remove: [env.ROLE_NO_APPLICATION_ID],
            add: [env.ROLE_ACCEPTED_ID]
          });
        } catch { /* best-effort */ }
      }

      // Update the original application message: append decision + disable buttons
      const updatedContent = `${originalContent}\n\n**Decision: ${decisionLabel.toUpperCase()}**`;
      const disabledComponents = originalComponents.map(row => ({
        type: 1,
        components: (row.components || []).map(button => ({
          type: 2,
          style: button.style,
          label: button.label,
          custom_id: button.custom_id,
          disabled: true
        }))
      }));

      await editOriginalResponse(applicationId, interactionToken, {
        content: updatedContent,
        components: disabledComponents,
        allowed_mentions: { parse: [] }
      });

    } catch {
      try {
        await editOriginalResponse(applicationId, interactionToken, {
          content: originalContent + "\n\n⚠️ **An error occurred while processing the decision.** Try again.",
          components: originalComponents,
          allowed_mentions: { parse: [] }
        });
      } catch { /* nothing more we can do */ }
    }
  })());

  return json({ type: 6 });
}
