from __future__ import annotations

from pathlib import Path
from typing import Any

import discord

from .config import (
    CLASS_MULTIPLIERS,
    SHOP_ITEMS,
    TIER_ASSETS,
    TIER_BENEFITS,
    TIER_COLORS,
    TIER_DISPLAY_NAMES,
    TIER_MINIMUM_MILES,
    TIER_MULTIPLIERS,
    TIER_ROLE_LABELS,
)


def number(value: int) -> str:
    return f"{value:,}"


def account_message(
    account: dict[str, Any], inventory: list[dict[str, Any]]
) -> tuple[discord.Embed, discord.File]:
    tier = account["tier"]
    filename = Path(TIER_ASSETS[tier]).name
    embed = discord.Embed(
        title=f"Emirates Skywards Account — {account['display_name']}",
        description=(
            '> “Every journey starts with a destination.”\n\n'
            f"**{TIER_DISPLAY_NAMES[tier]}** member · {TIER_ROLE_LABELS[tier]}\n"
            "*Your Skywards profile at a glance.*"
        ),
        colour=TIER_COLORS[tier],
    )
    embed.set_thumbnail(url=f"attachment://{filename}")
    embed.add_field(name="Skywards number", value=f"`{account['skywards_number']}`", inline=True)
    embed.add_field(name="Available miles", value=f"**{number(account['miles'])}**", inline=True)
    embed.add_field(
        name="Tier threshold",
        value=f"{number(TIER_MINIMUM_MILES[tier])} miles",
        inline=True,
    )
    embed.add_field(
        name="Status bonus",
        value=f"{TIER_MULTIPLIERS[tier]:.2f}× event multiplier",
        inline=True,
    )
    embed.add_field(
        name=f"{TIER_DISPLAY_NAMES[tier]} benefits",
        value="\n".join(f"• {benefit}" for benefit in TIER_BENEFITS[tier]),
        inline=False,
    )
    if inventory:
        owned = "\n".join(
            f"{item['product_id'].replace('_', ' ').title()} × {item['quantity']}" for item in inventory
        )
    else:
        owned = "*No perks owned yet.*"
    embed.add_field(name="Your perks", value=owned, inline=False)
    embed.set_footer(text="Emirates PTFS • Skywards")
    return embed, discord.File(str(TIER_ASSETS[tier]), filename=filename)


def account_inventory_embed(account: dict[str, Any], inventory: list[dict[str, Any]]) -> discord.Embed:
    embed = discord.Embed(
        title=f"Perks — {account['display_name']}",
        description='> “A little extra makes every journey better.”',
        colour=TIER_COLORS[account["tier"]],
    )
    embed.add_field(
        name="Skywards tier",
        value=f"**{TIER_DISPLAY_NAMES[account['tier']]}** · {TIER_ROLE_LABELS[account['tier']]}",
        inline=False,
    )
    if inventory:
        for item in inventory:
            embed.add_field(
                name=item["product_id"].replace("_", " ").title(),
                value=f"Quantity: **{item['quantity']}**",
                inline=True,
            )
    else:
        embed.description += "\n\n*You have not purchased any perks yet.*"
    embed.set_footer(text="Use /shop to browse available perks.")
    return embed


def shop_embed() -> discord.Embed:
    embed = discord.Embed(
        title="Emirates Skywards Shop",
        description=(
            '> “Make your miles work harder.”\n\n'
            "Use the buttons below to exchange miles for PTFS perks."
        ),
        colour=0x1F2937,
    )
    for product in SHOP_ITEMS.values():
        embed.add_field(
            name=f"{product['name']} — {number(product['price'])} miles",
            value=product["description"],
            inline=False,
        )
    embed.set_footer(text="Purchases are added to your Skywards account inventory.")
    return embed


def event_embed(event: dict[str, Any], interested_count: int) -> discord.Embed:
    embed = discord.Embed(
        title=f"Emirates PTFS Event — {event['name']}",
        description=f"> “{event['description']}”",
        colour=0x315B9A,
    )
    embed.add_field(name="Base miles", value=f"**{number(event['base_miles'])}**", inline=True)
    embed.add_field(name="Interested", value=f"**{interested_count}**", inline=True)
    embed.add_field(name="Event ID", value=f"`{event['id']}`", inline=True)
    if event["event_date"]:
        embed.add_field(name="Date", value=event["event_date"], inline=False)
    if event["awarded_at"]:
        embed.set_footer(text="Miles have already been awarded for this event.")
    else:
        embed.set_footer(text="Click I'm Interested, then choose your travel class.")
    return embed


def award_preview_embed(event: dict[str, Any], rows: list[dict[str, Any]]) -> discord.Embed:
    embed = discord.Embed(
        title=f"Interested passengers — {event['name']}",
        description=(
            f"**{len(rows)}** passenger(s) are registered.\n"
            f"Base miles: **{number(event['base_miles'])}** per passenger before multipliers."
        ),
        colour=0x315B9A,
    )
    for index, row in enumerate(rows[:25], start=1):
        calculated = round(
            event["base_miles"]
            * CLASS_MULTIPLIERS[row["travel_class"]]
            * TIER_MULTIPLIERS[row["tier"]]
        )
        embed.add_field(
            name=f"{index}. {row['display_name']}",
            value=(
                f"Class: **{row['travel_class']}**\n"
                f"Status: **{TIER_DISPLAY_NAMES[row['tier']]}** ({TIER_ROLE_LABELS[row['tier']]})\n"
                f"Projected award: **{number(calculated)} miles**"
            ),
            inline=False,
        )
    if len(rows) > 25:
        embed.set_footer(text=f"Showing the first 25 of {len(rows)} passengers.")
    return embed


def scheduled_event_preview_embed(
    event: discord.ScheduledEvent,
    rows: list[dict[str, Any]],
    base_miles: int | None = None,
) -> discord.Embed:
    description = event.description or "No description was provided for this Discord event."
    embed = discord.Embed(
        title=f"Discord event attendees — {event.name}",
        description=(
            f"> “{description}”\n\n"
            f"Event ID: `{event.id}`\n"
            f"Discord interest count: **{event.user_count or len(rows)}**"
        ),
        colour=0x315B9A,
    )
    for index, row in enumerate(rows[:25], start=1):
        if row["tier"]:
            status = f"{TIER_DISPLAY_NAMES[row['tier']]} ({TIER_ROLE_LABELS[row['tier']]})"
        else:
            status = "No Skywards account"
        lines = [
            f"User ID: `{row['user_id']}`",
            f"Class: **{row.get('travel_class', 'Economy')}**",
            f"Status: **{status}**",
        ]
        if base_miles is not None and row["tier"]:
            travel_class = str(row.get("travel_class") or "Economy")
            calculated = round(
                base_miles
                * CLASS_MULTIPLIERS[travel_class]
                * TIER_MULTIPLIERS[row["tier"]]
            )
            lines.append(f"Projected award: **{number(calculated)} miles**")
        embed.add_field(name=f"{index}. {row['display_name']}", value="\n".join(lines), inline=False)
    if len(rows) > 25:
        embed.set_footer(text=f"Showing the first 25 of {len(rows)} attendees.")
    return embed
