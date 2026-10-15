export async function onRequestGet({ request, env }) {
  if (!env.DISCORD_BOT_TOKEN) {
    return Response.json({ error: "Discord lookup is not configured." }, { status: 503 });
  }

  const url = new URL(request.url);
  const username = (url.searchParams.get("username") || "").trim().toLowerCase();

  // Accept either a username (letters/numbers/dots/underscores/hyphens) or a numeric ID
  const isId = /^[0-9]{17,20}$/.test(username);
  const isUsername = /^[a-z0-9._]{2,32}$/.test(username);

  if (!isId && !isUsername) {
    return Response.json({ error: "Enter a valid Discord username or user ID." }, { status: 400 });
  }

  try {
    let user;

    if (isId) {
      // Direct ID lookup
      const response = await fetch(`https://discord.com/api/v10/users/${username}`, {
        headers: {
          Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
          "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
        }
      });
      if (response.status === 404) {
        return Response.json({ error: "No Discord account found for that ID." }, { status: 404 });
      }
      if (!response.ok) {
        return Response.json({ error: "Discord could not verify that account. Try again shortly." }, { status: 502 });
      }
      user = await response.json();
    } else {
      // Username lookup via guild member search or global username lookup
      // Discord doesn't have a public username→ID API without being in a mutual server,
      // so we use the /users/@me/channels trick: try to open a DM by username search.
      // Best available: search guild members if DISCORD_GUILD_ID is set, otherwise instruct user to use ID.
      if (!env.DISCORD_GUILD_ID) {
        return Response.json({
          error: "Username lookup requires a server to search. Please enter your numeric Discord user ID instead, or ask an admin to configure DISCORD_GUILD_ID."
        }, { status: 400 });
      }

      // Search guild members by username
      const searchResp = await fetch(
        `https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/members/search?query=${encodeURIComponent(username)}&limit=5`,
        {
          headers: {
            Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
            "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
          }
        }
      );

      if (!searchResp.ok) {
        return Response.json({ error: "Username search failed. Try again or use your user ID." }, { status: 502 });
      }

      const members = await searchResp.json();
      // Find exact username match (Discord usernames are unique and lowercase)
      const match = members.find(m =>
        m.user.username.toLowerCase() === username ||
        (m.user.global_name || "").toLowerCase() === username
      );

      if (!match) {
        return Response.json({
          error: "No Discord account found with that username in the server. Make sure you've joined the vJetstar Discord server, or enter your numeric user ID."
        }, { status: 404 });
      }

      user = match.user;
    }

    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith("a_") ? "gif" : "png"}?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(user.id) >> 22n) % 6n)}.png`;

    return Response.json({
      id: user.id,
      username: user.username,
      globalName: user.global_name || user.username,
      avatar
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Discord account lookup failed. Please try again." }, { status: 502 });
  }
}
