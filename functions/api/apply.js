export async function onRequestPost({ request, env }) {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_USER_ID) {
    return Response.json({ error: "Application delivery is not configured." }, { status: 503 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid submission." }, { status: 400 });
  }

  // Hidden-field spam trap.
  if (body.website) return Response.json({ ok: true });

  const username = String(body.username || "").trim();
  const discordId = String(body.discordId || "").trim();
  const email = String(body.email || "").trim();
  const cid = body.noVatsim
    ? "Does not have a VATSIM CID yet"
    : String(body.cid || "").trim();

  const allowedAircraft = ["A320", "A320neo", "A321", "B787-8"];
  const aircraft = Array.isArray(body.aircraft)
    ? [...new Set(body.aircraft.map(String).filter(x => allowedAircraft.includes(x)))]
    : [];

  if (
    username.length < 3 || username.length > 32 ||
    !/^[0-9]{17,20}$/.test(discordId) ||
    email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    (!body.noVatsim && !/^[0-9]{1,12}$/.test(cid)) ||
    !aircraft.length
  ) {
    return Response.json({ error: "Check your details and select at least one aircraft." }, { status: 400 });
  }

  try {
    // Re-verify the Discord ID server-side; do not trust browser-submitted profile data.
    const lookup = await fetch(`https://discord.com/api/v10/users/${discordId}`, {
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
      }
    });

    if (!lookup.ok) {
      return Response.json({ error: "Could not verify that Discord account." }, { status: 400 });
    }

    const user = await lookup.json();
    const escapeDiscord = value =>
      String(value).replace(/[`@*_~|>]/g, "\\$&").slice(0, 500);

    const message = [
      "**New vJetstar pilot application**",
      "",
      `**Pilot hub username:** ${escapeDiscord(username)}`,
      `**Discord account:** ${escapeDiscord(user.global_name || user.username)} (@${escapeDiscord(user.username)})`,
      `**Discord user ID:** ${user.id}`,
      `**VATSIM CID:** ${escapeDiscord(cid)}`,
      `**Preferred aircraft:** ${aircraft.map(escapeDiscord).join(", ")}`,
      `**Email:** ${escapeDiscord(email)}`,
      "",
      "_No password was requested or stored._"
    ].join("\n");

    const headers = {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
    };

    const dmResponse = await fetch("https://discord.com/api/v10/users/@me/channels", {
      method: "POST",
      headers,
      body: JSON.stringify({ recipient_id: String(env.DISCORD_USER_ID) })
    });

    if (!dmResponse.ok) {
      return Response.json({
        error: "Could not open your Discord DM. Check the bot token, your user ID, and whether the bot can contact you."
      }, { status: 502 });
    }

    const dm = await dmResponse.json();
    const sent = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: message,
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: "Accept application", custom_id: `vjetstar:accept:${discordId}` },
            { type: 2, style: 4, label: "Decline application", custom_id: `vjetstar:decline:${discordId}` }
          ]
        }],
        allowed_mentions: { parse: [] }
      })
    });

    if (!sent.ok) {
      return Response.json({ error: "Discord could not deliver the application." }, { status: 502 });
    }

    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "A delivery error occurred. Please try again later." }, { status: 502 });
  }
}
