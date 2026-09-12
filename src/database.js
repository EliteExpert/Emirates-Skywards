const { Pool } = require('pg');
const crypto = require('node:crypto');
const { SHOP_COOLDOWN_HOURS } = require('./config');

function normalizeDatabaseUrl(value) {
  if (value.startsWith('postgres://')) return `postgresql://${value.slice('postgres://'.length)}`;
  return value;
}

class Database {
  constructor(databaseUrl) {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is missing. Add a Railway PostgreSQL database and expose its DATABASE_URL variable.');
    }
    const normalized = normalizeDatabaseUrl(databaseUrl);
    this.pool = new Pool({
      connectionString: normalized,
      max: 10,
      min: 1,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 25_000,
      ssl: /[?&]sslmode=require(?:&|$)/.test(normalized) ? { rejectUnauthorized: false } : undefined,
    });
    this.pool.on('error', (error) => console.error('PostgreSQL pool error:', error));
  }

  async initialize() {
    const statements = [
      `CREATE TABLE IF NOT EXISTS accounts (
        user_id BIGINT PRIMARY KEY,
        display_name TEXT NOT NULL,
        skywards_number TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL DEFAULT 'Blue',
        miles BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS events (
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
        awarded_at TIMESTAMPTZ,
        event_type TEXT NOT NULL DEFAULT 'GENERIC',
        flight_code TEXT,
        airline TEXT,
        departure TEXT,
        aircraft TEXT,
        terminal TEXT,
        check_in_status TEXT,
        location TEXT
      )`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'GENERIC'`,
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS flight_code TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS airline TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS departure TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS aircraft TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS terminal TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS check_in_status TEXT',
      'ALTER TABLE events ADD COLUMN IF NOT EXISTS location TEXT',
      `CREATE TABLE IF NOT EXISTS event_interest (
        event_id BIGINT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
        travel_class TEXT NOT NULL,
        clicked_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (event_id, user_id)
      )`,
      `CREATE TABLE IF NOT EXISTS awards (
        id BIGSERIAL PRIMARY KEY,
        event_id BIGINT REFERENCES events(id) ON DELETE CASCADE,
        external_event_id BIGINT,
        user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
        miles BIGINT NOT NULL,
        travel_class TEXT NOT NULL,
        tier TEXT NOT NULL,
        awarded_at TIMESTAMPTZ NOT NULL,
        CHECK ((event_id IS NOT NULL) OR (external_event_id IS NOT NULL))
      )`,
      `CREATE TABLE IF NOT EXISTS external_event_awards (
        event_id BIGINT PRIMARY KEY,
        awarded_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS flight_awards (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
        miles BIGINT NOT NULL,
        flight_reference TEXT NOT NULL,
        awarded_by BIGINT NOT NULL,
        awarded_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS inventory (
        user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        quantity BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, product_id)
      )`,
      `CREATE TABLE IF NOT EXISTS purchases (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        cost BIGINT NOT NULL,
        purchased_at TIMESTAMPTZ NOT NULL
      )`,
    ];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const sql of statements) await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Could not initialize PostgreSQL schema: ${error.message}`);
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async getAccount(userId) {
    const { rows } = await this.pool.query('SELECT * FROM accounts WHERE user_id = $1', [String(userId)]);
    return rows[0] || null;
  }

  async createAccount(userId, displayName) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const skywardsNumber = `ES-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      await this.pool.query(
        `INSERT INTO accounts (user_id, display_name, skywards_number, created_at)
         VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id) DO NOTHING`,
        [String(userId), displayName, skywardsNumber],
      );
      const account = await this.getAccount(userId);
      if (account) return account;
    }
    throw new Error('Could not generate a unique Skywards number.');
  }

  async updateTier(userId, tier) {
    await this.pool.query('UPDATE accounts SET tier = $1 WHERE user_id = $2', [tier, String(userId)]);
  }

  async addMiles(userId, miles) {
    await this.pool.query('UPDATE accounts SET miles = miles + $1 WHERE user_id = $2', [miles, String(userId)]);
  }

  async addFlightMiles(userId, miles, flightReference, awardedBy) {
    return this.transaction(async (client) => {
      const account = await client.query('SELECT user_id FROM accounts WHERE user_id = $1 FOR UPDATE', [String(userId)]);
      if (!account.rowCount) return 'missing_account';
      await client.query('UPDATE accounts SET miles = miles + $1 WHERE user_id = $2', [miles, String(userId)]);
      await client.query(
        `INSERT INTO flight_awards (user_id, miles, flight_reference, awarded_by, awarded_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [String(userId), miles, flightReference, String(awardedBy)],
      );
      return 'awarded';
    });
  }

  async createEvent(data) {
    const { rows } = await this.pool.query(
      `INSERT INTO events
       (guild_id, channel_id, name, description, base_miles, event_date, created_by, created_at,
        event_type, flight_code, airline, departure, aircraft, terminal, check_in_status, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        String(data.guildId), String(data.channelId), data.name, data.description, data.baseMiles,
        data.eventDate || null, String(data.createdBy), data.eventType || 'GENERIC', data.flightCode || null,
        data.airline || null, data.departure || null, data.aircraft || null, data.terminal || null,
        data.checkInStatus || null, data.location || null,
      ],
    );
    return rows[0];
  }

  async setEventMessageId(eventId, messageId) {
    await this.pool.query('UPDATE events SET message_id = $1 WHERE id = $2', [String(messageId), String(eventId)]);
  }

  async getEvent(eventId) {
    const { rows } = await this.pool.query('SELECT * FROM events WHERE id = $1', [String(eventId)]);
    return rows[0] || null;
  }

  async listEvents(guildId) {
    const { rows } = await this.pool.query(
      'SELECT * FROM events WHERE guild_id = $1 AND message_id IS NOT NULL ORDER BY id',
      [String(guildId)],
    );
    return rows;
  }

  async countInterest(eventId) {
    const { rows } = await this.pool.query('SELECT COUNT(*)::int AS count FROM event_interest WHERE event_id = $1', [String(eventId)]);
    return rows[0]?.count || 0;
  }

  async addInterest(eventId, userId, travelClass) {
    const result = await this.pool.query(
      `INSERT INTO event_interest (event_id, user_id, travel_class, clicked_at)
       VALUES ($1, $2, $3, NOW()) ON CONFLICT DO NOTHING`,
      [String(eventId), String(userId), travelClass],
    );
    return result.rowCount === 1;
  }

  async removeInterest(eventId, userId) {
    await this.pool.query('DELETE FROM event_interest WHERE event_id = $1 AND user_id = $2', [String(eventId), String(userId)]);
  }

  async listInterest(eventId) {
    const { rows } = await this.pool.query(
      `SELECT i.user_id, i.travel_class, a.display_name, a.skywards_number, a.tier, a.miles
       FROM event_interest i JOIN accounts a ON a.user_id = i.user_id
       WHERE i.event_id = $1 ORDER BY i.clicked_at ASC`,
      [String(eventId)],
    );
    return rows;
  }

  async awardEvent(eventId, classOverrides = {}, tierOverrides = {}) {
    return this.transaction(async (client) => {
      const eventResult = await client.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [String(eventId)]);
      if (!eventResult.rowCount) return { status: 'missing', awards: [], missingAccounts: 0 };
      const event = eventResult.rows[0];
      if (event.awarded_at) return { status: 'already_awarded', awards: [], missingAccounts: 0 };
      const { rows } = await client.query(
        `SELECT i.user_id, i.travel_class, a.tier
         FROM event_interest i JOIN accounts a ON a.user_id = i.user_id
         WHERE i.event_id = $1 ORDER BY i.clicked_at ASC`,
        [String(eventId)],
      );
      const awards = [];
      for (const row of rows) {
        const userId = String(row.user_id);
        const travelClass = classOverrides[userId] || row.travel_class;
        const tier = tierOverrides[userId] || row.tier;
        const miles = calculateMiles(event.base_miles, travelClass, tier);
        await addAward(client, String(eventId), null, userId, miles, travelClass, tier);
        awards.push({ user_id: userId, miles, travel_class: travelClass, tier });
      }
      await client.query('UPDATE events SET awarded_at = NOW() WHERE id = $1', [String(eventId)]);
      return { status: 'awarded', awards, missingAccounts: 0 };
    });
  }

  async awardExternalEvent(externalEventId, baseMiles, profiles) {
    return this.transaction(async (client) => {
      const existing = await client.query('SELECT event_id FROM external_event_awards WHERE event_id = $1 FOR UPDATE', [String(externalEventId)]);
      if (existing.rowCount) return { status: 'already_awarded', awards: [], missingAccounts: 0 };
      const awards = [];
      let missingAccounts = 0;
      const seen = new Set();
      for (const profile of profiles) {
        const userId = String(profile.user_id);
        if (seen.has(userId)) continue;
        seen.add(userId);
        const account = await client.query('SELECT tier FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
        if (!account.rowCount) {
          missingAccounts += 1;
          continue;
        }
        const travelClass = profile.travel_class || 'Economy';
        const tier = profile.tier || account.rows[0].tier;
        const miles = calculateMiles(baseMiles, travelClass, tier);
        await addAward(client, null, String(externalEventId), userId, miles, travelClass, tier);
        awards.push({ user_id: userId, miles, travel_class: travelClass, tier });
      }
      await client.query('INSERT INTO external_event_awards (event_id, awarded_at) VALUES ($1, NOW())', [String(externalEventId)]);
      return { status: 'awarded', awards, missingAccounts };
    });
  }

  async getInventory(userId) {
    const { rows } = await this.pool.query(
      'SELECT product_id, quantity FROM inventory WHERE user_id = $1 AND quantity > 0 ORDER BY product_id',
      [String(userId)],
    );
    return rows;
  }

  async getShopCooldowns(userId) {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (product_id)
        product_id,
        purchased_at + make_interval(hours => $2::int) AS available_at
       FROM purchases
       WHERE user_id = $1
       ORDER BY product_id, purchased_at DESC`,
      [String(userId), SHOP_COOLDOWN_HOURS],
    );
    const now = Date.now();
    return Object.fromEntries(rows
      .filter((row) => new Date(row.available_at).getTime() > now)
      .map((row) => [row.product_id, row.available_at]));
  }

  async purchase(userId, productId, cost) {
    return this.transaction(async (client) => {
      const account = await client.query('SELECT miles FROM accounts WHERE user_id = $1 FOR UPDATE', [String(userId)]);
      if (!account.rowCount) return { status: 'missing_account' };
      const cooldown = await client.query(
        `SELECT purchased_at + make_interval(hours => $3::int) AS available_at
         FROM purchases
         WHERE user_id = $1 AND product_id = $2
         ORDER BY purchased_at DESC
         LIMIT 1`,
        [String(userId), productId, SHOP_COOLDOWN_HOURS],
      );
      const availableAt = cooldown.rows[0]?.available_at;
      if (availableAt && new Date(availableAt).getTime() > Date.now()) {
        return { status: 'cooldown', availableAt };
      }
      if (Number(account.rows[0].miles) < cost) return { status: 'insufficient_miles' };
      await client.query('UPDATE accounts SET miles = miles - $1 WHERE user_id = $2', [cost, String(userId)]);
      await client.query(
        `INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = inventory.quantity + 1`,
        [String(userId), productId],
      );
      await client.query(
        'INSERT INTO purchases (user_id, product_id, cost, purchased_at) VALUES ($1, $2, $3, NOW())',
        [String(userId), productId, cost],
      );
      return { status: 'purchased' };
    });
  }

  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

function calculateMiles(baseMiles, travelClass, tier) {
  const { CLASS_MULTIPLIERS, TIER_MULTIPLIERS } = require('./config');
  if (!(travelClass in CLASS_MULTIPLIERS) || !(tier in TIER_MULTIPLIERS)) {
    throw new Error('Unknown travel class or Skywards tier.');
  }
  return Math.max(1, Math.round(Number(baseMiles) * CLASS_MULTIPLIERS[travelClass] * TIER_MULTIPLIERS[tier]));
}

async function addAward(client, eventId, externalEventId, userId, miles, travelClass, tier) {
  await client.query('UPDATE accounts SET miles = miles + $1 WHERE user_id = $2', [miles, userId]);
  await client.query(
    `INSERT INTO awards (event_id, external_event_id, user_id, miles, travel_class, tier, awarded_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [eventId, externalEventId, userId, miles, travelClass, tier],
  );
}

module.exports = { Database, calculateMiles };
