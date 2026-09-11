from __future__ import annotations

import asyncio
import logging
import re
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from .config import (
    CLASS_MULTIPLIERS,
    Settings,
    TIER_DISPLAY_NAMES,
    TIER_MULTIPLIERS,
    TIER_NAMES,
    TIER_ROLE_LABELS,
    TRAVEL_CLASSES,
)
from .database import Database
from .embeds import (
    account_inventory_embed,
    account_message,
    award_preview_embed,
    event_embed,
    shop_embed,
)
from .views import AccountView, EventInterestView, ShopView

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("skywards")


class SkywardsBot(commands.Bot):
    def __init__(self, settings: Settings):
        super().__init__(command_prefix="!", intents=discord.Intents.default())
        self.settings = settings
        self.db = Database(settings.database_path)
        self.synced = False

    async def setup_hook(self) -> None:
        await self.db.connect()
        self.add_view(AccountView(self.db))
        self.add_view(ShopView(self.db))
        for event in await self.db.list_events_with_messages():
            self.add_view(EventInterestView(self.db, event["id"]))

        if self.settings.test_guild_id:
            guild = discord.Object(id=self.settings.test_guild_id)
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
            logger.info("Slash commands synced to test guild %s", self.settings.test_guild_id)
        else:
            await self.tree.sync()
            logger.info("Global slash commands synced")
        self.synced = True

    async def close(self) -> None:
        await self.db.close()
        await super().close()


settings = Settings.from_environment()
bot = SkywardsBot(settings)

account_group = app_commands.Group(name="account", description="Create and manage Skywards accounts")
event_group = app_commands.Group(name="event", description="Create and manage PTFS events")


def parse_event_id(value: str) -> int | None:
    """Accept a numeric ID copied from an event card or event list."""
    cleaned = value.strip().strip("`")
    match = re.match(r"^(?:event[\s_-]*)?#?(\d+)\b", cleaned, re.IGNORECASE)
    return int(match.group(1)) if match else None


@account_group.command(name="create", description="Create your Emirates Skywards account")
@app_commands.guild_only()
async def account_create(interaction: discord.Interaction) -> None:
    existing = await bot.db.get_account(interaction.user.id)
    if existing:
        await interaction.response.send_message(
            f"You already have a Skywards account: `{existing['skywards_number']}`.",
            ephemeral=True,
        )
        return
    account = await bot.db.create_account(interaction.user.id, interaction.user.display_name)
    embed, file = account_message(account, [])
    await interaction.response.send_message(embed=embed, file=file, view=AccountView(bot.db))


@account_group.command(name="view", description="View a Skywards account")
@app_commands.guild_only()
async def account_view(interaction: discord.Interaction, member: Optional[discord.Member] = None) -> None:
    target = member or interaction.user
    account = await bot.db.get_account(target.id)
    if account is None:
        owner_text = "That member does not have" if member else "You do not have"
        await interaction.response.send_message(
            f"{owner_text} a Skywards account yet. Use `/account create` first.",
            ephemeral=True,
        )
        return
    embed, file = account_message(account, await bot.db.get_inventory(target.id))
    await interaction.response.send_message(embed=embed, file=file, view=AccountView(bot.db))


@account_group.command(name="inventory", description="View your purchased Skywards perks")
@app_commands.guild_only()
async def account_inventory(interaction: discord.Interaction) -> None:
    account = await bot.db.get_account(interaction.user.id)
    if account is None:
        await interaction.response.send_message(
            "You do not have a Skywards account yet. Use `/account create` first.",
            ephemeral=True,
        )
        return
    await interaction.response.send_message(
        embed=account_inventory_embed(account, await bot.db.get_inventory(interaction.user.id)),
    )


@account_group.command(name="set-tier", description="Set a member's Skywards tier")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.choices(
    tier=[
        app_commands.Choice(
            name=f"{TIER_DISPLAY_NAMES[tier]} ({TIER_ROLE_LABELS[tier]})",
            value=tier,
        )
        for tier in TIER_NAMES
    ]
)
async def account_set_tier(
    interaction: discord.Interaction,
    member: discord.Member,
    tier: app_commands.Choice[str],
) -> None:
    account = await bot.db.get_account(member.id)
    if account is None:
        await interaction.response.send_message(
            "That member needs to create an account before their tier can be changed.",
            ephemeral=True,
        )
        return
    await bot.db.update_tier(member.id, tier.value)
    await interaction.response.send_message(
        f"**{member.display_name}** is now a **{TIER_DISPLAY_NAMES[tier.value]}** member "
        f"(`{TIER_ROLE_LABELS[tier.value]}`).",
        ephemeral=True,
    )


@account_group.command(name="add-miles", description="Grant miles to a member")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
async def account_add_miles(
    interaction: discord.Interaction,
    member: discord.Member,
    miles: app_commands.Range[int, 1, 1_000_000],
) -> None:
    account = await bot.db.get_account(member.id)
    if account is None:
        await interaction.response.send_message(
            "That member needs to create an account before receiving miles.",
            ephemeral=True,
        )
        return
    await bot.db.add_miles(member.id, miles)
    await interaction.response.send_message(
        f"Granted **{miles:,} miles** to **{member.display_name}**.",
        ephemeral=True,
    )


@event_group.command(name="create", description="Post an event with an interest button")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
async def event_create(
    interaction: discord.Interaction,
    name: app_commands.Range[str, 1, 80],
    description: app_commands.Range[str, 1, 500],
    base_miles: app_commands.Range[int, 1, 1_000_000],
    event_date: Optional[app_commands.Range[str, 1, 80]] = None,
) -> None:
    event = await bot.db.create_event(
        guild_id=interaction.guild_id or 0,
        channel_id=interaction.channel_id,
        name=name,
        description=description,
        base_miles=base_miles,
        event_date=event_date,
        created_by=interaction.user.id,
    )
    await interaction.response.send_message(
        embed=event_embed(event, 0),
        view=EventInterestView(bot.db, event["id"]),
    )
    original = await interaction.original_response()
    await bot.db.set_event_message_id(event["id"], original.id)


@event_group.command(name="list", description="List recent PTFS events")
@app_commands.guild_only()
async def event_list(interaction: discord.Interaction) -> None:
    events = [event for event in await bot.db.list_events_with_messages() if event["guild_id"] == interaction.guild_id]
    if not events:
        await interaction.response.send_message("No events have been created in this server yet.", ephemeral=True)
        return
    embed = discord.Embed(
        title="Emirates PTFS Events",
        description="Use the event ID with `/event interested` or `/event award`.",
        colour=0x315B9A,
    )
    for event in events[-20:]:
        count = await bot.db.count_interest(event["id"])
        status = "Awarded" if event["awarded_at"] else f"{count} interested"
        embed.add_field(name=f"{event['id']} — {event['name']}", value=status, inline=False)
    await interaction.response.send_message(embed=embed, ephemeral=True)


@event_group.command(name="interested", description="View members interested in an event")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
async def event_interested(interaction: discord.Interaction, event_id: str) -> None:
    parsed_event_id = parse_event_id(event_id)
    if parsed_event_id is None:
        await interaction.response.send_message(
            "Enter the numeric event ID shown by `/event list`, for example `1` or `#1`.",
            ephemeral=True,
        )
        return
    event = await bot.db.get_event(parsed_event_id)
    if event is None or event["guild_id"] != interaction.guild_id:
        await interaction.response.send_message("No event with that ID exists in this server.", ephemeral=True)
        return
    rows = await bot.db.list_interest(parsed_event_id)
    if not rows:
        await interaction.response.send_message(
            f"No one has clicked interested for **{event['name']}** yet.", ephemeral=True
        )
        return
    await interaction.response.send_message(embed=award_preview_embed(event, rows), ephemeral=True)


@event_group.command(name="award", description="Award event miles using class and status multipliers")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
async def event_award(
    interaction: discord.Interaction,
    event_id: str,
    confirm: bool = False,
) -> None:
    parsed_event_id = parse_event_id(event_id)
    if parsed_event_id is None:
        await interaction.response.send_message(
            "Enter the numeric event ID shown by `/event list`, for example `1` or `#1`.",
            ephemeral=True,
        )
        return
    event = await bot.db.get_event(parsed_event_id)
    if event is None or event["guild_id"] != interaction.guild_id:
        await interaction.response.send_message("No event with that ID exists in this server.", ephemeral=True)
        return
    rows = await bot.db.list_interest(parsed_event_id)
    if not rows:
        await interaction.response.send_message("There are no interested members to award.", ephemeral=True)
        return
    if not confirm:
        await interaction.response.send_message(
            embed=award_preview_embed(event, rows),
            content="Set `confirm` to **True** to apply these awards. This can only be done once per event.",
            ephemeral=True,
        )
        return
    result = await bot.db.award_event(parsed_event_id, CLASS_MULTIPLIERS, TIER_MULTIPLIERS)
    if result["status"] == "already_awarded":
        await interaction.response.send_message("Miles for this event have already been awarded.", ephemeral=True)
        return
    total = sum(item["miles"] for item in result["awards"])
    await interaction.response.send_message(
        f"**Awards complete.** Granted **{total:,} miles** across **{len(result['awards'])}** passenger(s).",
        ephemeral=True,
    )


@bot.tree.command(name="shop", description="Browse and buy Skywards perks")
@app_commands.guild_only()
async def shop(interaction: discord.Interaction) -> None:
    await interaction.response.send_message(embed=shop_embed(), view=ShopView(bot.db), ephemeral=True)


bot.tree.add_command(account_group)
bot.tree.add_command(event_group)


@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
    if isinstance(error, app_commands.MissingPermissions):
        message = "You need the **Manage Server** permission to use that command."
    elif isinstance(error, app_commands.CommandOnCooldown):
        message = "Please wait before using that command again."
    else:
        logger.error(
            "Unhandled application command error",
            exc_info=(type(error), error, error.__traceback__),
        )
        message = "Something went wrong while processing that command. Check the bot logs for details."
    if interaction.response.is_done():
        await interaction.followup.send(message, ephemeral=True)
    else:
        await interaction.response.send_message(message, ephemeral=True)


async def run_bot() -> None:
    if not settings.token:
        raise RuntimeError("DISCORD_TOKEN is missing. Copy .env.example to .env and add your bot token.")
    async with bot:
        await bot.start(settings.token)


def run() -> None:
    asyncio.run(run_bot())


if __name__ == "__main__":
    run()
