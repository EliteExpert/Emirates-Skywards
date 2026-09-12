# Emirates Skywards Discord Bot

A Node.js Discord bot for Emirates PTFS that provides Skywards accounts, tier visuals, flight cards, event interest tracking, automatic event-mile awards, and a miles shop.

The tier artwork supplied for this project is stored in `assets/tiers/` and is used in account cards:

- `Blue.png`
- `Silver.png`
- `Gold.png`
- `Platinum.png`

## Features

- `/account create` creates a member account with a generated Skywards number.
- `/account view` shows the account card, balance, tier artwork, status multiplier, and owned perks.
- `/account inventory` shows purchased perks.
- `/account set-tier` lets staff update a member's tier.
- `/account add-miles` lets staff grant miles.
- `/event list` lists recent flights and events, including native Discord scheduled events created by anyone.
- `/miles flight` reads the interested members for the supplied event ID and awards each attendee personalized miles.
- `/shop` displays interactive purchase buttons for PTFS perks.

## Award calculation

Event awards use:

`base event miles × travel-class multiplier × Skywards-tier multiplier`

Travel-class multipliers:

| Class | Multiplier |
| --- | ---: |
| Economy | 1.00× |
| Premium Economy | 1.25× |
| Business | 2.00× |
| First | 3.00× |

Skywards-tier multipliers:

| Tier | Multiplier |
| --- | ---: |
| Blue | 1.00× |
| Silver | 1.00× |
| Gold | 1.30× |
| Platinum | 1.75× |

For native Discord scheduled events, `/miles flight` uses **1,000 base miles** unless another value is supplied. The attendee's Economy, Business, or First role determines their cabin multiplier; without one of those roles, the command's optional fallback class is used. The Blue, Silver, Gold, or Platinum role determines the tier multiplier, falling back to the saved account tier when no tier role is present. This keeps the event awards aligned with the shop prices, which range from **2,000** to **8,000 miles**.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the `applications.commands` scope when inviting the bot to your server.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
4. Optionally set `TEST_GUILD_ID` to sync commands instantly to one development server. Without it, commands sync globally and may take time to appear.
5. Install and run with Node.js 20 or newer:

```powershell
npm install
npm start
```

The bot uses PostgreSQL through `DATABASE_URL`, so accounts, event registrations, purchases, and award history survive redeployments. Discord interactions are acknowledged before database or scheduled-event lookups begin, which prevents long-running lookups from expiring the interaction.

## Railpack / Railway

The repository includes `railpack.json`, which starts the worker with `npm start`, and `package.json`, which Railpack uses to install the Node.js dependencies.
Add `DISCORD_TOKEN` and `DATABASE_URL` to the service variables before deploying. In Railway, add a PostgreSQL service and link its `DATABASE_URL` to the bot service. `TEST_GUILD_ID` is optional and is useful for immediate command sync during development.

The bot reads native Discord scheduled events created by other users. Enable the **Guild Scheduled Events Intent** for the bot in the Discord Developer Portal so it can read event subscribers. The JavaScript version does not request Message Content or the privileged Server Members gateway intent.

## Staff workflow

1. A member runs `/account create`.
2. Members use Discord's native **Interested** control on a flight or event. Native Discord events created by any member are discoverable through `/event list`.
3. Staff run `/miles flight event_id` to preview the role-based awards, then run it again with `confirm:True` once the event is complete. For native Discord events, the base award defaults to 1,000 miles.
