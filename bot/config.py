from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT_DIR = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT_DIR / "assets" / "tiers"

TIER_NAMES = ("Blue", "Silver", "Gold", "Platinum")
TRAVEL_CLASSES = ("Economy", "Premium Economy", "Business", "First")

TIER_MULTIPLIERS = {
    "Blue": 1.00,
    "Silver": 1.25,
    "Gold": 1.50,
    "Platinum": 2.00,
}

CLASS_MULTIPLIERS = {
    "Economy": 1.00,
    "Premium Economy": 1.25,
    "Business": 2.00,
    "First": 3.00,
}

TIER_COLORS = {
    "Blue": 0x315B9A,
    "Silver": 0x9297A1,
    "Gold": 0xB48A35,
    "Platinum": 0x5F626B,
}

TIER_ASSETS = {
    "Blue": ASSET_DIR / "Blue.png",
    "Silver": ASSET_DIR / "Silver.png",
    "Gold": ASSET_DIR / "Gold.png",
    "Platinum": ASSET_DIR / "Platinum.png",
}

SHOP_ITEMS = {
    "priority_boarding": {
        "name": "Priority Boarding",
        "description": "Priority boarding on your next PTFS flight.",
        "price": 2000,
    },
    "lounge_access": {
        "name": "Lounge Access",
        "description": "One lounge access pass for a future PTFS flight.",
        "price": 5000,
    },
    "extra_baggage": {
        "name": "Extra Baggage",
        "description": "One extra baggage allowance token.",
        "price": 3500,
    },
    "upgrade_voucher": {
        "name": "Upgrade Voucher",
        "description": "One cabin upgrade voucher.",
        "price": 8000,
    },
}


@dataclass(frozen=True)
class Settings:
    token: str | None
    database_path: Path
    test_guild_id: int | None

    @classmethod
    def from_environment(cls) -> "Settings":
        database_value = os.getenv("DATABASE_PATH", "data/skywards.sqlite3")
        database_path = Path(database_value)
        if not database_path.is_absolute():
            database_path = ROOT_DIR / database_path

        test_guild_value = os.getenv("TEST_GUILD_ID", "").strip()
        test_guild_id = int(test_guild_value) if test_guild_value else None
        return cls(
            token=os.getenv("DISCORD_TOKEN"),
            database_path=database_path,
            test_guild_id=test_guild_id,
        )

