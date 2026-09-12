const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} = require('discord.js');
const { SHOP_ITEMS, TIERS, TRAVEL_CLASSES } = require('./config');

function accountComponents(userId, tier) {
  const nextTier = TIERS[TIERS.indexOf(tier) + 1];
  const buttons = [
    new ButtonBuilder().setCustomId(`account:refresh:${userId}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`account:shop:${userId}`).setLabel('Shop').setStyle(ButtonStyle.Secondary),
  ];
  if (nextTier) {
    buttons.unshift(new ButtonBuilder().setCustomId(`account:upgrade:${userId}`).setLabel('Upgrade to next tier').setStyle(ButtonStyle.Success));
  }
  return [new ActionRowBuilder().addComponents(buttons)];
}

function shopComponents(userId) {
  const entries = Object.entries(SHOP_ITEMS);
  const rows = [];
  for (let index = 0; index < entries.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(entries.slice(index, index + 5).map(([id, item]) =>
      new ButtonBuilder().setCustomId(`shop:buy:${id}:${userId}`).setLabel(`Buy ${item.name}`).setStyle(ButtonStyle.Success))));
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
