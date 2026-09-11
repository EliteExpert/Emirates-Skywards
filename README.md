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
| Silver | 1.25× |
| Gold | 1.50× |
| Platinum | 2.00× |

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

The SQLite database is created at `data/skywards.sqlite3` by default.

## Staff workflow

1. A member runs `/account create`.
2. A staff member posts an event with `/event create`.
3. Members click **I'm Interested** and select their travel class.
4. Staff use `/event interested event_id` to review registrations.
5. Staff run `/event award event_id confirm:True` once the event is complete.

