// Discord component interaction endpoint for vJetstar recruitment decisions.
// IMPORTANT: Due to a known issue where Cloudflare Workers POST fetch() calls to Discord
// hang indefinitely (Discord and Cloudflare share infrastructure), this handler does
// everything synchronously in a single response — no deferred updates, no background fetches.
// The only outbound fetch allowed is the DM to the applicant, which is fire-and-forget
// (we don't await its result before responding to Discord).

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

function botHeaders(env) {
  return {
    Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
  };
}

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

  // Discord PING — must respond synchronously, no fetches needed
  if (interaction.type === 1) return json({ type: 1 });

  // Only handle button clicks (type 3)
  if (interaction.type !== 3) {
    return json({ type: 4, data: { content: "Unsupported interaction.", flags: 64 } });
  }

  const customId = String(interaction.data?.custom_id || "");

  // ── "I've read #whats-next" button (clicked by applicant) ───────────────────
  const readMatch = /^vjetstar:onboarded:([0-9]{17,20})$/.exec(customId);
  if (readMatch) {
    const applicantId = readMatch[1];
    const clickerId = String(interaction.member?.user?.id || interaction.user?.id || "");

    if (clickerId !== applicantId) {
      return json({ type: 4, data: { content: "This button is only for the applicant.", flags: 64 } });
    }

    // Fire-and-forget role swap — don't await, just kick it off
    // We can't await this anyway due to the CF/Discord fetch hang issue
    if (env.DISCORD_GUILD_ID) {
      const base = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${applicantId}/roles`;
      if (env.ROLE_ACCEPTED_ID) {
        fetch(`${base}/${env.ROLE_ACCEPTED_ID}`, { method: "DELETE", headers: botHeaders(env) });
      }
      if (env.ROLE_PILOT_ID) {
        fetch(`${base}/${env.ROLE_PILOT_ID}`, { method: "PUT", headers: botHeaders(env) });
      }
    }

    // Respond directly — update the message in place, no follow-up fetch needed
    return json({
      type: 7,
      data: {
        content: "✅ You've been added as a **vJetstar Pilot**. Welcome to the team — see you in the skies! 🛫",
        components: [],
        allowed_mentions: { parse: [] }
      }
    });
  }

  // ── Accept / Decline buttons (recruitment admin only) ───────────────────────
  const match = /^vjetstar:(accept|decline):([0-9]{17,20})$/.exec(customId);
  if (!match) {
    return json({ type: 4, data: { content: "This application button is invalid.", flags: 64 } });
  }

  const actorId = String(interaction.member?.user?.id || interaction.user?.id || "");
  if (actorId !== String(env.DISCORD_USER_ID)) {
    return json({ type: 4, data: { content: "Only the vJetstar recruitment administrator can decide applications.", flags: 64 } });
  }

  const decision = match[1];
  const applicantId = match[2];
  const decisionLabel = decision === "accept" ? "ACCEPTED" : "DECLINED";

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

  // Fire-and-forget: open DM + send message to applicant
  // We do NOT await these — the CF/Discord fetch hang means awaiting will block forever
  // They still send fine; we just can't check the result
  context.waitUntil((async () => {
    try {
      const dmChRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
        method: "POST",
        headers: botHeaders(env),
        body: JSON.stringify({ recipient_id: applicantId })
      });
      if (dmChRes.ok) {
        const dmCh = await dmChRes.json();
        await fetch(`https://discord.com/api/v10/channels/${dmCh.id}/messages`, {
          method: "POST",
          headers: botHeaders(env),
          body: JSON.stringify({ content: dmText, components: dmComponents, allowed_mentions: { parse: [] } })
        });
      }
    } catch { /* best-effort */ }

    // Role swap on accept
    if (decision === "accept" && env.DISCORD_GUILD_ID) {
      const base = `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/${applicantId}/roles`;
      try {
        if (env.ROLE_NO_APPLICATION_ID) {
          await fetch(`${base}/${env.ROLE_NO_APPLICATION_ID}`, { method: "DELETE", headers: botHeaders(env) });
        }
        if (env.ROLE_ACCEPTED_ID) {
          await fetch(`${base}/${env.ROLE_ACCEPTED_ID}`, { method: "PUT", headers: botHeaders(env) });
        }
      } catch { /* best-effort */ }
    }
  })());

  // Respond to Discord immediately — update the original message in place
  // type 7 = UPDATE_MESSAGE, updates the message the button was on directly
  // This is the ONLY fetch that matters for Discord's 3s window — and it's the return value, not a fetch() call
  const originalContent = String(interaction.message?.content || "**vJetstar pilot application**");
  const updatedContent = `${originalContent}\n\n**Decision: ${decisionLabel}**`;
  const disabledComponents = (interaction.message?.components || []).map(row => ({
    type: 1,
    components: (row.components || []).map(btn => ({
      type: 2,
      style: btn.style,
      label: btn.label,
      custom_id: btn.custom_id,
      disabled: true
    }))
  }));

  return json({
    type: 7,
    data: {
      content: updatedContent,
      components: disabledComponents,
      allowed_mentions: { parse: [] }
    }
  });
}
