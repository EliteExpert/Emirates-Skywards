const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { Database } = require('./database');
const {
  CLASS_MULTIPLIERS,
  DEFAULT_EVENT_BASE_MILES,
  SHOP_ITEMS,
  TIERS,
  TIER_DISPLAY_NAMES,
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
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need the **Manage Server** permission to use that command.');
  }
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
    return { ...accountMessage(account, []), components: accountComponents(account.user_id, account.tier) };
  }
  if (subcommand === 'view') {
    const account = await database.getAccount(user.id);
    if (!account) return { content: `${user.id === interaction.user.id ? 'You do not have' : 'That member does not have'} a Skywards account yet. Use \`/account create\` first.` };
    return { ...accountMessage(account, await database.getInventory(user.id)), components: accountComponents(account.user_id, account.tier) };
  }
  if (subcommand === 'inventory') {
    const account = await database.getAccount(interaction.user.id);
    if (!account) return { content: 'You do not have a Skywards account yet. Use `/account create` first.' };
    return { embeds: [accountInventoryEmbed(account, await database.getInventory(interaction.user.id))] };
  }
  requireGuild(interaction);
  requireManager(interaction);
  const account = await database.getAccount(user.id);
  if (!account) return { content: 'That member needs to create an account first.' };
  if (subcommand === 'set-tier') {
    const tier = interaction.options.getString('tier', true);
    await database.updateTier(user.id, tier);
    return { content: `**${user.displayName}** is now a **${TIER_DISPLAY_NAMES[tier]}** member (<@&${TIER_ROLE_IDS[tier]}>).` };
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
  const embed = new (require('discord.js').EmbedBuilder)()
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

async function handleComponent(interaction) {
  const [type, action, id, ownerId] = interaction.customId.split(':');
  if (interaction.isButton() && type === 'event' && action === 'interest') {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply({ content: 'Choose your travel class.', components: travelClassComponents(id) });
  }
  if (interaction.isStringSelectMenu() && type === 'event' && action === 'class') {
    await interaction.deferReply({ ephemeral: true });
    const account = await database.getAccount(interaction.user.id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    const selected = interaction.values[0];
    const added = await database.addInterest(id, interaction.user.id, selected);
    if (!added) return interaction.editReply({ content: 'You are already registered as interested in this event.' });
    const event = await database.getEvent(id);
    if (event && interaction.message) {
      const count = await database.countInterest(id);
      await interaction.message.edit({ embeds: [eventEmbed(event, count)], components: eventComponents(id) }).catch(() => {});
    }
    return interaction.editReply({ content: `You are marked **Interested** for **${selected}**.` });
  }
  if (interaction.isButton() && type === 'account' && action === 'refresh') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can use these dashboard buttons.', ephemeral: true });
    await interaction.deferUpdate();
    const account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    return interaction.editReply({ ...accountMessage(account, await database.getInventory(id)), components: accountComponents(id, account.tier) });
  }
  if (interaction.isButton() && type === 'account' && action === 'shop') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can open this shop session.', ephemeral: true });
    await interaction.deferUpdate();
    const account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    return interaction.editReply({ embeds: [shopEmbed()], components: shopComponents(account.user_id) });
  }
  if (interaction.isButton() && type === 'account' && action === 'upgrade') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can upgrade this account.', ephemeral: true });
    await interaction.deferUpdate();
    const account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    const nextTier = TIERS[TIERS.indexOf(account.tier) + 1];
    if (!nextTier) return interaction.editReply({ content: 'You are already at the highest Skywards tier.' });
    await database.updateTier(id, nextTier);
    const upgraded = await database.getAccount(id);
    return interaction.editReply({ ...accountMessage(upgraded, await database.getInventory(id)), components: accountComponents(id, upgraded.tier) });
  }
  if (interaction.isButton() && type === 'shop' && action === 'buy') {
    await interaction.deferReply({ ephemeral: true });
    const item = SHOP_ITEMS[id];
    const account = await database.getAccount(ownerId);
    if (!item || !account || ownerId !== interaction.user.id) return interaction.editReply({ content: 'This shop session belongs to another member.' });
    const result = await database.purchase(ownerId, id, item.price);
    if (result === 'insufficient_miles') return interaction.editReply({ content: `You need **${number(item.price)} miles** to purchase **${item.name}**.` });
    if (result === 'missing_account') return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    return interaction.editReply({ content: `Purchased **${item.name}** for **${number(item.price)} miles**.` });
  }
  if (interaction.isButton() && type === 'shop' && action === 'back') {
    if (id !== interaction.user.id) return interaction.reply({ content: 'Only the account owner can return to this dashboard.', ephemeral: true });
    await interaction.deferUpdate();
    const account = await database.getAccount(id);
    if (!account) return interaction.editReply({ content: 'You do not have a Skywards account yet. Use `/account create` first.' });
    return interaction.editReply({ ...accountMessage(account, await database.getInventory(id)), components: accountComponents(id, account.tier) });
  }
  return null;
}

async function handleCommand(interaction) {
  const name = interaction.commandName;
  const subcommand = interaction.options.getSubcommand(false);
  if (name === 'account') return handleAccount(interaction, subcommand);
  if (name === 'flights-list') return handleFlightsList(interaction);
  if (name === 'flight-awards') return handleMilesFlight(interaction);
  if (name === 'shop') return { embeds: [shopEmbed()], components: shopComponents(interaction.user.id) };
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
  else await interaction.reply({ content, ephemeral: true }).catch(() => {});
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ ephemeral: !isPublicCommand(interaction) });
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
