// Discord component interaction endpoint for vJetstar recruitment decisions.
// Configure this URL in Discord Developer Portal as the Interactions Endpoint URL.
// Required Cloudflare Pages variables/secrets: DISCORD_BOT_TOKEN, DISCORD_USER_ID,
// DISCORD_PUBLIC_KEY (the application's public key from Discord Developer Portal).

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
  // Reject old requests to reduce replay risk.
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

export async function onRequestPost({ request, env }) {
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
  if (interaction.type !== 3) return json({ type: 4, data: { content: "Unsupported interaction.", flags: 64 } });

  const customId = String(interaction.data?.custom_id || "");
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
    ? "Your vJetstar pilot application has been **accepted**. The recruitment team will contact you with the next steps."
    : "Thank you for applying to vJetstar. Unfortunately, your pilot application has been **declined** at this time.";

  try {
    const dmChannelResponse = await discordApi(env, "/users/@me/channels", {
      method: "POST", body: JSON.stringify({ recipient_id: applicantId })
    });
    if (!dmChannelResponse.ok) {
      return json({ type: 4, data: { content: "Could not open a DM with the applicant. Their Discord privacy settings may block the bot. No decision was sent; try again later.", flags: 64 } });
    }
    const dmChannel = await dmChannelResponse.json();
    const dmResponse = await discordApi(env, `/channels/${dmChannel.id}/messages`, {
      method: "POST", body: JSON.stringify({ content: dmText, allowed_mentions: { parse: [] } })
    });
    if (!dmResponse.ok) {
      return json({ type: 4, data: { content: "Discord could not deliver the decision DM. No decision was marked on the application message; try again.", flags: 64 } });
    }

    const oldContent = String(interaction.message?.content || "**vJetstar pilot application**");
    const updatedContent = `${oldContent}\n\n**Decision: ${decisionLabel.toUpperCase()}**`;
    const disabledComponents = (interaction.message?.components || []).map(row => ({
      type: 1,
      components: (row.components || []).map(button => ({
        type: 2,
        style: button.style,
        label: button.label,
        custom_id: button.custom_id,
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
  } catch {
    return json({ type: 4, data: { content: "An error occurred while sending the decision. Please try again.", flags: 64 } });
  }
}
