from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import asyncpg


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_database_url(value: str) -> tuple[str, str | None]:
    """Normalize Railway/Postgres URLs for asyncpg."""
    if value.startswith("postgres://"):
        value = "postgresql://" + value.removeprefix("postgres://")
    parts = urlsplit(value)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    sslmode = query.pop("sslmode", None)
    clean_url = urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )
    return clean_url, ("require" if sslmode == "require" else None)


class Database:
    def __init__(self, database_url: str | None):
        self.database_url = database_url
        self.pool: asyncpg.Pool | None = None
        self.ssl: str | None = None

    async def connect(self) -> None:
        if not self.database_url:
            raise RuntimeError(
                "DATABASE_URL is missing. Add a Railway PostgreSQL database and expose its "
                "DATABASE_URL variable to this service."
            )
        self.database_url, self.ssl = normalize_database_url(self.database_url)
        options: dict[str, Any] = {
            "min_size": 1,
            "max_size": 5,
            "command_timeout": 30,
        }
        if self.ssl:
            options["ssl"] = self.ssl
        self.pool = await asyncpg.create_pool(self.database_url, **options)
        await self.initialize()

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def _pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("Database is not connected")
        return self.pool

    async def initialize(self) -> None:
        statements = (
            """
            CREATE TABLE IF NOT EXISTS accounts (
                user_id BIGINT PRIMARY KEY,
                display_name TEXT NOT NULL,
                skywards_number TEXT NOT NULL UNIQUE,
                tier TEXT NOT NULL DEFAULT 'Blue',
                miles BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS events (
                id BIGSERIAL PRIMARY KEY,
                guild_id BIGINT NOT NULL,
                channel_id BIGINT NOT NULL,
                message_id BIGINT,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                base_miles BIGINT NOT NULL,
                event_date TEXT,
                created_by BIGINT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                awarded_at TIMESTAMPTZ
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS event_interest (
                event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                travel_class TEXT NOT NULL,
                clicked_at TIMESTAMPTZ NOT NULL,
                PRIMARY KEY (event_id, user_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS awards (
                id BIGSERIAL PRIMARY KEY,
                event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
                external_event_id BIGINT,
                user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                miles BIGINT NOT NULL,
                travel_class TEXT NOT NULL,
                tier TEXT NOT NULL,
                awarded_at TIMESTAMPTZ NOT NULL,
                CHECK ((event_id IS NOT NULL) OR (external_event_id IS NOT NULL))
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS external_event_awards (
                event_id BIGINT PRIMARY KEY,
                awarded_at TIMESTAMPTZ NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS flight_awards (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                miles BIGINT NOT NULL,
                flight_reference TEXT NOT NULL,
                awarded_by BIGINT NOT NULL,
                awarded_at TIMESTAMPTZ NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS inventory (
                user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                quantity BIGINT NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, product_id)
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS purchases (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                cost BIGINT NOT NULL,
                purchased_at TIMESTAMPTZ NOT NULL
            )
            """,
        )
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                for statement in statements:
                    await connection.execute(statement)

    async def get_account(self, user_id: int) -> dict[str, Any] | None:
        row = await self._pool().fetchrow("SELECT * FROM accounts WHERE user_id = $1", user_id)
        return dict(row) if row else None

    async def create_account(self, user_id: int, display_name: str) -> dict[str, Any]:
        existing = await self.get_account(user_id)
        if existing:
            return existing
        for _ in range(10):
            skywards_number = f"ES-{secrets.token_hex(4).upper()}"
            row = await self._pool().fetchrow(
                """
                INSERT INTO accounts (user_id, display_name, skywards_number, created_at)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT DO NOTHING
                RETURNING *
                """,
                user_id,
                display_name,
                skywards_number,
                utc_now(),
            )
            if row:
                return dict(row)
        raise RuntimeError("Could not generate a unique Skywards number")

    async def update_tier(self, user_id: int, tier: str) -> None:
        await self._pool().execute("UPDATE accounts SET tier = $1 WHERE user_id = $2", tier, user_id)

    async def add_miles(self, user_id: int, miles: int) -> None:
        await self._pool().execute("UPDATE accounts SET miles = miles + $1 WHERE user_id = $2", miles, user_id)

    async def add_flight_miles(
        self, user_id: int, miles: int, flight_reference: str, awarded_by: int
    ) -> str:
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                account = await connection.fetchrow(
                    "SELECT user_id FROM accounts WHERE user_id = $1 FOR UPDATE", user_id
                )
                if account is None:
                    return "missing_account"
                await connection.execute(
                    "UPDATE accounts SET miles = miles + $1 WHERE user_id = $2", miles, user_id
                )
                await connection.execute(
                    """
                    INSERT INTO flight_awards
                        (user_id, miles, flight_reference, awarded_by, awarded_at)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    user_id,
                    miles,
                    flight_reference,
                    awarded_by,
                    utc_now(),
                )
                return "awarded"

    async def get_inventory(self, user_id: int) -> list[dict[str, Any]]:
        rows = await self._pool().fetch(
            """
            SELECT product_id, quantity
            FROM inventory
            WHERE user_id = $1 AND quantity > 0
            ORDER BY product_id
            """,
            user_id,
        )
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
        row = await self._pool().fetchrow(
            """
            INSERT INTO events
                (guild_id, channel_id, name, description, base_miles, event_date, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            """,
            guild_id,
            channel_id,
            name,
            description,
            base_miles,
            event_date,
            created_by,
            utc_now(),
        )
        return dict(row)

    async def set_event_message_id(self, event_id: int, message_id: int) -> None:
        await self._pool().execute("UPDATE events SET message_id = $1 WHERE id = $2", message_id, event_id)

    async def get_event(self, event_id: int) -> dict[str, Any] | None:
        row = await self._pool().fetchrow("SELECT * FROM events WHERE id = $1", event_id)
        return dict(row) if row else None

    async def list_events_with_messages(self) -> list[dict[str, Any]]:
        rows = await self._pool().fetch("SELECT * FROM events WHERE message_id IS NOT NULL ORDER BY id")
        return [dict(row) for row in rows]

    async def count_interest(self, event_id: int) -> int:
        row = await self._pool().fetchrow(
            "SELECT COUNT(*) AS count FROM event_interest WHERE event_id = $1", event_id
        )
        return int(row["count"])

    async def get_interest(self, event_id: int, user_id: int) -> dict[str, Any] | None:
        row = await self._pool().fetchrow(
            "SELECT * FROM event_interest WHERE event_id = $1 AND user_id = $2",
            event_id,
            user_id,
        )
        return dict(row) if row else None

    async def add_interest(self, event_id: int, user_id: int, travel_class: str) -> bool:
        result = await self._pool().execute(
            """
            INSERT INTO event_interest (event_id, user_id, travel_class, clicked_at)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT DO NOTHING
            """,
            event_id,
            user_id,
            travel_class,
            utc_now(),
        )
        return result == "INSERT 0 1"

    async def remove_interest(self, event_id: int, user_id: int) -> None:
        await self._pool().execute(
            "DELETE FROM event_interest WHERE event_id = $1 AND user_id = $2", event_id, user_id
        )

    async def list_interest(self, event_id: int) -> list[dict[str, Any]]:
        rows = await self._pool().fetch(
            """
            SELECT i.user_id, i.travel_class, i.clicked_at,
                   a.display_name, a.skywards_number, a.tier, a.miles
            FROM event_interest AS i
            JOIN accounts AS a ON a.user_id = i.user_id
            WHERE i.event_id = $1
            ORDER BY i.clicked_at ASC
            """,
            event_id,
        )
        return [dict(row) for row in rows]

    async def award_event(
        self,
        event_id: int,
        class_multipliers: dict[str, float],
        tier_multipliers: dict[str, float],
    ) -> dict[str, Any]:
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                event_row = await connection.fetchrow(
                    "SELECT * FROM events WHERE id = $1 FOR UPDATE", event_id
                )
                if event_row is None:
                    return {"status": "missing", "event": None, "awards": []}
                if event_row["awarded_at"]:
                    return {"status": "already_awarded", "event": dict(event_row), "awards": []}

                interested = await connection.fetch(
                    """
                    SELECT i.user_id, i.travel_class, a.tier
                    FROM event_interest AS i
                    JOIN accounts AS a ON a.user_id = i.user_id
                    WHERE i.event_id = $1
                    ORDER BY i.clicked_at ASC
                    """,
                    event_id,
                )
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
                    await connection.execute(
                        "UPDATE accounts SET miles = miles + $1 WHERE user_id = $2",
                        miles,
                        row["user_id"],
                    )
                    await connection.execute(
                        """
                        INSERT INTO awards
                            (event_id, external_event_id, user_id, miles, travel_class, tier, awarded_at)
                        VALUES ($1, NULL, $2, $3, $4, $5, $6)
                        """,
                        event_id,
                        row["user_id"],
                        miles,
                        row["travel_class"],
                        row["tier"],
                        utc_now(),
                    )
                    awards.append(
                        {
                            "user_id": row["user_id"],
                            "miles": miles,
                            "travel_class": row["travel_class"],
                            "tier": row["tier"],
                        }
                    )

                await connection.execute(
                    "UPDATE events SET awarded_at = $1 WHERE id = $2", utc_now(), event_id
                )
                return {"status": "awarded", "event": dict(event_row), "awards": awards}

    async def award_external_event(
        self,
        external_event_id: int,
        base_miles: int,
        travel_class: str,
        class_multipliers: dict[str, float],
        tier_multipliers: dict[str, float],
        user_ids: list[int],
    ) -> dict[str, Any]:
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                already_awarded = await connection.fetchrow(
                    "SELECT event_id FROM external_event_awards WHERE event_id = $1 FOR UPDATE",
                    external_event_id,
                )
                if already_awarded:
                    return {"status": "already_awarded", "awards": [], "missing_accounts": 0}

                awards: list[dict[str, Any]] = []
                missing_accounts = 0
                for user_id in dict.fromkeys(user_ids):
                    account = await connection.fetchrow(
                        "SELECT tier FROM accounts WHERE user_id = $1 FOR UPDATE", user_id
                    )
                    if account is None:
                        missing_accounts += 1
                        continue
                    miles = max(
                        1,
                        round(
                            base_miles
                            * class_multipliers[travel_class]
                            * tier_multipliers[account["tier"]]
                        ),
                    )
                    await connection.execute(
                        "UPDATE accounts SET miles = miles + $1 WHERE user_id = $2", miles, user_id
                    )
                    await connection.execute(
                        """
                        INSERT INTO awards
                            (event_id, external_event_id, user_id, miles, travel_class, tier, awarded_at)
                        VALUES (NULL, $1, $2, $3, $4, $5, $6)
                        """,
                        external_event_id,
                        user_id,
                        miles,
                        travel_class,
                        account["tier"],
                        utc_now(),
                    )
                    awards.append({"user_id": user_id, "miles": miles, "tier": account["tier"]})

                await connection.execute(
                    "INSERT INTO external_event_awards (event_id, awarded_at) VALUES ($1, $2)",
                    external_event_id,
                    utc_now(),
                )
                return {
                    "status": "awarded",
                    "awards": awards,
                    "missing_accounts": missing_accounts,
                }

    async def purchase(self, user_id: int, product_id: str, cost: int) -> str:
        async with self._pool().acquire() as connection:
            async with connection.transaction():
                account = await connection.fetchrow(
                    "SELECT miles FROM accounts WHERE user_id = $1 FOR UPDATE", user_id
                )
                if account is None:
                    return "missing_account"
                if account["miles"] < cost:
                    return "insufficient_miles"

                now = utc_now()
                await connection.execute(
                    "UPDATE accounts SET miles = miles - $1 WHERE user_id = $2", cost, user_id
                )
                await connection.execute(
                    """
                    INSERT INTO inventory (user_id, product_id, quantity)
                    VALUES ($1, $2, 1)
                    ON CONFLICT (user_id, product_id)
                    DO UPDATE SET quantity = inventory.quantity + 1
                    """,
                    user_id,
                    product_id,
                )
                await connection.execute(
                    "INSERT INTO purchases (user_id, product_id, cost, purchased_at) VALUES ($1, $2, $3, $4)",
                    user_id,
                    product_id,
                    cost,
                    now,
                )
                return "purchased"
