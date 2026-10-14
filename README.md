# vJetstar Pilot Application

A responsive vJetstar-styled application form for Cloudflare Pages, with Discord account preview and application notifications sent to your Discord DMs.

## Files

- `index.html` — application page
- `styles.css` — orange/white/black styling
- `app.js` — client-side validation and Discord preview
- `functions/api/discord-user.js` — server-side Discord account lookup
- `functions/api/apply.js` — sends applications to your Discord DMs

## Deploy to GitHub + Cloudflare Pages

1. Create a GitHub repository and upload all these files, preserving the `functions/api/` folders.
2. In Cloudflare, open **Workers & Pages → Create → Pages → Connect to Git** and select the repository.
3. For a Git-connected Pages project, use no build command and set the build output directory to `.` (the repository root). Keep `functions/api/discord-user.js`, `functions/api/apply.js`, and `functions/api/discord-interactions.js` inside the `functions/` directory. Do not set the build output directory to `public` or another folder that excludes `functions/`.

   For a direct Wrangler deployment, open a terminal in the `vjetstar-pilot-application` folder (the folder containing `index.html` and `functions/`) and run:

   ```bat
   npx wrangler pages deploy . --project-name jetstar-fs-apply --branch main
   ```
4. In the Pages project's **Settings → Variables and Secrets**, add:
   - `DISCORD_BOT_TOKEN` as an encrypted secret
   - `DISCORD_USER_ID` as a variable containing your numeric Discord user ID
5. Deploy or trigger a new deployment after adding the settings.

Do not put the bot token in `app.js`, `index.html`, or any other public file.

## Discord setup

Create a bot in the Discord Developer Portal, copy its bot token into the Cloudflare secret, and keep the token private. Copy your own Discord user ID into `DISCORD_USER_ID`. The bot must be able to use the Discord API and contact your account. Test the deployed form with a test application before sharing it publicly.

## Important limitations

- This form sends application details to you; it does not create pilot hub accounts.
- There is no password field and no password is collected.
- It does not yet provide the application approval / “send login details” button. That feature must be connected to your real pilot hub authentication backend to create working accounts and issue temporary credentials safely.
- The Discord account preview is a lookup by numeric user ID. The applicant should confirm the displayed avatar and name are theirs.
- Email addresses are sent to your Discord DM as part of the application. Treat the DM as personal information and keep access restricted.


## Accept/decline buttons in Discord

New application DMs include **Accept application** and **Decline application** buttons. Clicking one sends the applicant a direct message and disables the buttons after a successful delivery. Only the Discord user ID configured in `DISCORD_USER_ID` can make a decision.

### Extra setup required

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open the application belonging to your bot and go to **General Information**. Copy **Public Key**.
2. In Cloudflare Dashboard → **Workers & Pages** → `jetstar-fs-apply` → **Settings** → **Variables and Secrets**, add `DISCORD_PUBLIC_KEY` as a production variable. Paste the public key exactly as shown in Discord. Keep `DISCORD_BOT_TOKEN` as a secret.
3. In the Discord Developer Portal, set **Interactions Endpoint URL** to `https://jetstar-fs-apply.pages.dev/api/discord-interactions`. Discord will validate it; the endpoint supports Discord's signed PING verification.
4. Push the updated files to GitHub and deploy the `main` branch. From the project folder, run:

```bat
git add .
git commit -m "Add application decision buttons"
git push origin main
npx wrangler pages deploy . --project-name jetstar-fs-apply --branch main
```

If Discord will not save the endpoint URL, check that the latest deployment is live and `DISCORD_PUBLIC_KEY` is configured in the production environment. The bot must be able to DM applicants; if a user's privacy settings block DMs from the bot, the button will show an error instead of marking the application decided.
"# applicationforshittyjetstarairline" 
