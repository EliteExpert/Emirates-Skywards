const {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { Database } = require('./database');
const {
  CLASS_MULTIPLIERS,
  DEFAULT_EVENT_BASE_MILES,
  ADMIN_ROLE_IDS,
  SHOP_ITEMS,
  TIERS,
  TIER_DISPLAY_NAMES,
  TIER_MINIMUM_MILES,
  TIER_ROLE_IDS,
  TRAVEL_CLASS_ROLE_IDS,
  TRAVEL_CLASSES,
  settings,
} = require('./config');
const {
  accountMessage,
  accountInventoryEmbed,
  awardPreviewEmbed,
  eventEmbed,
  scheduledEventPreviewEmbed,
  shopEmbed,
  formatAvailability,
  number,
  tierName,
} = require('./embeds');
const {
  accountComponents,
  eventComponents,
  shopComponents,
  travelClassComponents,
} = require('./ui');

const appSettings = settings();
const database = new Database(appSettings.databaseUrl);
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildScheduledEvents],
});

function buildCommands() {
  const tierChoices = TIERS.map((tier) => ({
    name: `${TIER_DISPLAY_NAMES[tier]} (<@&${TIER_ROLE_IDS[tier]}>)`,
    value: tier,
  }));
  const travelChoices = TRAVEL_CLASSES.map((travelClass) => ({ name: travelClass, value: travelClass }));
  return [
    new SlashCommandBuilder().setName('account').setDescription('Create and manage Skywards accounts')
      .addSubcommand((sub) => sub.setName('create').setDescription('Create your Emirates Skywards account'))
      .addSubcommand((sub) => sub.setName('view').setDescription('View a Skywards account')
        .addUserOption((option) => option.setName('member').setDescription('Account to view').setRequired(false)))
      .addSubcommand((sub) => sub.setName('inventory').setDescription('View your purchased Skywards perks'))
      .addSubcommand((sub) => sub.setName('set-tier').setDescription("Set a member's Skywards tier")
        .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((option) => option.setName('tier').setDescription('Tier').setRequired(true).addChoices(...tierChoices)))
      .addSubcommand((sub) => sub.setName('add-miles').setDescription('Grant miles to a member')
        .addUserOption((option) => option.setName('member').setDescription('Member').setRequired(true))
        .addIntegerOption((option) => option.setName('miles').setDescription('Miles').setRequired(true).setMinValue(1).setMaxValue(1_000_000))),
    new SlashCommandBuilder().setName('flights-list').setDescription('List flights and events'),
    new SlashCommandBuilder().setName('flight-awards').setDescription('Award Skywards miles for a flight or event')
      .addStringOption((option) => option.setName('event_id').setDescription('Flight or event ID').setRequired(true))
      .addIntegerOption((option) => option.setName('base_miles').setDescription('Base miles for native events; defaults to 1,000').setRequired(false).setMinValue(1).setMaxValue(1_000_000))
      .addStringOption((option) => option.setName('travel_class').setDescription('Fallback class when no class role exists').setRequired(false).addChoices(...travelChoices))
      .addBooleanOption((option) => option.setName('confirm').setDescription('Apply the award').setRequired(false)),
    new SlashCommandBuilder().setName('shop').setDescription('Browse and buy Skywards perks'),
  ];
}

function parseEventId(value) {
  const match = String(value || '').trim().replaceAll('`', '').match(/^(?:event[\s_-]*)?#?(\d+)\b/i);
  return match ? match[1] : null;
}

function requireGuild(interaction) {
  if (!interaction.guild) throw new Error('This command can only be used inside a server.');
  return interaction.guild;
}

function requireManager(interaction) {
  const isAdministrator = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
  const hasStaffRole = ADMIN_ROLE_IDS.some((roleId) => interaction.member?.roles?.cache?.has(roleId));
  if (isAdministrator || hasStaffRole) return;
  const allowedRoles = ADMIN_ROLE_IDS.map((roleId) => `<@&${roleId}>`).join(', ');
  throw new Error(`You need the **Administrator** permission or one of these staff roles: ${allowedRoles}.`);
}

function memberRoleIds(member) {
  return new Set(member?.roles?.cache?.keys() || []);
}

function resolveTravelClass(member, fallback = 'Economy') {
  const roleIds = memberRoleIds(member);
  for (const travelClass of ['First', 'Business', 'Economy']) {
    if (roleIds.has(TRAVEL_CLASS_ROLE_IDS[travelClass])) return travelClass;
  }
  return CLASS_MULTIPLIERS[fallback] ? fallback : 'Economy';
}

function resolveTier(member, fallback = null) {
  const roleIds = memberRoleIds(member);
  for (const tier of ['Platinum', 'Gold', 'Silver', 'Blue']) {
    if (roleIds.has(TIER_ROLE_IDS[tier])) return tier;
  }
  return fallback;
}

async function findMember(guild, userId) {
  return guild.members.cache.get(String(userId)) || guild.members.fetch(String(userId)).catch(() => null);
}

const ROLE_SYNC_NOTE = '⚠️ I could not update their Discord roles. Give me the **Manage Roles** permission and move my bot role above the Skywards tier roles.';

async function syncTierRole(guild, userId, tier) {
  const targetRoleId = TIER_ROLE_IDS[tier];
  if (!guild || !targetRoleId) return false;
  const member = await findMember(guild, userId);
  if (!member) return false;
  const currentRoleIds = memberRoleIds(member);
  const staleRoleIds = Object.values(TIER_ROLE_IDS)
    .filter((roleId) => roleId !== targetRoleId && currentRoleIds.has(roleId));
  try {
    if (staleRoleIds.length) await member.roles.remove(staleRoleIds, 'Skywards tier sync');
    if (!currentRoleIds.has(targetRoleId)) await member.roles.add(targetRoleId, 'Skywards tier sync');
    return true;
  } catch (error) {
    console.error(`Could not sync the ${tier} tier role for ${userId}:`, error.message);
    return false;
  }
}

// Keeps the stored tier in step with the member's tier roles. A missing tier
// role falls back to the stored tier instead of demoting the member.
async function reconcileTier(member, account) {
  if (!member?.roles?.cache) return account;
  const resolved = resolveTier(member, null);
  if (!resolved || resolved === account.tier) return account;
  await database.updateTier(account.user_id, resolved);
  return { ...account, tier: resolved };
}

async function applyRoleProfiles(guild, rows) {
  const classOverrides = {};
  const tierOverrides = {};
  await Promise.all(rows.map(async (row) => {
    const member = await findMember(guild, row.user_id);
    row.travel_class = resolveTravelClass(member, row.travel_class || 'Economy');
    row.tier = resolveTier(member, row.tier || null);
    classOverrides[String(row.user_id)] = row.travel_class;
    if (row.tier) tierOverrides[String(row.user_id)] = row.tier;
  }));
  return { classOverrides, tierOverrides };
}

async function fetchScheduledEvent(guild, eventId) {
  return guild.scheduledEvents.fetch(String(eventId)).catch(() => null);
}

async function fetchScheduledRows(event, fallbackClass = 'Economy') {
  const rows = [];
  let after;
  while (true) {
    const options = { limit: 100, withMember: true };
    if (after) options.after = after;
    const page = await event.fetchSubscribers(options);
    const pageRows = await Promise.all([...page.values()].map(async (subscriber) => {
      const member = subscriber.member || await findMember(event.guild, subscriber.user.id);
      const account = await database.getAccount(subscriber.user.id);
      return {
        user_id: subscriber.user.id,
        display_name: member?.displayName || subscriber.user.globalName || subscriber.user.username,
        travel_class: resolveTravelClass(member, fallbackClass),
        tier: resolveTier(member, account?.tier || null),
      };
    }));
    rows.push(...pageRows);
    if (page.size < 100) break;
    const ids = [...page.keys()];
    after = ids[ids.length - 1];
    if (!after) break;
  }
  return rows;
}

async function handleAccount(interaction, subcommand) {
  const user = interaction.options.getUser('member') || interaction.user;
  if (subcommand === 'create') {
    const existing = await database.getAccount(interaction.user.id);
    if (existing) return { content: `You already have a Skywards account: \`${existing.skywards_number}\`.` };
    const account = await database.createAccount(interaction.user.id, interaction.user.displayName);
    const roleAssigned = await syncTierRole(interaction.guild, account.user_id, account.tier);
    const note = interaction.guild && !roleAssigned ? ` ${ROLE_SYNC_NOTE}` : '';
    return { ...(note && { content: note }), ...accountMessage(account, []), components: accountComponents(account) };
  }
  if (subcommand === 'view') {
    const account = await database.getAccount(user.id);
    if (!account) return { content: `${user.id === interaction.user.id ? 'You do not have' : 'That member does not have'} a Skywards account yet. Use \`/account create\` first.` };
    const member = interaction.guild
      ? (user.id === interaction.user.id ? interaction.member : await findMember(interaction.guild, user.id))
      : null;
    const fresh = await reconcileTier(member, account);
    return { ...accountMessage(fresh, await database.getInventory(user.id)), components: accountComponents(fresh) };
  }
  if (subcommand === 'inventory') {
    const account = await database.getAccount(interaction.user.id);
    if (!account) return { content: 'You do not have a Skywards account yet. Use `/account create` first.' };
    const fresh = await reconcileTier(interaction.guild ? interaction.member : null, account);
    return { embeds: [accountInventoryEmbed(fresh, await database.getInventory(interaction.user.id))] };
  }
  requireGuild(interaction);
  requireManager(interaction);
  const account = await database.getAccount(user.id);
  if (!account) return { content: 'That member needs to create an account first.' };
  if (subcommand === 'set-tier') {
    const tier = interaction.options.getString('tier', true);
    await database.updateTier(user.id, tier);
    const roleAssigned = await syncTierRole(interaction.guild, user.id, tier);
    return { content: `**${user.displayName}** is now a **${TIER_DISPLAY_NAMES[tier]}** member (<@&${TIER_ROLE_IDS[tier]}>).${roleAssigned ? '' : ` ${ROLE_SYNC_NOTE}`}` };
  }
  const miles = interaction.options.getInteger('miles', true);
  await database.addMiles(user.id, miles);
  return { content: `Granted **${number(miles)} miles** to **${user.displayName}**.` };
}

async function handleFlightsList(interaction) {
  const guild = requireGuild(interaction);
  return eventListPayload(guild);
}

async function eventListPayload(guild) {
  const events = await database.listEvents(guild.id);
  const scheduled = await guild.scheduledEvents.fetch().catch(() => new Map());
  const embed = new EmbedBuilder()
    .setTitle('Emirates PTFS Flights and Events')
    .setDescription('Use the flight or event ID with `/flight-awards`.')
    .setColor(0xed4245);
  const counts = await Promise.all(events.slice(-20).map((event) => database.countInterest(event.id)));
  events.slice(-20).forEach((event, index) => {
    embed.addFields({ name: `${event.id} — ${event.name}`, value: event.awarded_at ? 'Awarded' : `${counts[index]} interested` });
  });
  for (const event of [...scheduled.values()].slice(-20)) {
    embed.addFields({ name: `${event.id} — ${event.name}`, value: `${event.userCount || 0} interested · Discord scheduled event` });
  }
  return { embeds: [embed] };
}

async function handleMilesFlight(interaction) {
  const guild = requireGuild(interaction);
  requireManager(interaction);
  const eventId = parseEventId(interaction.options.getString('event_id', true));
  if (!eventId) return { content: 'Enter the numeric flight or event ID shown by `/flights-list`, for example `1` or `#1`.' };
  const botEvent = await database.getEvent(eventId);
  if (botEvent && botEvent.guild_id === guild.id) {
    const rows = await database.listInterest(eventId);
    if (!rows.length) return { content: 'There are no interested members to award.' };
    const { classOverrides, tierOverrides } = await applyRoleProfiles(guild, rows);
    if (!interaction.options.getBoolean('confirm')) return { embeds: [awardPreviewEmbed(botEvent, rows)], content: 'Set `confirm` to **True** to apply these awards. This can only be done once per event.' };
    const result = await database.awardEvent(eventId, classOverrides, tierOverrides);
    if (result.status === 'already_awarded') return { content: 'Miles for this event have already been awarded.' };
    const total = result.awards.reduce((sum, award) => sum + award.miles, 0);
    return { content: `**Event awards complete.** Granted **${number(total)} miles** across **${result.awards.length}** passenger(s).` };
  }
  const scheduled = await fetchScheduledEvent(guild, eventId);
  if (!scheduled) return { content: 'No bot event or Discord scheduled event with that ID exists in this server.' };
  const baseMiles = interaction.options.getInteger('base_miles') || DEFAULT_EVENT_BASE_MILES;
  const fallbackClass = interaction.options.getString('travel_class') || 'Economy';
  const rows = await fetchScheduledRows(scheduled, fallbackClass);
  if (!rows.length) return { content: `No one has clicked interested for **${scheduled.name}** yet.` };
  if (!interaction.options.getBoolean('confirm')) return {
    embeds: [scheduledEventPreviewEmbed(scheduled, rows, baseMiles)],
    content: `Base miles: **${number(baseMiles)}** · Fallback class: **${fallbackClass}**\nClass and tier roles override the fallback for each attendee.\nSet \`confirm\` to **True** to award miles to attendees with Skywards accounts.`,
  };
  const result = await database.awardExternalEvent(eventId, baseMiles, rows);
  if (result.status === 'already_awarded') return { content: 'Miles for this Discord event have already been awarded.' };
  const total = result.awards.reduce((sum, award) => sum + award.miles, 0);
  const skipped = result.missingAccounts ? ` Skipped **${result.missingAccounts}** attendee(s) without accounts.` : '';
  return { content: `**Event awards complete.** Granted **${number(total)} miles** across **${result.awards.length}** passenger(s).${skipped}` };
}

async function shopPayload(userId) {
  const cooldowns = await database.getShopCooldowns(userId);
  return {
    embeds: [shopEmbed(cooldowns)],
    components: shopComponents(userId, cooldowns),
    attachments: [],
  };
}

async function handleComponent(interaction) {
  const [type, action, id, ownerId] = interaction.customId.split(':');
  if (interaction.isButton() && type === 'event' && action === 'interest') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return interaction.editReply({ content: 'Choose your travel class.', components: travelClassComponents(id) });
  }
  if (interaction.isStringSelectMenu() && type === 'event' && action === 'class') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const account = await database.getAccount(interaction.user.id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    const event = await database.getEvent(id);
    if (!event) return interaction.editReply({ content: 'That event no longer exists or was removed.' });
    const selected = interaction.values[0];
    const added = await database.addInterest(id, interaction.user.id, selected);
    if (!added) return interaction.editReply({ content: 'You are already registered as interested in this event.' });
    if (interaction.message) {
      const count = await database.countInterest(id);
      await interaction.message.edit({ embeds: [eventEmbed(event, count)], components: eventComponents(id) }).catch(() => {});
    }
    return interaction.editReply({ content: `You are marked **Interested** for **${selected}**.` });
  }
  if (interaction.isButton() && type === 'account' && action === 'refresh') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can use these dashboard buttons.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    let account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    account = await reconcileTier(interaction.guild ? interaction.member : null, account);
    return interaction.editReply({ ...accountMessage(account, await database.getInventory(id)), components: accountComponents(account) });
  }
  if (interaction.isButton() && type === 'account' && action === 'shop') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can open this shop session.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    const account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    return interaction.editReply(await shopPayload(account.user_id));
  }
  if (interaction.isButton() && type === 'account' && action === 'upgrade') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can upgrade this account.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    const account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    if (!TIERS.includes(account.tier)) return interaction.editReply({ content: 'Your stored tier is not a valid Skywards tier. Ask staff to fix it with `/account set-tier`.' });
    const nextTier = TIERS[TIERS.indexOf(account.tier) + 1];
    if (!nextTier) return interaction.editReply({ content: 'You are already at the highest Skywards tier.' });
    const upgradeCost = TIER_MINIMUM_MILES[nextTier];
    const result = await database.upgradeTier(id, nextTier, upgradeCost);
    if (result.status === 'insufficient_miles') {
      return interaction.followUp({
        content: `Upgrading to **${TIER_DISPLAY_NAMES[nextTier]}** costs **${number(upgradeCost)} miles**. You have **${number(result.miles)}**. Earn miles on PTFS flights and events, then try again.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (result.status === 'missing_account') return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    const roleSynced = await syncTierRole(interaction.guild, id, nextTier);
    const upgraded = await database.getAccount(id);
    await interaction.editReply({ ...accountMessage(upgraded, await database.getInventory(id)), components: accountComponents(upgraded) });
    let note = `✅ Upgraded to **${TIER_DISPLAY_NAMES[nextTier]}** for **${number(upgradeCost)} miles**. You now have **${number(upgraded.miles)} miles**.`;
    if (!roleSynced) note += ` ${ROLE_SYNC_NOTE}`;
    await interaction.followUp({ content: note, flags: MessageFlags.Ephemeral }).catch(() => {});
    return;
  }
  if (interaction.isButton() && type === 'shop' && action === 'buy') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const item = SHOP_ITEMS[id];
    if (!item || ownerId !== interaction.user.id) return interaction.editReply({ content: 'This shop session belongs to another member.' });
    const account = await database.getAccount(ownerId);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    const result = await database.purchase(ownerId, id, item.price);
    if (result.status === 'cooldown') return interaction.editReply({ content: `${item.name} is on cooldown. ${formatAvailability(result.availableAt)}.` });
    if (result.status === 'insufficient_miles') return interaction.editReply({ content: `You need **${number(item.price)} miles** to purchase **${item.name}**.` });
    if (result.status === 'missing_account') return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    await interaction.message?.edit(await shopPayload(ownerId)).catch(() => {});
    return interaction.editReply({ content: `Purchased **${item.name}** for **${number(item.price)} miles**.` });
  }
  if (interaction.isButton() && type === 'shop' && action === 'back') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can return to this dashboard.', flags: MessageFlags.Ephemeral });
    await interaction.deferUpdate();
    let account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    account = await reconcileTier(interaction.guild ? interaction.member : null, account);
    return interaction.editReply({ ...accountMessage(account, await database.getInventory(id)), components: accountComponents(account) });
  }
  return null;
}

async function handleCommand(interaction) {
  const name = interaction.commandName;
  const subcommand = interaction.options.getSubcommand(false);
  if (name === 'account') return handleAccount(interaction, subcommand);
  if (name === 'flights-list') return handleFlightsList(interaction);
  if (name === 'flight-awards') return handleMilesFlight(interaction);
  if (name === 'shop') return shopPayload(interaction.user.id);
  return { content: 'Unknown command.' };
}

function isPublicCommand(interaction) {
  return interaction.commandName === 'shop'
    || (interaction.commandName === 'account'
      && ['create', 'view', 'inventory'].includes(interaction.options.getSubcommand(false)));
}

async function respondError(interaction, error) {
  console.error('Interaction failed:', error);
  const content = error?.message || 'Something went wrong while processing that command. Check the bot logs for details.';
  if (interaction.deferred || interaction.replied) await interaction.editReply({ content, embeds: [], components: [] }).catch(() => {});
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (isPublicCommand(interaction)) await interaction.deferReply();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const payload = await handleCommand(interaction);
      if (payload.eventToSaveId) {
        const eventId = payload.eventToSaveId;
        delete payload.eventToSaveId;
        const message = await interaction.editReply(payload);
        await database.setEventMessageId(eventId, message.id).catch(() => {});
      } else {
        await interaction.editReply(payload);
      }
      return;
    }
    if (interaction.isButton() || interaction.isStringSelectMenu()) await handleComponent(interaction);
  } catch (error) {
    await respondError(interaction, error);
  }
});

client.once(Events.ClientReady, async (ready) => {
  try {
    const commands = buildCommands().map((command) => command.toJSON());
    const commandNames = commands.map((command) => command.name);
    if (new Set(commandNames).size !== commandNames.length) {
      throw new Error(`Duplicate slash command names detected: ${commandNames.join(', ')}`);
    }
    if (appSettings.testGuildId) {
      // Development commands are guild-scoped. Clear older global copies so Discord cannot show duplicates.
      await ready.application.commands.set([]);
      const guild = ready.guilds.cache.get(appSettings.testGuildId);
      if (guild) await guild.commands.set(commands);
      else await ready.application.commands.set(commands, appSettings.testGuildId);
      console.log(`Slash commands synced to test guild ${appSettings.testGuildId}`);
    } else {
      await ready.application.commands.set(commands);
      console.log('Global slash commands synced');
    }
    console.log(`Logged in as ${ready.user.tag}`);
  } catch (error) {
    console.error('Command registration failed:', error);
  }
});

async function start() {
  if (!appSettings.token) throw new Error('DISCORD_TOKEN is missing.');
  await database.initialize();
  await client.login(appSettings.token);
}

process.on('SIGTERM', async () => {
  await client.destroy();
  await database.close();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await client.destroy();
  await database.close();
  process.exit(0);
});

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exitCode = 1;
});
