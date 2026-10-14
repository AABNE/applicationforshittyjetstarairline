export async function onRequestGet({ request, env }) {
  if (!env.DISCORD_BOT_TOKEN) {
    return Response.json({ error: "Discord lookup is not configured." }, { status: 503 });
  }

  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9]{17,20}$/.test(id)) {
    return Response.json({ error: "Enter a valid Discord user ID." }, { status: 400 });
  }

  try {
    const response = await fetch(`https://discord.com/api/v10/users/${id}`, {
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "User-Agent": "vJetstarPilotApplications (Cloudflare Pages)"
      }
    });

    if (response.status === 404) {
      return Response.json({ error: "No Discord account was found for that ID." }, { status: 404 });
    }
    if (!response.ok) {
      return Response.json({ error: "Discord could not verify that account. Try again shortly." }, { status: 502 });
    }

    const user = await response.json();
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
