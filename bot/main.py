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
    DEFAULT_EVENT_BASE_MILES,
    Settings,
    TIER_DISPLAY_NAMES,
    TIER_MULTIPLIERS,
    TIER_NAMES,
    TIER_ROLE_IDS,
    TIER_ROLE_LABELS,
    TRAVEL_CLASSES,
    TRAVEL_CLASS_ROLE_IDS,
)
from .database import Database
from .embeds import (
    account_inventory_embed,
    account_message,
    award_preview_embed,
    event_embed,
    shop_embed,
    scheduled_event_preview_embed,
)
from .views import AccountView, EventInterestView, ShopView

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("skywards")


class SkywardsBot(commands.Bot):
    def __init__(self, settings: Settings):
        intents = discord.Intents.default()
        intents.members = True
        intents.guild_scheduled_events = True
        super().__init__(command_prefix="!", intents=intents)
        self.settings = settings
        self.db = Database(settings.database_url)
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
miles_group = app_commands.Group(name="miles", description="Award Skywards miles for flights and events")


def parse_event_id(value: str) -> int | None:
    """Accept a numeric ID copied from an event card or event list."""
    cleaned = value.strip().strip("`")
    match = re.match(r"^(?:event[\s_-]*)?#?(\d+)\b", cleaned, re.IGNORECASE)
    return int(match.group(1)) if match else None


async def fetch_discord_event(guild: discord.Guild, event_id: int) -> discord.ScheduledEvent | None:
    try:
        return await guild.fetch_scheduled_event(event_id, with_counts=True)
    except (discord.NotFound, discord.HTTPException):
        return None


def resolve_travel_class(role_ids: set[int], fallback: str = "Economy") -> str:
    """Use the highest cabin role present, falling back to the event selection."""
    for travel_class in ("First", "Business", "Economy"):
        if TRAVEL_CLASS_ROLE_IDS[travel_class] in role_ids:
            return travel_class
    return fallback if fallback in TRAVEL_CLASSES else "Economy"


def resolve_tier(role_ids: set[int], fallback: str | None) -> str | None:
    """Use the highest Skywards role present, falling back to the saved account tier."""
    for tier in ("Platinum", "Gold", "Silver", "Blue"):
        if TIER_ROLE_IDS[tier] in role_ids:
            return tier
    return fallback


async def get_member_role_ids(guild: discord.Guild, user_id: int) -> set[int]:
    member = guild.get_member(user_id)
    if member is None:
        try:
            member = await guild.fetch_member(user_id)
        except (discord.Forbidden, discord.NotFound, discord.HTTPException):
            return set()
    return {role.id for role in member.roles}


async def apply_role_profiles(
    guild: discord.Guild, rows: list[dict[str, object]]
) -> tuple[dict[int, str], dict[int, str]]:
    """Apply current Discord class/tier roles while preserving account fallbacks."""
    class_overrides: dict[int, str] = {}
    tier_overrides: dict[int, str] = {}
    for row in rows:
        user_id = int(row["user_id"])
        role_ids = await get_member_role_ids(guild, user_id)
        row["travel_class"] = resolve_travel_class(
            role_ids, str(row.get("travel_class") or "Economy")
        )
        fallback_tier = str(row["tier"]) if row.get("tier") else None
        row["tier"] = resolve_tier(role_ids, fallback_tier)
        class_overrides[user_id] = str(row["travel_class"])
        if row["tier"]:
            tier_overrides[user_id] = str(row["tier"])
    return class_overrides, tier_overrides


async def fetch_discord_event_rows(
    guild: discord.Guild,
    event: discord.ScheduledEvent,
    fallback_class: str = "Economy",
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    async for user in event.users(limit=None):
        account = await bot.db.get_account(user.id)
        role_ids = await get_member_role_ids(guild, user.id)
        rows.append(
            {
                "user_id": user.id,
                "display_name": getattr(user, "display_name", user.name),
                "travel_class": resolve_travel_class(role_ids, fallback_class),
                "tier": resolve_tier(role_ids, account["tier"] if account else None),
            }
        )
    return rows


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
        f"({TIER_ROLE_LABELS[tier.value]}).",
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
    try:
        discord_events = await interaction.guild.fetch_scheduled_events(with_counts=True)
    except (discord.Forbidden, discord.HTTPException):
        discord_events = []
    if not events and not discord_events:
        await interaction.response.send_message("No events have been created in this server yet.", ephemeral=True)
        return
    embed = discord.Embed(
        title="Emirates PTFS Events",
        description="Use the event ID with `/event interested` or `/miles event`.",
        colour=0x315B9A,
    )
    for event in events[-20:]:
        count = await bot.db.count_interest(event["id"])
        status = "Awarded" if event["awarded_at"] else f"{count} interested"
        embed.add_field(name=f"{event['id']} — {event['name']}", value=status, inline=False)
    for event in discord_events[-20:]:
        embed.add_field(
            name=f"{event.id} — {event.name}",
            value=f"{event.user_count or 0} interested · Discord scheduled event",
            inline=False,
        )
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
    if event is not None and event["guild_id"] == interaction.guild_id:
        rows = await bot.db.list_interest(parsed_event_id)
        if not rows:
            await interaction.response.send_message(
                f"No one has clicked interested for **{event['name']}** yet.", ephemeral=True
            )
            return
        await apply_role_profiles(interaction.guild, rows)
        await interaction.response.send_message(embed=award_preview_embed(event, rows), ephemeral=True)
        return

    discord_event = await fetch_discord_event(interaction.guild, parsed_event_id)
    if discord_event is None:
        await interaction.response.send_message(
            "No bot event or Discord scheduled event with that ID exists in this server.",
            ephemeral=True,
        )
        return
    rows = await fetch_discord_event_rows(interaction.guild, discord_event)
    if not rows:
        await interaction.response.send_message(
            f"No one has clicked interested for **{discord_event.name}** yet.", ephemeral=True
        )
        return
    await interaction.response.send_message(
        embed=scheduled_event_preview_embed(discord_event, rows),
        ephemeral=True,
    )


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
    class_overrides, tier_overrides = await apply_role_profiles(interaction.guild, rows)
    if not confirm:
        await interaction.response.send_message(
            embed=award_preview_embed(event, rows),
            content="Set `confirm` to **True** to apply these awards. This can only be done once per event.",
            ephemeral=True,
        )
        return
    result = await bot.db.award_event(
        parsed_event_id,
        CLASS_MULTIPLIERS,
        TIER_MULTIPLIERS,
        class_overrides,
        tier_overrides,
    )
    if result["status"] == "already_awarded":
        await interaction.response.send_message("Miles for this event have already been awarded.", ephemeral=True)
        return
    total = sum(item["miles"] for item in result["awards"])
    await interaction.response.send_message(
        f"**Awards complete.** Granted **{total:,} miles** across **{len(result['awards'])}** passenger(s).",
        ephemeral=True,
    )


@miles_group.command(name="flight", description="Award miles to one member for a completed flight")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
async def miles_flight(
    interaction: discord.Interaction,
    member: discord.Member,
    miles: app_commands.Range[int, 1, 1_000_000],
    flight_reference: str = "PTFS Flight",
) -> None:
    result = await bot.db.add_flight_miles(
        member.id,
        miles,
        flight_reference[:100],
        interaction.user.id,
    )
    if result == "missing_account":
        await interaction.response.send_message(
            "That member needs to create a Skywards account before receiving flight miles.",
            ephemeral=True,
        )
        return
    await interaction.response.send_message(
        f"Awarded **{miles:,} miles** to **{member.display_name}** for *{flight_reference[:100]}*.",
        ephemeral=True,
    )


@miles_group.command(name="event", description="Award miles to everyone interested in an event")
@app_commands.guild_only()
@app_commands.checks.has_permissions(manage_guild=True)
@app_commands.choices(
    travel_class=[app_commands.Choice(name=travel_class, value=travel_class) for travel_class in TRAVEL_CLASSES]
)
async def miles_event(
    interaction: discord.Interaction,
    event_id: str,
    base_miles: Optional[int] = DEFAULT_EVENT_BASE_MILES,
    travel_class: Optional[app_commands.Choice[str]] = None,
    confirm: bool = False,
) -> None:
    parsed_event_id = parse_event_id(event_id)
    if parsed_event_id is None:
        await interaction.response.send_message(
            "Enter the numeric event ID shown by `/event list`, for example `1` or `#1`.",
            ephemeral=True,
        )
        return

    bot_event = await bot.db.get_event(parsed_event_id)
    if bot_event is not None and bot_event["guild_id"] == interaction.guild_id:
        rows = await bot.db.list_interest(parsed_event_id)
        if not rows:
            await interaction.response.send_message("There are no interested members to award.", ephemeral=True)
            return
        class_overrides, tier_overrides = await apply_role_profiles(interaction.guild, rows)
        if not confirm:
            await interaction.response.send_message(
                embed=award_preview_embed(bot_event, rows),
                content="Set `confirm` to **True** to apply these awards. This can only be done once per event.",
                ephemeral=True,
            )
            return
        result = await bot.db.award_event(
            parsed_event_id,
            CLASS_MULTIPLIERS,
            TIER_MULTIPLIERS,
            class_overrides,
            tier_overrides,
        )
        if result["status"] == "already_awarded":
            await interaction.response.send_message(
                "Miles for this event have already been awarded.", ephemeral=True
            )
            return
        total = sum(item["miles"] for item in result["awards"])
        await interaction.response.send_message(
            f"**Event awards complete.** Granted **{total:,} miles** across "
            f"**{len(result['awards'])}** passenger(s).",
            ephemeral=True,
        )
        return

    discord_event = await fetch_discord_event(interaction.guild, parsed_event_id)
    if discord_event is None:
        await interaction.response.send_message(
            "No bot event or Discord scheduled event with that ID exists in this server.",
            ephemeral=True,
        )
        return
    award_base_miles = DEFAULT_EVENT_BASE_MILES if base_miles is None else base_miles
    if not 1 <= award_base_miles <= 1_000_000:
        await interaction.response.send_message(
            "For a Discord scheduled event, `base_miles` must be between 1 and 1,000,000.",
            ephemeral=True,
        )
        return
    selected_class = travel_class.value if travel_class else "Economy"
    rows = await fetch_discord_event_rows(interaction.guild, discord_event, selected_class)
    if not rows:
        await interaction.response.send_message(
            f"No one has clicked interested for **{discord_event.name}** yet.", ephemeral=True
        )
        return
    if not confirm:
        await interaction.response.send_message(
            embed=scheduled_event_preview_embed(discord_event, rows, award_base_miles),
            content=(
                f"Base miles: **{award_base_miles:,}** · Fallback class: **{selected_class}**\n"
                "Class and tier roles override the fallback for each attendee.\n"
                "Set `confirm` to **True** to award miles to attendees with Skywards accounts."
            ),
            ephemeral=True,
        )
        return
    result = await bot.db.award_external_event(
        parsed_event_id,
        award_base_miles,
        CLASS_MULTIPLIERS,
        TIER_MULTIPLIERS,
        rows,
    )
    if result["status"] == "already_awarded":
        await interaction.response.send_message(
            "Miles for this Discord event have already been awarded.", ephemeral=True
        )
        return
    total = sum(item["miles"] for item in result["awards"])
    missing = result["missing_accounts"]
    skipped = f" Skipped **{missing}** attendee(s) without accounts." if missing else ""
    await interaction.response.send_message(
        f"**Event awards complete.** Granted **{total:,} miles** across "
        f"**{len(result['awards'])}** passenger(s).{skipped}",
        ephemeral=True,
    )


@bot.tree.command(name="shop", description="Browse and buy Skywards perks")
@app_commands.guild_only()
async def shop(interaction: discord.Interaction) -> None:
    await interaction.response.send_message(embed=shop_embed(), view=ShopView(bot.db), ephemeral=True)


bot.tree.add_command(account_group)
bot.tree.add_command(event_group)
bot.tree.add_command(miles_group)


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
