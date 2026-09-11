# Emirates Skywards Discord Bot

A Discord bot for Emirates PTFS that provides Skywards accounts, tier visuals, event interest tracking, automatic event-mile awards, and a miles shop.

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
- `/event create` posts an event with an **I'm Interested** button. Members choose Economy, Premium Economy, Business, or First after clicking it.
- `/event interested` shows the people registered for an event, their class, tier, and projected award.
- `/event award` calculates and grants miles once per event using both travel class and Skywards tier.
- `/event list` lists recent event IDs and interest counts.
- `/miles flight` grants miles to one member for a completed flight and records the flight reference.
- `/miles event` reads the interested members of a bot-created event or native Discord scheduled event, then grants each attendee a personalized award.
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

For native Discord scheduled events, `/miles event` uses **1,000 base miles** unless another value is supplied. The attendee's Economy, Business, or First role determines their cabin multiplier; without one of those roles, the command's optional fallback class is used. The Blue, Silver, Gold, or Platinum role determines the tier multiplier, falling back to the saved account tier when no tier role is present. This keeps the event awards aligned with the shop prices, which range from **2,000** to **8,000 miles**.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable the `applications.commands` scope when inviting the bot to your server.
3. Copy `.env.example` to `.env` and set `DISCORD_TOKEN`.
4. Optionally set `TEST_GUILD_ID` to sync commands instantly to one development server. Without it, commands sync globally and may take time to appear.
5. Install and run:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
python -m bot.main
```

The bot uses PostgreSQL through `DATABASE_URL`, so accounts, event registrations, purchases, and award history survive redeployments.

## Railpack / Railway

The repository includes `railpack.json`, which starts the worker with `python -m bot.main`, and `requirements.txt`, which Railpack uses to install the bot dependencies.
Add `DISCORD_TOKEN` and `DATABASE_URL` to the service variables before deploying. In Railway, add a PostgreSQL service and link its `DATABASE_URL` to the bot service. `TEST_GUILD_ID` is optional and is useful for immediate command sync during development.

The bot also reads native Discord scheduled events created by other users. Enable the **Server Members Intent** and **Guild Scheduled Events Intent** for the bot in the Discord Developer Portal so it can read event subscribers.

## Staff workflow

1. A member runs `/account create`.
2. A staff member posts an event with `/event create`.
3. Members click **I'm Interested** and select their travel class.
4. Staff use `/event interested event_id` to review registrations from either bot events or native Discord scheduled events.
5. Staff run `/miles event event_id` to preview the role-based awards, then run it again with `confirm:True` once the event is complete. For native Discord events, the base award defaults to 1,000 miles.
