const path = require('node:path');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const {
  CLASS_MULTIPLIERS,
  SHOP_ITEMS,
  TIER_BENEFITS,
  TIER_BONUS_PERCENTAGES,
  TIER_COLORS,
  TIER_DISPLAY_NAMES,
  TIER_MINIMUM_MILES,
  TIER_MULTIPLIERS,
  TIER_ROLE_IDS,
} = require('./config');

const number = (value) => Number(value || 0).toLocaleString('en-US');
const titleCase = (value) => value.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
const roleMention = (tier) => `<@&${TIER_ROLE_IDS[tier]}>`;
const tierName = (tier) => TIER_DISPLAY_NAMES[tier] || tier;
const assetPath = (tier) => path.resolve('assets', 'tiers', `${tier}.png`);
const GENERAL_COLOR = 0xed4245;

function formatAvailability(availableAt) {
  if (!availableAt) return '**Available now**';
  const timestamp = new Date(availableAt);
  const remainingMs = timestamp.getTime() - Date.now();
  if (remainingMs <= 0) return '**Available now**';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, '0');
  return `**Available in ${hours}:${minutes}hrs** · <t:${Math.floor(timestamp.getTime() / 1000)}:R>`;
}

function accountMessage(account, inventory) {
  const tier = account.tier;
  const filename = `${tier}.png`;
  const embed = new EmbedBuilder()
    .setTitle(`Emirates Skywards Account — ${account.display_name}`)
    .setDescription(`> “Every journey starts with a destination.”\n\n**${tierName(tier)}** member · ${roleMention(tier)}\n*Your Skywards profile at a glance.*`)
    .setColor(TIER_COLORS[tier])
    .setThumbnail(`attachment://${filename}`)
    .addFields(
      { name: 'Skywards number', value: '`' + account.skywards_number + '`', inline: true },
      { name: 'Available miles', value: `**${number(account.miles)}**`, inline: true },
      { name: 'Tier threshold', value: `${number(TIER_MINIMUM_MILES[tier])} miles`, inline: true },
      { name: 'Status bonus', value: `+${TIER_BONUS_PERCENTAGES[tier]}% Skywards miles`, inline: true },
      { name: `${tierName(tier)} benefits`, value: TIER_BENEFITS[tier].map((benefit) => `• ${benefit}`).join('\n') },
      { name: 'Your perks', value: inventory.length ? inventory.map((item) => `${titleCase(item.product_id)} × ${item.quantity}`).join('\n') : '*No perks owned yet.*' },
    )
    .setFooter({ text: 'Emirates PTFS • Skywards' });
  return { embeds: [embed], files: [new AttachmentBuilder(assetPath(tier), { name: filename })] };
}

function accountInventoryEmbed(account, inventory) {
  const embed = new EmbedBuilder()
    .setTitle(`Perks — ${account.display_name}`)
    .setDescription('> “A little extra makes every journey better.”')
    .setColor(TIER_COLORS[account.tier])
    .addFields({ name: 'Skywards tier', value: `**${tierName(account.tier)}** · ${roleMention(account.tier)}` });
  if (inventory.length) {
    embed.addFields(...inventory.map((item) => ({
      name: titleCase(item.product_id),
      value: `Quantity: **${item.quantity}**`,
      inline: true,
    })));
  } else {
    embed.setDescription(`${embed.data.description}\n\n*You have not purchased any perks yet.*`);
  }
  return embed.setFooter({ text: 'Use /shop to browse available perks.' });
}

function shopEmbed(cooldowns = {}) {
  return new EmbedBuilder()
    .setTitle('Emirates Skywards Shop')
    .setDescription('> “Make your miles work harder.”\n\nUse the buttons below to exchange miles for PTFS perks.')
    .setColor(GENERAL_COLOR)
    .addFields(...Object.entries(SHOP_ITEMS).map(([productId, item]) => ({
      name: `${item.name} — ${number(item.price)} miles`,
      value: `${item.description}\n\n${formatAvailability(cooldowns[productId])}`,
    })))
    .setFooter({ text: 'Purchases are added to your Skywards account inventory.' });
}

function eventEmbed(event, interestedCount) {
  if (event.event_type === 'FLIGHT') return flightEmbed(event, interestedCount);
  const embed = new EmbedBuilder()
    .setTitle(`Emirates PTFS Event — ${event.name}`)
    .setDescription(`> “${event.description}”`)
    .setColor(GENERAL_COLOR)
    .addFields(
      { name: 'Base miles', value: `**${number(event.base_miles)}**`, inline: true },
      { name: 'Interested', value: `**${interestedCount}**`, inline: true },
      { name: 'Event ID', value: '`' + event.id + '`', inline: true },
    )
    .setFooter({ text: event.awarded_at ? 'Miles have already been awarded for this event.' : "Click I'm Interested, then choose your travel class." });
  if (event.event_date) embed.addFields({ name: 'Date', value: event.event_date });
  return embed;
}

function flightEmbed(event, interestedCount) {
  const embed = new EmbedBuilder()
    .setTitle(`${event.flight_code || event.name} · ${event.airline || 'Emirates'}`)
    .setDescription(`Departure · ${event.departure || event.location || 'TBD'} · ${event.aircraft || 'Aircraft TBD'} · Terminal ${event.terminal || 'TBD'} · Check-in ${event.check_in_status || 'Open'}`)
    .setColor(GENERAL_COLOR)
    .addFields(
      { name: 'Location', value: event.location || event.departure || 'TBD', inline: true },
      { name: 'Interested', value: `**${interestedCount}**`, inline: true },
      { name: 'Event ID', value: '`' + event.id + '`', inline: true },
    )
    .setFooter({ text: event.awarded_at ? 'Miles have already been awarded for this event.' : "Click I'm Interested, then choose your travel class." });
  if (event.event_date) embed.addFields({ name: 'Date', value: event.event_date, inline: false });
  return embed;
}

function awardPreviewEmbed(event, rows) {
  const embed = new EmbedBuilder()
    .setTitle(`Interested passengers — ${event.name}`)
    .setDescription(`**${rows.length}** passenger(s) are registered.\nBase miles: **${number(event.base_miles)}** per passenger before multipliers.`)
    .setColor(GENERAL_COLOR);
  for (const [index, row] of rows.slice(0, 25).entries()) {
    const calculated = row.tier ? Math.round(Number(event.base_miles) * CLASS_MULTIPLIERS[row.travel_class] * TIER_MULTIPLIERS[row.tier]) : 0;
    embed.addFields({
      name: `${index + 1}. ${row.display_name}`,
      value: row.tier
        ? `Class: **${row.travel_class}**\nStatus: **${tierName(row.tier)}** (${roleMention(row.tier)})\nProjected award: **${number(calculated)} miles**`
        : `Class: **${row.travel_class || 'Economy'}**\nStatus: **No Skywards account**`,
    });
  }
  if (rows.length > 25) embed.setFooter({ text: `Showing the first 25 of ${rows.length} passengers.` });
  return embed;
}

function scheduledEventPreviewEmbed(event, rows, baseMiles = null) {
  const embed = new EmbedBuilder()
    .setTitle(`Discord event attendees — ${event.name}`)
    .setDescription(`> “${event.description || 'No description was provided for this Discord event.'}”\n\nEvent ID: \`${event.id}\`\nDiscord interest count: **${event.userCount ?? rows.length}**`)
    .setColor(GENERAL_COLOR);
  for (const [index, row] of rows.slice(0, 25).entries()) {
    const status = row.tier ? `${tierName(row.tier)} (${roleMention(row.tier)})` : 'No Skywards account';
    const lines = [`User ID: \`${row.user_id}\``, `Class: **${row.travel_class || 'Economy'}**`, `Status: **${status}**`];
    if (baseMiles !== null && row.tier) {
      const calculated = Math.round(Number(baseMiles) * CLASS_MULTIPLIERS[row.travel_class] * TIER_MULTIPLIERS[row.tier]);
      lines.push(`Projected award: **${number(calculated)} miles**`);
    }
    embed.addFields({ name: `${index + 1}. ${row.display_name}`, value: lines.join('\n') });
  }
  if (rows.length > 25) embed.setFooter({ text: `Showing the first 25 of ${rows.length} attendees.` });
  return embed;
}

module.exports = {
  accountMessage,
  accountInventoryEmbed,
  shopEmbed,
  eventEmbed,
  awardPreviewEmbed,
  scheduledEventPreviewEmbed,
  formatAvailability,
  roleMention,
  tierName,
  number,
};
