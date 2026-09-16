# Emirates Skywards Discord Bot

A Node.js Discord bot for Emirates PTFS that provides Skywards accounts, tier visuals, flight cards, event interest tracking, automatic event-mile awards, and a miles shop.

The tier artwork supplied for this project is stored in `assets/tiers/` and is used in account cards:

- `Blue.png`
- `Silver.png`
- `Gold.png`
- `Platinum.png`

## Features

- `/account create` creates a member account with a generated Skywards number and assigns the Discord role for the starting tier (Blue).
- `/account view` shows the account card, balance, tier artwork, status bonus, and owned perks.
- `/account inventory` re-checks the member's tier roles first, syncs the stored tier, then shows purchased perks.
- `/account set-tier` lets staff update a member's tier; the matching tier role is applied to the member automatically.
- `/account add-miles` lets staff grant miles.
- `/flights-list` lists recent flights and events, including native Discord scheduled events created by anyone.
- `/flight-awards` reads the interested members for the supplied flight or event ID and awards each attendee personalized miles.
- `/shop` displays interactive purchase buttons for PTFS perks publicly.

Each shop item has an independent **48-hour cooldown per member**. The shop shows the remaining time and disables an item until it becomes available again.

## Tiers and upgrades

Upgrading to a higher tier **spends miles**, which are deducted from the member's available balance:

| Tier | Upgrade cost |
| --- | ---: |
| Blue | Starting tier |
| Silver | 1,500 miles |
| Gold | 3,500 miles |
| Platinum | 7,000 miles |

The account dashboard's **Upgrade** button deducts the next tier's cost from the member's available miles and advances them one tier; the button stays disabled until they can afford it and the purchase is re-verified server-side inside a transaction. Staff can still set any tier directly with `/account set-tier`, which is free of charge.

The bot keeps Discord roles and stored tiers in sync: the starting tier role is granted when the account is created, tier changes (upgrade or staff set-tier) reapply the correct role and remove stale tier roles, and `/account inventory` and `/account view` re-check the member's tier roles before displaying anything. For flight awards, a member's tier roles take priority over the stored tier, falling back to the stored tier when no tier role is present.

Administrative commands (`/account set-tier`, `/account add-miles`, and `/flight-awards`) require the Discord **Administrator** permission or one of these staff roles: `<@&1416276747246244013>`, `<@&1464239438183010469>`, or `<@&1473279339817730170>`.

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

Official Emirates Skywards status bonuses:

| Tier | Status bonus | Total award multiplier |
| --- | ---: | ---: |
| Blue | +0% | 1.00× |
| Silver | +30% | 1.30× |
| Gold | +75% | 1.75× |
| Platinum | +100% | 2.00× |

For native Discord scheduled events, `/flight-awards` uses **1,000 base miles** unless another value is supplied. The attendee's Economy, Business, or First role determines their PTFS cabin multiplier; without one of those roles, the command's optional fallback class is used. The Blue, Silver, Gold, or Platinum role determines the tier multiplier, falling back to the saved account tier when no tier role is present. This keeps the flight awards aligned with the shop prices, which range from **2,000** to **8,000 miles**.

Emirates calculates the base flight miles using the route, fare type, and cabin. The status bonuses above are the official Emirates bonuses; the cabin multipliers in this bot are PTFS gameplay settings rather than universal real-world Emirates values.

Reference: [Emirates Earn Miles](https://www.emirates.com/us/english/skywards/earn-miles/) and [Emirates Skywards Programme Rules](https://www.emirates.com/english/skywards/emirates-skywards-programme-rules/).

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the `applications.commands` scope when inviting the bot to your server, and grant it the **Manage Roles** permission. Position the bot's role **above** the Skywards tier roles so it can grant and remove them; otherwise tier role sync fails gracefully and the bot logs a warning.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
4. Optionally set `TEST_GUILD_ID` to sync commands instantly to one development server. In test-guild mode, commands are guild-only and old global copies are cleared to prevent duplicate command entries. Without it, commands sync globally and may take time to appear.
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

1. A member runs `/account create`; the bot creates the account and grants the Blue tier role.
2. Members use Discord's native **Interested** control on a flight or event. Native Discord events created by any member are discoverable through `/flights-list`.
3. Staff run `/flight-awards event_id` to preview the role-based awards, then run it again with `confirm:True` once the flight or event is complete. For native Discord events, the base award defaults to 1,000 miles.
