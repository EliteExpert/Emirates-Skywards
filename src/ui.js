const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { SHOP_ITEMS, TIER_DISPLAY_NAMES, TIER_MINIMUM_MILES, TIERS, TRAVEL_CLASSES } = require('./config');

function accountComponents(account) {
  const nextTier = TIERS[TIERS.indexOf(account.tier) + 1];
  const buttons = [
    new ButtonBuilder().setCustomId(`account:refresh:${account.user_id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`account:shop:${account.user_id}`).setLabel('Shop').setStyle(ButtonStyle.Secondary),
  ];
  if (nextTier) {
    buttons.unshift(new ButtonBuilder()
      .setCustomId(`account:upgrade:${account.user_id}`)
      .setLabel(`Upgrade to ${TIER_DISPLAY_NAMES[nextTier]} (${TIER_MINIMUM_MILES[nextTier].toLocaleString('en-US')} miles)`)
      .setStyle(ButtonStyle.Success)
      .setDisabled(Number(account.miles || 0) < TIER_MINIMUM_MILES[nextTier]));
  }
  return [new ActionRowBuilder().addComponents(buttons)];
}

function shopComponents(userId, cooldowns = {}) {
  const entries = Object.entries(SHOP_ITEMS);
  const rows = [];
  for (let index = 0; index < entries.length; index += 3) {
    rows.push(new ActionRowBuilder().addComponents(entries.slice(index, index + 3).map(([id, item]) =>
      new ButtonBuilder()
        .setCustomId(`shop:buy:${id}:${userId}`)
        .setLabel(`Buy ${item.name}`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(Boolean(cooldowns[id] && new Date(cooldowns[id]).getTime() > Date.now())))));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`shop:back:${userId}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

function eventComponents(eventId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`event:interest:${eventId}`).setLabel("I'm Interested").setStyle(ButtonStyle.Secondary),
  )];
}

function travelClassComponents(eventId) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`event:class:${eventId}`)
    .setPlaceholder('Choose your travel class')
    .addOptions(TRAVEL_CLASSES.map((travelClass) =>
      new StringSelectMenuOptionBuilder().setLabel(travelClass).setValue(travelClass)));
  return [new ActionRowBuilder().addComponents(menu)];
}

module.exports = { accountComponents, shopComponents, eventComponents, travelClassComponents };
