from __future__ import annotations

from contextlib import suppress
from typing import Any

import discord

from .config import TIER_DISPLAY_NAMES, TIER_MINIMUM_MILES, TIER_NAMES, SHOP_ITEMS, TRAVEL_CLASSES
from .embeds import account_inventory_embed, account_message, event_embed, shop_embed


async def refresh_event_message(interaction: discord.Interaction, db: Any, event_id: int) -> None:
    event = await db.get_event(event_id)
    if not event or not event["message_id"]:
        return
    channel = interaction.client.get_channel(event["channel_id"])
    if channel is None:
        with suppress(discord.HTTPException, discord.NotFound):
            channel = await interaction.client.fetch_channel(event["channel_id"])
    if channel is None or not hasattr(channel, "fetch_message"):
        return
    with suppress(discord.HTTPException, discord.NotFound):
        message = await channel.fetch_message(event["message_id"])
        await message.edit(
            embed=event_embed(event, await db.count_interest(event_id)),
            view=EventInterestView(db, event_id),
        )


class AccountView(discord.ui.View):
    def __init__(self, db: Any):
        super().__init__(timeout=None)
        self.db = db

    @discord.ui.button(
        label="Refresh Account",
        style=discord.ButtonStyle.secondary,
        custom_id="account:refresh",
    )
    async def refresh(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        account = await self.db.get_account(interaction.user.id)
        if account is None:
            await interaction.response.send_message(
                "You do not have a Skywards account yet. Use `/account create` first.",
                ephemeral=True,
            )
            return
        embed, file = account_message(account, await self.db.get_inventory(interaction.user.id))
        await interaction.response.edit_message(embed=embed, attachments=[file], view=self)

    @discord.ui.button(
        label="Open Shop",
        style=discord.ButtonStyle.primary,
        custom_id="account:shop",
    )
    async def shop(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        await interaction.response.edit_message(embed=shop_embed(), attachments=[], view=ShopView(self.db))

    @discord.ui.button(
        label="Upgrade to Next Tier",
        style=discord.ButtonStyle.success,
        custom_id="account:upgrade",
        row=1,
    )
    async def upgrade(self, interaction: discord.Interaction, _: discord.ui.Button) -> None:
        account = await self.db.get_account(interaction.user.id)
        if account is None:
            await interaction.response.send_message(
                "You do not have a Skywards account yet. Use `/account create` first.",
                ephemeral=True,
            )
            return
        current_index = TIER_NAMES.index(account["tier"])
        if current_index == len(TIER_NAMES) - 1:
            await interaction.response.send_message(
                "You already have the highest Skywards tier.",
                ephemeral=True,
            )
            return
        next_tier = TIER_NAMES[current_index + 1]
        required_miles = TIER_MINIMUM_MILES[next_tier]
        if account["miles"] < required_miles:
            await interaction.response.send_message(
                f"You need **{required_miles:,} miles** to upgrade to "
                f"**{TIER_DISPLAY_NAMES[next_tier]}**. Your balance is **{account['miles']:,} miles**.",
                ephemeral=True,
            )
            return
        await self.db.update_tier(account["user_id"], next_tier)
        refreshed = await self.db.get_account(account["user_id"])
        embed, file = account_message(refreshed, await self.db.get_inventory(account["user_id"]))
        await interaction.response.edit_message(embed=embed, attachments=[file], view=self)


class InterestClassSelect(discord.ui.Select):
    def __init__(self, db: Any, event_id: int):
        options = [
            discord.SelectOption(
                label=travel_class,
                value=travel_class,
                description=f"Register as {travel_class.lower()} for this event.",
            )
            for travel_class in TRAVEL_CLASSES
        ]
        super().__init__(
            placeholder="Choose your travel class",
            min_values=1,
            max_values=1,
            options=options,
        )
        self.db = db
        self.event_id = event_id

    async def callback(self, interaction: discord.Interaction) -> None:
        event = await self.db.get_event(self.event_id)
        account = await self.db.get_account(interaction.user.id)
        if event is None:
            await interaction.response.edit_message(content="This event no longer exists.", view=None)
            return
        if event["awarded_at"]:
            await interaction.response.edit_message(
                content="This event is closed because its miles have already been awarded.",
                view=None,
            )
            return
        if account is None:
            await interaction.response.edit_message(
                content="Create your Skywards account with `/account create` before registering.",
                view=None,
            )
            return
        travel_class = self.values[0]
        added = await self.db.add_interest(self.event_id, interaction.user.id, travel_class)
        if added:
            message = (
                f"**Interest registered.**\nYou are listed as **{travel_class}** for "
                f"*{event['name']}*."
            )
        else:
            message = "You are already listed as interested in this event."
        await interaction.response.edit_message(content=message, view=None)
        await refresh_event_message(interaction, self.db, self.event_id)


class InterestClassView(discord.ui.View):
    def __init__(self, db: Any, event_id: int):
        super().__init__(timeout=120)
        self.add_item(InterestClassSelect(db, event_id))


class EventInterestView(discord.ui.View):
    def __init__(self, db: Any, event_id: int):
        super().__init__(timeout=None)
        self.db = db
        self.event_id = event_id

        button = discord.ui.Button(
            label="I'm Interested",
            style=discord.ButtonStyle.primary,
            custom_id=f"event:interest:{event_id}",
        )
        button.callback = self.interest_callback
        self.add_item(button)

    async def interest_callback(self, interaction: discord.Interaction) -> None:
        event = await self.db.get_event(self.event_id)
        if event is None:
            await interaction.response.send_message("This event no longer exists.", ephemeral=True)
            return
        if event["awarded_at"]:
            await interaction.response.send_message(
                "This event is closed because its miles have already been awarded.",
                ephemeral=True,
            )
            return
        account = await self.db.get_account(interaction.user.id)
        if account is None:
            await interaction.response.send_message(
                "Create your Skywards account with `/account create` before registering.",
                ephemeral=True,
            )
            return
        existing = await self.db.get_interest(self.event_id, interaction.user.id)
        if existing:
            await self.db.remove_interest(self.event_id, interaction.user.id)
            await interaction.response.edit_message(
                embed=event_embed(event, await self.db.count_interest(self.event_id)),
                view=self,
            )
            return
        await interaction.response.send_message(
            f"**{event['name']}**\n*Choose the class you expect to fly in.*",
            view=InterestClassView(self.db, self.event_id),
            ephemeral=True,
        )


class ShopButton(discord.ui.Button):
    def __init__(self, db: Any, product_id: str, row: int):
        product = SHOP_ITEMS[product_id]
        super().__init__(
            label=f"Buy {product['name']}",
            style=discord.ButtonStyle.primary,
            custom_id=f"shop:buy:{product_id}",
            row=row,
        )
        self.db = db
        self.product_id = product_id

    async def callback(self, interaction: discord.Interaction) -> None:
        product = SHOP_ITEMS[self.product_id]
        result = await self.db.purchase(interaction.user.id, self.product_id, product["price"])
        if result == "missing_account":
            await interaction.response.send_message(
                "Create your Skywards account with `/account create` before shopping.",
                ephemeral=True,
            )
            return
        if result == "insufficient_miles":
            account = await self.db.get_account(interaction.user.id)
            await interaction.response.send_message(
                f"You need **{product['price']:,} miles** for {product['name']}. "
                f"Your balance is **{account['miles']:,} miles**.",
                ephemeral=True,
            )
            return
        account = await self.db.get_account(interaction.user.id)
        await interaction.response.send_message(
            f"**Purchase complete.**\n{product['name']} was added to your inventory. "
            f"Remaining balance: **{account['miles']:,} miles**.",
            ephemeral=True,
        )


class ShopBackButton(discord.ui.Button):
    def __init__(self, db: Any):
        super().__init__(
            label="Back to Account",
            style=discord.ButtonStyle.secondary,
            custom_id="shop:back",
            row=2,
        )
        self.db = db

    async def callback(self, interaction: discord.Interaction) -> None:
        account = await self.db.get_account(interaction.user.id)
        if account is None:
            await interaction.response.send_message(
                "You do not have a Skywards account yet. Use `/account create` first.",
                ephemeral=True,
            )
            return
        embed, file = account_message(account, await self.db.get_inventory(interaction.user.id))
        await interaction.response.edit_message(
            embed=embed,
            attachments=[file],
            view=AccountView(self.db),
        )


class ShopView(discord.ui.View):
    def __init__(self, db: Any):
        super().__init__(timeout=None)
        self.db = db
        for index, product_id in enumerate(SHOP_ITEMS):
            self.add_item(ShopButton(db, product_id, index // 2))
        self.add_item(ShopBackButton(db))
