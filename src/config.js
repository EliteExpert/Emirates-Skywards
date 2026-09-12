require('dotenv').config();

const TIERS = ['Blue', 'Silver', 'Gold', 'Platinum'];
const TRAVEL_CLASSES = ['Economy', 'Premium Economy', 'Business', 'First'];

const TIER_DISPLAY_NAMES = {
  Blue: 'Bronze',
  Silver: 'Silver',
  Gold: 'Gold',
  Platinum: 'Platinum',
};

const TIER_ROLE_IDS = {
  Blue: '1315217374705618995',
  Silver: '1315217584890712104',
  Gold: '1315217736292372480',
  Platinum: '1315217903892566046',
};

const TRAVEL_CLASS_ROLE_IDS = {
  Economy: '1295736936299757568',
  Business: '1331852990629417020',
  First: '1331853227720708146',
};

const TIER_MINIMUM_MILES = { Blue: 0, Silver: 1500, Gold: 3500, Platinum: 7000 };
const TIER_MULTIPLIERS = { Blue: 1, Silver: 1, Gold: 1.3, Platinum: 1.75 };
const CLASS_MULTIPLIERS = { Economy: 1, 'Premium Economy': 1.25, Business: 2, First: 3 };
const TIER_COLORS = { Blue: 0x315b9a, Silver: 0x9297a1, Gold: 0xb48a35, Platinum: 0x5f626b };

const TIER_BENEFITS = {
  Blue: [
    'Free Wi-Fi on board',
    'Earn and redeem Emirates miles',
    'Priority for boarding gates',
  ],
  Silver: [
    'All benefits from Bronze',
    'Use your miles to upgrade on selected routes',
    'Eligible for upgrades when seats are open',
  ],
  Gold: [
    'All benefits from Silver',
    '+30% bonus points on all Emirates PTFS flights',
    'Access to the Business Class Lounge at the Dubai Hub',
    'Extra baggage slots for long-haul PTFS routes',
    'Complimentary flight upgrades for one friend per event',
  ],
  Platinum: [
    'All benefits from Gold',
    '+75% bonus points per flight',
    'Access to Business Class lounges worldwide',
    'Priority baggage handling at all PTFS airports',
    'Complimentary flight upgrades for one friend per event',
  ],
};

const SHOP_ITEMS = {
  priority_boarding: {
    name: 'Priority Boarding',
    description: 'Priority boarding on your next PTFS flight.',
    price: 2000,
  },
  lounge_access: {
    name: 'Lounge Access',
    description: 'One lounge access pass for a future PTFS flight.',
    price: 5000,
  },
  extra_baggage: {
    name: 'Extra Baggage',
    description: 'One extra baggage allowance token.',
    price: 3500,
  },
  upgrade_voucher: {
    name: 'Upgrade Voucher',
    description: 'One cabin upgrade voucher.',
    price: 8000,
  },
};

const DEFAULT_EVENT_BASE_MILES = 1000;

function settings() {
  const testGuildId = process.env.TEST_GUILD_ID?.trim();
  return {
    token: process.env.DISCORD_TOKEN?.trim(),
    databaseUrl: process.env.DATABASE_URL?.trim(),
    testGuildId: testGuildId || null,
  };
}

module.exports = {
  TIERS,
  TRAVEL_CLASSES,
  TIER_DISPLAY_NAMES,
  TIER_ROLE_IDS,
  TRAVEL_CLASS_ROLE_IDS,
  TIER_MINIMUM_MILES,
  TIER_MULTIPLIERS,
  CLASS_MULTIPLIERS,
  TIER_COLORS,
  TIER_BENEFITS,
  SHOP_ITEMS,
  DEFAULT_EVENT_BASE_MILES,
  settings,
};
