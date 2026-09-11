from __future__ import annotations

import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.connection: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = await aiosqlite.connect(self.path)
        self.connection.row_factory = aiosqlite.Row
        await self.connection.execute("PRAGMA foreign_keys = ON")
        await self.initialize()

    async def close(self) -> None:
        if self.connection is not None:
            await self.connection.close()
            self.connection = None

    def _db(self) -> aiosqlite.Connection:
        if self.connection is None:
            raise RuntimeError("Database is not connected")
        return self.connection

    async def initialize(self) -> None:
        await self._db().executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                user_id INTEGER PRIMARY KEY,
                display_name TEXT NOT NULL,
                skywards_number TEXT NOT NULL UNIQUE,
                tier TEXT NOT NULL DEFAULT 'Blue',
                miles INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                guild_id INTEGER NOT NULL,
                channel_id INTEGER NOT NULL,
                message_id INTEGER,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                base_miles INTEGER NOT NULL,
                event_date TEXT,
                created_by INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                awarded_at TEXT
            );

            CREATE TABLE IF NOT EXISTS event_interest (
                event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                travel_class TEXT NOT NULL,
                clicked_at TEXT NOT NULL,
                PRIMARY KEY (event_id, user_id)
            );

            CREATE TABLE IF NOT EXISTS awards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                miles INTEGER NOT NULL,
                travel_class TEXT NOT NULL,
                tier TEXT NOT NULL,
                awarded_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS inventory (
                user_id INTEGER NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, product_id)
            );

            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                cost INTEGER NOT NULL,
                purchased_at TEXT NOT NULL
            );
            """
        )
        await self._db().commit()

    async def get_account(self, user_id: int) -> dict[str, Any] | None:
        async with self._db().execute(
            "SELECT * FROM accounts WHERE user_id = ?", (user_id,)
        ) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else None

    async def create_account(self, user_id: int, display_name: str) -> dict[str, Any]:
        for _ in range(10):
            skywards_number = f"ES-{secrets.token_hex(4).upper()}"
            try:
                await self._db().execute(
                    """
                    INSERT INTO accounts (user_id, display_name, skywards_number, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (user_id, display_name, skywards_number, utc_now()),
                )
                await self._db().commit()
                account = await self.get_account(user_id)
                if account is None:
                    raise RuntimeError("Account was not returned after creation")
                return account
            except aiosqlite.IntegrityError:
                existing = await self.get_account(user_id)
                if existing:
                    return existing
        raise RuntimeError("Could not generate a unique Skywards number")

    async def update_tier(self, user_id: int, tier: str) -> None:
        await self._db().execute("UPDATE accounts SET tier = ? WHERE user_id = ?", (tier, user_id))
        await self._db().commit()

    async def add_miles(self, user_id: int, miles: int) -> None:
        await self._db().execute("UPDATE accounts SET miles = miles + ? WHERE user_id = ?", (miles, user_id))
        await self._db().commit()

    async def get_inventory(self, user_id: int) -> list[dict[str, Any]]:
        async with self._db().execute(
            "SELECT product_id, quantity FROM inventory WHERE user_id = ? AND quantity > 0 ORDER BY product_id",
            (user_id,),
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def create_event(
        self,
        guild_id: int,
        channel_id: int,
        name: str,
        description: str,
        base_miles: int,
        event_date: str | None,
        created_by: int,
    ) -> dict[str, Any]:
        cursor = await self._db().execute(
            """
            INSERT INTO events
                (guild_id, channel_id, name, description, base_miles, event_date, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (guild_id, channel_id, name, description, base_miles, event_date, created_by, utc_now()),
        )
        await self._db().commit()
        event = await self.get_event(cursor.lastrowid)
        if event is None:
            raise RuntimeError("Event was not returned after creation")
        return event

    async def set_event_message_id(self, event_id: int, message_id: int) -> None:
        await self._db().execute("UPDATE events SET message_id = ? WHERE id = ?", (message_id, event_id))
        await self._db().commit()

    async def get_event(self, event_id: int) -> dict[str, Any] | None:
        async with self._db().execute("SELECT * FROM events WHERE id = ?", (event_id,)) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else None

    async def list_events_with_messages(self) -> list[dict[str, Any]]:
        async with self._db().execute(
            "SELECT * FROM events WHERE message_id IS NOT NULL ORDER BY id"
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def count_interest(self, event_id: int) -> int:
        async with self._db().execute(
            "SELECT COUNT(*) AS count FROM event_interest WHERE event_id = ?", (event_id,)
        ) as cursor:
            row = await cursor.fetchone()
        return int(row["count"])

    async def get_interest(self, event_id: int, user_id: int) -> dict[str, Any] | None:
        async with self._db().execute(
            "SELECT * FROM event_interest WHERE event_id = ? AND user_id = ?",
            (event_id, user_id),
        ) as cursor:
            row = await cursor.fetchone()
        return dict(row) if row else None

    async def add_interest(self, event_id: int, user_id: int, travel_class: str) -> bool:
        cursor = await self._db().execute(
            """
            INSERT OR IGNORE INTO event_interest (event_id, user_id, travel_class, clicked_at)
            VALUES (?, ?, ?, ?)
            """,
            (event_id, user_id, travel_class, utc_now()),
        )
        await self._db().commit()
        return cursor.rowcount == 1

    async def remove_interest(self, event_id: int, user_id: int) -> None:
        await self._db().execute(
            "DELETE FROM event_interest WHERE event_id = ? AND user_id = ?", (event_id, user_id)
        )
        await self._db().commit()

    async def list_interest(self, event_id: int) -> list[dict[str, Any]]:
        async with self._db().execute(
            """
            SELECT i.user_id, i.travel_class, i.clicked_at,
                   a.display_name, a.skywards_number, a.tier, a.miles
            FROM event_interest AS i
            JOIN accounts AS a ON a.user_id = i.user_id
            WHERE i.event_id = ?
            ORDER BY i.clicked_at ASC
            """,
            (event_id,),
        ) as cursor:
            rows = await cursor.fetchall()
        return [dict(row) for row in rows]

    async def award_event(
        self,
        event_id: int,
        class_multipliers: dict[str, float],
        tier_multipliers: dict[str, float],
    ) -> dict[str, Any]:
        db = self._db()
        await db.execute("BEGIN IMMEDIATE")
        try:
            async with db.execute("SELECT * FROM events WHERE id = ?", (event_id,)) as cursor:
                event_row = await cursor.fetchone()
            if event_row is None:
                await db.rollback()
                return {"status": "missing", "event": None, "awards": []}
            if event_row["awarded_at"]:
                await db.rollback()
                return {"status": "already_awarded", "event": dict(event_row), "awards": []}

            async with db.execute(
                """
                SELECT i.user_id, i.travel_class, a.tier
                FROM event_interest AS i
                JOIN accounts AS a ON a.user_id = i.user_id
                WHERE i.event_id = ?
                ORDER BY i.clicked_at ASC
                """,
                (event_id,),
            ) as cursor:
                interested = await cursor.fetchall()

            awards: list[dict[str, Any]] = []
            for row in interested:
                miles = max(
                    1,
                    round(
                        event_row["base_miles"]
                        * class_multipliers[row["travel_class"]]
                        * tier_multipliers[row["tier"]]
                    ),
                )
                await db.execute(
                    "UPDATE accounts SET miles = miles + ? WHERE user_id = ?",
                    (miles, row["user_id"]),
                )
                await db.execute(
                    """
                    INSERT INTO awards (event_id, user_id, miles, travel_class, tier, awarded_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (event_id, row["user_id"], miles, row["travel_class"], row["tier"], utc_now()),
                )
                awards.append(
                    {
                        "user_id": row["user_id"],
                        "miles": miles,
                        "travel_class": row["travel_class"],
                        "tier": row["tier"],
                    }
                )

            awarded_at = utc_now()
            await db.execute("UPDATE events SET awarded_at = ? WHERE id = ?", (awarded_at, event_id))
            await db.commit()
            return {"status": "awarded", "event": dict(event_row), "awards": awards}
        except Exception:
            await db.rollback()
            raise

    async def purchase(self, user_id: int, product_id: str, cost: int) -> str:
        db = self._db()
        await db.execute("BEGIN IMMEDIATE")
        try:
            async with db.execute("SELECT miles FROM accounts WHERE user_id = ?", (user_id,)) as cursor:
                account = await cursor.fetchone()
            if account is None:
                await db.rollback()
                return "missing_account"
            if account["miles"] < cost:
                await db.rollback()
                return "insufficient_miles"

            now = utc_now()
            await db.execute("UPDATE accounts SET miles = miles - ? WHERE user_id = ?", (cost, user_id))
            await db.execute(
                """
                INSERT INTO inventory (user_id, product_id, quantity)
                VALUES (?, ?, 1)
                ON CONFLICT(user_id, product_id)
                DO UPDATE SET quantity = quantity + 1
                """,
                (user_id, product_id),
            )
            await db.execute(
                "INSERT INTO purchases (user_id, product_id, cost, purchased_at) VALUES (?, ?, ?, ?)",
                (user_id, product_id, cost, now),
            )
            await db.commit()
            return "purchased"
        except Exception:
            await db.rollback()
            raise

